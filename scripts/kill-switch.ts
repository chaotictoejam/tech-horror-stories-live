import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { loadOutputs } from './outputs.js';

export async function setSubmissions(open: boolean) {
  const { configTable } = await loadOutputs();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await ddb.send(
    new PutCommand({
      TableName: configTable,
      Item: { pk: 'config#submissions', open, updatedAt: new Date().toISOString() },
    }),
  );
  console.log(open ? 'Submissions are OPEN.' : 'Submissions are CLOSED. The submit endpoint now returns 503 "Submissions closed".');
}
