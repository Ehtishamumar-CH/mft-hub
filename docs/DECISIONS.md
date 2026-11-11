# MFT Hub — Design Decisions

Living log of decisions made while designing the MFT Hub. Each entry: decision, rationale, status.

## Environment facts (verified 2026-11-10)

- Node 22.14 / npm 10.9 / Python 3.11.9 / git 2.48 installed locally.
- AWS CLI and AWS CDK **not yet installed**.
- AWS account exists (console currently on `eu-north-1` Stockholm).
- AWS Transfer Family is available in `eu-central-2` (Zurich) and `eu-north-1` (Stockholm). Zurich is an opt-in region.

## Environment facts (verified 2026-11-11, new account 090243701552)

- AWS CLI 2.40.0 installed (per-user). Profile `mft-hub`, signed in via `aws login`, role `AccountFullAccessRole`.
- The account is a **"new AWS experience" project account** inside an AWS-managed organization. AWS-managed SCPs:
  - **Region floor:** only the project region `eu-north-1` (Stockholm) works. Zurich is not enabled, and `account:*Region*` actions are explicitly denied.
  - **AWS Transfer Family is denied** (`transfer:ListServers` → explicit deny). It is on AWS's "not supported unless you activate advanced AWS features" list, as are GuardDuty and IAM Identity Center.
  - Works in `eu-north-1`: S3, KMS, Lambda, DynamoDB, SQS, EventBridge, SNS, Secrets Manager, CloudFormation, Budgets, CloudWatch, X-Ray.
- Unlocking Transfer Family + Zurich requires: upgrade to the Paid Plan → **activate advanced AWS features** (irreversible; removes project spend limits; budgets and Cost Anomaly Detection remain), then edit the `RegionFloor` SCP and enable Zurich.
- **2026-11-11, after D25:** advanced features activated, `eu-central-2` added to the region SCP and enabled. Verified with profile `mft-hub`: Transfer Family, DynamoDB, KMS, CloudFormation and GuardDuty all respond in Zurich and Stockholm. Profile default region set to `eu-central-2`.
- AWS Agent Toolkit installed: 25 AWS skills, `aws-mcp` MCP server (Claude Code entry pinned to `AWS_MCP_PROXY_PROFILES=mft-hub`), advanced-experience rules in project `CLAUDE.md`.
  Refs: https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html, https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html

## Environment facts (verified 2026-11-11, Phase 0)

- `cdk bootstrap aws://090243701552/eu-central-2` done: stack `CDKToolkit` `CREATE_COMPLETE`, termination protection on, bootstrap version 32, default qualifier `hnb659fds`, default CFN execution policy `AdministratorAccess` (sandbox; scope down in production).
- Toolchain pinned (dependency cooldown: versions at least 14 days old): `aws-cdk` CLI 2.1146.1, `aws-cdk-lib` 2.275.0, `cdk-nag` 3.0.2, TypeScript 5.9.3, Jest 30, Python deps in `lambdas/requirements-dev.txt`.
- **cdk-nag 3.x API:** `Validations.of(app).addPlugins(new AwsSolutionsChecks(app))`; suppressions via `Validations.of(construct).acknowledge({ id, reason })`. This replaces `Aspects` + `NagSuppressions` (D22 still holds: every acknowledgement carries a reason).
- Git Bash: prefix AWS CLI calls whose arguments start with `/` (SSM names) with `MSYS_NO_PATHCONV=1`.

## Environment facts (verified 2026-11-11, Phase 1 deploy)

- `MftCoreStack` deployed to `eu-central-2` by the user at 13:32 UTC: `CREATE_COMPLETE`, termination protection on, 20 resources.
- Verified live: KMS key `alias/mft-hub` rotation enabled (365 days). The three data buckets use SSE-KMS with that key and bucket keys; the access-log bucket uses SSE-S3. All four have Block Public Access (all four flags), `BucketOwnerEnforced`, versioning enabled and every lifecycle rule `Enabled`. The data buckets log to the access-log bucket under `landing/`, `processed/` and `quarantine/`.
- Alert topic is SSE-KMS. The email subscription is confirmed (1 confirmed, 0 pending). The address is supplied at deploy time only (D14).
- Budget `mft-hub-monthly-e748878c`: $10 monthly COST budget, notifications ACTUAL 50/80/100 and FORECASTED 100, all `OK`. ACTUAL 80 checked: its subscriber is the alert topic (SNS).
- **Not yet verified:** delivery of a real budget alert through the encrypted topic (needs spend over 50 %).
- Redeploys must pass the same `-c alertEmail=...`, or CDK removes the subscription.

