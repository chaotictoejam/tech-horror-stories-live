// Per-model prices in USD per 1 million tokens. Update these when AWS changes Bedrock pricing.
// Keys are matched against the Bedrock model ID with `includes`, so one entry covers the
// regional and cross-region (us., eu., global.) inference profile IDs of the same model.
// Check https://aws.amazon.com/bedrock/pricing/ before the talk.
export const MODEL_PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  'claude-sonnet-5-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-opus-5-5': { inputPerMTok: 4.0, outputPerMTok: 20.0 },
};

// Bedrock Guardrails prices in USD per 1,000 text units (1 text unit = up to 1,000 characters).
export const GUARDRAIL_PRICES = {
  contentPolicyPer1kUnits: 0.15,
  topicPolicyPer1kUnits: 0.15,
  sensitiveInformationPolicyPer1kUnits: 0.1,
  wordPolicyPer1kUnits: 0,
};
