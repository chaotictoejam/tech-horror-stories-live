import type { App } from 'aws-cdk-lib';
import { DEFAULT_MODELS } from './models.js';

export interface AppConfig {
  classifierModelId: string;
  postmortemModelId: string;
  alertEmail: string;
  budgetUsd: number;
}

// Resolution order: environment variable, then CDK context, then the default.
export function loadConfig(app: App): AppConfig {
  const ctx = (key: string) => app.node.tryGetContext(key) as string | number | undefined;
  return {
    classifierModelId:
      process.env.CLASSIFIER_MODEL_ID || String(ctx('classifierModelId') || DEFAULT_MODELS.classifier),
    postmortemModelId:
      process.env.POSTMORTEM_MODEL_ID || String(ctx('postmortemModelId') || DEFAULT_MODELS.postmortem),
    alertEmail: process.env.ALERT_EMAIL || String(ctx('alertEmail') || ''),
    budgetUsd: Number(process.env.BUDGET_USD || ctx('budgetUsd') || 5),
  };
}

export const PREFIX = 'TechHorror';
export const STORY_MAX_CHARS = 280;
export const COOLDOWN_SECONDS = 20;
// A few swear words are censored on the board. This many or more sends the story to the Graveyard.
export const PROFANITY_LIMIT = 3;
export const PRESENTER_KEY_PARAM = '/tech-horror/presenter-key';
