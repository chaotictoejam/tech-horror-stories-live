import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PROFANITY_LIMIT, STORY_MAX_CHARS } from '../../config/app-config.js';
import { countProfanity } from '../shared/censor.js';
import { classifyShortText } from '../shared/heckle.js';
import type { GraveyardReason } from '../shared/schema.js';
import { log } from '../shared/log.js';
import { normalizeStory } from '../shared/normalize.js';

const s3 = new S3Client({});

export interface LoadStoryInput {
  bucket: string;
  key: string;
}

export interface LoadedStory {
  storyId: string;
  createdAt: string;
  /** Empty unless the story is usable. Unmoderated text never travels to the Graveyard. */
  text: string;
  usable: boolean;
  reason?: GraveyardReason;
  /** Why it is unusable, for the Graveyard quip: blank, gibberish, too_long, profanity, heckle, chatter, unreadable. */
  detail?: string;
}

const KEY_PATTERN = /^stories\/([A-Za-z0-9-]{8,64})\.json$/;

/** True when text has fewer than 3 word-like tokens (letters with at least one vowel). */
export function isGibberish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z][a-z']+/g) ?? [];
  const real = words.filter((w) => /[aeiouy]/.test(w) && !/(.)\1{3,}/.test(w));
  return real.length < 3;
}

export function assess(text: unknown): { usable: boolean; reason?: GraveyardReason; detail?: string } {
  if (typeof text !== 'string' || text.trim().length === 0) return { usable: false, reason: 'empty', detail: 'blank' };
  if (text.length > STORY_MAX_CHARS) return { usable: false, reason: 'too_long', detail: 'too_long' };
  // Before the gibberish check, so "test" or "booo" gets the chatter or heckle quip.
  const notAStory = classifyShortText(text);
  if (notAStory) return { usable: false, reason: 'not_a_story', detail: notAStory };
  if (isGibberish(text)) return { usable: false, reason: 'empty', detail: 'gibberish' };
  // A couple of swear words get censored on the board. A torrent of them gets buried.
  if (countProfanity(text) >= PROFANITY_LIMIT) return { usable: false, reason: 'moderation_blocked', detail: 'profanity' };
  return { usable: true };
}

export const handler = async (input: LoadStoryInput): Promise<LoadedStory> => {
  const match = KEY_PATTERN.exec(input.key);
  const storyId = match?.[1] ?? (input.key.replace(/[^A-Za-z0-9-]/g, '').slice(-64) || 'unknown');
  if (!match) {
    log.warn('unexpected key', { key: input.key });
    return { storyId, createdAt: new Date().toISOString(), text: '', usable: false, reason: 'other', detail: 'unreadable' };
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
  const body = (await obj.Body?.transformToString()) ?? '';

  let doc: { text?: unknown; createdAt?: unknown };
  try {
    doc = JSON.parse(body);
  } catch {
    log.warn('story is not JSON', { storyId });
    return { storyId, createdAt: new Date().toISOString(), text: '', usable: false, reason: 'other', detail: 'unreadable' };
  }

  const createdAt = typeof doc.createdAt === 'string' ? doc.createdAt : new Date().toISOString();
  // Undo filter-evasion tricks before any check runs.
  if (typeof doc.text === 'string') doc.text = normalizeStory(doc.text);
  const verdict = assess(doc.text);
  log.info('story loaded', { storyId, usable: verdict.usable, reason: verdict.reason, detail: verdict.detail, length: typeof doc.text === 'string' ? doc.text.length : 0 });
  return { storyId, createdAt, text: verdict.usable ? (doc.text as string).trim() : '', detail: '', ...verdict };
};
