import { ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { censor } from '../shared/censor.js';
import { quipFor } from '../shared/quips.js';
import { CATEGORIES } from '../shared/schema.js';
import { queryByStatus, scariest, type StoryRow } from '../shared/board-data.js';
import { json } from '../shared/http.js';
import { log } from '../shared/log.js';
import { ddb, TOTALS_ID } from '../shared/usage.js';

const sfn = new SFNClient({});
const FEED_SIZE = 30;

// The board polls every 2 seconds. Cache the in-flight count briefly so many open boards
// do not hammer ListExecutions.
let inFlightCache: { at: number; value: number } | undefined;

async function inFlight(): Promise<number> {
  if (inFlightCache && Date.now() - inFlightCache.at < 2000) return inFlightCache.value;
  try {
    const res = await sfn.send(
      new ListExecutionsCommand({ stateMachineArn: process.env.STATE_MACHINE_ARN!, statusFilter: 'RUNNING', maxResults: 100 }),
    );
    inFlightCache = { at: Date.now(), value: res.executions?.length ?? 0 };
  } catch (err) {
    log.warn('ListExecutions failed', { error: (err as Error).name });
    inFlightCache = { at: Date.now(), value: inFlightCache?.value ?? 0 };
  }
  return inFlightCache.value;
}

const feedCard = (r: StoryRow) => ({
  id: r.id,
  createdAt: r.createdAt,
  text: censor(r.text ?? ''),
  category: r.category,
  fear_level: r.fear_level,
  root_cause: censor(r.root_cause),
  survivable: r.survivable,
  one_liner: censor(r.one_liner),
  input_tokens: r.input_tokens,
  output_tokens: r.output_tokens,
  cost_usd: r.cost_usd,
});

// Text blocked by moderation or removed by the presenter is never sent to the browser.
// Everything else is censored for profanity on the way out.
const HIDDEN_REASONS = new Set(['moderation_blocked', 'removed']);
const graveCard = (r: StoryRow) => ({
  id: r.id,
  createdAt: r.createdAt,
  reason: r.reason ?? 'other',
  quip: quipFor(r),
  text: HIDDEN_REASONS.has(r.reason ?? '') ? '' : censor(r.text ?? ''),
});

export const handler = async (): Promise<APIGatewayProxyStructuredResultV2> => {
  const table = process.env.TABLE_NAME!;
  const [published, graveyard, totalsRes, running] = await Promise.all([
    queryByStatus(table, 'published', 1000),
    queryByStatus(table, 'graveyard', 1000),
    ddb.send(new GetCommand({ TableName: table, Key: { id: TOTALS_ID } })),
    inFlight(),
  ]);

  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of published) if (r.category && r.category in categories) categories[r.category]++;

  const t = totalsRes.Item ?? {};
  return json(200, {
    feed: published.slice(0, FEED_SIZE).map(feedCard),
    leaderboard: scariest(published, 3).map(feedCard),
    categories,
    graveyard: graveyard.slice(0, FEED_SIZE).map(graveCard),
    totals: {
      stories: published.length + graveyard.length,
      published: published.length,
      rejected: graveyard.length,
      input_tokens: Number(t.input_tokens ?? 0),
      output_tokens: Number(t.output_tokens ?? 0),
      cost_usd: Number(t.cost_usd ?? 0),
      guardrail_units: Number(t.guardrail_units ?? 0),
      model_calls: Number(t.model_calls ?? 0),
    },
    inFlight: running,
    generatedAt: new Date().toISOString(),
  });
};
