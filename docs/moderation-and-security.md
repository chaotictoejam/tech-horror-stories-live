# Moderation and security

How the demo keeps an open, anonymous form on a projector safe.

## Moderation

Everything the audience writes and everything the model writes goes through a Bedrock Guardrail. Policies live in [infra/lib/pipeline-stack.ts](../infra/lib/pipeline-stack.ts).

There are two guardrails. The main one makes block decisions and reviews model output. A second, masking-only guardrail replaces names, links, and secrets in audience stories. It exists because **Bedrock Guardrails only anonymize when `source` is `OUTPUT`**; on `INPUT` the mask rules are silently ignored, so the Moderate step runs the story through the masking guardrail as `OUTPUT`.

| What | Action | Where |
|---|---|---|
| Hate, sexual content, violence, insults (low), misconduct (low) | Block | Story and model output |
| Prompt attacks | Block | Story |
| Threats against a person or group | Block | Story and model output |
| Mocking an identifiable person by role, employer, appearance, or seat ("the guy in row 3") | Block | Story and model output |
| Accusing a named real company of negligence, insecurity, or law breaking | Block | Story and model output |
| Jokes about suicide or self-harm | Block | Model output only (an audience member venting is let through; the model may not joke about it) |
| Emails, phone numbers, addresses, US social security numbers, card numbers, passwords, AWS keys | Block | Story and model output |
| Names, usernames, `@handles` | Mask as `[name]` | Story and model output |
| IP addresses, URLs, 12 digit account ids, GitHub/Slack/OpenAI tokens, JWTs, private key headers, `*.internal` style hosts | Mask as `[ip]`, `[link]`, `[account id]`, `[token]`, `[key]`, `[host]` | Story and model output |
| Heckles and chatter ("this is dumb", "boring", "test") | Graveyard as "Not a story", text hidden. Short ones (6 words or fewer) are caught by a free text check; longer ones by the classifier's `is_story` field | Load Story, Classify |
| Profanity | One or two words: allowed and censored on display (`f******`), including `sh1t`, `f*ck`, `f u c k`. Three or more: Graveyard (`PROFANITY_LIMIT` in [config/app-config.ts](../config/app-config.ts)) | Load Story, board and postmortem APIs |
| Postmortems | Whole text reviewed; a blocked one shows "failed its own moderation review" | Postmortem worker |

Every Graveyard entry records what exactly failed (for example `content:PROMPT_ATTACK`, `topic:IdentifiablePerson`, `profanity`, `gibberish`) and the board shows a canned, deadpan quip for that cause, like "Ignore previous instructions? Ignored." or "Come on, we're professionals. Allegedly." The quips are fixed text in [src/shared/quips.ts](../src/shared/quips.ts), never model-generated, and the same story always gets the same quip.

Anything that still slips through: bury it from the presenter admin page ([Presenting](presenting.md#presenter-admin-local-only)).

**Tuning:** every filter sends some honest stories to the Graveyard. The company and identifiable-person topics are the most likely to over-block (for example "AWS had an outage"). After deploying, run `npm run seed` and check the Graveyard; loosen a topic by editing its definition and examples and redeploying `TechHorrorPipeline`. Guardrails are most accurate in English, French, and Spanish.

## Security and abuse controls

- **Prompt injection:** story text goes only in the user turn, wrapped in `<<<STORY nonce>>> ... <<<END STORY nonce>>>` with a random nonce, and anything delimiter-like is stripped. The system prompt says the block is data. The zod schema is strict, so extra keys like `"admin": true` fail validation and the story is buried. The Guardrail's prompt-attack filter may also catch it first. Both outcomes are tested.
- **Rate limits:** stage throttling (submit 20 rps, burst 40; board API 30 rps, burst 60; postmortem route 1 rps, burst 2), a 1 second edge cache on `/api/board` so open boards cannot exhaust the board throttle, and a 20 second per-device cooldown enforced with a DynamoDB conditional write. The device is a random id the phone keeps in localStorage. Without one it falls back to a hash of IP and user agent. Only the hash is stored. The cooldown keeps an honest phone from spamming, but the device id is chosen by the client, so a script can send a new one every time (the seed script does exactly that). The stage throttle and the kill switch are the real backstop.
- **Direct API access:** each API's `execute-api` URL works without CloudFront. That skips the CSP and the board cache, but every control above still applies. See [Architecture](architecture.md#http-api).
- **Kill switch:** one DynamoDB item, read with a consistent read on every submit.
- **Presenter key:** postmortems cost real money, so `POST /api/postmortem` needs the key from SSM (SecureString). The board reads it from `#key=` once, keeps it in sessionStorage for that tab, and removes it from the address bar.
- **Profanity:** allowed through the pipeline (the Guardrail has no profanity filter), stored as written, and censored on the way out by the board and postmortem APIs (`fucking` shows as `f******`). The word list is in [src/shared/censor.ts](../src/shared/censor.ts).
- **Output:** the board renders every string with `textContent`. CloudFront adds a strict Content-Security-Policy (no inline scripts or styles, nothing from other origins), which is why the fonts are self-hosted in [web/fonts/](../web/fonts/).
- **IAM:** every grant is scoped to a specific resource. Bedrock `InvokeModel` is scoped to the configured inference profile and the regions it routes to.
- **No naming and shaming:** the Guardrail anonymizes personal names, usernames, and `@handles` instead of blocking the story. "Dave from ops dropped prod" is published as "[name] from ops dropped prod". The masked text is what gets classified, stored, and shown, and the classifier and postmortem prompts both say never to name a person.
- **Privacy:** the Guardrail blocks emails, phone numbers, addresses, card numbers, passwords, and AWS keys. Story text is logged only at DEBUG (off). Raw S3 objects expire after one day. Step Functions keeps execution input and output until the state machine is deleted by teardown. The `Load Story` output there still has the original text, names included; every later state has the masked text.

