import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';

/**
 * A device is identified by the random id the submit page keeps in localStorage. Without it we
 * fall back to a hash of IP and user agent. Only the hash is stored, never the raw values.
 */
export function deviceKey(input: { deviceId?: string; ip?: string; userAgent?: string }, salt = ''): string {
  const id = input.deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(input.deviceId) ? `d:${input.deviceId}` : `n:${input.ip ?? ''}|${input.userAgent ?? ''}`;
  return createHash('sha256').update(salt).update(id).digest('hex').slice(0, 32);
}

export function cooldownItem(key: string, nowMs: number, seconds: number) {
  const expiresAt = Math.floor(nowMs / 1000) + seconds;
  return { pk: `cooldown#${key}`, expiresAt, ttl: expiresAt + 60 };
}

/**
 * Returns true if the device may submit now. Uses a conditional write so two requests from the
 * same device racing each other cannot both pass. TTL cleans the items up later; the
 * expiresAt comparison is what actually enforces the window.
 */
export async function tryAcquireCooldown(
  ddb: DynamoDBDocumentClient,
  table: string,
  key: string,
  nowMs: number,
  seconds: number,
): Promise<boolean> {
  const item = cooldownItem(key, nowMs, seconds);
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
        ExpressionAttributeValues: { ':now': Math.floor(nowMs / 1000) },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || (err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
