import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createHash, timingSafeEqual } from 'node:crypto';

const ssm = new SSMClient({});
let cached: { at: number; value: string | undefined } | undefined;

async function expectedKey(): Promise<string | undefined> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: process.env.PRESENTER_KEY_PARAM!, WithDecryption: true }));
    cached = { at: Date.now(), value: res.Parameter?.Value };
  } catch {
    // Missing parameter: fail closed.
    cached = { at: Date.now(), value: undefined };
  }
  return cached.value;
}

export function keysMatch(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function isPresenter(given: string | undefined): Promise<boolean> {
  return keysMatch(given, await expectedKey());
}
