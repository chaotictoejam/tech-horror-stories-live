import { describe, expect, it } from 'vitest';
import { collapseSpacedLetters, normalizeStory } from '../src/shared/normalize.js';

describe('normalizeStory', () => {
  it('strips zero-width and bidi characters', () => {
    expect(normalizeStory('pro​duction‮ down')).toBe('production down');
  });

  it('folds Cyrillic look-alikes inside Latin words', () => {
    // "рrod" uses a Cyrillic p
    expect(normalizeStory('dropped рrod')).toBe('dropped prod');
  });

  it('leaves real Cyrillic text alone', () => {
    expect(normalizeStory('прод упал')).toBe('прод упал');
  });

  it('applies NFKC so full-width letters become normal', () => {
    expect(normalizeStory('ＤＮＳ')).toBe('DNS');
  });

  it('collapses runs of spaced letters', () => {
    expect(collapseSpacedLetters('we d e p l o y e d it')).toBe('we deployed it');
    expect(collapseSpacedLetters('h.a.t.e speech')).toBe('hate speech');
  });

  it('keeps short spaced runs like A B testing', () => {
    expect(collapseSpacedLetters('A B testing')).toBe('A B testing');
    expect(collapseSpacedLetters('r u ok')).toBe('r u ok');
  });

  it('collapses repeated spaces', () => {
    expect(normalizeStory('  too    many   spaces ')).toBe('too many spaces');
  });
});
