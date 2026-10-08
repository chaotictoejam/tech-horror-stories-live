import { applyGuardrail } from '../shared/guardrail.js';
import { log } from '../shared/log.js';

export interface ModerateOutputInput {
  storyId: string;
  one_liner: string;
  root_cause: string;
}

export interface ModerateOutputResult {
  blocked: boolean;
  policies: string[];
  /** Why the model's text was blocked, prefixed with "output:". Empty if not blocked. */
  detail: string;
  one_liner: string;
  root_cause: string;
  guardrail_units: number;
  cost_usd: number;
}

// Both fields go through one Guardrail call, then get split back apart.
const SEPARATOR = '\n\n';

/** Moderates what the model wrote before it goes on the board. */
export const handler = async (input: ModerateOutputInput): Promise<ModerateOutputResult> => {
  const verdict = await applyGuardrail(`${input.one_liner}${SEPARATOR}${input.root_cause}`, 'OUTPUT');
  const parts = verdict.text.split(SEPARATOR);
  // If masking changed the shape of the text, fail closed rather than publish a mangled headline.
  const blocked = verdict.blocked || parts.length !== 2;
  log.info('moderated output', { storyId: input.storyId, blocked, policies: verdict.policies, redactions: verdict.redactions });
  return {
    blocked,
    policies: verdict.policies,
    detail: blocked ? `output:${verdict.detail || 'unknown'}` : '',
    one_liner: blocked ? '' : parts[0].trim(),
    root_cause: blocked ? '' : parts[1].trim(),
    guardrail_units: verdict.guardrail_units,
    cost_usd: verdict.cost_usd,
  };
};
