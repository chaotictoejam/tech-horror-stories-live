// Default Bedrock model IDs. Override with CDK context (-c classifierModelId=...) or the
// CLASSIFIER_MODEL_ID / POSTMORTEM_MODEL_ID environment variables at synth time.
export const DEFAULT_MODELS = {
  classifier: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  postmortem: 'us.anthropic.claude-sonnet-5-5',
};
