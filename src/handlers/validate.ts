import { log } from '../shared/log.js';
import { validateClassification, type Classification } from '../shared/schema.js';
import type { ClassifyOutput } from './classify.js';

export class InvalidModelOutput extends Error {
  constructor(message: string) {
    super(message);
    // Step Functions matches Retry and Catch on this name.
    this.name = 'InvalidModelOutput';
  }
}

export type ValidateOutput = Classification & Omit<ClassifyOutput, 'raw'>;

export const handler = async (input: ClassifyOutput): Promise<ValidateOutput> => {
  const result = validateClassification(input.raw ?? '');
  if (!result.ok) {
    log.warn('invalid model output', { error: result.error });
    throw new InvalidModelOutput(result.error);
  }
  const { raw: _raw, ...usage } = input;
  return { ...result.data, ...usage };
};
