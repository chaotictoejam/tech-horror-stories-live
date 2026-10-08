import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './usage.js';

export interface StoryRow {
  id: string;
  status: 'published' | 'graveyard';
  createdAt: string;
  text?: string;
  category?: string;
  fear_level?: number;
  root_cause?: string;
  survivable?: boolean;
  one_liner?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  moderation_cost_usd?: number;
  reason?: string;
  detail?: string;
  postmortem_status?: string;
}

/** Newest first, up to `limit` rows of one status, from the byStatus index. */
export async function queryByStatus(table: string, status: StoryRow['status'], limit: number): Promise<StoryRow[]> {
  const rows: StoryRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
        ScanIndexForward: false,
        Limit: limit - rows.length,
        ExclusiveStartKey,
      }),
    );
    rows.push(...((res.Items ?? []) as StoryRow[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && rows.length < limit);
  return rows;
}

/** Highest fear level wins; ties go to the newest story. */
export function scariest(rows: StoryRow[], n: number): StoryRow[] {
  return [...rows]
    .sort((a, b) => (b.fear_level ?? 0) - (a.fear_level ?? 0) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, n);
}
