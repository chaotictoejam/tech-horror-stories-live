import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/submit.js';

process.env.CONFIG_TABLE = 'config';
process.env.RAW_BUCKET = 'raw';

const docMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const event = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    headers: { 'user-agent': 'phone', ...headers },
    requestContext: { http: { sourceIp: '203.0.113.9' } },
  }) as any;

beforeEach(() => {
  docMock.reset();
  s3Mock.reset();
  docMock.on(GetCommand).resolves({});
  docMock.on(PutCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('submit', () => {
  it('accepts a story and writes it to S3', async () => {
    const res = await handler(event({ text: 'We deployed on Friday.', deviceId: 'device-123456' }));
    expect(res.statusCode).toBe(202);
    const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(put.Key).toMatch(/^stories\/[0-9a-f-]{36}\.json$/);
    const stored = JSON.parse(put.Body as string);
    expect(stored.text).toBe('We deployed on Friday.');
    // No device id, IP, or user agent in the stored object.
    expect(put.Body).not.toContain('device-123456');
    expect(put.Body).not.toContain('203.0.113.9');
  });

  it('returns 503 when the kill switch is off', async () => {
    docMock.on(GetCommand).resolves({ Item: { pk: 'config#submissions', open: false } });
    const res = await handler(event({ text: 'hello' }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!).message).toBe('Submissions closed');
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('rejects stories over 280 characters', async () => {
    const res = await handler(event({ text: 'x'.repeat(281) }));
    expect(res.statusCode).toBe(400);
    expect(docMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rejects bad JSON', async () => {
    expect((await handler(event('{nope'))).statusCode).toBe(400);
    expect((await handler(event({ text: 42 }))).statusCode).toBe(400);
  });

  it('lets empty stories through so the Graveyard can show them', async () => {
    expect((await handler(event({ text: '' }))).statusCode).toBe(202);
  });

  it('returns 429 inside the cooldown window', async () => {
    docMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const res = await handler(event({ text: 'second story too soon' }));
    expect(res.statusCode).toBe(429);
    expect(res.headers?.['retry-after']).toBe('20');
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('uses the CloudFront viewer address for the fallback device key', async () => {
    await handler(event({ text: 'a' }, { 'cloudfront-viewer-address': '198.51.100.7:51234' }));
    await handler(event({ text: 'a' }, { 'cloudfront-viewer-address': '198.51.100.8:51234' }));
    const [a, b] = docMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item!.pk);
    expect(a).not.toBe(b);
  });
});
