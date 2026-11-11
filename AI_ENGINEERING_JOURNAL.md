# AI Engineering Journal

One entry per phase (D15): Goal, Prompts, AI output, My review, Changes made, Lessons.
The agent drafts each entry; **"My review" is written by me, in my own words.**

---

## Phase 0 - Tooling, repo and CI skeleton (2026-11-11)

### Goal

Reach a working, verifiable baseline before any infrastructure exists: CDK toolchain, a CDK app that synthesizes with cdk-nag enforced, a Python Lambda test harness, CI that runs both, and a bootstrapped `eu-central-2` environment.

### Prompts

- "Start Phase 0 of the MFT Hub. Read CLAUDE.md and docs/DECISIONS.md first. Use the AWS profile mft-hub in eu-central-2."

### AI output (summary)

- CDK TypeScript app: `lib/app.ts` builds the app (shared by `bin/` and tests), with an empty `MftCoreStack` pinned to `eu-central-2`, termination protection, default tags, and the cdk-nag `AwsSolutionsChecks` plugin.
- Jest tests: a clean synth with no nag findings, region/tag/termination-protection assertions, and a **canary test** that adds an insecure S3 bucket and expects synth to fail. Without it, a disabled nag gate would go unnoticed.
- Python harness in `lambdas/` (ruff, pytest, moto) with a smoke test against moto S3 in `eu-central-2`.
- GitHub Actions CI (two jobs, actions pinned to commit SHAs, `contents: read`, no AWS credentials) and Dependabot for npm, pip and actions.
- `cdk bootstrap aws://090243701552/eu-central-2` with termination protection and project tags. Bootstrap version 32.

### My review

_TODO (me): security / cost / correctness review in my own words._

Prompts for my review:

- The bootstrap CloudFormation execution role uses the default `AdministratorAccess`. Acceptable for a solo sandbox? What would I scope it to in production?
- All dependencies are pinned to versions at least 2 weeks old (supply-chain cooldown). `aws-cdk-lib` is pinned exactly to 2.275.0 rather than a caret range.
- Is the canary test enough to trust the nag gate?

### Changes made during the phase

- `npm install` resolved `aws-cdk-lib` to 2.276.0 (published the day before). Pinned it exactly to 2.275.0 to respect the cooldown.
- cdk-nag 3.x changed its API: it is now a synth-time **policy validation plugin** (`Validations.of(app).addPlugins(...)`), and suppressions use `Validations.of(x).acknowledge(...)`. `Aspects.of(app).add(...)` and `NagSuppressions` from older docs no longer apply.
- Tag assertions failed at first, because tags are applied by an Aspect during synthesis. The test now synthesizes before it asserts.
- `cdk init` flags were one release behind `aws-cdk-lib`. Set the missing `@aws-cdk/aws-apigateway:logGroupDestinationArnWithoutWildcard` flag to its recommended value (safe on a stack with no resources).
- Git Bash rewrites leading-slash arguments such as `/cdk-bootstrap/...` into Windows paths. Use `MSYS_NO_PATHCONV=1` for SSM parameter names.

### Lessons

- Check a library's current README before trusting remembered APIs (cdk-nag 3).
- A security gate needs a test proving it can fail.

---

## Phase 1 - MftCoreStack: KMS, buckets, alerts, budget (2026-11-11)

### Goal

Add the persistent, near-free storage and guardrail layer: one CMK, landing/processed/quarantine buckets with D19 hardening and lifecycle rules, an access-log bucket, an encrypted alert topic, and the $10 monthly budget.

### Prompts

- "lets start next"
- Decision prompt from the agent: CloudFormation cannot create a budget in any region the SCP allows. Chose "CDK custom resource" (D26).

### AI output (summary)

