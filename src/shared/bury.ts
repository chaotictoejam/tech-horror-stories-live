import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Presenter takedown. A published story moves to the Graveyard as "removed"; a Graveyard entry
 * has its reason switched to "removed" so its text is hidden. The original text and reason are
 * kept so restore() can undo it. The board API never sends text for removed stories.
 */
export async function bury(ddb: DynamoDBDocumentClient, table: string, id: string): Promise<'buried' | 'already' | 'missing'> {
  const item = (await ddb.send(new GetCommand({ TableName: table, Key: { id } }))).Item;
  if (!item || id === 'TOTALS') return 'missing';
  if (item.reason === 'removed') return 'already';

  const now = new Date().toISOString();
  if (item.status === 'published') {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id },
        UpdateExpression: 'SET #s = :g, reason = :r, removed_from = :p, removed_at = :now',
        ConditionExpression: '#s = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':g': 'graveyard', ':r': 'removed', ':p': 'published', ':now': now },
      }),
    );
  } else {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id },
        UpdateExpression: 'SET reason = :r, prev_reason = :old, removed_from = :g, removed_at = :now',
        ConditionExpression: '#s = :g AND reason = :old',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':r': 'removed', ':old': item.reason ?? 'other', ':g': 'graveyard', ':now': now },
      }),
    );
  }
  return 'buried';
}

export async function restore(ddb: DynamoDBDocumentClient, table: string, id: string): Promise<'restored' | 'not-removed'> {
  const item = (await ddb.send(new GetCommand({ TableName: table, Key: { id } }))).Item;
  if (!item || item.reason !== 'removed') return 'not-removed';

  if (item.removed_from === 'published') {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id },
        UpdateExpression: 'SET #s = :p REMOVE reason, removed_from, removed_at',
        ConditionExpression: 'reason = :r',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':p': 'published', ':r': 'removed' },
      }),
    );
  } else {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id },
        UpdateExpression: 'SET reason = :old REMOVE prev_reason, removed_from, removed_at',
        ConditionExpression: 'reason = :r',
        ExpressionAttributeValues: { ':old': item.prev_reason ?? 'other', ':r': 'removed' },
      }),
    );
  }
  return 'restored';
}
