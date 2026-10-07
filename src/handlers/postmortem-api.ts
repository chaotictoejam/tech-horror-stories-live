import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { queryByStatus, scariest } from '../shared/board-data.js';
import { json, parseBody } from '../shared/http.js';
import { log } from '../shared/log.js';
import { isPresenter } from '../shared/presenter.js';
import { ddb } from '../shared/usage.js';

const lambda = new LambdaClient({});
const ID = /^[A-Za-z0-9-]{8,64}$/;
const STALE_PENDING_MS = 2 * 60_000;

async function getStory(table: string, id: string) {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: { id } }));
  return res.Item?.status === 'published' ? res.Item : undefined;
}

function view(item: Record<string, any>) {
  return {
    storyId: item.id,
    status: item.postmortem_status ?? 'none',
    one_liner: item.one_liner,
    category: item.category,
    fear_level: item.fear_level,
    postmortem: item.postmortem_status === 'done' ? item.postmortem : undefined,
  };
}

/**
 * POST /api/postmortem  {storyId?, fresh?}  (presenter key required) starts a postmortem.
 * GET  /api/postmortem/{id}                  returns its status and text.
 * Generation runs in a separate async Lambda so the call never hits the 30 second API limit.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const table = process.env.TABLE_NAME!;

  if (event.requestContext.http.method === 'GET') {
    const id = event.pathParameters?.id ?? '';
    if (!ID.test(id)) return json(400, { message: 'Bad story id' });
    const item = await getStory(table, id);
    return item ? json(200, view(item)) : json(404, { message: 'No such published story' });
  }

  if (!(await isPresenter(event.headers?.['x-presenter-key']))) {
    return json(403, { message: 'Presenter key required' });
  }

  const body = parseBody(event) ?? {};
  let storyId = typeof body.storyId === 'string' ? body.storyId.trim() : '';
  if (storyId && !ID.test(storyId)) return json(400, { message: 'Bad story id' });
  if (!storyId) {
    const [top] = scariest(await queryByStatus(table, 'published', 1000), 1);
    if (!top) return json(404, { message: 'No published stories yet' });
    storyId = top.id;
  }

  const item = await getStory(table, storyId);
  if (!item) return json(404, { message: 'No such published story' });

  // Cached: repeat clicks cost nothing.
  if (item.postmortem_status === 'done' && body.fresh !== true) return json(200, view(item));

  const now = Date.now();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: storyId },
        UpdateExpression: 'SET postmortem_status = :p, postmortem_started = :now',
        ConditionExpression: 'attribute_not_exists(postmortem_status) OR postmortem_status <> :p OR postmortem_started < :stale',
        ExpressionAttributeValues: { ':p': 'pending', ':now': now, ':stale': now - STALE_PENDING_MS },
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      return json(202, { ...view(item), status: 'pending' });
    }
    throw err;
  }

  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.WORKER_FUNCTION!,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ storyId })),
    }),
  );
  log.info('postmortem started', { storyId });
  return json(202, { ...view(item), status: 'pending' });
};
