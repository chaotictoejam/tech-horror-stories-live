# Architecture

How the pieces fit together. For the big picture, start with the [README](../README.md).

## Stacks

| Stack | What is in it | Changes when |
|---|---|---|
| `TechHorrorIngestion` | Submit HTTP API (throttled), submit Lambda, raw story bucket (EventBridge on, 1 day expiry), config table (kill switch, cooldowns), alert SNS topic, $5 AWS Budget | Rarely |
| `TechHorrorPipeline` | Standard state machine, Load/Moderate/Classify/Validate Lambdas, Bedrock Guardrail, stories table, Graveyard SQS queue, the EventBridge rule | When tuning the AI steps |
| `TechHorrorBoard` | CloudFront + S3 for both pages, board read API, postmortem API and worker | When polishing the board |

Every Lambda uses one construct, `MonitoredFunction` ([lib/constructs/monitored-function.ts](../infra/lib/constructs/monitored-function.ts)): Node 22 on ARM, esbuild bundling, 1 week log retention, and an error alarm wired to the alert topic.

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

- One execution per story (no Map state). Each one can be opened in the console during the talk.
- Every failure path ends in `Rejected`, a Succeed state. Bad input never fails an execution. Lambda errors are caught too: `Load Story` goes to `Reason: Unreadable Story`, `Moderate` to `Reason: Moderation Unavailable`.
- `Classify and Validate` is a Parallel with one branch. That lets a single native Retry re-run both steps when the model returns something that fails the zod schema.
- `Load Story` normalizes text first (look-alike characters, invisible and direction-flipping characters, spaced-out letters) so filter-evasion tricks stop working.
- `Apply Redactions` swaps in the Guardrail's masked text, so names, links, and secrets become `[name]`, `[link]`, `[token]` before the model, the table, or the board see them.
- `Is It a Story?` sends heckles and chatter the classifier flagged (`is_story: false`) to the Graveyard.
- `Moderate Output` runs the model's headline and root cause back through the same Guardrail before publishing.
- Text that never passed moderation is blanked before it reaches the Graveyard. The board also hides moderated text in the API response.

## Why not an agent (AgentCore, Strands, Bedrock Agents, LangGraph)?

The most common question after the talk. The short answer: **this is a workflow, not an agent**, and that distinction is the point of the demo.

An agent framework is built for work where the model decides what happens next. Strands Agents runs a loop in which the model picks tools, calls them, reads the results, and keeps going until it decides it is done. Amazon Bedrock AgentCore gives that loop somewhere managed to live: a runtime, memory, a gateway to tools, identity, and observability. Bedrock Agents and LangGraph cover similar ground. These are good tools when the path through a task is not known in advance.

Here the path is known in advance. Every story goes through the same steps in the same order: normalize, moderate, classify, validate, check the output, publish or bury. The model is called once per story to do one well-defined thing (turn text into a small JSON object), and it has no tools at all. That is a job for a state machine, and choosing one buys several things that matter for this demo.

- **The input is hostile by design.** Anyone in the room can type anything. With no tools, the worst a successful prompt injection can do is produce bad JSON, which the zod schema rejects and the story lands in the Graveyard. Give the same model tools and a loop, and an injection gets to choose which tool to call next.
- **The safety steps cannot be skipped.** The Guardrail runs before the model and again on its output because the state machine says so, not because a prompt asked the model to check. No reasoning step can route around moderation.
- **Every failure has a named path.** Retries, catches, and the Graveyard reasons are explicit states. An agent that gets confused fails in open-ended ways; this one fails into `Reason: Invalid Model Output`.
- **You can watch it.** Each story is one Step Functions execution with a graph you can click through on stage. Anyone can see exactly what ran, with what input, and what it cost.
- **Cost is predictable.** One small Haiku call per story (plus up to two retries if its JSON fails validation) and a Guardrail check. An agent loop's cost depends on how many turns the model decides to take.
- **It is testable.** The whole workflow runs locally in the test suite against mocked Bedrock ([test/support/asl-runner.ts](../test/support/asl-runner.ts)). The same input always takes the same path.
- **Less to run.** No agent runtime, no session memory, no tool gateway. It is Lambda, Step Functions, and two Bedrock APIs (`Converse` and `ApplyGuardrail`).

**When you would reach for one.** The postmortem is the closest thing here to agent-shaped work. Today it is a single model call over the story text. If it had to dig through real CloudWatch logs, read the runbook, and check the deploy history before writing, the model would need to decide which of those to look at, and an agent framework like Strands, hosted on AgentCore, would be a reasonable fit. A good rule of thumb: if you can draw the flowchart before the model runs, build the flowchart. Reach for an agent when the model has to draw it.

## Design decisions and assumptions

- The EventBridge rule lives in `TechHorrorPipeline`, not `TechHorrorIngestion`. The rule targets the state machine and the pipeline reads the bucket, so putting it in ingestion would create a circular cross-stack reference.
- Moderation uses a Bedrock Guardrail (`ApplyGuardrail`), not a model call. It is cheaper and shows up as its own cost line. Names are masked rather than blocked so a story about "Dave" still makes the board without naming him. Emails, phone numbers, and keys block the whole story.
- Empty stories are accepted by the submit API on purpose, so the Graveyard has something to show. Stories over 280 characters are rejected with 400 at the API. The pipeline checks length again.
- No batch/CSV path. Seed goes through the real API, one execution per story.
- Postmortems run asynchronously (start, then poll) because HTTP APIs time out after 30 seconds and larger models can think for a while.
- The state machine test runs the synthesized ASL in a small local interpreter ([test/support/asl-runner.ts](../test/support/asl-runner.ts)) against the real handlers, with Bedrock, S3, and DynamoDB mocked. It covers Task, Choice, Parallel, Retry, Catch, and the JSONPath features this workflow uses, not all of ASL.
