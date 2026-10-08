# Deploying

Everything you need to run your own copy in an AWS account.

## Prerequisites

1. Node 22 and the AWS CLI, signed in to the account you will present from (`aws sts get-caller-identity`).
2. CDK bootstrap in that account and region, once: `npx cdk bootstrap`.
3. **Bedrock model access** in the deploy region. By default both models are called through US cross-region inference profiles:
   - Classifier: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5)
   - Postmortem: `us.anthropic.claude-sonnet-4-6` (Claude Sonnet 4.6)

   If your account has never used Anthropic models on Bedrock, submit the one-time use case form in the Bedrock console first.

   **Invoke each model once yourself.** The first call to an Anthropic model in an account quietly subscribes the account to it through AWS Marketplace, and the caller needs `aws-marketplace:Subscribe`. The Lambda roles only have `bedrock:InvokeModel`, so if a Lambda makes that first call it fails with `AccessDeniedException ... AWS Marketplace actions`. Call each model once with your own admin credentials before the demo, then wait about 5 minutes:
   ```bash
   for m in us.anthropic.claude-haiku-4-5-20251001-v1:0 us.anthropic.claude-sonnet-4-6; do
     aws bedrock-runtime converse --model-id "$m" --messages '[{"role":"user","content":[{"text":"hi"}]}]' --inference-config maxTokens=10 --query stopReason
   done
   ```

   **Check quotas, not just access.** A model can be listed as ACTIVE and still have a quota of 0. New accounts start with 0 tokens per minute for Claude 5.x models on Bedrock, which is why the postmortem defaults to Sonnet 4.6. New accounts also get only 10 concurrent Lambda executions; request 1,000 in Service Quotas (Lambda, "Concurrent executions") a few days before the talk. Haiku 4.5 allows 50 requests per minute by default; the pipeline retries patiently on throttling, so a burst arrives late rather than in the Graveyard.
   ```bash
   aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions
   aws service-quotas list-service-quotas --service-code bedrock --query "Quotas[?contains(QuotaName,'Cross-region model inference')&&contains(QuotaName,'Claude')].[QuotaName,Value]" --output text
   ```

   Confirm the exact profile IDs your account sees:
   ```bash
   aws bedrock list-inference-profiles --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId"
   ```
4. Bedrock Guardrails must be available in the region (they are in us-east-1 and us-west-2).

## Configuration

Model IDs, the alert email, and the budget come from CDK context or environment variables (env wins):

| Setting | Context key | Env var | Default |
|---|---|---|---|
| Classifier model | `classifierModelId` | `CLASSIFIER_MODEL_ID` | Haiku 4.5 US profile |
| Postmortem model | `postmortemModelId` | `POSTMORTEM_MODEL_ID` | Sonnet 4.6 US profile |
| Alarm and budget email | `alertEmail` | `ALERT_EMAIL` | none (budget still alerts the SNS topic) |
| Monthly budget (USD) | `budgetUsd` | `BUDGET_USD` | 5 |

Example: `npm run deploy -- -c alertEmail=you@example.com -c postmortemModelId=us.anthropic.claude-opus-5-5`

Model prices live in [config/prices.ts](../config/prices.ts). Update them if Bedrock pricing changes. A model without a price entry is counted as $0.

## Deploy, test, tear down

```bash
npm install
npm test                 # unit tests + the state machine run locally against mocked Bedrock
npm run synth            # cdk synth, all three stacks
npm run deploy           # cdk deploy --all, writes cdk-outputs.json for the scripts
npm run presenter-key    # creates the key and prints the presenter board URL
npm run qr               # QR codes in qr/
npm run seed             # 22 stories through the real API
npm run teardown         # after the talk
```

| Script | What it does |
|---|---|
| `npm run seed [-- --fast]` | Submits the 22 seed stories (15 good, two with a little swearing that the board censors; 2 empty or gibberish; 1 personal data; 1 heckle; 1 with too much swearing; 2 prompt injections) |
| `npm run qr` | `qr/submit-slide.{png,svg}` (1600px) and `qr/submit-corner.{png,svg}` (200px) for the submit URL |
| `npm run admin` | Local presenter page: bury or restore stories, open or close submissions |
| `npm run reset` | Empties the board: every story, Graveyard entry, cached postmortem, and the cost counter. Asks you to type `reset`. Infrastructure, presenter key, and kill switch are untouched |
| `npm run kill` | Submit endpoint returns 503 "Submissions closed" immediately |
| `npm run reopen` | Opens submissions again |
| `npm run presenter-key` | Rotates the presenter key in SSM and prints `board.html#key=...` |
| `npm run replay -- --record` | Saves the live board and cached postmortems to `replay/recording.json` |
| `npm run replay` | Offline board at `http://localhost:8080/board.html#key=replay` |
| `npm run teardown` | `cdk destroy --all`, deletes the presenter key and local outputs |

## Cost

**The counter on the board is real.** Every Bedrock call (Guardrail, classify including retries, and postmortem) adds the token or text-unit usage returned by Bedrock to a running total in DynamoDB, priced with [config/prices.ts](../config/prices.ts).

Rough model cost for 60 people x 3 stories (180 stories):

| Item | Estimate |
|---|---|
| Guardrail (story and model output, 1 text unit each) | about $0.15 |
| Classify (about 650 input, 70 output tokens on Haiku 4.5) | about $0.18 |
| Postmortems (5 runs on Sonnet 4.6) | about $0.10 |
| **Total shown on the counter** | **about $0.50** |

**Not included in the counter:** Step Functions transitions, Lambda, API Gateway, DynamoDB, S3, EventBridge, SQS, CloudFront, CloudWatch. Rough figures for the same session:

| Service | Estimate |
|---|---|
| Step Functions Standard (about 10 transitions per story, 1,800 total; 4,000 per month are free) | $0 to $0.05 |
| Lambda, API Gateway, DynamoDB, S3, EventBridge, SQS, CloudFront (board polling every 2s for an hour is about 1,800 requests) | under $0.05 combined |
| CloudWatch alarms (9 alarms at $0.10 per month, prorated) | about $0.03 per day while deployed |

The whole talk should come in well under $1. Tear down afterwards so the alarms stop accruing. The $5 Budget alerts at 80% actual and 100% forecast.

