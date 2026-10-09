import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/app-config.js';
import { invokeModelStatement } from './bedrock-iam.js';
import { MonitoredFunction } from './constructs/monitored-function.js';
import { buildPipelineDefinition } from './state-machine.js';

// Spans masked rather than blocked. Shared by the main guardrail (model output) and the masking
// guardrail (audience input), because Bedrock only anonymizes when source is OUTPUT.
const MASK_PII = ['NAME', 'USERNAME', 'IP_ADDRESS', 'URL'];
const MASK_REGEXES: bedrock.CfnGuardrail.RegexConfigProperty[] = [
    { name: 'Handle', description: 'Social or chat handles like @dave', pattern: '@[A-Za-z0-9_.-]{2,}', action: 'ANONYMIZE' },
    // Bedrock's IP_ADDRESS detector is a model and missed 10.2.3.4 in a live test. This regex is deterministic.
  { name: 'IpAddress', description: 'IPv4 addresses', pattern: '\\b(?:[0-9]{1,3}\\.){3}[0-9]{1,3}\\b', action: 'ANONYMIZE' },
  { name: 'AwsAccountId', description: '12 digit AWS account ids', pattern: '\\b[0-9]{12}\\b', action: 'ANONYMIZE' },
    {
      name: 'ApiToken',
      description: 'GitHub, Slack, and OpenAI style tokens',
      pattern: '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})',
      action: 'ANONYMIZE',
    },
    { name: 'Jwt', description: 'JSON web tokens', pattern: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', action: 'ANONYMIZE' },
    { name: 'PrivateKey', description: 'PEM private key headers', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', action: 'ANONYMIZE' },
    {
      name: 'InternalHost',
      description: 'Internal hostnames',
      pattern: '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:internal|corp|local|lan|intranet)\\b',
      action: 'ANONYMIZE',
    },
];

export interface PipelineStackProps extends StackProps {
  config: AppConfig;
  rawBucket: s3.IBucket;
  alertTopic: sns.ITopic;
}

export class PipelineStack extends Stack {
  readonly table: dynamodb.Table;
  readonly stateMachine: sfn.StateMachine;
  readonly graveyardQueue: sqs.Queue;
  readonly guardrail: { id: string; version: string; arn: string };

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config, rawBucket, alertTopic } = props;

    // One table for published stories, graveyard records, and the running TOTALS item.
    this.table = new dynamodb.Table(this, 'Stories', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    this.graveyardQueue = new sqs.Queue(this, 'Graveyard', {
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const guardrailProps: bedrock.CfnGuardrailProps = {
      name: `${this.stackName}-moderation`,
      description: 'Blocks hate, sexual content, threats, and personal data in audience stories.',
      blockedInputMessaging: 'Blocked by moderation',
      blockedOutputsMessaging: 'Blocked by moderation',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          // Low so "my idiot coworker ran rm -rf" is not blocked. Tune before the talk if needed.
          { type: 'INSULTS', inputStrength: 'LOW', outputStrength: 'LOW' },
          { type: 'MISCONDUCT', inputStrength: 'LOW', outputStrength: 'LOW' },
          { type: 'PROMPT_ATTACK', inputStrength: 'MEDIUM', outputStrength: 'NONE' },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'Threats',
            type: 'DENY',
            definition: 'Statements threatening violence, harm, doxxing, or retaliation against a real person or group.',
            examples: ['I know where my manager lives and he will pay', 'Someone should hurt the person who wrote this code'],
          },
          {
            // Name masking cannot catch people identified by description.
            name: 'IdentifiablePerson',
            type: 'DENY',
            definition: 'Mocking, shaming, or harassing a specific real person who can be identified by their role, employer, appearance, or seat in the room, even without a name.',
            examples: [
              'Our CTO at Acme Corp cannot even read a stack trace',
              'The guy in the red hoodie in row 3 broke prod and lied about it',
              'Shoutout to the speaker, worst engineer I ever worked with',
            ],
          },
          {
            name: 'CompanyAccusation',
            type: 'DENY',
            definition: 'Claims that a specific named real company or employer was negligent, insecure, dishonest, or broke the law.',
            examples: [
              'Acme Bank stores every customer password in plaintext',
              'Initech leaked all its customer data and covered it up',
              'Do not trust Globex, their security team is a joke',
            ],
          },
          {
            // Output only: an audience member may joke about burnout, the model may not.
            name: 'SelfHarmJokes',
            type: 'DENY',
            definition: 'Jokes, humor, or flippant remarks about suicide, self-harm, or wanting to die.',
            examples: ['The on-call engineer considered jumping out the window', 'Action item: update the will. Owner: on-call.'],
            inputEnabled: false,
            outputEnabled: true,
          },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          'EMAIL',
          'PHONE',
          'ADDRESS',
          'US_SOCIAL_SECURITY_NUMBER',
          'CREDIT_DEBIT_CARD_NUMBER',
          'PASSWORD',
          'AWS_ACCESS_KEY',
          'AWS_SECRET_KEY',
        ]
          .map((type) => ({ type, action: 'BLOCK' }))
          // Names, handles, IPs, and links are masked, not blocked: the story still runs, but nobody
          // gets named on the projector. Apply Redactions swaps in the masked text before anything stores it.
          .concat(MASK_PII.map((type) => ({ type, action: 'ANONYMIZE' }))),
        regexesConfig: MASK_REGEXES,
      },
    };
    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', guardrailProps);
    const guardrailVersion = this.pinnedVersion('GuardrailVersion', guardrail, guardrailProps);

    // Masking only: names, links, and secrets become placeholders. Applied to the audience story
    // with source OUTPUT, since Bedrock Guardrails do not anonymize INPUT. Kept separate so the
    // main guardrail's output-only rules (like SelfHarmJokes) never judge audience text.
    const maskingProps: bedrock.CfnGuardrailProps = {
      name: `${this.stackName}-masking`,
      description: 'Masks names, handles, links, and secrets in audience stories.',
      blockedInputMessaging: 'Blocked by moderation',
      blockedOutputsMessaging: 'Blocked by moderation',
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: MASK_PII.map((type) => ({ type, action: 'ANONYMIZE' })),
        regexesConfig: MASK_REGEXES,
      },
    };
    const maskingGuardrail = new bedrock.CfnGuardrail(this, 'MaskingGuardrail', maskingProps);
    const maskingVersion = this.pinnedVersion('MaskingGuardrailVersion', maskingGuardrail, maskingProps);

    this.guardrail = { id: guardrail.attrGuardrailId, version: guardrailVersion.attrVersion, arn: guardrail.attrGuardrailArn };
    const common = { TABLE_NAME: this.table.tableName };
    const guardrailEnv = { GUARDRAIL_ID: guardrail.attrGuardrailId, GUARDRAIL_VERSION: guardrailVersion.attrVersion };
    const maskingEnv = { MASK_GUARDRAIL_ID: maskingGuardrail.attrGuardrailId, MASK_GUARDRAIL_VERSION: maskingVersion.attrVersion };

    const loadStory = new MonitoredFunction(this, 'LoadStory', {
      handler: 'load-story',
      description: 'Reads a raw story from S3 and checks it is usable',
      alarmTopic: alertTopic,
    });
    loadStory.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [rawBucket.arnForObjects('stories/*')] }));

    const moderate = new MonitoredFunction(this, 'Moderate', {
      handler: 'moderate',
      description: 'Runs the story through a Bedrock Guardrail',
      environment: { ...common, ...guardrailEnv, ...maskingEnv },
      timeout: Duration.seconds(20),
      alarmTopic: alertTopic,
    });
    moderate.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn, maskingGuardrail.attrGuardrailArn] }),
    );
    this.table.grant(moderate.fn, 'dynamodb:UpdateItem');

    const classify = new MonitoredFunction(this, 'Classify', {
      handler: 'classify',
      description: 'Classifies a story with Bedrock Converse',
      environment: { ...common, CLASSIFIER_MODEL_ID: config.classifierModelId },
      timeout: Duration.seconds(45),
      memorySize: 512,
      alarmTopic: alertTopic,
    });
    classify.fn.addToRolePolicy(invokeModelStatement(this, config.classifierModelId));
    this.table.grant(classify.fn, 'dynamodb:UpdateItem');

    const validate = new MonitoredFunction(this, 'Validate', {
      handler: 'validate',
      description: 'Validates classifier output against the zod schema',
      alarmTopic: alertTopic,
      // InvalidModelOutput is an expected, handled error. Only alarm on a burst of them.
      errorThreshold: 5,
    });

    const moderateOutput = new MonitoredFunction(this, 'ModerateOutput', {
      handler: 'moderate-output',
      description: 'Runs the model headline and root cause through the Guardrail',
      environment: { ...common, ...guardrailEnv },
      timeout: Duration.seconds(20),
      alarmTopic: alertTopic,
    });
    moderateOutput.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn] }),
    );
    this.table.grant(moderateOutput.fn, 'dynamodb:UpdateItem');

    this.stateMachine = new sfn.StateMachine(this, 'StoryPipeline', {
      stateMachineName: `${this.stackName}-story-pipeline`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      comment: 'Tech Horror Stories: load, moderate, classify, validate, publish or bury',
      definitionBody: sfn.DefinitionBody.fromChainable(
        buildPipelineDefinition(new Construct(this, 'States'), {
          fns: { loadStory: loadStory.fn, moderate: moderate.fn, classify: classify.fn, validate: validate.fn, moderateOutput: moderateOutput.fn },
          table: this.table,
          graveyardQueue: this.graveyardQueue,
        }),
      ),
      timeout: Duration.minutes(5),
    });

    // S3 Object Created (via EventBridge) starts one execution per story.
    new events.Rule(this, 'StorySubmitted', {
      description: 'Start the pipeline when a raw story lands in S3',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [rawBucket.bucketName] }, object: { key: [{ prefix: 'stories/' }] } },
      },
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          input: events.RuleTargetInput.fromObject({
            bucket: events.EventField.fromPath('$.detail.bucket.name'),
            key: events.EventField.fromPath('$.detail.object.key'),
          }),
          deadLetterQueue: this.graveyardQueue,
          retryAttempts: 3,
        }),
      ],
    });

    new CfnOutput(this, 'StoriesTableName', { value: this.table.tableName });
    new CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
  }

  /** A guardrail version is a snapshot. Key its logical id on the config so any change publishes a new one. */
  private pinnedVersion(id: string, guardrail: bedrock.CfnGuardrail, props: bedrock.CfnGuardrailProps) {
    const hash = createHash('sha256').update(JSON.stringify(props)).digest('hex').slice(0, 8);
    return new bedrock.CfnGuardrailVersion(this, `${id}${hash}`, {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `Pipeline snapshot ${hash}`,
    });
  }
}
