import { describe, expect, it } from 'vitest';
import { censor } from '../src/shared/censor.js';

describe('censor', () => {
  it.each([
    ['It was fucking DNS.', 'It was f****** DNS.'],
    ['Shit.', 'S***.'],
    ['total bullshit', 'total b*******'],
    ['WTF happened', 'W** happened'],
    ['what an asshole move', 'what an a****** move'],
    ['damn it', 'd*** it'],
  ])('masks %s', (input, expected) => {
    expect(censor(input)).toBe(expected);
  });

  it.each(['class', 'passed the assessment', 'Dickens', 'cockpit', 'Scunthorpe', 'shitake'])('leaves %s alone', (word) => {
    expect(censor(word)).toBe(word);
  });

  it('keeps first letter and length', () => {
    expect(censor('fuck')).toMatch(/^f\*{3}$/);
  });

  it('passes through empty values', () => {
    expect(censor(undefined)).toBeUndefined();
    expect(censor('')).toBe('');
  });
});

describe('censor evasion', () => {
  it.each([
    ['sh1t happens', 's*** happens'],
    ['what the f*ck', 'what the f***'],
    ['f u c k this', 'f*** this'],
    ['s.h.i.t', 's***'],
    ['@sshole', '@******'],
    ['b1tch', 'b****'],
  ])('masks %s', (input, expected) => {
    expect(censor(input)).toBe(expected);
  });

  it.each(['passes', 'assess', 'A B testing', 'Shitake', 'r u ok', 'class', 'Dickens', 'Scunthorpe', 'title', 'cocktail', 'assignment'])(
    'leaves %s alone',
    (word) => {
      expect(censor(word)).toBe(word);
    },
  );
});
