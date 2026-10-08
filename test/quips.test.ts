import { describe, expect, it } from 'vitest';
import { countProfanity } from '../src/shared/censor.js';
import { assess } from '../src/handlers/load-story.js';
import { ALL_QUIPS, quipFor } from '../src/shared/quips.js';
import { SEED_STORIES } from '../scripts/stories.js';

describe('quipFor', () => {
  it('matches the specific cause when known', () => {
    expect(ALL_QUIPS['moderation_blocked/profanity']).toContain(quipFor({ id: 'a', reason: 'moderation_blocked', detail: 'profanity' }));
    expect(ALL_QUIPS['moderation_blocked/content:PROMPT_ATTACK']).toContain(
      quipFor({ id: 'b', reason: 'moderation_blocked', detail: 'content:PROMPT_ATTACK' }),
    );
    expect(ALL_QUIPS['empty/gibberish']).toContain(quipFor({ id: 'c', reason: 'empty', detail: 'gibberish' }));
  });

  it('falls back to the reason, then to a generic quip', () => {
    expect(ALL_QUIPS.moderation_blocked).toContain(quipFor({ id: 'd', reason: 'moderation_blocked', detail: 'content:SOMETHING_NEW' }));
    expect(ALL_QUIPS.removed).toContain(quipFor({ id: 'e', reason: 'removed' }));
    expect(ALL_QUIPS.other).toContain(quipFor({ id: 'f' }));
  });

  it('blames the model for any model output block', () => {
    expect(ALL_QUIPS.invalid_model_output).toContain(quipFor({ id: 'g', reason: 'invalid_model_output', detail: 'output:topic:SelfHarmJokes' }));
  });

  it('is stable for the same story, so the board does not flicker', () => {
    const e = { id: 'story-1234', reason: 'moderation_blocked', detail: 'profanity' };
    expect(quipFor(e)).toBe(quipFor({ ...e }));
  });

  it('has no em or en dashes in any quip', () => {
    for (const q of Object.values(ALL_QUIPS).flat()) expect(q).not.toMatch(/[–—]/);
  });
});

describe('profanity limit', () => {
  it('counts swears, including evasions', () => {
    expect(countProfanity('fucking DNS, sh1t, f u c k')).toBe(3);
    expect(countProfanity('a clean story about classes')).toBe(0);
  });

  it('lets a couple of swear words through', () => {
    expect(assess('Deployed on Friday and the rollback broke. Shit. It was fucking DNS all along.')).toEqual({ usable: true });
  });

  it('buries three or more', () => {
    expect(assess('Fucking Jenkins. Fucking YAML. Shit broke at 2am and nobody answered the pager.')).toEqual({
      usable: false,
      reason: 'moderation_blocked',
      detail: 'profanity',
    });
  });

  it('only the profanity seed trips the limit', () => {
    const tripped = SEED_STORIES.filter((s) => countProfanity(s.text) >= 3).map((s) => s.kind);
    expect(tripped).toEqual(['profanity']);
  });

  it('every seed fits in 280 characters', () => {
    for (const s of SEED_STORIES) expect(s.text.length).toBeLessThanOrEqual(280);
  });
});
