import { ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.TABLE_NAME = 'stories';
process.env.POSTMORTEM_MODEL_ID = 'us.anthropic.claude-sonnet-5-5';
process.env.GUARDRAIL_ID = 'gr';
process.env.GUARDRAIL_VERSION = '1';

const bedrockMock = mockClient(BedrockRuntimeClient);
const docMock = mockClient(DynamoDBDocumentClient);
const usage = { contentPolicyUnits: 1, topicPolicyUnits: 1, sensitiveInformationPolicyUnits: 1, sensitiveInformationPolicyFreeUnits: 0, wordPolicyUnits: 0, contextualGroundingPolicyUnits: 0 };
const statusWrites = () =>
  docMock.commandCalls(UpdateCommand).map((c) => c.args[0].input).filter((i) => i.Key?.id === 'story-0001');

beforeEach(() => {
  bedrockMock.reset();
  docMock.reset();
  docMock.on(GetCommand).resolves({ Item: { id: 'story-0001', status: 'published', text: 'It was DNS', category: 'it_was_dns', fear_level: 7 } });
  docMock.on(UpdateCommand).resolves({});
  bedrockMock.on(ConverseCommand).resolves({
    output: { message: { role: 'assistant', content: [{ text: '## Summary\nIt was DNS.' }] } },
    usage: { inputTokens: 800, outputTokens: 900, totalTokens: 1700 },
    stopReason: 'end_turn',
    metrics: { latencyMs: 1 },
  });
});

describe('postmortem worker', () => {
  it('stores a postmortem that passes review', async () => {
    bedrockMock.on(ApplyGuardrailCommand).resolves({ action: 'NONE', outputs: [], assessments: [], usage });
    const { handler } = await import('../src/handlers/postmortem-worker.js');
    await handler({ storyId: 'story-0001' });
    expect(statusWrites().at(-1)!.ExpressionAttributeValues).toMatchObject({ ':d': 'done', ':t': '## Summary\nIt was DNS.' });
    expect(bedrockMock.commandCalls(ApplyGuardrailCommand)[0].args[0].input.source).toBe('OUTPUT');
  });

  it('marks the postmortem blocked when the Guardrail rejects it', async () => {
    bedrockMock.on(ApplyGuardrailCommand).resolves({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'Blocked by moderation' }],
      assessments: [{ topicPolicy: { topics: [{ name: 'SelfHarmJokes', type: 'DENY', action: 'BLOCKED' }] } }],
      usage,
    });
    const { handler } = await import('../src/handlers/postmortem-worker.js');
    await handler({ storyId: 'story-0001' });
    expect(statusWrites().at(-1)!.ExpressionAttributeValues).toEqual({ ':b': 'blocked' });
  });
});
