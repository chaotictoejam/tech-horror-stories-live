import { App, Tags } from 'aws-cdk-lib';
import { loadConfig, PREFIX } from '../config/app-config.js';
import { IngestionStack } from '../lib/ingestion-stack.js';

const app = new App();
const config = loadConfig(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

new IngestionStack(app, `${PREFIX}Ingestion`, { env, config });

Tags.of(app).add('project', 'tech-horror-stories');
