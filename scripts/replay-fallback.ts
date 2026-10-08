// Built-in fallback data for replay mode, used when no recording exists. Classifications are
// hand-written to match the seed stories. Token counts are typical values, not measurements,
// which is why the board shows a REPLAY badge in this mode.
import { SEED_STORIES } from './stories.js';

export interface Recording {
  board: {
    feed: any[];
    graveyard: any[];
    totals: Record<string, number>;
  };
  postmortems: Record<string, any>;
  recordedAt: string;
  source: 'fallback' | 'live';
}

const VERDICTS = [
  { category: 'friday_deploy', fear_level: 8, root_cause: 'Friday deploy with one prod admin', survivable: true, one_liner: 'Trailing comma takes weekend off, takes checkout with it' },
  { category: 'no_backups', fear_level: 10, root_cause: 'Backups never verified by restore', survivable: false, one_liner: 'Three years of green checkmarks protected nothing at all' },
  { category: 'leaked_secret', fear_level: 10, root_cause: 'Root keys committed to public repo', survivable: false, one_liner: 'Intern discovers regions, crypto miners discover intern first' },
  { category: 'prod_is_test', fear_level: 9, root_cause: 'Staging hostname aliased to production', survivable: true, one_liner: 'Load test succeeds, two million real orders ship' },
  { category: 'spreadsheet_as_database', fear_level: 7, root_cause: 'Payroll in a sorted single column', survivable: true, one_liner: 'Everyone paid on time, nobody paid correctly' },
  { category: 'mystery_cron_job', fear_level: 7, root_cause: 'Unowned cron on decommissioned server', survivable: true, one_liner: 'Cost saving initiative also saves company from coffee' },
  { category: 'rm_rf_moment', fear_level: 9, root_cause: 'Unset variable in root cleanup', survivable: false, one_liner: 'Cleanup script achieves cleanest server in company history' },
  { category: 'it_was_dns', fear_level: 6, root_cause: 'One week TTL on bad record', survivable: true, one_liner: 'Team checks everything, then checks DNS, then waits' },
  { category: 'other', fear_level: 8, root_cause: 'Expired cluster cert, departed consultant', survivable: true, one_liner: 'Resilient platform celebrates New Year by refusing all traffic' },
  { category: 'other', fear_level: 5, root_cause: 'Dashboard monitored only itself', survivable: true, one_liner: 'Dashboard reports flawless uptime for dashboard' },
  { category: 'other', fear_level: 9, root_cause: 'Billing gated by temporary feature flag', survivable: true, one_liner: 'Flag cleanup makes product free for four days' },
  { category: 'no_backups', fear_level: 8, root_cause: 'DR plan stored on failed server', survivable: false, one_liner: 'Recovery plan located inside the thing being recovered' },
  { category: 'leaked_secret', fear_level: 9, root_cause: 'Request bodies logged to public bucket', survivable: true, one_liner: 'Researcher polite, journalist less so, logs very complete' },
  { category: 'mystery_cron_job', fear_level: 6, root_cause: 'Batch scheduled in local time', survivable: true, one_liner: 'Daylight saving bills everyone twice, refunds everyone twice' },
  { category: 'prod_is_test', fear_level: 10, root_cause: 'Stale tmux pane connected to prod', survivable: false, one_liner: 'Local database drop goes surprisingly global' },
];

const GRAVE_REASONS: Record<string, [string, string]> = {
  empty: ['empty', 'blank'],
  gibberish: ['empty', 'gibberish'],
  moderation: ['moderation_blocked', 'pii'],
  injection: ['moderation_blocked', 'content:PROMPT_ATTACK'],
  profanity: ['moderation_blocked', 'profanity'],
  heckle: ['not_a_story', 'heckle'],
};

const POSTMORTEM = `## Summary
A cleanup script removed the contents of the root filesystem on a production server. Service was restored from a rebuild. The server has never been cleaner.

## Timeline
- 14:02 Cleanup script merged after one approval and zero reads.
- 14:05 Script runs as root with BUILD_DIR unset.
- 14:06 Monitoring stops reporting, because monitoring was also on the server.
- 14:40 A customer reports the outage in a support ticket titled "hello?"
- 18:15 Server rebuilt from a two month old image.

## Root Cause
An unset environment variable expanded to an empty string, turning a targeted delete into a total one.

## Contributing Factors
- The script ran as root because "it was easier".
- No set -u, no guard, no dry run.
- The runbook for this server lived on this server.

## What Went Well
- Disk usage alerts were resolved permanently.
- Nobody had to argue about what to delete.

## Action Items
- Add set -euo pipefail to every script. Owner: everyone. Due: never, realistically.
- Stop running cleanup jobs as root. Owner: nobody. Due: next incident.
- Move the runbook somewhere that survives the incident. Owner: TBD. Due: TBD.`;

export function fallbackRecording(): Recording {
  const start = Date.parse('2026-10-07T12:00:00.000Z');
  const feed: any[] = [];
  const graveyard: any[] = [];
  let good = 0;
  SEED_STORIES.forEach((s, i) => {
    const id = `replay-${String(i + 1).padStart(4, '0')}`;
    const createdAt = new Date(start + i * 1500).toISOString();
    if (s.kind === 'good') {
      const v = VERDICTS[good++];
      feed.push({ id, createdAt, text: s.text, ...v, input_tokens: 640 + (i % 5) * 9, output_tokens: 64 + (i % 4) * 5, cost_usd: 0.00098 });
    } else {
      const [reason, detail] = GRAVE_REASONS[s.kind] ?? ['other', 'error'];
      graveyard.push({ id, createdAt, reason, detail, text: '' });
    }
  });
  const scariestRmRf = feed.find((f) => f.category === 'rm_rf_moment');
  return {
    board: {
      feed: feed.reverse(),
      graveyard: graveyard.reverse(),
      totals: { input_tokens: 9874, output_tokens: 1061, cost_usd: 0.0218, guardrail_units: 54, model_calls: 33 },
    },
    postmortems: {
      [scariestRmRf.id]: { storyId: scariestRmRf.id, status: 'done', one_liner: scariestRmRf.one_liner, category: scariestRmRf.category, fear_level: scariestRmRf.fear_level, postmortem: POSTMORTEM },
    },
    recordedAt: new Date(start).toISOString(),
    source: 'fallback',
  };
}
