// Offline fallback for when the room's Wi-Fi dies. Serves the real board page from localhost and
// replays a recorded run at human speed. The board shows a REPLAY badge the whole time.
//
//   npm run replay -- --record        Save the live board (and cached postmortems) to replay/recording.json
//   npm run replay                    Serve http://localhost:8080/board.html#key=replay
//   npm run replay -- --interval 4    Seconds between stories (default 4)
//   npm run replay -- --port 8080
//
// With no recording it uses built-in fallback data based on the seed stories.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { CATEGORIES } from '../src/shared/schema.js';
import { arg, argValue, loadOutputs } from './outputs.js';
import { fallbackRecording, type Recording } from './replay-fallback.js';

const RECORDING = 'replay/recording.json';
const WEB = join(process.cwd(), 'web');

if (arg('record')) {
  const { submitUrl } = await loadOutputs();
  const board = await (await fetch(new URL('/api/board', submitUrl))).json();
  const postmortems: Record<string, unknown> = {};
  for (const s of board.feed) {
    const res = await fetch(new URL(`/api/postmortem/${s.id}`, submitUrl));
    const pm = await res.json();
    if (pm.status === 'done') postmortems[s.id] = pm;
  }
  const recording: Recording = {
    board: { feed: board.feed, graveyard: board.graveyard, totals: board.totals },
    postmortems,
    recordedAt: new Date().toISOString(),
    source: 'live',
  };
  mkdirSync('replay', { recursive: true });
  writeFileSync(RECORDING, JSON.stringify(recording, null, 2));
  console.log(`Recorded ${board.feed.length} stories, ${board.graveyard.length} graves, ${Object.keys(postmortems).length} postmortems to ${RECORDING}`);
  process.exit(0);
}

const recording: Recording = existsSync(RECORDING) ? JSON.parse(readFileSync(RECORDING, 'utf8')) : fallbackRecording();
const intervalMs = Number(argValue('interval') ?? 4) * 1000;
const port = Number(argValue('port') ?? 8080);

// Oldest first, interleaving published and buried stories in the order they arrived.
const timeline = [
  ...recording.board.feed.map((s) => ({ kind: 'feed' as const, item: s })),
  ...recording.board.graveyard.map((g) => ({ kind: 'grave' as const, item: g })),
].sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));

const started = Date.now();
const revealedCount = () => Math.min(timeline.length, 1 + Math.floor((Date.now() - started) / intervalMs));

function boardSnapshot() {
  const n = revealedCount();
  const shown = timeline.slice(0, n);
  const feed = shown.filter((t) => t.kind === 'feed').map((t) => t.item).reverse();
  const graveyard = shown.filter((t) => t.kind === 'grave').map((t) => t.item).reverse();
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const s of feed) categories[s.category] = (categories[s.category] ?? 0) + 1;
  const leaderboard = [...feed].sort((a, b) => b.fear_level - a.fear_level || b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  const frac = timeline.length ? n / timeline.length : 1;
  const t = recording.board.totals;
  const sinceLast = (Date.now() - started) % intervalMs;
  return {
    replay: true,
    feed,
    leaderboard,
    categories,
    graveyard,
    totals: {
      stories: n,
      published: feed.length,
      rejected: graveyard.length,
      input_tokens: Math.round((t.input_tokens ?? 0) * frac),
      output_tokens: Math.round((t.output_tokens ?? 0) * frac),
      cost_usd: Number(((t.cost_usd ?? 0) * frac).toFixed(6)),
    },
    inFlight: n < timeline.length && sinceLast > intervalMs - 2500 ? 1 : 0,
    generatedAt: new Date().toISOString(),
  };
}

const pmStarted = new Map<string, number>();
function postmortemView(id: string) {
  const pm = recording.postmortems[id];
  const story = recording.board.feed.find((s) => s.id === id);
  if (!story) return { status: 404, body: { message: 'No such story in this replay' } };
  if (!pm) return { status: 200, body: { storyId: id, status: 'error', one_liner: story.one_liner } };
  // Pretend to think for 4 seconds so the "writing" state shows.
  const ready = Date.now() - (pmStarted.get(id) ?? 0) > 4000;
  return { status: 200, body: ready ? pm : { ...pm, status: 'pending', postmortem: undefined } };
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/api/board') return send(200, boardSnapshot());
  if (url.pathname === '/api/stories') return send(503, { message: 'Submissions closed' });
  if (url.pathname === '/api/postmortem' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const snap = boardSnapshot();
    const id = body.storyId || Object.keys(recording.postmortems).find((k) => snap.feed.some((s: any) => s.id === k)) || snap.leaderboard[0]?.id;
    if (!id) return send(404, { message: 'No published stories yet' });
    if (!pmStarted.has(id)) pmStarted.set(id, Date.now());
    const v = postmortemView(id);
    return send(v.status === 200 ? 202 : v.status, v.body);
  }
  const pmMatch = /^\/api\/postmortem\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (pmMatch) {
    const v = postmortemView(pmMatch[1]);
    return send(v.status, v.body);
  }

  const file = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(WEB) || !existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

server.listen(port, () => {
  console.log(`Replaying ${timeline.length} items (${recording.source} data from ${recording.recordedAt}), one every ${intervalMs / 1000}s.`);
  console.log(`Board: http://localhost:${port}/board.html#key=replay`);
});
