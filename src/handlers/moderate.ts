import { applyGuardrail, type GuardrailVerdict } from '../shared/guardrail.js';
import { log } from '../shared/log.js';

export interface ModerateInput {
  storyId: string;
  text: string;
}

export type ModerateOutput = GuardrailVerdict;

/** Moderates what the audience wrote. Names, links, and secrets come back masked. */
export const handler = async (input: ModerateInput): Promise<ModerateOutput> => {
  const verdict = await applyGuardrail(input.text, 'INPUT');
  log.info('moderated input', { storyId: input.storyId, blocked: verdict.blocked, policies: verdict.policies, redactions: verdict.redactions });
  return verdict;
};
