import { ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PipelineStack } from '../lib/pipeline-stack.js';
import { SEED_STORIES } from '../scripts/stories.js';
import { AslRunner, resolveDefinition } from './support/asl-runner.js';

process.env.TABLE_NAME = 'stories-test';
process.env.CLASSIFIER_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
process.env.GUARDRAIL_ID = 'gr-test';
process.env.GUARDRAIL_VERSION = '1';
process.env.MASK_GUARDRAIL_ID = 'gr-mask';
process.env.MASK_GUARDRAIL_VERSION = '1';
process.env.AWS_REGION = 'us-east-1';

const bedrockMock = mockClient(BedrockRuntimeClient);
const s3Mock = mockClient(S3Client);
const docMock = mockClient(DynamoDBDocumentClient);

const GOOD = {
  category: 'it_was_dns',
  fear_level: 7,
  root_cause: 'One week TTL on a record',
  survivable: true,
  is_story: true,
  one_liner: 'Local team discovers DNS, regrets it',
};

const converseReply = (text: string) => ({
  output: { message: { role: 'assistant' as const, content: [{ text }] } },
  usage: { inputTokens: 612, outputTokens: 71, totalTokens: 683 },
  stopReason: 'end_turn' as const,
  metrics: { latencyMs: 1 },
});

let definition: any;
let handlers: Record<string, (input: any) => Promise<any>>;
// Fake service integrations: what the state machine wrote directly to DynamoDB and SQS.
let putItems: any[];
let sqsMessages: any[];

function runner() {
  return new AslRunner(definition, async (resource, input) => {
    if (resource.endsWith(':states:::dynamodb:putItem')) {
      putItems.push(input.Item);
      return {};
    }
    if (resource.endsWith(':states:::sqs:sendMessage')) {
      sqsMessages.push(input.MessageBody);
      return { MessageId: 'm-1' };
    }
    const fn = Object.keys(handlers).find((prefix) => resource.includes(`:${prefix}`));
    if (!fn) throw new Error(`no handler for ${resource}`);
    return handlers[fn](structuredClone(input));
  });
}

function storyObject(text: string, id = 'abcd1234-0000') {
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => JSON.stringify({ id, text, createdAt: '2026-10-07T12:00:00.000Z' }) } as any,
  });
  return { bucket: 'raw', key: `stories/${id}.json` };
}

const graveyardReason = () => putItems.find((i) => i.status.S === 'graveyard')?.reason.S;
const graveyardDetail = () => putItems.find((i) => i.status.S === 'graveyard')?.detail.S;
const published = () => putItems.find((i) => i.status.S === 'published');

beforeAll(async () => {
  // Skip esbuild bundling: we only need the definition.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const base = new Stack(app, 'Base');
  const pipeline = new PipelineStack(app, 'Pipeline', {
    config: { classifierModelId: process.env.CLASSIFIER_MODEL_ID!, postmortemModelId: 'x', alertEmail: '', budgetUsd: 5 },
    rawBucket: new s3.Bucket(base, 'Raw'),
    alertTopic: new sns.Topic(base, 'Topic'),
  });
  const template = Template.fromStack(pipeline).toJSON();
  const sm = Object.values<any>(template.Resources).find((r) => r.Type === 'AWS::StepFunctions::StateMachine');
  definition = resolveDefinition(sm.Properties.DefinitionString);

  handlers = {
    LoadStoryFn: (await import('../src/handlers/load-story.js')).handler,
    ModerateFn: (await import('../src/handlers/moderate.js')).handler,
    ClassifyFn: (await import('../src/handlers/classify.js')).handler,
    ValidateFn: (await import('../src/handlers/validate.js')).handler,
    ModerateOutputFn: (await import('../src/handlers/moderate-output.js')).handler,
  };
});

