// Display-time censoring. Profanity is allowed through the pipeline (the model sees the original
// text and the Guardrail only blocks hate, threats, sexual content, and personal data). The board
// masks it on the way out: "fucking" becomes "f******".
const STEMS = [
  'motherfuck\\w*',
  'fuck\\w*',
  'bullshit\\w*',
  'shit(?:s|ty|ting|ted|show|head|storm)?',
  'asshole\\w*',
  'ass',
  'bitch\\w*',
  'bastard\\w*',
  'dick\\w*head',
  'dickhead',
  'piss\\w*',
  'cunt\\w*',
  'goddamn\\w*',
  'damn\\w*',
  'wtf',
];

const PATTERN = new RegExp(`\\b(?:${STEMS.join('|')})\\b`, 'gi');

export function censor(text: string): string;
export function censor(text: string | undefined): string | undefined;
export function censor(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(PATTERN, (word) => word[0] + '*'.repeat(word.length - 1));
}
