import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { converse } from '../shared/bedrock.js';
import { applyGuardrail } from '../shared/guardrail.js';
import { tokenCost } from '../shared/cost.js';
import { log } from '../shared/log.js';
import { buildPostmortemPrompt } from '../shared/prompt.js';
import { stripDashes } from '../shared/schema.js';
import { ddb, recordUsage } from '../shared/usage.js';

export const handler = async (input: { storyId: string }): Promise<void> => {
  const table = process.env.TABLE_NAME!;
  const model = process.env.POSTMORTEM_MODEL_ID!;
  const res = await ddb.send(new GetCommand({ TableName: table, Key: { id: input.storyId } }));
  const story = res.Item;
  if (!story || story.status !== 'published') return;

  try {
    const { system, user } = buildPostmortemPrompt(story.text ?? '', { category: story.category, fear_level: story.fear_level });
    // Generous max: newer models may spend part of the budget thinking before they write.
    const out = await converse({ modelId: model, system, user, maxTokens: 4000 });
    const cost = tokenCost(model, out.inputTokens, out.outputTokens);
    await recordUsage(table, { inputTokens: out.inputTokens, outputTokens: out.outputTokens, costUsd: cost });

    if (!out.text) throw new Error(`empty postmortem (stop reason ${out.stopReason})`);

    // The biggest block of model text on screen gets the same Guardrail as everything else.
    const review = await applyGuardrail(out.text, 'OUTPUT');
    if (review.blocked) {
      log.warn('postmortem blocked by guardrail', { storyId: input.storyId, policies: review.policies });
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { id: input.storyId },
          UpdateExpression: 'SET postmortem_status = :b',
          ExpressionAttributeValues: { ':b': 'blocked' },
        }),
      );
      return;
    }

    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: input.storyId },
        UpdateExpression:
          'SET postmortem = :t, postmortem_status = :d, postmortem_model = :m, postmortem_input_tokens = :i, postmortem_output_tokens = :o, postmortem_cost_usd = :c',
        ExpressionAttributeValues: {
          ':t': stripDashes(review.text),
          ':d': 'done',
          ':m': model,
          ':i': out.inputTokens,
          ':o': out.outputTokens,
          ':c': cost,
        },
      }),
    );
    log.info('postmortem written', { storyId: input.storyId, inputTokens: out.inputTokens, outputTokens: out.outputTokens });
  } catch (err) {
    log.error('postmortem failed', { storyId: input.storyId, error: (err as Error).name, message: (err as Error).message });
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: input.storyId },
        UpdateExpression: 'SET postmortem_status = :e',
        ExpressionAttributeValues: { ':e': 'error' },
      }),
    );
    // Rethrow so the error alarm fires. Async retries are off, so this does not re-bill.
    throw err;
  }
};
