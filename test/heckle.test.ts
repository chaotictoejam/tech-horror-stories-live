import { describe, expect, it } from 'vitest';
import { classifyShortText } from '../src/shared/heckle.js';
import { ALL_QUIPS, quipFor } from '../src/shared/quips.js';
import { assess } from '../src/handlers/load-story.js';

describe('classifyShortText', () => {
  it.each([
    'This is dumb',
    'this talk is boring',
    'Your demo sucks',
    'boring',
    'Who cares',
    'get off the stage',
    'next slide',
    'booooo',
    'zzzzz',
    'is this over yet',
    'The speaker is lame',
  ])('flags heckle: %s', (text) => {
    expect(classifyShortText(text)).toBe('heckle');
  });

  it.each(['test', 'hi', 'lol', 'Hello!', 'first', '???'])('flags chatter: %s', (text) => {
    expect(classifyShortText(text)).toBe('chatter');
  });

  it.each([
    'It was DNS.',
    'The demo was boring until prod caught fire and took billing with it.',
    'Dropped the users table. On a Friday.',
    'rm -rf / as root',
    'Our tests were all mocked',
    'Backups were empty',
  ])('leaves real stories alone: %s', (text) => {
    expect(classifyShortText(text)).toBeUndefined();
  });
});

describe('heckle quips', () => {
  it('has quips for heckles, chatter, and model-flagged non-stories', () => {
    expect(ALL_QUIPS['not_a_story/heckle']).toContain(quipFor({ id: 'x', reason: 'not_a_story', detail: 'heckle' }));
    expect(ALL_QUIPS['not_a_story/chatter']).toContain(quipFor({ id: 'y', reason: 'not_a_story', detail: 'chatter' }));
    expect(ALL_QUIPS.not_a_story).toContain(quipFor({ id: 'z', reason: 'not_a_story', detail: 'model' }));
  });
});

describe('full Load Story checks on short real stories', () => {
  // Regression: "It was DNS." used to fail the gibberish check because DNS has no vowel.
  it.each([
    'It was DNS.',
    'rm -rf / in prod',
    'AWS bill: $40k. Oops.',
    'Dropped the users table. On a Friday.',
    'SQL injection in the login form',
    'K8S ate our certs again',
    'Backups were empty',
  ])('publishes: %s', (text) => {
    expect(assess(text)).toEqual({ usable: true });
  });

  it.each([
    ['asdfjkl;;; qwrtzp xxxx 12345 !!!! zzzzzzz', 'gibberish'],
    ['qwpoeiru zxmcnvb lkjhgf 0000 ;;;;', 'gibberish'],
    ['qqqq xxxx vvvv', 'gibberish'],
    ['zzzz xxxx qqqq', 'heckle'],
    ['This is dumb', 'heckle'],
    ['test', 'chatter'],
  ])('rejects %s as %s', (text, detail) => {
    expect(assess(text).detail).toBe(detail);
  });
});
