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

### Lessons

- Read the service's auth contract and limits before writing policy code.
- Prefer granular nag acknowledgements; a blanket one hides new wildcards.
