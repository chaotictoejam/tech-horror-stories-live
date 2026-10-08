import { BatchWriteCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Delete every item in the stories table: published stories, Graveyard records, cached
 * postmortems, and the TOTALS counter. Returns how many items were deleted.
 */
export async function clearStories(ddb: DynamoDBDocumentClient, table: string): Promise<number> {
  let deleted = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ProjectionExpression: 'id', ExclusiveStartKey }));
    const keys = (page.Items ?? []).map((i) => ({ id: i.id }));
    for (let i = 0; i < keys.length; i += 25) {
      let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      // DynamoDB may hand back unprocessed items under load: retry them with a short backoff.
      for (let attempt = 0; requests.length > 0; attempt++) {
        if (attempt > 5) throw new Error('DynamoDB kept returning unprocessed deletes');
        if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
        const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
        const left = (res.UnprocessedItems?.[table] ?? []) as typeof requests;
        deleted += requests.length - left.length;
        requests = left;
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return deleted;
}
