import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from './bedrock.js';
import { guardrailCost, guardrailUnits } from './cost.js';
import { recordUsage } from './usage.js';

export interface GuardrailVerdict {
  blocked: boolean;
  /** Policy names that blocked, for the execution history. Never the matched text. */
  policies: string[];
  /** How many names, links, hosts, or tokens were masked. */
  redactions: number;
  /** The text with masked spans replaced by friendly placeholders. Empty when blocked. */
  text: string;
  guardrail_units: number;
  cost_usd: number;
}

// Guardrail placeholders look like {NAME} or {AwsAccountId}. Show friendlier text on the board.
const PLACEHOLDERS: Record<string, string> = {
  NAME: '[name]',
  USERNAME: '[name]',
  Handle: '[name]',
  IP_ADDRESS: '[ip]',
  URL: '[link]',
  AwsAccountId: '[account id]',
  ApiToken: '[token]',
  Jwt: '[token]',
  PrivateKey: '[key]',
  InternalHost: '[host]',
};

export function friendlyPlaceholders(text: string): string {
  return text.replace(/\{([A-Za-z_]+)\}/g, (m, key: string) => PLACEHOLDERS[key] ?? '[redacted]');
}

export function summarize(res: ApplyGuardrailCommandOutput) {
  const policies = new Set<string>();
  let redactions = 0;
  for (const a of res.assessments ?? []) {
    const content = a.contentPolicy?.filters ?? [];
    const topics = a.topicPolicy?.topics ?? [];
    const pii = a.sensitiveInformationPolicy?.piiEntities ?? [];
    const regexes = a.sensitiveInformationPolicy?.regexes ?? [];
    const words = [...(a.wordPolicy?.customWords ?? []), ...(a.wordPolicy?.managedWordLists ?? [])];
    if (content.some((f) => f.action === 'BLOCKED')) policies.add('content');
    for (const t of topics) if (t.action === 'BLOCKED') policies.add(`topic:${t.name}`);
    if ([...pii, ...regexes].some((p) => p.action === 'BLOCKED')) policies.add('pii');
    if (words.some((w) => w.action === 'BLOCKED')) policies.add('words');
    redactions += [...pii, ...regexes].filter((p) => p.action === 'ANONYMIZED').length;
  }
  return { policies: [...policies], anyBlocked: policies.size > 0, redactions };
}

/**
 * Run text through the Guardrail, record its cost in the running totals, and decide.
 * Masking (names, links, tokens) is not a block: the masked text comes back to use instead.
 * Bedrock only masks when source is OUTPUT; with INPUT, anonymize rules are ignored.
 * An intervention we cannot explain as masking-only fails closed and counts as a block.
 */
export async function applyGuardrail(
  text: string,
  source: 'INPUT' | 'OUTPUT',
  target = { id: process.env.GUARDRAIL_ID!, version: process.env.GUARDRAIL_VERSION! },
): Promise<GuardrailVerdict> {
  const res = await bedrock.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: target.id,
      guardrailVersion: target.version,
      source,
      content: [{ text: { text } }],
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
  const blocked = intervened && (anyBlocked || redactions === 0 || !masked);
  return {
    blocked,
    policies,
    redactions,
    text: blocked ? '' : intervened ? friendlyPlaceholders(masked) : text,
    guardrail_units: units,
    cost_usd: cost,
  };
}
