// Submits the 20 seed stories through the real public API so every one gets its own execution.
// Usage: npm run seed [-- --fast] [-- --url https://xxxx.cloudfront.net/]
import { randomBytes } from 'node:crypto';
import { arg, argValue, loadOutputs, sleep } from './outputs.js';
import { SEED_STORIES } from './stories.js';

const base = argValue('url') ?? (await loadOutputs()).submitUrl;
const delay = arg('fast') ? 300 : 1500;
const endpoint = new URL('/api/stories', base).toString();

console.log(`Seeding ${SEED_STORIES.length} stories to ${endpoint}`);
let accepted = 0;
for (const [i, s] of SEED_STORIES.entries()) {
  // Each seed story pretends to be its own phone, so the 20 second cooldown does not apply.
  const deviceId = `seed-${randomBytes(8).toString('hex')}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: s.text, deviceId }),
  });
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