- `lib/mft-core-stack.ts`: KMS key (annual rotation, alias `alias/mft-hub`, RETAIN). Three SSE-KMS data buckets with bucket keys, Block Public Access, BucketOwnerEnforced, TLS-only plus TLS 1.2 minimum, versioning, server access logs and lifecycle rules. An SSE-S3 access-log bucket. A KMS-encrypted, TLS-only SNS topic with an optional email subscription (`-c alertEmail=...`).
- `lib/constructs/monthly-budget.ts`: an `AwsCustomResource` that creates and deletes the budget through the Budgets API. IAM is scoped to the one budget ARN. Retries are idempotent.
- 12 new Jest assertions (15 total) covering encryption, public access, TLS denies, lifecycle, confused-deputy conditions, subscriptions and budget thresholds.

### My review

_TODO (me): security / cost / correctness review in my own words._

Prompts for my review:

- Is the `budgets.amazonaws.com` grant on the shared data key acceptable, or should alerts get their own key (D11 trade-off)?
- A 90-day expiry on access logs: long enough for an audit story?
- All buckets are RETAIN. What does Phase 5 teardown need to do about that?

### Changes made during the phase

- Found that `AWS::Budgets::Budget` does not exist in `eu-central-2` / `eu-north-1` CloudFormation and that the SCP blocks CloudFormation in `us-east-1`. Asked for a decision and added D26.
- Checked the AWS docs: server access logs require an SSE-S3 destination bucket, and Budgets needs topic-policy and key-policy grants for an SSE-KMS topic.
- cdk-nag flagged `AwsSolutions-IAM4` on CDK's singleton custom-resource Lambda role (`AWSLambdaBasicExecutionRole`). Acknowledged it with a reason. Also acknowledged `AwsSolutions-S1` on the log bucket itself.
- Tests failed at first: `new App()` in Jest does not load `cdk.json` feature flags, so S3 fell back to ACL-based log delivery. Added `test/helpers.ts` so tests use the same flags as the CLI.

### Deployment and verification