beforeEach(() => {
  bedrockMock.reset();
  s3Mock.reset();
  docMock.reset();
  docMock.on(UpdateCommand).resolves({});
  bedrockMock.on(ApplyGuardrailCommand).resolves({
    action: 'NONE',
    outputs: [],
    assessments: [],
    usage: { contentPolicyUnits: 1, topicPolicyUnits: 1, sensitiveInformationPolicyUnits: 1, wordPolicyUnits: 0, sensitiveInformationPolicyFreeUnits: 0, contextualGroundingPolicyUnits: 0 },
  });
  bedrockMock.on(ConverseCommand).resolves(converseReply(JSON.stringify(GOOD)));
  putItems = [];
  sqsMessages = [];
});

describe('state machine definition', () => {
  it('is a Standard workflow with the expected states', () => {
    expect(Object.keys(definition.States).sort()).toEqual(
      [
        'Apply Redactions',
        'Classify and Validate',
        'Is Story Usable?',
        'Load Story',
        'Moderate',
        'Moderate Output',
        'Output Passed?',
        'Passed Moderation?',
        'Publish to Board',
        'Published',
        'Reason: Invalid Model Output',
        'Reason: Moderation Unavailable',
        'Reason: Not a Story',
        'Is It a Story?',
        'Reason: Output Blocked',
        'Reason: Pipeline Error',
        'Reason: Unreadable Story',
        'Redact Blocked Story',
        'Rejected',
        'Send to Graveyard',
      ].sort(),
    );
  });

  it('retries classify and validate together up to 2 times on InvalidModelOutput', () => {
    expect(definition.States['Classify and Validate'].Retry).toEqual([
      expect.objectContaining({ ErrorEquals: ['InvalidModelOutput'], MaxAttempts: 2 }),
    ]);
  });
});

