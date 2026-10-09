import { Duration } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';

export interface PipelineFunctions {
  loadStory: lambda.IFunction;
  moderate: lambda.IFunction;
  classify: lambda.IFunction;
  validate: lambda.IFunction;
  moderateOutput: lambda.IFunction;
}

export interface PipelineDefinitionProps {
  fns: PipelineFunctions;
  table: dynamodb.ITable;
  graveyardQueue: sqs.IQueue;
}

const TRANSIENT_ERRORS = [
  'Lambda.ServiceException',
  'Lambda.AWSLambdaException',
  'Lambda.SdkClientException',
  'Lambda.TooManyRequestsException',
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'InternalServerException',
];

// Patient retries: Haiku 4.5 allows 50 requests per minute and a new account allows 10 concurrent
// Lambdas, so a room-wide burst gets throttled. Waiting up to about a minute (3, 6, 12, 20, 20, 20
// seconds, with jitter so retries spread out) means a story arrives late instead of being buried.
const PATIENT_RETRY: sfn.RetryProps = {
  errors: TRANSIENT_ERRORS,
  maxAttempts: 6,
  interval: Duration.seconds(3),
  backoffRate: 2,
  maxDelay: Duration.seconds(20),
  jitterStrategy: sfn.JitterType.FULL,
};

const S = (path: string) => tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt(path));
// DynamoDB wants numbers as strings, so serialize with States.JsonToString.
const N = (path: string) => tasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt(path)));

/**
 * Build a Pass state that sets $.story to a Graveyard-ready shape with a fixed reason. `detail`
 * says what exactly went wrong (a literal, or a JSONPath into the state) and picks the board quip.
 */
function reasonState(
  scope: Construct,
  id: string,
  reason: string,
  opts: { keepText: boolean; fromExecution?: boolean; detail: string | { path: string } },
) {
  const detail = typeof opts.detail === 'string' ? { detail: opts.detail } : { 'detail.$': opts.detail.path };
  return new sfn.Pass(scope, id, {
    parameters: opts.fromExecution
      ? {
          'storyId.$': '$$.Execution.Name',
          'createdAt.$': '$$.Execution.StartTime',
          text: '',
          reason,
          ...detail,
        }
      : {
          'storyId.$': '$.story.storyId',
          'createdAt.$': '$.story.createdAt',
          ...(opts.keepText ? { 'text.$': '$.story.text' } : { text: '' }),
          reason,
          ...detail,
        },
    resultPath: '$.story',
  });
}

/**
 * Linear flow, no Map: one execution per story so each one can be opened in the console.
 * Every failure path ends in the Graveyard and a Succeed state, so bad input never fails an execution.
 */