- I ran `cdk deploy MftCoreStack -c alertEmail=...` myself (the agent's own deploy attempt was blocked by its permission mode, by design) and confirmed the SNS email subscription.
- The agent then checked the live account against the design: stack status, KMS rotation, encryption on each bucket, public access block, ownership, versioning, logging, lifecycle rule state, topic encryption and subscription, and budget limit, thresholds and subscriber.
- Gap: real budget alert delivery through the encrypted topic is untested until spend crosses 50 %.
- The agent at first reported "not deployed": it had checked before my deploy ran and did not know when I had run it.

### Lessons

- Before treating a missing deploy as a finding, establish when the command was run.
- Check CloudFormation resource-type availability per region (`aws cloudformation describe-type`) before designing around it.
- Unit tests must synthesize with the same feature flags as the real deploy.

---

## Phase 2 - MftSftpStack: SFTP endpoint and Lambda identity provider (2026-11-11)

### Goal

Partners log in over SFTP with SSH keys only and each partner sees only its own `/inbound` (write), `/processed` and `/rejected` (read) folders.

### Prompts

- "ok good lets do this" (after merging PR 1 and PR 2, with my approval).

### AI output (summary)

- Demo ed25519 keypairs for `ACMEBANK` and `GLOBEX` in gitignored `.keys/`; public keys in `config/partners.json`, validated by `lib/partners.ts` (ID pattern, key format, IP/CIDR, duplicates).
- `MftCoreStack` gains one KMS-encrypted secret per partner, the shared partner access role (D28), and a retained Transfer log group.
- `MftSftpStack`: Python 3.12 arm64 IdP Lambda with its own least-privilege role, a public SFTP-only Transfer server (Lambda IdP, `PUBLIC_KEY` only, `TransferSecurityPolicy-2025-03`, structured logs), invoke permission scoped to the server ARN.
- `lambdas/src/mft_lambdas/idp.py`: pure functions for home directories, session policy (checked against the 2048-char limit) and source-IP allowlists; denies passwords, non-SFTP, bad usernames, unknown/disabled partners and disallowed IPs. 25 pytest tests, Jest grows to 33.

### My review

_TODO (me): security / cost / correctness review in my own words._

Prompts for my review:

- Is granting `s3:GetObject` on a partner's own `/inbound` acceptable (some SFTP clients stat files after upload)?
- The IdP fails closed on any error. What does that mean for an outage of Secrets Manager?
- Cost: the server bills ~$0.30/h from deploy until `cdk destroy MftSftpStack`.

### Changes made during the phase

- Read the Transfer Family docs before designing: Lambda IdP contract, role trust conditions, 2048-char session-policy limit, and that policy variables do not work with LOGICAL home directories. That led to D27.
- Effective access is role ∩ session policy, so the session policy repeats the KMS statement; without it, uploads to SSE-KMS buckets would fail.
- cdk-nag 3 reports `IAM5` once per wildcard resource, so every wildcard is acknowledged individually with its reason instead of one blanket acknowledgement.
- The Jest run caught a bug in the IdP role acknowledgement: with no account at synth time, cdk-nag renders the account as `<AWS::AccountId>`. The ID now handles both cases.

### Deployment and verification

- I ran `cdk deploy` for both stacks. The agent then verified in the account: stack and server state, `test-identity-provider` allow/deny cases, a real SFTP session per partner (upload, forbidden write, forbidden delete, cross-partner and `..` path attempts, wrong key), object encryption, and the IdP and Transfer logs.
- Everything matched the design. One log nuance: a wrong-key login shows an IdP allow followed by a Transfer `AUTH_FAILURE`, because Transfer does the key comparison.

### Lessons

- Read the service's auth contract and limits before writing policy code.
- Prefer granular nag acknowledgements; a blanket one hides new wildcards.
- Test the negative paths against the live service, not only in unit tests: path tricks and wrong keys are where isolation bugs hide.

---

## Phase 3 - File pipeline: EventBridge, SQS, processing Lambda, DynamoDB (2026-11-11)

### Goal

Every partner upload is validated (D5), routed to `processed/` or `rejected/` (D6) and recorded in DynamoDB (D12), exactly once in effect even though S3 and EventBridge deliver at least once (D18).

### Prompts

- "lets start with next phase"

### AI output (summary)

- `lib/constructs/file-pipeline.ts` in `MftCoreStack`: `PartnerTransfers` table (CMK, PITR, deletion protection, `status-index` GSI), KMS-encrypted processing queue and DLQ, an EventBridge rule for `Object Created` under `inbound/`, and the processing Lambda (Python 3.12 arm64, 512 MB, 5 min) with its own least-privilege role.
- `lambdas/src/mft_lambdas/processor.py`: pure validation functions (path, filename pattern and date, partner match, extension, size, magic bytes, SHA-256), routing with status and reason tags, and per-message `batchItemFailures`.
- 53 new pytest tests with moto, including a simulated crash after the landing delete that the retry must finish, duplicate events and re-uploads of identical content. 7 new Jest tests (40 total).

### My review

_TODO (me): security / cost / correctness review in my own words._

Prompts for my review:

- D30 changes D18's idempotency key from the eTag to the version ID. Do I agree that a re-upload of identical content is a new transfer?
- The processor can delete anything under landing `inbound/`. Acceptable for one shared function, or one function per partner?
- A file rejected for size is still copied to quarantine. Is keeping a 5 GB rejected file for 30 days a cost risk?
- CDK's `SqsEventSource` grants the processor `kms:Decrypt` on the project key with no `kms:ViaService` condition (found by a Jest assertion). Accepted and pinned by a test as decrypt-only. Is that good enough, or should alerts and data get separate keys (D11)?
- The `SqsQueue` target makes CDK grant `events.amazonaws.com` `Encrypt`, `Decrypt`, `ReEncrypt*` and `GenerateDataKey*` on the key (scoped by `aws:SourceAccount`), more than the documented minimum of `Decrypt` + `GenerateDataKey`. Hand-write that statement instead?
- A processed file with the same name overwrites the earlier one (versioning keeps the old version for 30 days). Should destinations carry a timestamp?

### Changes made during the phase

- Read the S3 EventBridge event format: the event carries `version-id`, which made the version-based idempotency key possible (D30). The docs do not say whether the key is URL-encoded, so the processor retries a HEAD with the decoded key; to be verified live.
- CDK's `eventBridgeEnabled` adds a custom-resource Lambda; the native CloudFormation `EventBridgeConfiguration` does the same with no extra function (D31).
- Ordered the steps so the final status is written last. With the obvious order (status before delete), a crash in between would leave a file in landing that every retry skips as a duplicate.

### Deployment and verification

- I deployed `MftCoreStack` from `main` after merging PR 10 and PR 12. The agent then checked the stack and resources and uploaded 6 files over SFTP as ACMEBANK: one valid and five invalid (wrong content, bad names, empty, a space and a `+` in the name).
- All 6 went where the design says, with the right reason, tags, SHA-256 and DynamoDB record, about 10 to 15 s after upload. No errors, and nothing in the DLQ.
- The agent replayed the valid file's event into the queue: it was skipped as a duplicate, with no second record and no second copy.
- Still open: whether EventBridge URL-encodes keys. Both odd names worked, but the processor's fallback means the logs cannot tell which path ran; S3 access logs will show it.

### Lessons

- Idempotency keys must separate "same event twice" from "same content twice".
- In an at-least-once pipeline, write the "done" marker last and make every step before it repeatable.
- A fallback that makes both cases work also hides which case happened; log which branch ran when the question matters.

---

## Phase 4 - Observability: alarms, Powertools, smoke test, DLQ redrive (2026-11-11)

### Goal

Know when the pipeline breaks without watching it: alarms to email, structured logs and metrics per file, traces, a one-command post-deploy check and a one-command replay.

### Prompts

- "lets start the phase 4"

### AI output (summary)

- `lib/constructs/pipeline-alarms.ts`: four alarms (DLQ not empty, processor errors, queue stuck, rejected-file rate) with ALARM and OK notifications (D32). CloudWatch topic and key grants in `MftCoreStack`, plus stack outputs for the scripts.
- `lib/constructs/powertools.ts`: the AWS-managed Powertools layer, pinned to the version the tests use. The processor gets active X-Ray tracing.
- `processor.py`: Powertools Logger (correlation ID = EventBridge event ID, `keyDecoded`), Metrics (`FilesValidated`, `FilesRejected`, by reason, `ProcessingFailures`) and Tracer (D33).
- `scripts/smoke-test.sh` (D23) and `scripts/redrive-dlq.sh` (D17).
- 4 new pytest tests (82 total) and 7 new Jest tests.

### My review

_TODO (me): security / cost / correctness review in my own words._

Prompts for my review:

- Per-file failures are caught (partial batch), so Lambda `Errors` only shows crashes. Is the DLQ alarm enough, or should `ProcessingFailures` alarm too (noisier, earlier)?
- The rejected-rate alarm needs 3 files in an hour. Right threshold for a demo vs. production?
- The processor role's X-Ray acknowledgement covers any `*` resource; a Jest test pins it to the two X-Ray actions. Is a test the right guard for that?
- Cost: 4 standard alarms are about $0.40/month; X-Ray and custom metrics stay within the free tier at demo volume (to check against the bill).

### Changes made during the phase

- Checked the Powertools layer in `eu-central-2`: version 40 is 3.37.0 (published 2026-10-22), the same version as the test pin. Newer layers (3.38 to 3.40) were skipped by the 14-day cooldown.
- Powertools Tracer needs `aws-xray-sdk` even with tracing disabled, so tests failed on import. Pinned `aws-xray-sdk` 2.15.0 for tests (2.16.0 is 12 days old).
- Read the CloudWatch SNS guide for the topic and key grants (D32).
- The Powertools Logger writes to the stream it saw at import time, so pytest's `capsys`/`capfd` saw nothing; the test swaps the handler's stream.
- The Windows AWS CLI prints CRLF, so every `$(aws ...)` comparison in the scripts would have failed in Git Bash. Found by running the DynamoDB query from the smoke test against the live table; the scripts strip `
`.
- cdk-nag flagged `IAM5[Resource::*]` for the X-Ray actions CDK adds with active tracing; acknowledged with the reason (X-Ray has no resource-level permissions).

### Lessons

- Run a script's AWS calls against the real account on the real shell before trusting it; CI on Linux would not catch CRLF.
- A per-entity nag acknowledgement can hide later findings of the same ID; pin what it covers with a test.
