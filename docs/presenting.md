# Presenting

The presenter's guide: the local admin page, the run sheet, and what to do when something breaks mid-demo. It assumes you have already deployed (see [Deploying](deploying.md)).

## Presenter admin (local only)

```bash
npm run admin          # prints http://127.0.0.1:8787/?t=<token>
```

A page that runs on your laptop only, using your own AWS credentials. There is no public admin endpoint.

- **Bury** any story on the board. It moves to the Graveyard as "Removed by presenter" and its text is never sent to the board again. **Restore** undoes it.
- **Hide text** on a Graveyard entry that shows text.
- **Close / reopen submissions** (same as `npm run kill` / `npm run reopen`).

It listens on 127.0.0.1 only, requires the random token from the printed URL, and checks the Host header, so neither the venue Wi-Fi nor a web page you visit can drive it. Text is censored the same way as the board in case your screen is mirrored.

## Demo run sheet

### The day before

- [ ] `npm test` passes and `npm run deploy` succeeds in the presenting account.
- [ ] Both models invoked once with your own credentials (see [Prerequisites](deploying.md#prerequisites)).
- [ ] Lambda concurrent executions is 1,000, not 10 (see [Prerequisites](deploying.md#prerequisites)).
- [ ] Load test: 60 stories at once with `npm run seed -- --burst 60`, then `npm run reset`.
- [ ] `npm run presenter-key`. Bookmark the printed URL on the presenter laptop only.
- [ ] `npm run qr`. Put `qr/submit-slide.png` on the "join in" slide and `qr/submit-corner.png` in the corner of later slides.
- [ ] `npm run reset` to clear any test stories, then `npm run seed`. Wait 30 seconds. The Feed has 15 stories and the Graveyard has the rest, each with a quip.
- [ ] Click Postmortem once to warm it up and cache it.
- [ ] `npm run replay -- --record`, then `npm run replay` and check the offline board works.
- [ ] Submit one story from your own phone on mobile data. It should appear within about 10 seconds.

### 30 minutes before

- [ ] `npm run reopen` (in case you closed it).
- [ ] Open the board bookmark on the projector at 1920x1080, browser fullscreen (F11). Keys: `1` Feed, `2` Leaderboard, `3` Graveyard, `P` postmortem, `Esc` close.
- [ ] Open the Step Functions console in another tab (the `StateMachineConsoleUrl` output). Zoom the browser to 125% or more.
- [ ] `npm run admin` and keep the admin page open on the laptop screen, not the projector. It is your bury button and kill switch.

### Trace one execution live

1. Step Functions console: state machine `TechHorrorPipeline-story-pipeline`, **Executions** tab. The newest is at the top.
2. Open it and switch to **Graph view**. Green states ran, grey were skipped.
3. Click **Load Story** and show only its **input**: the S3 key from EventBridge. Do not open its output on the projector. It still holds the original story text, names included, because masking happens in the next step.
4. Click **Moderate**: the Guardrail verdict, text units, and cost. Every state from here on has the masked text.
5. Click **Classify and Validate**, then **Classify**: raw model output plus `input_tokens`, `output_tokens`, and `cost_usd`. If the model returned bad JSON, the retry shows in the event list.
6. Click **Publish to Board**: the exact DynamoDB item. Point at the counter on the board going up.
7. For a rejection, open an execution that ended in `Rejected` and show the reason state it went through.

### Show the Graveyard

Press `3` on the board. Rejected stories show the reason. Anything moderation blocked shows only "Blocked by moderation". If the audience has not broken anything yet, read one of the seeded prompt injections aloud and show where it ended up.

### Trigger the postmortem

Press `P` (or click **Postmortem**) to write one for the scariest story. To pick another story, click its card on the Feed, then **Postmortem**. Shift+click (or Shift+P) regenerates instead of using the cached one. The first run takes about 10 to 20 seconds while "Writing the postmortem" shows. Every run is added to the cost counter.

### If something breaks

| Symptom | Fix |
|---|---|
| Board says "Reconnecting..." | Room Wi-Fi is down. Run `npm run replay` and switch the projector to `http://localhost:8080/board.html#key=replay`. The REPLAY badge stays visible. |
| Everything lands in the Graveyard as "Pipeline error" | Usually Bedrock access or a wrong model ID. Check the Classify Lambda logs. Redeploy with `-c classifierModelId=...`. |
| Good stories show "Blocked by moderation" | Guardrail too strict. Lower filter strengths in [lib/pipeline-stack.ts](../infra/lib/pipeline-stack.ts) and redeploy `TechHorrorPipeline` (about 1 minute). |
| Something offensive is on the board | **Bury** it from the admin page. It disappears within a few seconds. |
| Someone is abusing the form | **Close submissions** on the admin page (or `npm run kill`). Phones get "Submissions closed". |
| Postmortem "failed its own moderation review" | The Guardrail blocked what the model wrote. Shift+click Postmortem to regenerate, or pick another story. |
| Postmortem button missing | The board was opened without `#key=`. Open the bookmark from `npm run presenter-key`. |
| Postmortem says "Presenter key required" | The key was rotated. Re-run `npm run presenter-key` and use the new URL. Lambdas pick it up within a minute. |
| Postmortem "had its own incident" | Postmortem model access or ID. Check the PostmortemWorker logs. An `AccessDeniedException` about AWS Marketplace means the model was never invoked by an admin (see [Prerequisites](deploying.md#prerequisites)); invoke it once, wait 5 minutes, then Shift+P. The rest of the demo is unaffected. |
| Phones get "One story every 20 seconds" | Working as intended. |
| Whole room gets errors | Stage throttle (20 rps). Raise it in [lib/ingestion-stack.ts](../infra/lib/ingestion-stack.ts). |

### After the demo

`npm run teardown`, then check that the CloudFormation console shows no stacks left.

