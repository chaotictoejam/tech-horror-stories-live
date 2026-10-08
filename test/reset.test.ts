import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearStories } from '../src/shared/reset.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const mock = mockClient(doc);
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `s-${from + i}` }));

beforeEach(() => mock.reset());

describe('clearStories', () => {
  it('deletes every item across pages in batches of 25, including TOTALS', async () => {
    mock
      .on(ScanCommand)
      .resolvesOnce({ Items: [...ids(30), { id: 'TOTALS' }], LastEvaluatedKey: { id: 's-29' } })
      .resolvesOnce({ Items: ids(10, 30) });
    mock.on(BatchWriteCommand).resolves({});
    expect(await clearStories(doc, 't')).toBe(41);
    const batches = mock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.t.length);
    expect(batches).toEqual([25, 6, 10]);
    const all = mock.commandCalls(BatchWriteCommand).flatMap((c) => c.args[0].input.RequestItems!.t.map((r: any) => r.DeleteRequest.Key.id));
    expect(all).toContain('TOTALS');
  });

  it('retries unprocessed deletes', async () => {
    mock.on(ScanCommand).resolves({ Items: ids(3) });
    mock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { t: [{ DeleteRequest: { Key: { id: 's-2' } } }] } })
      .resolves({});
    expect(await clearStories(doc, 't')).toBe(3);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it('handles an empty table', async () => {
    mock.on(ScanCommand).resolves({ Items: [] });
    expect(await clearStories(doc, 't')).toBe(0);
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});
