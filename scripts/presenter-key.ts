// Creates (or rotates) the presenter key used by the Postmortem button and prints the board URL
// that carries it. The key lives in SSM Parameter Store as a SecureString.
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { randomBytes } from 'node:crypto';
import { PRESENTER_KEY_PARAM } from '../config/app-config.js';
import { loadOutputs } from './outputs.js';

const key = randomBytes(18).toString('base64url');
await new SSMClient({}).send(
  new PutParameterCommand({ Name: PRESENTER_KEY_PARAM, Value: key, Type: 'SecureString', Overwrite: true }),
);

let boardUrl = '<board url>';
try {
  boardUrl = (await loadOutputs()).boardUrl;
} catch {
  /* not deployed yet */
}
console.log(`Presenter key stored in ${PRESENTER_KEY_PARAM}. It takes up to a minute to reach warm Lambdas.`);
console.log(`Open this on the presenter laptop only (the key is removed from the address bar after load):\n\n  ${boardUrl}#key=${key}\n`);
