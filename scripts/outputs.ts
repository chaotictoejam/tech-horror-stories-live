import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { existsSync, readFileSync } from 'node:fs';
import { PREFIX } from '../config/app-config.js';

export interface DeployedOutputs {
  submitUrl: string;
  boardUrl: string;
  configTable: string;
  stateMachineConsoleUrl?: string;
}

/** Read stack outputs from cdk-outputs.json (written by npm run deploy), or from CloudFormation. */
export async function loadOutputs(): Promise<DeployedOutputs> {
  let all: Record<string, Record<string, string>> = {};
  if (existsSync('cdk-outputs.json')) {
    all = JSON.parse(readFileSync('cdk-outputs.json', 'utf8'));
  } else {
    const cfn = new CloudFormationClient({});
    for (const name of ['Ingestion', 'Board']) {
      const res = await cfn.send(new DescribeStacksCommand({ StackName: `${PREFIX}${name}` }));
      all[`${PREFIX}${name}`] = Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
    }
  }
  const board = all[`${PREFIX}Board`] ?? {};
  const ingestion = all[`${PREFIX}Ingestion`] ?? {};
  if (!board.SubmitUrl) throw new Error('No deployed outputs found. Run npm run deploy first.');
  return {
    submitUrl: board.SubmitUrl,
    boardUrl: board.BoardUrl,
    configTable: ingestion.ConfigTableName,
    stateMachineConsoleUrl: board.StateMachineConsoleUrl,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const arg = (name: string) => process.argv.includes(`--${name}`);
export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
