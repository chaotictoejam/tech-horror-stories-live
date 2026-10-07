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

const S = (path: string) => tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt(path));
// DynamoDB wants numbers as strings, so serialize with States.JsonToString.
const N = (path: string) => tasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt(path)));

/** Build a Pass state that sets $.story to a Graveyard-ready shape with a fixed reason. */
function reasonState(scope: Construct, id: string, reason: string, opts: { keepText: boolean; fromExecution?: boolean }) {
  return new sfn.Pass(scope, id, {
    parameters: opts.fromExecution
      ? {
          'storyId.$': '$$.Execution.Name',
          'createdAt.$': '$$.Execution.StartTime',
          text: '',
          reason,
        }
      : {
          'storyId.$': '$.story.storyId',
          'createdAt.$': '$.story.createdAt',
          ...(opts.keepText ? { 'text.$': '$.story.text' } : { text: '' }),
          reason,
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
        text: S('$.story.text'),
      },
      resultPath: sfn.JsonPath.DISCARD,
    }),
  );
  graveyard.next(new sfn.Succeed(scope, 'Rejected'));

  const unreadable = reasonState(scope, 'Reason: Unreadable Story', 'other', { keepText: false, fromExecution: true }).next(graveyard);
  const moderationDown = reasonState(scope, 'Reason: Moderation Unavailable', 'other', { keepText: false }).next(graveyard);
  const redact = reasonState(scope, 'Redact Blocked Story', 'moderation_blocked', { keepText: false }).next(graveyard);
  const invalidOutput = reasonState(scope, 'Reason: Invalid Model Output', 'invalid_model_output', { keepText: true }).next(graveyard);
  const pipelineError = reasonState(scope, 'Reason: Pipeline Error', 'other', { keepText: true }).next(graveyard);

  const loadStory = new tasks.LambdaInvoke(scope, 'Load Story', {
    lambdaFunction: fns.loadStory,
    payloadResponseOnly: true,
    resultPath: '$.story',
    retryOnServiceExceptions: false,
  });
  loadStory.addRetry({ errors: TRANSIENT_ERRORS, maxAttempts: 3, interval: Duration.seconds(1), backoffRate: 2 });
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
  moderate.addRetry({ errors: TRANSIENT_ERRORS, maxAttempts: 3, interval: Duration.seconds(1), backoffRate: 2 });
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
  classify.addRetry({ errors: TRANSIENT_ERRORS, maxAttempts: 3, interval: Duration.seconds(2), backoffRate: 2 });

  const validate = new tasks.LambdaInvoke(scope, 'Validate Output', {
    lambdaFunction: fns.validate,
    payloadResponseOnly: true,
    retryOnServiceExceptions: false,
  });

  // Parallel with one branch: lets a single Retry re-run Classify and Validate together.
  const classifyAndValidate = new sfn.Parallel(scope, 'Classify and Validate', {
    resultSelector: {
      'category.$': '$[0].category',
      'fear_level.$': '$[0].fear_level',
      'root_cause.$': '$[0].root_cause',
      'survivable.$': '$[0].survivable',
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
      root_cause: S('$.verdict.root_cause'),
      survivable: tasks.DynamoAttributeValue.booleanFromJsonPath(sfn.JsonPath.stringAt('$.verdict.survivable')),
      one_liner: S('$.verdict.one_liner'),
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

  const passedModeration = new sfn.Choice(scope, 'Passed Moderation?')
    .when(sfn.Condition.booleanEquals('$.moderation.blocked', true), redact)
    .otherwise(applyRedactions.next(classifyAndValidate).next(publish).next(new sfn.Succeed(scope, 'Published')));

  const usable = new sfn.Choice(scope, 'Is Story Usable?')
    .when(sfn.Condition.booleanEquals('$.story.usable', true), moderate.next(passedModeration))
    .otherwise(graveyard);

  return loadStory.next(usable);
}