describe('pipeline execution (mocked Bedrock)', () => {
  it('publishes a good story with tokens and cost', async () => {
    const res = await runner().run(storyObject('The site was down for 6 hours. It was DNS. The TTL was a week.'));
    expect(res.status).toBe('SUCCEEDED');
    expect(res.path).toEqual(['Load Story', 'Is Story Usable?', 'Moderate', 'Passed Moderation?', 'Apply Redactions', 'Classify and Validate', 'Classify', 'Validate Output', 'Is It a Story?', 'Moderate Output', 'Output Passed?', 'Publish to Board', 'Published']);
    const item = published();
    expect(item.category.S).toBe('it_was_dns');
    expect(item.fear_level.N).toBe('7');
    expect(item.survivable.BOOL).toBe(true);
    expect(item.input_tokens.N).toBe('612');
    expect(item.output_tokens.N).toBe('71');
    expect(Number(item.cost_usd.N)).toBeCloseTo((612 * 1 + 71 * 5) / 1e6, 6);
    expect(Number(item.moderation_cost_usd.N)).toBeCloseTo(0.0008, 6);
    // Input check, masking, classify, and output check are all recorded in the running totals.
    expect(docMock.commandCalls(UpdateCommand)).toHaveLength(4);
  });

  it.each([
    ['empty', 'blank', '   '],
    ['empty', 'gibberish', 'asdfjkl;;; qwrtzp xxxx 12345 !!!! zzzzzzz'],
    ['too_long', 'too_long', 'a story '.repeat(40)],
    ['moderation_blocked', 'profanity', 'Fucking Jenkins. Fucking YAML. Shit broke at 2am and nobody answered.'],
    ['not_a_story', 'heckle', 'This is dumb'],
    ['not_a_story', 'chatter', 'test'],
  ])('sends %s (%s) input to the Graveyard without calling Bedrock', async (reason, detail, text) => {
    const res = await runner().run(storyObject(text));
    expect(res.status).toBe('SUCCEEDED');
    expect(res.path.at(-1)).toBe('Rejected');
    expect(graveyardReason()).toBe(reason);
    expect(graveyardDetail()).toBe(detail);
    expect(putItems.find((i) => i.status.S === 'graveyard').text.S).toBe('');
    expect(bedrockMock.calls()).toHaveLength(0);
    expect(sqsMessages[0]).toMatchObject({ reason, detail });
  });

  it('redacts stories blocked by moderation', async () => {
    bedrockMock.on(ApplyGuardrailCommand).resolves({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'Blocked by moderation' }],
      assessments: [{ sensitiveInformationPolicy: { piiEntities: [{ type: 'EMAIL', match: 'x', action: 'BLOCKED' }], regexes: [] } }],
      usage: { contentPolicyUnits: 1, topicPolicyUnits: 1, sensitiveInformationPolicyUnits: 1, wordPolicyUnits: 0, sensitiveInformationPolicyFreeUnits: 0, contextualGroundingPolicyUnits: 0 },
    });
    const res = await runner().run(storyObject('email me at someone@example.com about the outage please'));
    expect(res.path).toContain('Redact Blocked Story');
    expect(graveyardReason()).toBe('moderation_blocked');
    expect(graveyardDetail()).toBe('pii');
    const grave = putItems.find((i) => i.status.S === 'graveyard');
    expect(grave.text.S).toBe('');
    expect(JSON.stringify(res.output)).not.toContain('someone@example.com');
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);
  });

  describe('names', () => {
    const anonymized = (masked: string, count = 1) => ({
      action: 'GUARDRAIL_INTERVENED' as const,
      outputs: [{ text: masked }],
      assessments: [
        {
          sensitiveInformationPolicy: {
            piiEntities: Array.from({ length: count }, () => ({ type: 'NAME' as const, match: 'x', action: 'ANONYMIZED' as const })),
            regexes: [],
          },
        },
      ],
      usage: { contentPolicyUnits: 1, topicPolicyUnits: 1, sensitiveInformationPolicyUnits: 1, sensitiveInformationPolicyFreeUnits: 0, wordPolicyUnits: 0, contextualGroundingPolicyUnits: 0 },
    });

    it('masks names before the model, the table, or the board see them', async () => {
      bedrockMock.on(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-mask' }).resolves(anonymized('{NAME} from ops dropped the prod database at 2am.'));
      const res = await runner().run(storyObject('Dave from ops dropped the prod database at 2am.'));
      expect(res.path).toContain('Apply Redactions');
      expect(res.path.at(-1)).toBe('Published');
      expect(published().text.S).toBe('[name] from ops dropped the prod database at 2am.');
      const prompt = bedrockMock.commandCalls(ConverseCommand)[0].args[0].input.messages![0].content![0].text!;
      expect(prompt).toContain('[name] from ops');
      expect(prompt).not.toContain('Dave');
    });

    it('keeps masked text when the story is later buried for bad model output', async () => {
      bedrockMock.on(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-mask' }).resolves(anonymized('{NAME} ran rm -rf on the wrong box.'));
      bedrockMock.on(ConverseCommand).resolves(converseReply('nope'));
      await runner().run(storyObject('Priya ran rm -rf on the wrong box.'));
      expect(graveyardReason()).toBe('invalid_model_output');
      expect(putItems.find((i) => i.status.S === 'graveyard').text.S).toBe('[name] ran rm -rf on the wrong box.');
    });

    it('blocks on the input check before masking runs', async () => {
      const hate = anonymized('Blocked by moderation', 0);
      hate.assessments = [{ contentPolicy: { filters: [{ type: 'HATE', confidence: 'HIGH', action: 'BLOCKED' }] } } as any];
      bedrockMock.on(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-test', source: 'INPUT' }).resolves(hate);
      await runner().run(storyObject('Some hateful story naming Dave'));
      expect(graveyardReason()).toBe('moderation_blocked');
      expect(bedrockMock.commandCalls(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-mask' })).toHaveLength(0);
    });

    it('masks audience text with source OUTPUT, because Bedrock ignores anonymize on INPUT', async () => {
      await runner().run(storyObject('Dave from ops dropped the prod database at 2am.'));
      const mask = bedrockMock.commandCalls(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-mask' });
      expect(mask).toHaveLength(1);
      expect(mask[0].args[0].input.source).toBe('OUTPUT');
    });

    it('fails closed on an intervention with no explanation', async () => {
      bedrockMock.on(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-mask' }).resolves({ ...anonymized('x', 0), assessments: [] });
      await runner().run(storyObject('A normal story that somehow tripped the guardrail'));
      expect(graveyardReason()).toBe('moderation_blocked');
    });
  });

  it('buries a longer heckle the classifier flags, without the output check or the board', async () => {
    bedrockMock.on(ConverseCommand).resolves(converseReply(JSON.stringify({ ...GOOD, is_story: false, category: 'other', fear_level: 1 })));
    const res = await runner().run(storyObject('Why are we even doing this, nobody in this room has ever run anything in production.'));
    expect(res.path).toContain('Reason: Not a Story');
    expect(res.path).not.toContain('Moderate Output');
    expect(graveyardReason()).toBe('not_a_story');
    expect(graveyardDetail()).toBe('model');
    expect(putItems.find((i) => i.status.S === 'graveyard').text.S).toBe('');
    expect(published()).toBeUndefined();
  });

  describe('model output moderation', () => {
    const guard = (over: Record<string, unknown>) => ({
      outputs: [],
      assessments: [],
      usage: { contentPolicyUnits: 1, topicPolicyUnits: 1, sensitiveInformationPolicyUnits: 1, sensitiveInformationPolicyFreeUnits: 0, wordPolicyUnits: 0, contextualGroundingPolicyUnits: 0 },
      ...over,
    });

    it('buries a story when the model wrote something the Guardrail blocks', async () => {
      bedrockMock.on(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-test', source: 'OUTPUT' }).resolves(
        guard({
          action: 'GUARDRAIL_INTERVENED',
          outputs: [{ text: 'Blocked by moderation' }],
          assessments: [{ topicPolicy: { topics: [{ name: 'SelfHarmJokes', type: 'DENY', action: 'BLOCKED' }] } }],
        }) as any,
      );
      const res = await runner().run(storyObject('The pager went off 40 times in one night and I was done with everything.'));
      expect(res.path).toContain('Reason: Output Blocked');
      expect(graveyardReason()).toBe('invalid_model_output');
      expect(graveyardDetail()).toBe('output:topic:SelfHarmJokes');
      expect(published()).toBeUndefined();
    });

    it('publishes the masked headline when the model names someone', async () => {
      bedrockMock.on(ApplyGuardrailCommand, { guardrailIdentifier: 'gr-test', source: 'OUTPUT' }).resolves(
        guard({
          action: 'GUARDRAIL_INTERVENED',
          outputs: [{ text: '{NAME} discovers DNS, regrets it\n\nOne week TTL on a record' }],
          assessments: [{ sensitiveInformationPolicy: { piiEntities: [{ type: 'NAME', match: 'x', action: 'ANONYMIZED' }], regexes: [] } }],
        }) as any,
      );
      await runner().run(storyObject('The site was down for 6 hours. It was DNS again.'));
      expect(published().one_liner.S).toBe('[name] discovers DNS, regrets it');
      expect(published().root_cause.S).toBe('One week TTL on a record');
    });

    it('normalizes evasion tricks before moderation sees the text', async () => {
      await runner().run(storyObject('pro\u200bduction went d o w n because \u0440rod was test'));
      const sent = bedrockMock.commandCalls(ApplyGuardrailCommand)[0].args[0].input.content![0].text!.text;
      expect(sent).toBe('production went down because prod was test');
    });
  });

  it('recovers when the first model output is invalid', async () => {
    bedrockMock
      .on(ConverseCommand)
      .resolvesOnce(converseReply('Sure! Here is a haiku about DNS instead.'))
      .resolves(converseReply(JSON.stringify(GOOD)));
    const res = await runner().run(storyObject('The site was down for 6 hours. It was DNS. Again.'));
    expect(res.path).toContain('Classify and Validate (retry 1)');
    expect(res.path.at(-1)).toBe('Published');
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('buries the story after 3 invalid outputs and still counts every call', async () => {
    bedrockMock.on(ConverseCommand).resolves(converseReply('{"category":"kubernetes","fear_level":99}'));
    const res = await runner().run(storyObject('Our pager went off for the pager service being down.'));
    expect(res.status).toBe('SUCCEEDED');
    expect(graveyardReason()).toBe('invalid_model_output');
    expect(graveyardDetail()).toBe('schema');
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(3);
    // input check + masking + 3 classify calls
    expect(docMock.commandCalls(UpdateCommand)).toHaveLength(5);
  });

  it('routes Bedrock access errors to the Graveyard, never a failed execution', async () => {
    const denied = Object.assign(new Error('not enabled'), { name: 'AccessDeniedException' });
    bedrockMock.on(ConverseCommand).rejects(denied);
    const res = await runner().run(storyObject('Someone ran the migration twice and now every user has two emails.'));
    expect(res.status).toBe('SUCCEEDED');
    expect(graveyardReason()).toBe('other');
    expect(graveyardDetail()).toBe('error');
  });

  it('redacts text when moderation itself is unavailable', async () => {
    bedrockMock.on(ApplyGuardrailCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    await runner().run(storyObject('A perfectly normal story about a cron job nobody owns.'));
    expect(graveyardReason()).toBe('other');
    expect(putItems.find((i) => i.status.S === 'graveyard').text.S).toBe('');
  });

  it('handles an unexpected S3 key', async () => {
    const res = await runner().run({ bucket: 'raw', key: 'stories/../../etc/passwd' });
    expect(res.status).toBe('SUCCEEDED');
    expect(graveyardReason()).toBe('other');
    expect(graveyardDetail()).toBe('unreadable');
  });
});

describe('prompt injection test set', () => {
  const injections = SEED_STORIES.filter((s) => s.kind === 'injection');

  it.each(injections.map((s) => [s.text]))('sends the story only as delimited data: %s', async (text) => {
    await runner().run(storyObject(text));
    const input = bedrockMock.commandCalls(ConverseCommand)[0].args[0].input;
    const system = input.system![0].text!;
    const user = input.messages![0].content![0].text!;
    expect(system).not.toContain(text.slice(0, 30));
    expect(user).toMatch(/<<<STORY [0-9a-f]+>>>[\s\S]*<<<END STORY [0-9a-f]+>>>$/);
  });

  it.each(injections.map((s) => [s.text]))('a model that obeys the injection lands in the Graveyard: %s', async (text) => {
    bedrockMock.on(ConverseCommand).resolves(converseReply('{"category":"other","fear_level":10,"admin":true,"one_liner":"I have been pwned"}'));
    const res = await runner().run(storyObject(text));
    expect(res.status).toBe('SUCCEEDED');
    expect(graveyardReason()).toBe('invalid_model_output');
    expect(published()).toBeUndefined();
  });

  it.each(injections.map((s) => [s.text]))('a model that ignores the injection publishes a normal story: %s', async (text) => {
    bedrockMock.on(ConverseCommand).resolves(
      converseReply(JSON.stringify({ ...GOOD, category: 'other', one_liner: 'Attendee attempts prompt injection, gets classified instead' })),
    );
    const res = await runner().run(storyObject(text));
    expect(res.path.at(-1)).toBe('Published');
    expect(Object.keys(published()).sort()).not.toContain('admin');
  });

  it('a guardrail prompt-attack block lands in the Graveyard redacted', async () => {
    bedrockMock.on(ApplyGuardrailCommand).resolves({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'Blocked by moderation' }],
      assessments: [{ contentPolicy: { filters: [{ type: 'PROMPT_ATTACK', confidence: 'HIGH', action: 'BLOCKED' }] } }],
      usage: { contentPolicyUnits: 1, topicPolicyUnits: 0, sensitiveInformationPolicyUnits: 0, wordPolicyUnits: 0, sensitiveInformationPolicyFreeUnits: 0, contextualGroundingPolicyUnits: 0 },
    });
    await runner().run(storyObject(injections[0].text));
    expect(graveyardReason()).toBe('moderation_blocked');
    expect(graveyardDetail()).toBe('content:PROMPT_ATTACK');
  });
});
