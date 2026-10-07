import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';
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
  /** How many names, usernames, or handles were masked. */
  redactions: number;
  /** The story with names masked as [name]. Empty when blocked. */
  text: string;
  guardrail_units: number;
  cost_usd: number;
}

// Guardrail placeholders look like {NAME}. Show something friendlier on the board.
const PLACEHOLDERS: Record<string, string> = { NAME: '[name]', USERNAME: '[name]', Handle: '[name]' };

export function friendlyPlaceholders(text: string): string {
  return text.replace(/\{([A-Za-z_]+)\}/g, (m, key: string) => PLACEHOLDERS[key] ?? m);
}

export function summarize(res: ApplyGuardrailCommandOutput) {
  const policies = new Set<string>();
  let anyBlocked = false;
  let redactions = 0;
  for (const a of res.assessments ?? []) {
    const content = a.contentPolicy?.filters ?? [];
    const topics = a.topicPolicy?.topics ?? [];
    const pii = a.sensitiveInformationPolicy?.piiEntities ?? [];
    const regexes = a.sensitiveInformationPolicy?.regexes ?? [];
    const words = [...(a.wordPolicy?.customWords ?? []), ...(a.wordPolicy?.managedWordLists ?? [])];
    if (content.some((f) => f.action === 'BLOCKED')) policies.add('content');
    if (topics.some((t) => t.action === 'BLOCKED')) policies.add('topic');
    if ([...pii, ...regexes].some((p) => p.action === 'BLOCKED')) policies.add('pii');
    if (words.some((w) => w.action === 'BLOCKED')) policies.add('words');
    anyBlocked ||= policies.size > 0;
    redactions += [...pii, ...regexes].filter((p) => p.action === 'ANONYMIZED').length;
  }
  return { policies: [...policies], anyBlocked, redactions };
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

  const { policies, anyBlocked, redactions } = summarize(res);
  const intervened = res.action === 'GUARDRAIL_INTERVENED';
  const masked = res.outputs?.map((o) => o.text ?? '').join('') ?? '';

  // Fail closed: an intervention we cannot explain as masking-only counts as a block.
  const blocked = intervened && (anyBlocked || redactions === 0 || !masked);
  const text = blocked ? '' : intervened ? friendlyPlaceholders(masked) : input.text;

  log.info('moderated', { storyId: input.storyId, blocked, policies, redactions, units });
  return { blocked, policies, redactions, text, guardrail_units: units, cost_usd: cost };
};
