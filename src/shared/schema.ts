import { z } from 'zod';

export const CATEGORIES = [
  'friday_deploy',
  'no_backups',
  'leaked_secret',
  'prod_is_test',
  'spreadsheet_as_database',
  'mystery_cron_job',
  'rm_rf_moment',
  'it_was_dns',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const GRAVEYARD_REASONS = ['empty', 'moderation_blocked', 'invalid_model_output', 'too_long', 'other'] as const;
export type GraveyardReason = (typeof GRAVEYARD_REASONS)[number];

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// Strict: unknown keys are rejected, so story text can never add fields to the output.
export const ClassificationSchema = z
  .object({
    category: z.enum(CATEGORIES),
    fear_level: z.number().int().min(1).max(10),
    root_cause: z.string().trim().min(1).refine((s) => wordCount(s) <= 8, 'root_cause must be 8 words or fewer'),
    survivable: z.boolean(),
    one_liner: z
      .string()
      .trim()
      .min(1)
      .refine((s) => wordCount(s) <= 12, 'one_liner must be 12 words or fewer'),
  })
  .strict();
export type Classification = z.infer<typeof ClassificationSchema>;

/** Replace em and en dashes so nothing on the board renders one. */
export function stripDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ' - ');
}

/** Pull the first JSON object out of a model response that may include fences or prose. */
export function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export type ValidationResult = { ok: true; data: Classification } | { ok: false; error: string };

export function validateClassification(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    return { ok: false, error: `unparseable: ${(err as Error).message}` };
  }
  const result = ClassificationSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  }
  return {
    ok: true,
    data: { ...result.data, root_cause: stripDashes(result.data.root_cause), one_liner: stripDashes(result.data.one_liner) },
  };
}
