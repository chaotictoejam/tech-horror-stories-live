// Presenter admin page, served only on this laptop. Uses your own AWS credentials, so there is no
// public admin endpoint to attack. Lets you bury or restore any story and open or close submissions.
//
//   npm run admin                 http://127.0.0.1:8787/?t=<random token>
//   npm run admin -- --port 9000
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { queryByStatus } from '../src/shared/board-data.js';
import { bury, restore } from '../src/shared/bury.js';
import { censor } from '../src/shared/censor.js';
import { quipFor } from '../src/shared/quips.js';
import { argValue, loadOutputs } from './outputs.js';

const outputs = await loadOutputs();
if (!outputs.storiesTable) throw new Error('StoriesTableName output missing. Redeploy with npm run deploy.');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const port = Number(argValue('port') ?? 8787);
const token = randomBytes(16).toString('hex');
const ADMIN_DIR = join(process.cwd(), 'admin');
const ID = /^[A-Za-z0-9-]{8,64}$/;

// Any web page you visit could try to POST to localhost. The token and Host check stop that.
function authorized(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function state() {
  const [published, graveyard, kill] = await Promise.all([
    queryByStatus(outputs.storiesTable, 'published', 500),
    queryByStatus(outputs.storiesTable, 'graveyard', 500),
    ddb.send(new GetCommand({ TableName: outputs.configTable, Key: { pk: 'config#submissions' }, ConsistentRead: true })),
  ]);
  // Same censoring as the board, in case this screen is mirrored to the projector.
  const row = (r: any) => ({
    id: r.id,
    createdAt: r.createdAt,
    text: censor(r.text ?? ''),
    one_liner: censor(r.one_liner),
    category: r.category,
    fear_level: r.fear_level,
    reason: r.reason,
    detail: r.detail,
    quip: r.status === 'graveyard' ? quipFor(r) : undefined,
  });
  return { submissionsOpen: kill.Item?.open !== false, published: published.map(row), graveyard: graveyard.map(row), boardUrl: outputs.boardUrl };
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req)) return send(403, { message: 'Bad admin token. Use the URL printed in the terminal.' });
      if (url.pathname === '/api/state' && req.method === 'GET') return send(200, await state());

      const body = await readJson(req);
      if (req.method === 'POST' && (url.pathname === '/api/bury' || url.pathname === '/api/restore')) {
        const id = String(body.id ?? '');
        if (!ID.test(id)) return send(400, { message: 'Bad story id' });
        const result = url.pathname === '/api/bury' ? await bury(ddb, outputs.storiesTable, id) : await restore(ddb, outputs.storiesTable, id);
        console.log(`${new Date().toLocaleTimeString()} ${result} ${id}`);
        return send(200, { result });
      }
      if (req.method === 'POST' && url.pathname === '/api/submissions') {
        const open = body.open === true;
        await ddb.send(
          new PutCommand({ TableName: outputs.configTable, Item: { pk: 'config#submissions', open, updatedAt: new Date().toISOString() } }),
        );
        console.log(`${new Date().toLocaleTimeString()} submissions ${open ? 'OPEN' : 'CLOSED'}`);
        return send(200, { open });
      }
      return send(404, { message: 'Not found' });
    }

    const file = url.pathname === '/' ? 'admin.html' : url.pathname.slice(1);
    if (!['admin.html', 'admin.css', 'admin.js'].includes(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[file.slice(file.lastIndexOf('.'))],
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    res.end(readFileSync(join(ADMIN_DIR, file)));
  } catch (err) {
    console.error(err);
    send(500, { message: (err as Error).message });
  }
});

// Loopback only: nothing on the conference Wi-Fi can reach this.
server.listen(port, '127.0.0.1', () => {
  console.log(`Admin (this laptop only): http://127.0.0.1:${port}/?t=${token}`);
  console.log('Leave this running during the talk. Ctrl+C to stop.');
});
