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
