import { CfnOutput, Duration, Names, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { AppConfig } from '../../config/app-config.js';
import { MonitoredFunction } from './constructs/monitored-function.js';

export interface IngestionStackProps extends StackProps {
  config: AppConfig;
}

export class IngestionStack extends Stack {
  readonly alertTopic: sns.Topic;
  readonly rawBucket: s3.Bucket;
  readonly configTable: dynamodb.Table;
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Shared alarm topic. Lambda error alarms in every stack publish here.
    this.alertTopic = new sns.Topic(this, 'AlertTopic', { displayName: 'Tech Horror Stories alerts', enforceSSL: true });
    if (config.alertEmail) {
      this.alertTopic.addSubscription(new subs.EmailSubscription(config.alertEmail));
    }

    // Raw stories land here. EventBridge notifications start the pipeline. Objects expire after a day.
    this.rawBucket = new s3.Bucket(this, 'RawStories', {
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(1) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Kill switch item and per-device cooldown items. Cooldowns expire through TTL.
    this.configTable = new dynamodb.Table(this, 'Config', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const submit = new MonitoredFunction(this, 'Submit', {
      handler: 'submit',
      description: 'Accepts a story, enforces kill switch and cooldown, writes it to S3',
      environment: {
        CONFIG_TABLE: this.configTable.tableName,
        RAW_BUCKET: this.rawBucket.bucketName,
        COOLDOWN_SALT: Names.uniqueId(this),
      },
      timeout: Duration.seconds(10),
      alarmTopic: this.alertTopic,
    });
    submit.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [this.rawBucket.arnForObjects('stories/*')] }));
    this.configTable.grant(submit.fn, 'dynamodb:GetItem', 'dynamodb:PutItem');

    this.api = new apigw.HttpApi(this, 'SubmitApi', { createDefaultStage: false, description: 'Story submission' });
    new apigw.HttpStage(this, 'SubmitStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      // Room-wide limit. Per-device limits are the 20 second cooldown.
      throttle: { rateLimit: 20, burstLimit: 40 },
    });
    this.api.addRoutes({
      path: '/api/stories',
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('SubmitIntegration', submit.fn),
    });

    // Monthly cost budget. Alerts at 80% actual and 100% forecast.
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        resources: [this.alertTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    const subscribers = [
      { subscriptionType: 'SNS', address: this.alertTopic.topicArn },
      ...(config.alertEmail ? [{ subscriptionType: 'EMAIL', address: config.alertEmail }] : []),
    ];
    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `${this.stackName}-budget`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers },
      ],
    });

    new CfnOutput(this, 'ConfigTableName', { value: this.configTable.tableName });
    new CfnOutput(this, 'SubmitApiEndpoint', { value: this.api.apiEndpoint });
  }
}
