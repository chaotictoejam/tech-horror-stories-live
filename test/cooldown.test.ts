import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { cooldownItem, deviceKey, tryAcquireCooldown } from '../src/shared/cooldown.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const ddbMock = mockClient(doc);

describe('deviceKey', () => {
  it('prefers a well formed device id', () => {
    const a = deviceKey({ deviceId: 'abcdef123456', ip: '1.1.1.1', userAgent: 'x' });
    const b = deviceKey({ deviceId: 'abcdef123456', ip: '2.2.2.2', userAgent: 'y' });
    expect(a).toBe(b);
  });

  it('falls back to ip and user agent when device id is junk', () => {
    const a = deviceKey({ deviceId: '<script>', ip: '1.1.1.1', userAgent: 'x' });
    const b = deviceKey({ ip: '1.1.1.1', userAgent: 'x' });
    expect(a).toBe(b);
    expect(a).not.toBe(deviceKey({ ip: '1.1.1.1', userAgent: 'z' }));
  });

  it('never contains the raw ip', () => {
    expect(deviceKey({ ip: '10.0.0.1', userAgent: 'x' })).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('cooldown window', () => {
  it('builds an item that expires after the window', () => {
    const item = cooldownItem('k', 1_000_000, 20);
    expect(item).toEqual({ pk: 'cooldown#k', expiresAt: 1020, ttl: 1080 });
  });
});

describe('tryAcquireCooldown', () => {
  beforeEach(() => ddbMock.reset());

  // Simulates DynamoDB's conditional write against an in-memory table.
  function fakeTable() {
    const rows = new Map<string, { expiresAt: number }>();
    ddbMock.on(PutCommand).callsFake((input) => {
      const existing = rows.get(input.Item.pk);
      const now = input.ExpressionAttributeValues[':now'];
      if (existing && existing.expiresAt > now) {
        throw new ConditionalCheckFailedException({ message: 'nope', $metadata: {} });
      }
      rows.set(input.Item.pk, { expiresAt: input.Item.expiresAt });
      return {};
    });
  }

  it('allows the first submission', async () => {
    fakeTable();
    expect(await tryAcquireCooldown(doc, 't', 'dev', 0, 20)).toBe(true);
  });

  it('blocks a second submission inside 20 seconds', async () => {
    fakeTable();
    await tryAcquireCooldown(doc, 't', 'dev', 0, 20);
    expect(await tryAcquireCooldown(doc, 't', 'dev', 19_000, 20)).toBe(false);
  });

  it('allows again once the window has passed', async () => {
    fakeTable();
    await tryAcquireCooldown(doc, 't', 'dev', 0, 20);
    expect(await tryAcquireCooldown(doc, 't', 'dev', 20_000, 20)).toBe(true);
  });

  it('keeps devices independent', async () => {
    fakeTable();
    await tryAcquireCooldown(doc, 't', 'a', 0, 20);
    expect(await tryAcquireCooldown(doc, 't', 'b', 1000, 20)).toBe(true);
  });

  it('sends a conditional write', async () => {
    fakeTable();
    await tryAcquireCooldown(doc, 't', 'dev', 0, 20);
    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.ConditionExpression).toContain('attribute_not_exists(pk)');
  });

  it('rethrows unexpected errors', async () => {
    ddbMock.on(PutCommand).rejects(new Error('throttled'));
    await expect(tryAcquireCooldown(doc, 't', 'dev', 0, 20)).rejects.toThrow('throttled');
  });
});