## Settled

| #   | Decision                                                                                                                                                                                                                                                                                                                   | Rationale                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Real AWS deployment** to the user's own account, with teardown after demos and a cost budget alarm.                                                                                                                                                                                                                      | Transfer Family SFTP endpoint bills ~$0.30/h (~$216/mo) while it exists; a live demo is the strongest portfolio evidence. |
| D3  | **CDK in TypeScript**, **Lambdas in Python 3.12**.                                                                                                                                                                                                                                                                         | Matches plan; Python is the ops/DevOps Lambda lingua franca; shows polyglot IaC + runtime.                                |
| D4  | **Custom Lambda identity provider** backed by Secrets Manager, **SSH-key auth only** (no passwords). Each partner is chrooted to its own logical home directory.                                                                                                                                                           | Demonstrates per-partner isolation and secrets handling — the core of the security story.                                 |
| D5  | **Validation rules (v1):** extension allowlist (`.csv .xml .json .pdf`), non-empty and ≤ 100 MB, filename pattern `<PARTNERID>_<YYYYMMDD>_<name>.<ext>`, SHA-256 recorded, light magic-byte content sniff. GuardDuty Malware Protection deferred to a later phase.                                                         | Concrete, testable rules; malware scanning adds cost and is a clean "next phase".                                         |
| D6  | **File routing:** pass → copy to `processed/<partner>/…`, delete from landing. Fail → move to `rejected/<partner>/…` in the quarantine bucket, tagged with reason. Every file gets a DynamoDB record `RECEIVED → VALIDATED \| REJECTED`. Partners have read-only access to their own `processed/` and `rejected/` folders. | Full audit trail; partners can self-serve failure reasons.                                                                |
| D7  | **Git + GitHub + GitHub Actions CI** (lint, Jest CDK assertion tests, pytest+moto Lambda tests, `cdk synth`) on every PR. Deploys are manual from the workstation; OIDC-based CD is a later phase.                                                                                                                         | DevOps role — CI quality gates are table stakes; keeps AWS creds out of CI for v1.                                        |

