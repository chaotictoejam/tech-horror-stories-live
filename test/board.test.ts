import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { scariest } from '../src/shared/board-data.js';
import { keysMatch } from '../src/shared/presenter.js';

process.env.TABLE_NAME = 'stories';
process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:111111111111:stateMachine:x';
process.env.PRESENTER_KEY_PARAM = '/tech-horror/presenter-key';
process.env.WORKER_FUNCTION = 'worker';

const docMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);
const ssmMock = mockClient(SSMClient);
const lambdaMock = mockClient(LambdaClient);

const pub = (id: string, fear: number, extra = {}) => ({
  id,
  status: 'published',
  createdAt: `2026-10-07T12:00:0${id.slice(-1)}.000Z`,
  category: 'it_was_dns',
  fear_level: fear,
  one_liner: 'It was DNS',
  text: 'story',
  ...extra,
});

beforeEach(() => {
  docMock.reset();
  sfnMock.reset();
  ssmMock.reset();
  lambdaMock.reset();
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'correct-horse' } });
});

describe('scariest', () => {
  it('sorts by fear, newest first on ties', () => {
    const rows = [pub('story-0001', 5), pub('story-0002', 9), pub('story-0003', 9)] as any;
    expect(scariest(rows, 2).map((r: any) => r.id)).toEqual(['story-0003', 'story-0002']);
  });
});

describe('board handler', () => {
  it('returns feed, totals, categories, in-flight count, and redacts moderated text', async () => {
    docMock
      .on(QueryCommand, { ExpressionAttributeValues: { ':s': 'published' } })
      .resolves({ Items: [pub('story-0001', 4, { text: 'It was fucking DNS' }), pub('story-0002', 8, { category: 'no_backups' })] })
      .on(QueryCommand, { ExpressionAttributeValues: { ':s': 'graveyard' } })
      .resolves({
        Items: [
          { id: 'grave-0001', status: 'graveyard', createdAt: '2026-10-07T12:00:00Z', reason: 'moderation_blocked', text: 'leaked text' },
          { id: 'grave-0002', status: 'graveyard', createdAt: '2026-10-07T12:00:00Z', reason: 'invalid_model_output', text: 'ok shit text' },
        ],
      });
    docMock.on(GetCommand).resolves({ Item: { id: 'TOTALS', input_tokens: 1200, output_tokens: 140, cost_usd: 0.0019, model_calls: 2 } });
    sfnMock.on(ListExecutionsCommand).resolves({ executions: [{} as any] });

    const { handler } = await import('../src/handlers/board.js');
    const res = await handler();
    const body = JSON.parse(res.body!);
    expect(body.totals).toMatchObject({ stories: 4, published: 2, rejected: 2, input_tokens: 1200, output_tokens: 140, cost_usd: 0.0019 });
    expect(body.categories).toMatchObject({ it_was_dns: 1, no_backups: 1, friday_deploy: 0 });
    expect(body.leaderboard[0].id).toBe('story-0002');
    expect(body.inFlight).toBe(1);
    expect(body.graveyard[0].text).toBe('');
    expect(body.graveyard[1].text).toBe('ok s*** text');
    expect(body.feed.find((f: any) => f.id === 'story-0001').text).toBe('It was f****** DNS');
    expect(res.body).not.toMatch(/fuck|shit/);
    expect(res.body).not.toContain('leaked text');
  });
});

describe('postmortem api', () => {
  const post = (body: unknown, key?: string) =>
    ({
      requestContext: { http: { method: 'POST' } },
      headers: key ? { 'x-presenter-key': key } : {},
      body: JSON.stringify(body),
    }) as any;

  it('compares keys safely', () => {
    expect(keysMatch('a', 'a')).toBe(true);
    expect(keysMatch('a', 'b')).toBe(false);
    expect(keysMatch(undefined, 'a')).toBe(false);
    expect(keysMatch('a', undefined)).toBe(false);
  });

  it('rejects calls without the presenter key', async () => {
    const { handler } = await import('../src/handlers/postmortem-api.js');
    expect((await handler(post({}))).statusCode).toBe(403);
    expect((await handler(post({}, 'wrong'))).statusCode).toBe(403);
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it('starts a postmortem for the scariest story', async () => {
    docMock.on(QueryCommand).resolves({ Items: [pub('story-0001', 3), pub('story-0002', 10)] });
    docMock.on(GetCommand).resolves({ Item: pub('story-0002', 10) });
    docMock.on(UpdateCommand).resolves({});
    const { handler } = await import('../src/handlers/postmortem-api.js');
    const res = await handler(post({}, 'correct-horse'));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body!).storyId).toBe('story-0002');
    const invoke = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(invoke.InvocationType).toBe('Event');
  });

  it('returns a cached postmortem without calling the model again', async () => {
    docMock.on(GetCommand).resolves({ Item: pub('story-0002', 10, { postmortem_status: 'done', postmortem: '## Summary\nIt was DNS.' }) });
    const { handler } = await import('../src/handlers/postmortem-api.js');
    const res = await handler(post({ storyId: 'story-0002' }, 'correct-horse'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).postmortem).toContain('It was DNS');
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it('rejects malformed story ids', async () => {
    const { handler } = await import('../src/handlers/postmortem-api.js');
    expect((await handler(post({ storyId: '../../x' }, 'correct-horse'))).statusCode).toBe(400);
  });
});
