import { ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from '../shared/bedrock.js';
import { guardrailCost, guardrailUnits } from '../shared/cost.js';
import { log } from '../shared/log.js';
import { recordUsage } from '../shared/usage.js';

export interface ModerateInput {
  storyId: string;
  text: string;
}

export interface ModerateOutput {
  blocked: boolean;
  /** Policy names that fired, for the execution history. Never the matched text. */
  policies: string[];
  guardrail_units: number;
  cost_usd: number;
}

export const handler = async (input: ModerateInput): Promise<ModerateOutput> => {
  const res = await bedrock.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: process.env.GUARDRAIL_ID!,
      guardrailVersion: process.env.GUARDRAIL_VERSION!,
      source: 'INPUT',
      content: [{ text: { text: input.text } }],
      outputScope: 'INTERVENTIONS',
    }),
  );

  const usage = res.usage ?? {};
  const units = guardrailUnits(usage);
  const cost = guardrailCost(usage);
  await recordUsage(process.env.TABLE_NAME!, { costUsd: cost, guardrailUnits: units });

  const policies = new Set<string>();
  for (const a of res.assessments ?? []) {
    if (a.contentPolicy?.filters?.some((f) => f.action === 'BLOCKED')) policies.add('content');
    if (a.topicPolicy?.topics?.some((t) => t.action === 'BLOCKED')) policies.add('topic');
    if (a.sensitiveInformationPolicy?.piiEntities?.some((p) => p.action === 'BLOCKED')) policies.add('pii');
    if (a.sensitiveInformationPolicy?.regexes?.some((r) => r.action === 'BLOCKED')) policies.add('pii');
    if (a.wordPolicy?.customWords?.length || a.wordPolicy?.managedWordLists?.length) policies.add('words');
  }

  const blocked = res.action === 'GUARDRAIL_INTERVENED';
  log.info('moderated', { storyId: input.storyId, blocked, policies: [...policies], units });
  return { blocked, policies: [...policies], guardrail_units: units, cost_usd: cost };
};
