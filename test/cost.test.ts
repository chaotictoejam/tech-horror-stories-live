import { describe, expect, it } from 'vitest';
import { guardrailCost, guardrailUnits, priceFor, tokenCost } from '../src/shared/cost.js';

describe('cost calculator', () => {
  it('prices Haiku 4.5 through a cross-region profile id', () => {
    // 1M in at $1 + 1M out at $5
    expect(tokenCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', 1_000_000, 1_000_000)).toBe(6);
  });

  it('prices a typical classify call', () => {
    expect(tokenCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', 600, 80)).toBeCloseTo(0.001, 6);
  });

  it('prefers the most specific price key', () => {
    expect(priceFor('us.anthropic.claude-sonnet-5-5')).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(priceFor('anthropic.claude-sonnet-4-6')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it('returns 0 for unknown models', () => {
    expect(tokenCost('amazon.mystery-model', 1000, 1000)).toBe(0);
  });

  it('prices guardrail text units per policy', () => {
    const usage = { contentPolicyUnits: 1, topicPolicyUnits: 1, sensitiveInformationPolicyUnits: 1 };
    expect(guardrailUnits(usage)).toBe(3);
    expect(guardrailCost(usage)).toBeCloseTo(0.0004, 6);
  });
});
