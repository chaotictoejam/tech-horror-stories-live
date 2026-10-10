# Architecture

How the pieces fit together. For the big picture, start with the [README](../README.md).

## Stacks

| Stack | What is in it | Changes when |
|---|---|---|
| `TechHorrorIngestion` | Submit HTTP API (throttled), submit Lambda, raw story bucket (EventBridge on, 1 day expiry), config table (kill switch, cooldowns), alert SNS topic, $5 AWS Budget | Rarely |
| `TechHorrorPipeline` | Standard state machine (5 minute timeout), Load Story/Moderate/Classify/Validate/Moderate Output Lambdas, two Bedrock Guardrails (main and masking-only, each with a pinned version), stories table, Graveyard SQS queue, the EventBridge rule | When tuning the AI steps |
| `TechHorrorBoard` | CloudFront + S3 for both pages (one domain that also fronts both APIs, with a strict CSP), board read API (throttled, 1 second edge cache), postmortem API and async worker | When polishing the board |

Every Lambda uses one construct, `MonitoredFunction` ([infra/lib/constructs/monitored-function.ts](../infra/lib/constructs/monitored-function.ts)): Node 22 on ARM, esbuild bundling, 1 week log retention, and an error alarm wired to the alert topic.

## The state machine

```
Load Story -> Is Story Usable? -> Moderate -> Passed Moderation? -> Apply Redactions -> Classify and Validate
                    |                                |                                  (Parallel: Classify -> Validate Output,
                    |                                |                                   Retry x2 on InvalidModelOutput)
                    |                                v                                          |
                    |                       Redact Blocked Story                                v
                    v                                |     Is It a Story? -> Moderate Output -> Output Passed? -> Publish to Board -> Published
             Send to Graveyard  <--------------------+---------------------- Reason: Not a Story / Output Blocked / Invalid Model Output / Pipeline Error
             (Queue for Review + Record in Graveyard) -> Rejected
```

- One execution per story (no Map state). Each one can be opened in the console while the demo runs. EventBridge retries starting an execution 3 times, then drops the event in the Graveyard queue as a dead letter.
- Every Lambda and Guardrail call retries patiently on throttling and transient errors (up to 6 attempts, 3 to 20 seconds apart with jitter), so a room-wide burst arrives late instead of in the Graveyard.
- Every failure path ends in `Rejected`, a Succeed state. Bad input never fails an execution. Lambda errors are caught too: `Load Story` goes to `Reason: Unreadable Story`, `Moderate` to `Reason: Moderation Unavailable`.
- `Classify and Validate` is a Parallel with one branch. That lets a single native Retry re-run both steps when the model returns something that fails the zod schema.
- `Load Story` normalizes text first (look-alike characters, invisible and direction-flipping characters, spaced-out letters) so filter-evasion tricks stop working.
- `Apply Redactions` swaps in the Guardrail's masked text, so names, links, and secrets become `[name]`, `[link]`, `[token]` before the model, the table, or the board see them.
- `Is It a Story?` sends heckles and chatter the classifier flagged (`is_story: false`) to the Graveyard.
- `Moderate Output` runs the model's headline and root cause back through the same Guardrail before publishing.
- Text that never passed moderation is blanked before it reaches the Graveyard. The board also hides moderated text in the API response.

## Why not an agent (AgentCore, Strands, Bedrock Agents, LangGraph)?

The short answer: **this is a workflow, not an agent**, and that distinction is the point of the demo.

An agent framework is built for work where the model decides what happens next. Strands Agents runs a loop in which the model picks tools, calls them, reads the results, and keeps going until it decides it is done. Amazon Bedrock AgentCore gives that loop somewhere managed to live: a runtime, memory, a gateway to tools, identity, and observability. Bedrock Agents and LangGraph cover similar ground. These are good tools when the path through a task is not known in advance.

Here the path is known in advance. Every story goes through the same steps in the same order: normalize, moderate, classify, validate, check the output, publish or bury. The model is called once per story to do one well-defined thing (turn text into a small JSON object), and it has no tools at all. That is a job for a state machine, and choosing one buys several things that matter for this demo.

- **The input is hostile by design.** Anyone with the QR code can type anything. With no tools, the worst a successful prompt injection can do is produce bad JSON, which the zod schema rejects and the story lands in the Graveyard. Give the same model tools and a loop, and an injection gets to choose which tool to call next.
- **The safety steps cannot be skipped.** The Guardrail runs before the model and again on its output because the state machine says so, not because a prompt asked the model to check. No reasoning step can route around moderation.
- **Every failure has a named path.** Retries, catches, and the Graveyard reasons are explicit states. An agent that gets confused fails in open-ended ways; this one fails into `Reason: Invalid Model Output`.
- **You can watch it.** Each story is one Step Functions execution with a graph you can click through live. Anyone can see exactly what ran, with what input, and what it cost.
- **Cost is predictable.** One small Haiku call per story (plus up to two retries if its JSON fails validation) and a Guardrail check. An agent loop's cost depends on how many turns the model decides to take.
- **It is testable.** The whole workflow runs locally in the test suite against mocked Bedrock ([test/support/asl-runner.ts](../test/support/asl-runner.ts)). The same input always takes the same path.
- **Less to run.** No agent runtime, no session memory, no tool gateway. It is Lambda, Step Functions, and two Bedrock APIs (`Converse` and `ApplyGuardrail`).

