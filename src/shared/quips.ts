// Deadpan one-liners for the Graveyard, picked by what actually went wrong. Fixed text, never
// model-generated: a model would have to read the blocked story to riff on it.
//
// Keys are a Graveyard reason, or "reason/detail" for something more specific. Detail values come
// from the pipeline: Load Story checks, Guardrail policies ("content:HATE", "topic:Threats"), and
// model output blocks ("output:...").
const QUIPS: Record<string, string[]> = {
  // Too much swearing
  'moderation_blocked/profanity': [
    "Come on, we're professionals. Allegedly.",
    'Your incident report has been returned for a vocabulary review.',
    "That's a lot of words HR would like a word about.",
  ],
  // Guardrail content filters
  'moderation_blocked/content:HATE': ['Bigotry is not a supported deployment target.', "That's not a hot take, that's a rollback."],
  'moderation_blocked/content:SEXUAL': ['Wrong kind of hot fix.', 'This is a tech conference, not that kind of incident.'],
  'moderation_blocked/content:VIOLENCE': ['Please direct all violence at the legacy codebase.', 'Violence is never the answer. The answer is usually DNS.'],
  'moderation_blocked/content:INSULTS': ["Blameless postmortem. It's right there in the name.", 'We blame systems here, not humans.'],
  'moderation_blocked/content:MISCONDUCT': ['Legal has entered the chat. Legal has left the chat.', 'Sounds like a story for your lawyer, not the projector.'],
  'moderation_blocked/content:PROMPT_ATTACK': [
    'Ignore previous instructions? Ignored.',
    'Nice try. The AI has been warned about people like you.',
    'Prompt injection detected. Your pentest report is in the mail.',
  ],
  // Guardrail topics
  'moderation_blocked/topic:Threats': ['Threats are not an escalation path. Try the on-call rotation.', 'Take a breath. Then take a ticket.'],
  'moderation_blocked/topic:IdentifiablePerson': ['We blame systems, not the person in row 3.', 'Blameless means blameless. Even for them.'],
  'moderation_blocked/topic:CompanyAccusation': ['Our lawyers read this and fainted.', 'Allegedly. Very, very allegedly.'],
  // Personal data, secrets
  'moderation_blocked/pii': [
    'You leaked personal data at a talk about data pipelines. Iconic.',
    'Rule one of a leaked secret story: do not leak the secret.',
  ],
  'moderation_blocked': ['The moderator had a gut feeling about this one.', 'Blocked by moderation. You know what you did.'],

  // Load Story checks
  'empty/blank': ['A bold story about nothing. Very minimalist.', 'The quietest incident report we have ever received.'],
  'empty/gibberish': ['Did you deploy your keyboard to prod?', 'This looks like a base64 string that gave up.'],
  'empty': ['We could not find a story in there. We looked.'],
  'too_long': ['We said 280 characters. That is the real incident here.'],

  // The model's fault
  'invalid_model_output/schema': ["The AI returned something that wasn't JSON. Relatable.", 'Even the model could not classify this one. It needs a minute.'],
  'invalid_model_output': ["The AI got a little too creative. We've had a talk with it.", 'The model wrote something it should not have. It has been sent to training.'],

  // Ours
  'other/moderation_down': ['Moderation was down, so we played it safe. Very enterprise of us.'],
  'other': ['The pipeline had its own incident. How meta.', 'Something broke. We will write a postmortem about it.'],
  'removed': ['The presenter pressed the big red button.', 'Removed by a human. Some things even the AI will not touch.'],
};

function pick(options: string[], id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length];
}

/** A stable quip for one Graveyard entry. Same id, same quip, so it never flickers between polls. */
export function quipFor(entry: { id: string; reason?: string; detail?: string }): string {
  const reason = entry.reason ?? 'other';
  const detail = (entry.detail ?? '').replace(/^output:/, '');
  // Model output blocks always get the "model's fault" quips, whatever policy fired.
  if (entry.detail?.startsWith('output:')) return pick(QUIPS.invalid_model_output, entry.id);
  return pick(QUIPS[`${reason}/${detail}`] ?? QUIPS[reason] ?? QUIPS.other, entry.id);
}

export const ALL_QUIPS = QUIPS;
