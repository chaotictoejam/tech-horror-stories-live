import { App, Tags } from 'aws-cdk-lib';
import { loadConfig, PREFIX } from '../config/app-config.js';
import { BoardStack } from '../lib/board-stack.js';
import { IngestionStack } from '../lib/ingestion-stack.js';
import { PipelineStack } from '../lib/pipeline-stack.js';

const app = new App();
const config = loadConfig(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const ingestion = new IngestionStack(app, `${PREFIX}Ingestion`, { env, config });
const pipeline = new PipelineStack(app, `${PREFIX}Pipeline`, {
  env,
  config,
  rawBucket: ingestion.rawBucket,
  alertTopic: ingestion.alertTopic,
});
new BoardStack(app, `${PREFIX}Board`, {
  env,
  config,
  table: pipeline.table,
  stateMachine: pipeline.stateMachine,
  submitApi: ingestion.api,
  alertTopic: ingestion.alertTopic,
});

Tags.of(app).add('project', 'tech-horror-stories');
