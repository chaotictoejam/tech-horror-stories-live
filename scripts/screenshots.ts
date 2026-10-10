// Regenerates the README screenshots in docs/images/ from the offline replay board, so no deployment
// is needed. Uses replay/recording.json if it exists (npm run replay -- --record), otherwise the
// built-in fallback data. Do not record a live audience session for this: the images are public.
// Needs Chrome or Chromium installed. Set CHROME=/path/to/chrome if it is not found.
// Usage: npm run screenshots [-- --out docs/images]
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argValue, sleep } from './outputs.js';

const OUT = argValue('out') ?? 'docs/images';
const REPLAY_PORT = 8099;
const DEBUG_PORT = 9333;
const BASE = `http://localhost:${REPLAY_PORT}`;

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter((p): p is string => !!p);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('Chrome not found. Set CHROME=/path/to/chrome and try again.');
  process.exit(1);
}

const children: ChildProcess[] = [];
const profile = mkdtempSync(join(tmpdir(), 'ths-chrome-'));
// Best effort on the error path: Chrome may still be writing to its profile as it dies.
process.on('exit', () => {
  for (const c of children) c.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* left in the temp dir */
  }
});

/** Poll until fn returns a value, or give up after about 10 seconds. */
async function waitFor<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Tiny interval so every story is on the board by the time the page loads.
children.push(spawn(process.execPath, ['--import', 'tsx', 'scripts/replay.ts', '--interval', '0.01', '--port', String(REPLAY_PORT)], { stdio: 'ignore' }));
await waitFor('the replay server', async () => ((await fetch(`${BASE}/api/board`)).ok ? true : undefined));

children.push(
  spawn(chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' }),
);
const wsUrl = await waitFor('Chrome', async () => {
  const targets: { type: string; webSocketDebuggerUrl: string }[] = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  return targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
});

// Minimal Chrome DevTools Protocol client: one page, request/response only.
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
};
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function press(key: string) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
}

interface Shot {
  file: string;
  url: string;
  width?: number;
  height?: number;
  mobile?: boolean;
  /** Runs after the page settles, before the capture. */
  before?: () => Promise<void>;
}

async function capture({ file, url, width = 1920, height = 1080, mobile = false, before }: Shot) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await send('Page.navigate', { url });
  // Fonts, the first poll, and the card entry animation.
  await sleep(mobile ? 2000 : 6000);
  if (before) await before();
  const res = await send('Page.captureScreenshot', { format: 'webp', quality: 82 });
  writeFileSync(join(OUT, file), Buffer.from(res.result.data, 'base64'));
  console.log(`${join(OUT, file)}`);
}

mkdirSync(OUT, { recursive: true });
await send('Page.enable');
// #key=replay shows the presenter controls, as on the projector.
await capture({ file: 'board-feed.webp', url: `${BASE}/board.html?tab=feed#key=replay` });
await capture({ file: 'board-graveyard.webp', url: `${BASE}/board.html?tab=graveyard#key=replay` });
// The replay server pretends to write for 4 seconds before returning the recorded postmortem.
await capture({
  file: 'board-postmortem.webp',
  url: `${BASE}/board.html?tab=feed#key=replay`,
  before: async () => {
    await press('p');
    await sleep(9000);
  },
});
await capture({ file: 'submit-phone.webp', url: `${BASE}/`, width: 390, height: 844, mobile: true });

ws.close();
await Promise.all(children.map((c) => new Promise((resolve) => c.once('exit', resolve).kill())));
rmSync(profile, { recursive: true, force: true });
process.exit(0);
