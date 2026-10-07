import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { COOLDOWN_SECONDS, STORY_MAX_CHARS } from '../../config/app-config.js';
import { deviceKey, tryAcquireCooldown } from '../shared/cooldown.js';
import { json, parseBody, viewerIp } from '../shared/http.js';
import { log } from '../shared/log.js';
import { ddb } from '../shared/usage.js';

const s3 = new S3Client({});
export const KILL_SWITCH_KEY = { pk: 'config#submissions' };

export async function submissionsOpen(table: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: KILL_SWITCH_KEY, ConsistentRead: true }));
  return res.Item?.open !== false;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const configTable = process.env.CONFIG_TABLE!;

  if (!(await submissionsOpen(configTable))) {
    return json(503, { message: 'Submissions closed' });
  }

  const body = parseBody(event);
  if (!body || (body.text !== undefined && typeof body.text !== 'string')) {
    return json(400, { message: 'Send JSON like {"text": "..."}' });
  }
  // Empty text is allowed through on purpose: the pipeline sends it to the Graveyard, which is part of the demo.
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > STORY_MAX_CHARS) {
    return json(400, { message: `Stories are limited to ${STORY_MAX_CHARS} characters` });
  }

  const key = deviceKey(
    {
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
      ip: viewerIp(event),
      userAgent: event.headers?.['user-agent'],
    },
    process.env.COOLDOWN_SALT,
  );
  if (!(await tryAcquireCooldown(ddb, configTable, key, Date.now(), COOLDOWN_SECONDS))) {
    return json(429, { message: `One story every ${COOLDOWN_SECONDS} seconds, please` }, { 'retry-after': String(COOLDOWN_SECONDS) });
  }

  const id = randomUUID();
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.RAW_BUCKET!,
      Key: `stories/${id}.json`,
      ContentType: 'application/json',
      Body: JSON.stringify({ id, text, createdAt: new Date().toISOString() }),
    }),
  );
  log.info('story accepted', { id, length: text.length });
  return json(202, { id, message: 'Story received. Watch the board.' });
};
