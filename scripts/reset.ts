// Clears the board before the talk: every story, Graveyard record, cached postmortem, and the
// running token and cost counter. Also empties the Graveyard SQS queue. Infrastructure, the
// presenter key, and the kill switch are left alone. Step Functions history stays until teardown.
//
//   npm run reset            asks you to type "reset"
//   npm run reset -- --yes   no prompt
import { CloudFormationClient, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn';
import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createInterface } from 'node:readline/promises';
import { PREFIX } from '../config/app-config.js';
import { clearStories } from '../src/shared/reset.js';
import { arg, loadOutputs } from './outputs.js';

const outputs = await loadOutputs();
if (!outputs.storiesTable) throw new Error('StoriesTableName output missing. Redeploy with npm run deploy.');

if (outputs.stateMachineArn) {
  const running = await new SFNClient({}).send(
    new ListExecutionsCommand({ stateMachineArn: outputs.stateMachineArn, statusFilter: 'RUNNING', maxResults: 10 }),
  );
  if (running.executions?.length) {
    console.log(`${running.executions.length} execution(s) still running. They would write to the board after the reset.`);
    console.log('Close submissions (npm run kill), wait a few seconds, then try again.');
    process.exit(1);
  }
}

if (!arg('yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This deletes every story and zeroes the counter on ${outputs.boardUrl}\nType "reset" to continue: `);
  rl.close();
  if (answer.trim() !== 'reset') {
    console.log('Aborted. Nothing was deleted.');
    process.exit(1);
  }
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const deleted = await clearStories(ddb, outputs.storiesTable);
console.log(`Deleted ${deleted} items (stories, Graveyard, postmortems, counter).`);

// The Graveyard queue is not shown on the board, but empty it too so the console matches.
const resources = await new CloudFormationClient({}).send(new ListStackResourcesCommand({ StackName: `${PREFIX}Pipeline` }));
const queueUrl = resources.StackResourceSummaries?.find((r) => r.ResourceType === 'AWS::SQS::Queue')?.PhysicalResourceId;
if (queueUrl) {
  try {
    await new SQSClient({}).send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    console.log('Purged the Graveyard queue.');
  } catch (err) {
    // SQS allows one purge per 60 seconds.
    console.log(`Graveyard queue not purged: ${(err as Error).message}`);
  }
}
console.log('Board is clean. Run npm run seed to load the seed stories.');
