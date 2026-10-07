import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

export const bedrock = new BedrockRuntimeClient({});

export interface ConverseResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
}

export async function converse(opts: { modelId: string; system: string; user: string; maxTokens: number }): Promise<ConverseResult> {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: opts.modelId,
      system: [{ text: opts.system }],
      messages: [{ role: 'user', content: [{ text: opts.user }] }],
      // No temperature: newer Claude models reject non-default sampling parameters.
      inferenceConfig: { maxTokens: opts.maxTokens },
    }),
  );
  const text = (res.output?.message?.content ?? [])
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim();
  return {
    text,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
    stopReason: res.stopReason,
  };
}