**When you would reach for one.** The postmortem is the closest thing here to agent-shaped work. Today it is a single model call over the story text. If it had to dig through real CloudWatch logs, read the runbook, and check the deploy history before writing, the model would need to decide which of those to look at, and an agent framework like Strands, hosted on AgentCore, would be a reasonable fit. A good rule of thumb: if you can draw the flowchart before the model runs, build the flowchart. Reach for an agent when the model has to draw it.

## HTTP API

Two API Gateway HTTP APIs, both served through the one CloudFront domain, so the pages call relative `/api/...` paths and the CSP can stay `connect-src 'self'`. All responses are JSON with `cache-control: no-store`, except `GET /api/board`.

| Route | API (stack) | Auth | Request | Responses |
|---|---|---|---|---|
| `POST /api/stories` | Submit (`TechHorrorIngestion`) | None | `{"text": "...", "deviceId": "..."}`. `deviceId` is optional, 8 to 64 of `A-Z a-z 0-9 _ -` | `202 {id, message}` accepted (empty text included, on purpose). `400` bad JSON or over 280 characters. `429` cooldown, with `retry-after: 20`. `503` submissions closed |
| `GET /api/board` | Board (`TechHorrorBoard`) | None | | `200 {feed, leaderboard, categories, graveyard, totals, inFlight, generatedAt}`. Feed and graveyard are the newest 30. Text is censored, and hidden for moderated, removed, and not-a-story entries. `cache-control: public, max-age=0, s-maxage=1` |
| `POST /api/postmortem` | Board | `X-Presenter-Key` header | `{"storyId"?: "...", "fresh"?: true}`. No `storyId` means the scariest published story | `200` cached postmortem. `202` started or already running (`status: pending`). `403` missing or wrong key. `404` no such published story |
| `GET /api/postmortem/{id}` | Board | None | | `200 {storyId, status, one_liner, category, fear_level, postmortem?}`, where `status` is `none`, `pending`, `done`, `blocked`, or `error`. `404` no such published story |

Stage throttles: submit 20 rps (burst 40), board 30 rps (burst 60), and `POST /api/postmortem` 1 rps (burst 2).

**The `execute-api` URLs are public too.** CloudFront is the intended way in, but each API's own `https://<id>.execute-api.<region>.amazonaws.com` endpoint answers the same routes (the `SubmitApiEndpoint` output prints the submit one). Calling them directly skips the CSP and the 1 second board cache. It does not skip anything that protects the pipeline: the stage throttles, kill switch, length limit, cooldown, presenter key, and every moderation step still apply. This is accepted for a demo that is torn down after the talk. To close it, put a secret header on the CloudFront origins and check it in the Lambdas, or front the APIs with a CloudFront VPC origin or WAF rule.

## Design decisions and assumptions

- Submit writes to S3 and an S3 `Object Created` event starts the pipeline, instead of the Lambda calling `StartExecution` directly. This demo is data-focused, so the workflow is triggered by data landing in a bucket, not by application code. Anything that can drop a file in the bucket (another system's export, `aws s3 cp`, a different front end) starts the same pipeline, and the submit Lambda doesn't need to know the state machine exists. It also keeps the raw story out of the execution input: the input is just the S3 key, which is safe to show on the projector. The cost is a little extra latency and a bucket that holds raw text for a day.
- The EventBridge rule lives in `TechHorrorPipeline`, not `TechHorrorIngestion`. The rule targets the state machine and the pipeline reads the bucket, so putting it in ingestion would create a circular cross-stack reference.
- Moderation uses a Bedrock Guardrail (`ApplyGuardrail`), not a model call. It is cheaper and shows up as its own cost line. Names are masked rather than blocked so a story about "Dave" still makes the board without naming him. Emails, phone numbers, and keys block the whole story.
- Empty stories are accepted by the submit API on purpose, so the Graveyard has something to show. Stories over 280 characters are rejected with 400 at the API. The pipeline checks length again.
- No batch/CSV path. Seed goes through the real API, one execution per story.
- Postmortems run asynchronously because HTTP APIs time out after 30 seconds and larger models can think for a while. `POST /api/postmortem` marks the story `pending` and invokes the worker Lambda with an `Event` invocation (async retries off, so a failure never bills twice); the board polls `GET /api/postmortem/{id}`. A finished postmortem is cached on the story item, so repeat clicks are free.
- The pipeline Lambdas use pinned Guardrail versions (a new version is published whenever the config changes). The postmortem worker uses `DRAFT`, which always matches the deployed config, because importing the pinned version across stacks would create an export that blocks the next Guardrail change.
- The board is the same for every viewer, so `/api/board` gets a 1 second CloudFront cache (`s-maxage=1`, plus request collapsing). Audience phones can open the board too (the submit page links to it after a story is sent), and any number of open boards costs about one Lambda call per second, so they cannot use up the board API's throttle (30 rps, burst 60) and starve the projector. 5xx responses are never cached, so one Lambda error does not freeze the board.
- The board also shows how many executions are running right now (`ListExecutions`, cached for 2 seconds in the Lambda).
- The Graveyard SQS queue is a record for review; nothing consumes it. Messages expire after 4 days, and `npm run reset` purges it.
- The state machine test runs the synthesized ASL in a small local interpreter ([test/support/asl-runner.ts](../test/support/asl-runner.ts)) against the real handlers, with Bedrock, S3, and DynamoDB mocked. It covers Task, Choice, Parallel, Retry, Catch, and the JSONPath features this workflow uses, not all of ASL.
