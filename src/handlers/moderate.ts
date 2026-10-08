import { applyGuardrail, type GuardrailVerdict } from '../shared/guardrail.js';
import { log } from '../shared/log.js';

export interface ModerateInput {
  storyId: string;
  text: string;
}

export type ModerateOutput = GuardrailVerdict;

/**
 * Moderates what the audience wrote, in two passes:
 * 1. The main guardrail with source INPUT decides whether the story is blocked.
 * 2. The masking guardrail with source OUTPUT masks names, links, and secrets. Bedrock Guardrails
 *    only anonymize on OUTPUT, so this pass is what actually removes "Kevin" from the story.
 */
export const handler = async (input: ModerateInput): Promise<ModerateOutput> => {
  const verdict = await applyGuardrail(input.text, 'INPUT');
  if (verdict.blocked) {
    log.info('moderated input', { storyId: input.storyId, blocked: true, policies: verdict.policies });
    return verdict;
  }

  const masked = await applyGuardrail(input.text, 'OUTPUT', {
    id: process.env.MASK_GUARDRAIL_ID!,
    version: process.env.MASK_GUARDRAIL_VERSION!,
  });
  // The masking guardrail has no block rules, so a block here is unexplained: fail closed.
  const blocked = masked.blocked;
  const result: ModerateOutput = {
    blocked,
    policies: blocked ? ['masking'] : verdict.policies,
    detail: blocked ? 'unknown' : '',
    redactions: masked.redactions,
    text: blocked ? '' : masked.text,
    guardrail_units: verdict.guardrail_units + masked.guardrail_units,
    cost_usd: Math.round((verdict.cost_usd + masked.cost_usd) * 1e6) / 1e6,
  };
  log.info('moderated input', { storyId: input.storyId, blocked, policies: result.policies, redactions: result.redactions });
  return result;
};
