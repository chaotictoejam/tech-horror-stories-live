// Display-time censoring. Profanity is allowed through the pipeline (the model sees the original
// text and the Guardrail only blocks hate, threats, sexual content, and personal data). The board
// masks it on the way out: "fucking" becomes "f******". Common letter swaps (sh1t, f*ck) and
// spaced-out spellings (f u c k) are caught too.
import { collapseSpacedLetters } from './normalize.js';

// Base words with the suffixes that are still profane. Leet swaps are added below.
const WORDS: [string, string][] = [
  ['motherfuck', '(?:er|ers|ing|in)?'],
  ['fuck', '(?:s|ed|er|ers|ing|in|face|wit|up|ups)?'],
  ['bullshit', '(?:s|ting|ted)?'],
  ['shit', '(?:s|ty|ting|ted|show|head|storm)?'],
  ['asshole', 's?'],
  ['ass', '(?:es|hat|hats)?'],
  ['bitch', '(?:es|ing|y)?'],
  ['bastard', 's?'],
  ['dickhead', 's?'],
  ['piss', '(?:ed|ing)?'],
  ['cunt', 's?'],
  ['goddamn', '(?:it|ed)?'],
  ['damn', '(?:it|ed)?'],
  ['wtf', ''],
];

// Characters people swap in for letters. Only the swaps that keep words readable.
const LEET: Record<string, string> = {
  a: '[a@4]', e: '[e3]', i: '[i1!]', o: '[o0]', s: '[s$5]', t: '[t7]', u: '[u*v]', c: '[c(]',
};

const letters = (w: string) => [...w].map((ch) => LEET[ch] ?? ch).join('');
const PATTERN = new RegExp(`(?<![A-Za-z0-9])(?:${WORDS.map(([w, sfx]) => letters(w) + sfx).join('|')})(?![A-Za-z0-9])`, 'gi');

const mask = (word: string) => word[0] + '*'.repeat(word.length - 1);

export function censor(text: string): string;
export function censor(text: string | undefined): string | undefined;
export function censor(text: string | undefined): string | undefined {
  if (!text) return text;
  return collapseSpacedLetters(text).replace(PATTERN, mask);
}

/** How many profane words a text contains, counting the same evasions censor() catches. */
export function countProfanity(text: string): number {
  return collapseSpacedLetters(text).match(PATTERN)?.length ?? 0;
}
