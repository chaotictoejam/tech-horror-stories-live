import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

// Regions each cross-region inference profile prefix can route to. Update if AWS adds regions.
const PROFILE_REGIONS: Record<string, string[]> = {
  us: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
  eu: ['eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-2', 'eu-west-3'],
  apac: ['ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-4'],
};

/**
 * Least-privilege InvokeModel statement for one model ID. Handles plain foundation model IDs and
 * cross-region inference profile IDs (us., eu., apac., global.). A global. profile can route to any
 * commercial region, so only that case uses a region wildcard, still scoped to one model.
 */
export function invokeModelStatement(stack: Stack, modelId: string): iam.PolicyStatement {
  const match = /^(us|eu|apac|global)\.(.+)$/.exec(modelId);
  const resources: string[] = [];
  if (!match) {
    resources.push(`arn:${stack.partition}:bedrock:${stack.region}::foundation-model/${modelId}`);
  } else {
    const [, prefix, foundation] = match;
    resources.push(`arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`);
    const regions = prefix === 'global' ? ['*'] : PROFILE_REGIONS[prefix];
    for (const r of regions) resources.push(`arn:${stack.partition}:bedrock:${r}::foundation-model/${foundation}`);
  }
  return new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources });
}
