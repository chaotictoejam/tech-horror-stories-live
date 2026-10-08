// Free, instant check for short heckles and chatter, before any model runs. Longer or subtler
// ones are caught by the classifier's is_story field.
//
// Only applies to very short submissions (6 words or fewer), so a real story that happens to
// say "boring" ("The demo was boring until prod caught fire") is never caught here, and a
// classic three word story ("It was DNS.") is never mistaken for chatter.
const MAX_WORDS = 6;

const HECKLE = [
  // "this is dumb", "this talk sucks", "your demo is boring"
  /\b(this|that|it|talk|demo|you|speaker|presentation|slides?|session)\b.*\b(dumb|stupid|boring|lame|sucks?|cringe|pointless|trash|garbage|awful|terrible|useless|overrated|mid)\b/,
  /^(boring|lame|cringe|mid|dumb|stupid|who cares|so what|get off( the)? stage|next slide|wake me up|is this (over|done) yet|when is lunch|do better|yawn)\b/,
  /^(b+o+o+|z{3,}|y+a+w+n+)\b/,
];

const CHATTER = /^(test(ing)?|hi|hello|hey|yo|lol|lmao|ok(ay)?|first|hi mom|asdf|sup|meow|\?+|!+)[.!? ]*$/;

export type NotAStory = 'heckle' | 'chatter';

export function classifyShortText(text: string): NotAStory | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const words = t.split(' ').filter(Boolean).length;
  if (words === 0 || words > MAX_WORDS) return undefined;
  if (CHATTER.test(t)) return 'chatter';
  if (HECKLE.some((re) => re.test(t))) return 'heckle';
  return undefined;
}
