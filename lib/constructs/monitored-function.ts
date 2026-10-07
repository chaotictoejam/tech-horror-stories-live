import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDLERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'handlers');

export interface MonitoredFunctionProps {
  /** File name in src/handlers, without extension. */
  handler: string;
  description: string;
  environment?: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
  /** Optional SNS topic notified when the error alarm fires. */
  alarmTopic?: sns.ITopic;
}

/**
 * A Node 22 Lambda bundled with esbuild, with a one-week log group and an alarm that fires
 * on any error in a 5 minute window. Every Lambda in the project uses this.
 */
export class MonitoredFunction extends Construct {
  readonly fn: nodejs.NodejsFunction;
  readonly errorAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: MonitoredFunctionProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new nodejs.NodejsFunction(this, 'Fn', {
      entry: path.join(HANDLERS_DIR, `${props.handler}.ts`),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      description: props.description,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(15),
      environment: { LOG_LEVEL: 'INFO', ...props.environment },
      logGroup,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        // Bundle the AWS SDK so we control the version (ApplyGuardrail, Converse).
        externalModules: [],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    this.errorAlarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmDescription: `Errors in ${props.handler}`,
      metric: this.fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (props.alarmTopic) {
      this.errorAlarm.addAlarmAction(new cwActions.SnsAction(props.alarmTopic));
    }
  }
}
