// Submits the 22 seed stories through the real public API so every one gets its own execution.
// Usage: npm run seed [-- --fast] [-- --url https://xxxx.cloudfront.net/]
//        npm run seed -- --burst 60   load test: 60 good stories at the same moment, like a room scanning the QR code
import { randomBytes } from 'node:crypto';
import { arg, argValue, loadOutputs, sleep } from './outputs.js';
import { SEED_STORIES } from './stories.js';

const base = argValue('url') ?? (await loadOutputs()).submitUrl;
const delay = arg('fast') ? 300 : 1500;
const endpoint = new URL('/api/stories', base).toString();

const post = (text: string) =>
  fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Each story pretends to be its own phone, so the 20 second cooldown does not apply.
    body: JSON.stringify({ text, deviceId: `seed-${randomBytes(8).toString('hex')}` }),
  });

const burst = Number(argValue('burst') ?? 0);
if (burst > 0) {
  const good = SEED_STORIES.filter((s) => s.kind === 'good');
  console.log(`Load test: ${burst} stories to ${endpoint} at the same moment`);
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: burst }, (_, i) =>
      post(`${good[i % good.length].text.slice(0, 270)} (#${i + 1})`).then((r) => r.status, () => 'network error'),
    ),
  );
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
  console.log(`Done in ${Date.now() - started} ms. Status codes:`, counts);
  console.log('Watch the board: all of them should reach the Feed, some a bit late. Run npm run reset afterwards.');
  process.exit(0);
}

console.log(`Seeding ${SEED_STORIES.length} stories to ${endpoint}`);
let accepted = 0;
for (const [i, s] of SEED_STORIES.entries()) {
  const res = await post(s.text);
  if (res.status === 202) accepted++;
  const preview = s.text.trim().slice(0, 50) || '(empty)';
  console.log(`${String(i + 1).padStart(2)}. ${res.status} [${s.kind}] ${preview}`);
  if (res.status === 503) {
    console.log('Submissions are closed. Run npm run reopen first.');
    process.exit(1);
  }
  await sleep(delay);
}
console.log(`\n${accepted}/${SEED_STORIES.length} accepted. Expect ${SEED_STORIES.filter((s) => s.kind === 'good').length} on the Feed and the rest in the Graveyard (injections may land in either).`);
