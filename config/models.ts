// Default Bedrock model IDs. Override with CDK context (-c classifierModelId=...) or the
// CLASSIFIER_MODEL_ID / POSTMORTEM_MODEL_ID environment variables at synth time.
export const DEFAULT_MODELS = {
  classifier: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Sonnet 5.5 was the first choice, but new accounts start with 0 tokens per minute of quota for
  // Claude 5.x models on Bedrock. Sonnet 4.6 has quota out of the box.
  postmortem: 'us.anthropic.claude-sonnet-4-6',
};
