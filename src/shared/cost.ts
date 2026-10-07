import { GUARDRAIL_PRICES, MODEL_PRICES } from '../../config/prices.js';

export function priceFor(modelId: string) {
  // Longest key first so "claude-sonnet-5-5" wins over "claude-sonnet-5".
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => modelId.includes(k));
  return key ? MODEL_PRICES[key] : undefined;
}

/** USD cost of one model call. Unknown models cost 0 and are flagged by the caller. */
export function tokenCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return round6((inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000);
}

export interface GuardrailUsage {
  contentPolicyUnits?: number;
  topicPolicyUnits?: number;
  sensitiveInformationPolicyUnits?: number;
  wordPolicyUnits?: number;
}

export function guardrailUnits(u: GuardrailUsage): number {
  return (u.contentPolicyUnits ?? 0) + (u.topicPolicyUnits ?? 0) + (u.sensitiveInformationPolicyUnits ?? 0) + (u.wordPolicyUnits ?? 0);
}

export function guardrailCost(u: GuardrailUsage): number {
  return round6(
    ((u.contentPolicyUnits ?? 0) * GUARDRAIL_PRICES.contentPolicyPer1kUnits +
      (u.topicPolicyUnits ?? 0) * GUARDRAIL_PRICES.topicPolicyPer1kUnits +
      (u.sensitiveInformationPolicyUnits ?? 0) * GUARDRAIL_PRICES.sensitiveInformationPolicyPer1kUnits +
      (u.wordPolicyUnits ?? 0) * GUARDRAIL_PRICES.wordPolicyPer1kUnits) /
      1000,
  );
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