| D2 | **Region `eu-central-2` (Zurich).** User enables the opt-in region once. _(2026-11-11: confirmed "Keep Zurich". Requires D25.)_ | Swiss data residency — directly relevant to Swiss Post. |
| D25 | **Activate advanced AWS features** on the new account (Paid Plan, then activation). Then add `eu-central-2` to the `RegionFloor` SCP and enable Zurich for project account `090243701552`. Done by the user in the console (irreversible; removes the project spend limit, so a manual $10 budget replaces it). | The only way to use Transfer Family and Zurich on this account. |
| D8 | **Workstation auth via `aws login`** (browser sign-in, CLI profile `mft-hub`). Credentials last 12 h and renew for up to 90 days without re-signing in. No long-lived access keys; the user performs the sign-in. _(Revised 2026-11-11: replaced IAM Identity Center, which needs AWS Organizations. The new account uses AWS's "new experience" with a project, and `aws login` is the AWS-recommended path for it.)_ | Short-lived creds; avoids a classic security finding; less setup. |
| D9 | **Two stacks:** `MftCoreStack` (persistent, ~free: KMS, buckets, DynamoDB, EventBridge, processing Lambda, DLQ, alarms, partner secrets, partner S3 access role, budget) and `MftSftpStack` (ephemeral: Transfer server + IdP Lambda). Tear down only `MftSftpStack` after demos. | Isolates the only expensive resource; keeps audit history and avoids repeated KMS key deletion. |
| D10 | **PUBLIC Transfer Family endpoint** for v1. VPC endpoint + IP allowlisting is a later phase. | No VPC/EIP cost or complexity in v1. |
| D11 | **Single customer-managed KMS key** with annual rotation, used by S3, DynamoDB, SQS, Secrets Manager. Per-data-class keys deferred. | $1/mo per key; one readable key policy. |
| D12 | **`PartnerTransfers` table:** PK `partnerId`, SK `transferTs#objectKey`; attrs `status, reason, sha256, sizeBytes, sourceKey, destKey, processedAt`; GSI `status-index` (`status` + `transferTs`); on-demand; PITR on; no TTL. | Answers per-partner and "all rejected today" queries; audit records retained. |
| D13 | **Partner onboarding via `config/partners.json`** (id, name, SSH public keys, optional source IPs) → CDK creates per-partner secret + S3 home prefixes. Onboarding = PR + `cdk deploy`. Demo partners `ACMEBANK`, `GLOBEX`. | IaC onboarding; public keys are safe to commit. |
| D14 | **Alerting:** CloudWatch alarms (DLQ depth > 0, processing Lambda errors, rejected-file rate, budget threshold) → one SNS topic with email subscription; email passed at deploy time via `-c alertEmail=…`, never committed. | On-call readiness without leaking PII into the repo. |
| D15 | **`AI_ENGINEERING_JOURNAL.md`**, one entry per phase: Goal → Prompts → AI output → My review (security/cost/correctness) → Changes made → Lessons. Agent drafts; user rewrites "My review" in their own voice. | Mirrors the job's AI-first-with-ownership expectation. |
| D17 | **Pipeline: EventBridge rule → SQS processing queue → Lambda** (batched, `ReportBatchItemFailures`), `maxReceiveCount: 3` → SQS DLQ. DLQ redrive used for replay. | Buffers bursts, visible retries, one-command replay. |
| D18 | **Idempotent processing** via DynamoDB conditional write on `partnerId + sourceKey + eTag`; duplicates are skipped. | S3/EventBridge are at-least-once. |
| D19 | **Bucket hardening:** Block Public Access, BucketOwnerEnforced, TLS-only policy, versioning, server access logs to a dedicated log bucket. **Lifecycle:** `rejected/` expires 30d; processed → Standard-IA 30d → Glacier 180d; abort incomplete multipart uploads after 7d. | Baseline compliance controls + storage cost control. |
| D20 | **SFTP logical home:** `/inbound` → landing `inbound/<partner>/` (write); `/processed` → processed `<partner>/` (read-only); `/rejected` → quarantine `rejected/<partner>/` (read-only). Enforced by per-partner IAM session policy. | Partner jail + least privilege. |
| D21 | **Observability:** Powertools for AWS Lambda (Python) — structured JSON logs, correlation IDs, custom metrics `FilesValidated` / `FilesRejected{reason}`; X-Ray tracing; Transfer Family CloudWatch logging. | Diagnosable in production. |
| D22 | **cdk-nag (AwsSolutions pack)** runs on synth and fails CI; every suppression carries a written justification. | Automated security gate; journal material. |
| D23 | **`scripts/smoke-test.sh`**: SFTP as `ACMEBANK`, upload one valid + one invalid file, assert routing and DynamoDB records. Test keypairs generated into gitignored `.keys/`; only public keys go into `partners.json`. | Repeatable post-deploy verification and demo. |
| D24 | **Public GitHub repo `Ehtishamumar-CH/mft-hub`**, `main` protected (CI required). One branch + PR per phase, user merges. Agent asks before the first push. | Portfolio link; PR history tells the build story. |
| D26 | **Budget via CDK custom resource.** `MftCoreStack` manages the $10/month account budget with an `AwsCustomResource` that calls the Budgets API (`us-east-1` endpoint): ACTUAL 50/80/100 %, FORECASTED 100 %, all to the alert topic. The budget name carries a config hash, so a change creates the new budget before the old one is deleted. _(2026-11-11, chosen by user.)_ | CloudFormation has no `AWS::Budgets::Budget` type in `eu-central-2` or `eu-north-1`, and the region SCP denies CloudFormation in `us-east-1`. The Budgets API itself is allowed. Keeps the budget in IaC and removes it on destroy. |
| D27 | **IdP builds the session policy; secrets hold only partner data.** Each `mft/partners/<ID>` secret holds `partnerId`, `name`, `enabled`, `publicKeys`, `sourceIps`. The IdP Lambda derives the role ARN, the D20 logical home directories and a concrete per-partner session policy from environment variables. _(2026-11-11; replaces the earlier default that stored role and mappings in the secret.)_ | Policy variables are not supported with LOGICAL home directories, so the policy must be concrete per partner. Building it in code keeps it unit-tested (2048-char limit) and lets a partner be disabled by editing one secret field. |
| D28 | **Partner access role is the ceiling, the session policy the floor.** One role (in `MftCoreStack`) trusted by `transfer.amazonaws.com` with `aws:SourceAccount` + `aws:SourceArn` `user/*`. It allows `ListBucket` on the three buckets, `Put/Get/AbortMultipartUpload` on `inbound/*`, `Get/GetVersion` on processed and `rejected/*`, and KMS only `via s3`. No delete permissions. The session policy repeats the KMS statement, because effective access is role ∩ session policy. | Least privilege per partner with a single role (D4, D20). |
| D29 | **Server hardening:** `SftpAuthenticationMethods: PUBLIC_KEY` (the IdP also denies any password), security policy `TransferSecurityPolicy-2025-03`, structured JSON logs to a log group in `MftCoreStack` (retained, 1-year retention) so logs survive SFTP teardowns. The IdP Lambda has its own role (no AWS managed policies), may be invoked only by this server's ARN, and never logs the raw event. | Defence in depth, audit trail beyond the ephemeral stack. |

## Defaults (assumed unless overridden)

- npm as package manager; MIT license; README with architecture diagram (Mermaid).
- Partner secrets named `mft/partners/<PARTNERID>`, containing public keys, role ARN, home-directory mappings, optional source-IP allowlist (checked by IdP Lambda).
- Lambdas on arm64; processing Lambda 512 MB / 5 min timeout (streams the object for SHA-256); IdP Lambda 128 MB / 10 s.
- AWS Budget: $10/month, alerts at 50% / 80% / 100% forecast to the SNS topic.
- Phase 1 specifics: the access-log bucket is **SSE-S3** (S3 cannot deliver server access logs to SSE-KMS buckets) and expires logs after 90 days. Noncurrent versions expire after 7 days (landing, quarantine, logs) or 30 days (processed). All buckets and the KMS key are `RETAIN`.
- The alert topic is SSE-KMS with the project CMK, so the key policy grants `budgets.amazonaws.com` `kms:GenerateDataKey*` + `kms:Decrypt`. Both the topic and key statements are scoped by `aws:SourceAccount` + `aws:SourceArn` (AWS Budgets SNS guide). Phase 4 must add the same for `cloudwatch.amazonaws.com` alarms.
- Resource tags: `Project=mft-hub`, `Owner=<user>`, `Environment=demo`.

## Build order

1. Phase 0 — tooling (AWS CLI, CDK), `aws login` (D8), enable Zurich (D25), `cdk bootstrap`; repo + CI skeleton + cdk-nag. **Done 2026-11-11** (local; GitHub push pending).
2. Phase 1 — `MftCoreStack`: KMS, buckets, log bucket, lifecycle, budget, SNS. **Deployed 2026-11-11** from branch `phase-1/core` (user ran `cdk deploy`).
3. Phase 2 — `MftSftpStack`: Transfer server, IdP Lambda, partner secrets from `partners.json`, access role + session policies. **Built 2026-11-11** (branch `phase-2/sftp`; not yet deployed).
4. Phase 3 — EventBridge → SQS → processing Lambda → DynamoDB, idempotency, routing.
5. Phase 4 — DLQ, alarms, Powertools metrics, smoke test.
6. Phase 5 — journal completion, README, teardown script.
