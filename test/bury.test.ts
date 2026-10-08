import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { bury, restore } from '../src/shared/bury.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const mock = mockClient(doc);
const lastUpdate = () => mock.commandCalls(UpdateCommand).at(-1)!.args[0].input;

beforeEach(() => {
  mock.reset();
  mock.on(UpdateCommand).resolves({});
});

describe('bury', () => {
  it('moves a published story to the Graveyard as removed', async () => {
    mock.on(GetCommand).resolves({ Item: { id: 'story-0001', status: 'published' } });
    expect(await bury(doc, 't', 'story-0001')).toBe('buried');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({ ':g': 'graveyard', ':r': 'removed', ':p': 'published' });
    expect(lastUpdate().ConditionExpression).toBe('#s = :p');
  });

  it('hides text on a Graveyard entry and remembers the old reason', async () => {
    mock.on(GetCommand).resolves({ Item: { id: 'story-0002', status: 'graveyard', reason: 'invalid_model_output' } });
    await bury(doc, 't', 'story-0002');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({ ':r': 'removed', ':old': 'invalid_model_output' });
  });

  it('is idempotent and refuses the totals row', async () => {
    mock.on(GetCommand).resolves({ Item: { id: 'story-0003', status: 'graveyard', reason: 'removed' } });
    expect(await bury(doc, 't', 'story-0003')).toBe('already');
    expect(await bury(doc, 't', 'TOTALS')).toBe('missing');
    expect(mock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('restore', () => {
  it('puts a buried published story back on the board', async () => {
    mock.on(GetCommand).resolves({ Item: { id: 'story-0001', status: 'graveyard', reason: 'removed', removed_from: 'published' } });
    expect(await restore(doc, 't', 'story-0001')).toBe('restored');
    expect(lastUpdate().UpdateExpression).toContain('REMOVE reason');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({ ':p': 'published' });
  });

  it('restores the original Graveyard reason', async () => {
    mock.on(GetCommand).resolves({ Item: { id: 'story-0002', status: 'graveyard', reason: 'removed', removed_from: 'graveyard', prev_reason: 'empty' } });
    await restore(doc, 't', 'story-0002');
    expect(lastUpdate().ExpressionAttributeValues).toMatchObject({ ':old': 'empty' });
  });

  it('ignores stories that were not removed', async () => {
    mock.on(GetCommand).resolves({ Item: { id: 'story-0004', status: 'published' } });
    expect(await restore(doc, 't', 'story-0004')).toBe('not-removed');
  });
});