export function buildPipelineDefinition(scope: Construct, props: PipelineDefinitionProps): sfn.IChainable {
  const { fns, table, graveyardQueue } = props;

  // Graveyard: queue message plus a board record, in parallel.
  const graveyard = new sfn.Parallel(scope, 'Send to Graveyard', { resultPath: sfn.JsonPath.DISCARD });
  graveyard.branch(
    new tasks.SqsSendMessage(scope, 'Queue for Review', {
      queue: graveyardQueue,
      messageBody: sfn.TaskInput.fromObject({
        storyId: sfn.JsonPath.stringAt('$.story.storyId'),
        reason: sfn.JsonPath.stringAt('$.story.reason'),
        detail: sfn.JsonPath.stringAt('$.story.detail'),
        execution: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    }),
  );
  graveyard.branch(
    new tasks.DynamoPutItem(scope, 'Record in Graveyard', {
      table,
      item: {
        id: S('$.story.storyId'),
        status: tasks.DynamoAttributeValue.fromString('graveyard'),
        createdAt: S('$.story.createdAt'),
        reason: S('$.story.reason'),
        detail: S('$.story.detail'),
        text: S('$.story.text'),
      },
      resultPath: sfn.JsonPath.DISCARD,
    }),
  );
  graveyard.next(new sfn.Succeed(scope, 'Rejected'));

  const unreadable = reasonState(scope, 'Reason: Unreadable Story', 'other', { keepText: false, fromExecution: true, detail: 'unreadable' }).next(graveyard);
  const moderationDown = reasonState(scope, 'Reason: Moderation Unavailable', 'other', { keepText: false, detail: 'moderation_down' }).next(graveyard);
  const redact = reasonState(scope, 'Redact Blocked Story', 'moderation_blocked', { keepText: false, detail: { path: '$.moderation.detail' } }).next(graveyard);
  const invalidOutput = reasonState(scope, 'Reason: Invalid Model Output', 'invalid_model_output', { keepText: true, detail: 'schema' }).next(graveyard);
  const pipelineError = reasonState(scope, 'Reason: Pipeline Error', 'other', { keepText: true, detail: 'error' }).next(graveyard);
  const notAStory = reasonState(scope, 'Reason: Not a Story', 'not_a_story', { keepText: false, detail: 'model' }).next(graveyard);
  const outputBlocked = reasonState(scope, 'Reason: Output Blocked', 'invalid_model_output', { keepText: true, detail: { path: '$.outputCheck.detail' } }).next(graveyard);

  const loadStory = new tasks.LambdaInvoke(scope, 'Load Story', {
    lambdaFunction: fns.loadStory,
    payloadResponseOnly: true,
    resultPath: '$.story',
    retryOnServiceExceptions: false,
  });
  loadStory.addRetry(PATIENT_RETRY);
  loadStory.addCatch(unreadable, { errors: ['States.ALL'], resultPath: '$.error' });

  const moderate = new tasks.LambdaInvoke(scope, 'Moderate', {
    lambdaFunction: fns.moderate,
    payloadResponseOnly: true,
    payload: sfn.TaskInput.fromObject({
      storyId: sfn.JsonPath.stringAt('$.story.storyId'),
      text: sfn.JsonPath.stringAt('$.story.text'),
    }),
    resultPath: '$.moderation',
    retryOnServiceExceptions: false,
  });
  moderate.addRetry(PATIENT_RETRY);
  moderate.addCatch(moderationDown, { errors: ['States.ALL'], resultPath: '$.error' });

  const classify = new tasks.LambdaInvoke(scope, 'Classify', {
    lambdaFunction: fns.classify,
    payloadResponseOnly: true,
    payload: sfn.TaskInput.fromObject({
      storyId: sfn.JsonPath.stringAt('$.story.storyId'),
      text: sfn.JsonPath.stringAt('$.story.text'),
    }),
    retryOnServiceExceptions: false,
  });
  classify.addRetry(PATIENT_RETRY);

  const validate = new tasks.LambdaInvoke(scope, 'Validate Output', {
    lambdaFunction: fns.validate,
    payloadResponseOnly: true,
    retryOnServiceExceptions: false,
  });
  validate.addRetry(PATIENT_RETRY);

  // Parallel with one branch: lets a single Retry re-run Classify and Validate together.
  const classifyAndValidate = new sfn.Parallel(scope, 'Classify and Validate', {
    resultSelector: {
      'category.$': '$[0].category',
      'fear_level.$': '$[0].fear_level',
      'root_cause.$': '$[0].root_cause',
      'survivable.$': '$[0].survivable',
      'is_story.$': '$[0].is_story',
      'one_liner.$': '$[0].one_liner',
      'model.$': '$[0].model',
      'input_tokens.$': '$[0].input_tokens',
      'output_tokens.$': '$[0].output_tokens',
      'cost_usd.$': '$[0].cost_usd',
    },
    resultPath: '$.verdict',
  });
  classifyAndValidate.branch(classify.next(validate));
  classifyAndValidate.addRetry({ errors: ['InvalidModelOutput'], maxAttempts: 2, interval: Duration.seconds(1), backoffRate: 1 });
  classifyAndValidate.addCatch(invalidOutput, { errors: ['InvalidModelOutput'], resultPath: '$.error' });
  classifyAndValidate.addCatch(pipelineError, { errors: ['States.ALL'], resultPath: '$.error' });

  const publish = new tasks.DynamoPutItem(scope, 'Publish to Board', {
    table,
    item: {
      id: S('$.story.storyId'),
      status: tasks.DynamoAttributeValue.fromString('published'),
      createdAt: S('$.story.createdAt'),
      text: S('$.story.text'),
      category: S('$.verdict.category'),
      fear_level: N('$.verdict.fear_level'),
      root_cause: S('$.outputCheck.root_cause'),
      survivable: tasks.DynamoAttributeValue.booleanFromJsonPath(sfn.JsonPath.stringAt('$.verdict.survivable')),
      one_liner: S('$.outputCheck.one_liner'),
      model: S('$.verdict.model'),
      input_tokens: N('$.verdict.input_tokens'),
      output_tokens: N('$.verdict.output_tokens'),
      cost_usd: N('$.verdict.cost_usd'),
      moderation_cost_usd: N('$.moderation.cost_usd'),
    },
    resultPath: sfn.JsonPath.DISCARD,
  });
  publish.addRetry({ errors: ['DynamoDB.ProvisionedThroughputExceededException', 'DynamoDB.InternalServerErrorException'], maxAttempts: 3 });
  publish.addCatch(pipelineError, { errors: ['States.ALL'], resultPath: '$.error' });

  // From here on the story carries the Guardrail's masked text, so names never reach the model,
  // the table, or the board.
  const applyRedactions = new sfn.Pass(scope, 'Apply Redactions', {
    parameters: {
      'storyId.$': '$.story.storyId',
      'createdAt.$': '$.story.createdAt',
      'usable.$': '$.story.usable',
      'text.$': '$.moderation.text',
    },
    resultPath: '$.story',
  });

  // The model's own words get moderated too before they go on the projector.
  const moderateOutput = new tasks.LambdaInvoke(scope, 'Moderate Output', {
    lambdaFunction: fns.moderateOutput,
    payloadResponseOnly: true,
    payload: sfn.TaskInput.fromObject({
      storyId: sfn.JsonPath.stringAt('$.story.storyId'),
      one_liner: sfn.JsonPath.stringAt('$.verdict.one_liner'),
      root_cause: sfn.JsonPath.stringAt('$.verdict.root_cause'),
    }),
    resultPath: '$.outputCheck',
    retryOnServiceExceptions: false,
  });
  moderateOutput.addRetry(PATIENT_RETRY);
  moderateOutput.addCatch(pipelineError, { errors: ['States.ALL'], resultPath: '$.error' });

  const outputPassed = new sfn.Choice(scope, 'Output Passed?')
    .when(sfn.Condition.booleanEquals('$.outputCheck.blocked', true), outputBlocked)
    .otherwise(publish.next(new sfn.Succeed(scope, 'Published')));

  // The classifier flags heckles and chatter. They skip the output check and go straight to the Graveyard.
  const isStory = new sfn.Choice(scope, 'Is It a Story?')
    .when(sfn.Condition.booleanEquals('$.verdict.is_story', false), notAStory)
    .otherwise(moderateOutput.next(outputPassed));

  const passedModeration = new sfn.Choice(scope, 'Passed Moderation?')
    .when(sfn.Condition.booleanEquals('$.moderation.blocked', true), redact)
    .otherwise(applyRedactions.next(classifyAndValidate).next(isStory));

  const usable = new sfn.Choice(scope, 'Is Story Usable?')
    .when(sfn.Condition.booleanEquals('$.story.usable', true), moderate.next(passedModeration))
    .otherwise(graveyard);

  return loadStory.next(usable);
}
