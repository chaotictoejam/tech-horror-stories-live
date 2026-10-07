import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TOTALS_ID = 'TOTALS';

/**
 * Add one model or guardrail call to the running totals the board shows. Called right after
 * every Bedrock call, including retries, so the counter reflects real spend.
 */
export async function recordUsage(
  table: string,
  u: { inputTokens?: number; outputTokens?: number; costUsd: number; guardrailUnits?: number },
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: { id: TOTALS_ID },
      UpdateExpression: 'ADD input_tokens :i, output_tokens :o, cost_usd :c, guardrail_units :g, model_calls :one',
      ExpressionAttributeValues: {
        ':i': u.inputTokens ?? 0,
        ':o': u.outputTokens ?? 0,
        ':c': u.costUsd,
        ':g': u.guardrailUnits ?? 0,
        ':one': 1,
      },
    }),
  );
}
