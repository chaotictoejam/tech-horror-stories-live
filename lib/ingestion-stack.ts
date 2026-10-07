import { Stack, type StackProps } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { AppConfig } from '../config/app-config.js';

export interface IngestionStackProps extends StackProps {
  config: AppConfig;
}

export class IngestionStack extends Stack {
  readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    // Shared alarm topic. Lambda error alarms in every stack publish here.
    this.alertTopic = new sns.Topic(this, 'AlertTopic', { displayName: 'Tech Horror Stories alerts', enforceSSL: true });
    if (props.config.alertEmail) {
      this.alertTopic.addSubscription(new subs.EmailSubscription(props.config.alertEmail));
    }
  }
}
