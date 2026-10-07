import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
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
import type { AppConfig } from '../config/app-config.js';
import { invokeModelStatement } from './bedrock-iam.js';
import { MonitoredFunction } from './constructs/monitored-function.js';
import { buildPipelineDefinition } from './state-machine.js';

export interface PipelineStackProps extends StackProps {
  config: AppConfig;
  rawBucket: s3.IBucket;
  alertTopic: sns.ITopic;
}

export class PipelineStack extends Stack {
  readonly table: dynamodb.Table;
  readonly stateMachine: sfn.StateMachine;
  readonly graveyardQueue: sqs.Queue;

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

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
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
        ].map((type) => ({ type, action: 'BLOCK' })),
      },
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Pinned version used by the pipeline',
    });

    const common = { TABLE_NAME: this.table.tableName };

    const loadStory = new MonitoredFunction(this, 'LoadStory', {
      handler: 'load-story',
      description: 'Reads a raw story from S3 and checks it is usable',
      alarmTopic: alertTopic,
    });
    loadStory.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [rawBucket.arnForObjects('stories/*')] }));

    const moderate = new MonitoredFunction(this, 'Moderate', {
      handler: 'moderate',
      description: 'Runs the story through a Bedrock Guardrail',
      environment: { ...common, GUARDRAIL_ID: guardrail.attrGuardrailId, GUARDRAIL_VERSION: guardrailVersion.attrVersion },
      timeout: Duration.seconds(20),
      alarmTopic: alertTopic,
    });
    moderate.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn] }),
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

    this.stateMachine = new sfn.StateMachine(this, 'StoryPipeline', {
      stateMachineName: `${this.stackName}-story-pipeline`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      comment: 'Tech Horror Stories: load, moderate, classify, validate, publish or bury',
      definitionBody: sfn.DefinitionBody.fromChainable(
        buildPipelineDefinition(new Construct(this, 'States'), {
          fns: { loadStory: loadStory.fn, moderate: moderate.fn, classify: classify.fn, validate: validate.fn },
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
  }
}
