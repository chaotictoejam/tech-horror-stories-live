// Normalize story text before any filter sees it, so tricks that fool a filter but still read
// fine to humans stop working. Runs once in Load Story; everything downstream sees this text.

// Invisible characters: zero-width spaces and joiners, word joiner, BOM, soft hyphen.
const INVISIBLE = /[­​-‍⁠﻿]/g;
// Bidirectional controls that can reverse or hide text on screen.
const BIDI = /[‪-‮⁦-⁩‎‏]/g;

// Cyrillic and Greek letters that look like Latin ones. Only applied inside words that also
// contain Latin letters, so genuine Cyrillic or Greek text is left alone.
const HOMOGLYPHS: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ј': 'j', 'һ': 'h', 'ԁ': 'd', 'А': 'A', 'В': 'B', 'Е': 'E',
  'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T',
  'Х': 'X', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v',
  'ρ': 'p', 'τ': 't', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H',
  'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
  'Υ': 'Y', 'Χ': 'X',
};
const HOMOGLYPH_CLASS = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

function foldHomoglyphs(text: string): string {
  return text.replace(/\S+/g, (word) =>
    /[A-Za-z]/.test(word) && HOMOGLYPH_CLASS.test(word) ? word.replace(HOMOGLYPH_CLASS, (c) => HOMOGLYPHS[c]) : word,
  );
}

// Four or more single letters split by the same separator ("f u c k", "s.h.i.t") become one word.
const SPACED = /(?<![A-Za-z0-9])([A-Za-z0-9@$!*])([ ._*-])(?:[A-Za-z0-9@$!*]\2){2,}[A-Za-z0-9@$!*](?![A-Za-z0-9])/g;

export function collapseSpacedLetters(text: string): string {
  return text.replace(SPACED, (run, _first, sep: string) => run.split(sep).join(''));
}

export function normalizeStory(text: string): string {
  return collapseSpacedLetters(foldHomoglyphs(text.normalize('NFKC').replace(INVISIBLE, '').replace(BIDI, '')))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
