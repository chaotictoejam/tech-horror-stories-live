import { converse } from '../shared/bedrock.js';
import { tokenCost } from '../shared/cost.js';
import { log } from '../shared/log.js';
import { buildClassifierPrompt } from '../shared/prompt.js';
import { recordUsage } from '../shared/usage.js';

export interface ClassifyInput {
  storyId: string;
  text: string;
}

export interface ClassifyOutput {
  raw: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export const handler = async (input: ClassifyInput): Promise<ClassifyOutput> => {
  const model = process.env.CLASSIFIER_MODEL_ID!;
  const { system, user } = buildClassifierPrompt(input.text);
  const res = await converse({ modelId: model, system, user, maxTokens: 300 });
  const cost = tokenCost(model, res.inputTokens, res.outputTokens);

  // Record spend before validation, so retries that produce bad output still count.
  await recordUsage(process.env.TABLE_NAME!, { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost });
  log.info('classified', { storyId: input.storyId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, stopReason: res.stopReason });
  log.debug('raw model output', { raw: res.text });

  return { raw: res.text, model, input_tokens: res.inputTokens, output_tokens: res.outputTokens, cost_usd: cost };
};
