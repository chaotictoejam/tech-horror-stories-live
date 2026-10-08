import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESENTER_KEY_PARAM, type AppConfig } from '../config/app-config.js';
import { invokeModelStatement } from './bedrock-iam.js';
import { MonitoredFunction } from './constructs/monitored-function.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

export interface BoardStackProps extends StackProps {
  config: AppConfig;
  table: dynamodb.ITable;
  stateMachine: sfn.IStateMachine;
  submitApi: apigw.IHttpApi;
  alertTopic: sns.ITopic;
  guardrail: { id: string; arn: string };
}

export class BoardStack extends Stack {
  constructor(scope: Construct, id: string, props: BoardStackProps) {
    super(scope, id, props);
    const { config, table, stateMachine, submitApi, alertTopic, guardrail } = props;

    // ---------- Read API and postmortem ----------
    const board = new MonitoredFunction(this, 'Board', {
      handler: 'board',
      description: 'Feed, leaderboard, graveyard, and totals for the live board',
      environment: { TABLE_NAME: table.tableName, STATE_MACHINE_ARN: stateMachine.stateMachineArn },
      memorySize: 512,
      alarmTopic: alertTopic,
    });
    table.grant(board.fn, 'dynamodb:Query', 'dynamodb:GetItem');
    board.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:ListExecutions'], resources: [stateMachine.stateMachineArn] }));

    const worker = new MonitoredFunction(this, 'PostmortemWorker', {
      handler: 'postmortem-worker',
      description: 'Writes a blameless postmortem with the larger Bedrock model',
      environment: {
        TABLE_NAME: table.tableName,
        POSTMORTEM_MODEL_ID: config.postmortemModelId,
        GUARDRAIL_ID: guardrail.id,
        // DRAFT always matches the deployed guardrail config. Importing the pinned version from the
        // pipeline stack would create an export that blocks the next guardrail change.
        GUARDRAIL_VERSION: 'DRAFT',
      },
      timeout: Duration.minutes(2),
      memorySize: 512,
      alarmTopic: alertTopic,
    });
    worker.fn.configureAsyncInvoke({ retryAttempts: 0 });
    worker.fn.addToRolePolicy(invokeModelStatement(this, config.postmortemModelId));
    worker.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.arn] }));
    table.grant(worker.fn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');

    const presenterParamArn = this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PRESENTER_KEY_PARAM.slice(1) });
    const postmortem = new MonitoredFunction(this, 'Postmortem', {
      handler: 'postmortem-api',
      description: 'Starts and reports postmortems. POST requires the presenter key',
      environment: {
        TABLE_NAME: table.tableName,
        WORKER_FUNCTION: worker.fn.functionName,
        PRESENTER_KEY_PARAM,
      },
      alarmTopic: alertTopic,
    });
    table.grant(postmortem.fn, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    worker.fn.grantInvoke(postmortem.fn);
    postmortem.fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [presenterParamArn] }));

    const api = new apigw.HttpApi(this, 'BoardApi', { createDefaultStage: false, description: 'Board reads and postmortems' });
    const routes = [
      ...api.addRoutes({ path: '/api/board', methods: [apigw.HttpMethod.GET], integration: new integrations.HttpLambdaIntegration('BoardIntegration', board.fn) }),
      ...api.addRoutes({
        path: '/api/postmortem',
        methods: [apigw.HttpMethod.POST],
        integration: new integrations.HttpLambdaIntegration('PostmortemStart', postmortem.fn),
      }),
      ...api.addRoutes({
        path: '/api/postmortem/{id}',
        methods: [apigw.HttpMethod.GET],
        integration: new integrations.HttpLambdaIntegration('PostmortemStatus', postmortem.fn),
      }),
    ];
    const stage = new apigw.HttpStage(this, 'BoardStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 30, burstLimit: 60 },
    });
    // The expensive route gets its own tight limit.
    (stage.node.defaultChild as apigw.CfnStage).addPropertyOverride('RouteSettings', {
      'POST /api/postmortem': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
    });
    routes.forEach((r) => stage.node.addDependency(r));

    // ---------- Hosting: one CloudFront domain for pages and both APIs ----------
    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const apiOriginRequest = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequest', {
      comment: 'Forward what the APIs need, including the real viewer IP',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('User-Agent', 'Content-Type', 'X-Presenter-Key', 'CloudFront-Viewer-Address'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    const apiDomain = (a: apigw.IHttpApi) => Fn.select(2, Fn.split('/', a.apiEndpoint));
    const apiBehavior = (a: apigw.IHttpApi): cloudfront.BehaviorOptions => ({
      origin: new origins.HttpOrigin(apiDomain(a), { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: apiOriginRequest,
      responseHeadersPolicy: securityHeaders,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Tech Horror Stories',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        '/api/stories': apiBehavior(submitApi),
        '/api/*': apiBehavior(api),
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(WEB_DIR)],
      destinationBucket: site,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 256,
    });

    new CfnOutput(this, 'SubmitUrl', { value: `https://${distribution.distributionDomainName}/` });
    new CfnOutput(this, 'BoardUrl', { value: `https://${distribution.distributionDomainName}/board.html` });
    new CfnOutput(this, 'StateMachineConsoleUrl', {
      value: `https://${this.region}.console.aws.amazon.com/states/home?region=${this.region}#/statemachines/view/${stateMachine.stateMachineArn}`,
    });
  }
}
