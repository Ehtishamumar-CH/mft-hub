#!/usr/bin/env bash
# Teardown in three levels (D9, D1). Every level is opt-in; the default is the
# routine one.
#
#   scripts/teardown.sh                  Destroy MftSftpStack only. Stops the
#                                        ~$0.30/h SFTP charge; data, audit
#                                        records and partner records stay.
#   scripts/teardown.sh --all            Also destroy MftCoreStack. First writes
#                                        a manifest of the resources the stack
#                                        retains (key, buckets, table, log
#                                        groups) to .teardown/. Those remain.
#   scripts/teardown.sh --all --purge    Also delete everything in the manifest:
#                                        all object versions and the buckets, the
#                                        audit table, the log groups, and
#                                        schedule the KMS key for deletion (7 days).
#   scripts/teardown.sh --purge FILE     Purge from an earlier manifest.
#
#   --dry-run   Print every command instead of running it (no confirmations).
#
# Env: AWS_PROFILE (default mft-hub), AWS_REGION (default eu-central-2).
# Not touched: the CDKToolkit bootstrap stack. Re-deploy works after level 1
# and 2; after a purge, data and audit history are gone for good.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-mft-hub}"
export AWS_REGION="${AWS_REGION:-eu-central-2}"
# The Windows AWS CLI ends lines with CRLF; strip CR so comparisons work in
# Git Bash. pipefail keeps the CLI's exit code.
aws() { command aws "$@" | tr -d '\r'; }

# Git Bash rewrites arguments that start with "/" (log group names) into
# Windows paths; turn that off.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALL=false PURGE=false DRY=false MANIFEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=true ;;
    --purge) PURGE=true; if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then MANIFEST="$2"; shift; fi ;;
    --dry-run) DRY=true ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done
if $PURGE && ! $ALL && [ -z "$MANIFEST" ]; then
  echo "--purge needs --all (purge after destroying) or a manifest file from an earlier --all run."; exit 2
fi

run() { # print (shortened), then run unless --dry-run
  local line="$*"
  [ "${#line}" -le 200 ] || line="${line:0:200}..."
  echo "+ $line" >&2 # stderr: callers redirect the command's stdout
  $DRY || "$@"
}
confirm() { # phrase, message
  $DRY && return 0
  echo "$2"
  read -r -p "Type '$1' to continue: " answer
  [ "$answer" = "$1" ] || { echo "Cancelled."; exit 1; }
}
stack_exists() {
  aws cloudformation describe-stacks --stack-name "$1" > /dev/null 2>&1
}

# --- Level 1: SFTP stack ------------------------------------------------------
if stack_exists MftSftpStack; then
  run npx cdk destroy MftSftpStack --force --profile "$AWS_PROFILE"
else
  echo "MftSftpStack: not deployed."
fi
if ! $ALL && ! $PURGE; then echo "Done. Re-deploy with: npx cdk deploy MftSftpStack --profile $AWS_PROFILE"; exit 0; fi

# --- Level 2: core stack ------------------------------------------------------
if ! $ALL; then
  : # --purge FILE: the core stack was destroyed by an earlier --all run
elif stack_exists MftCoreStack; then
  mkdir -p "$ROOT/.teardown"
  MANIFEST="$ROOT/.teardown/retained-$(date -u +%Y%m%dT%H%M%SZ).txt"
  # Every resource type the stack retains (RemovalPolicy.RETAIN in lib/).
  aws cloudformation list-stack-resources --stack-name MftCoreStack \
    --query "StackResourceSummaries[?contains(['AWS::KMS::Key','AWS::S3::Bucket','AWS::DynamoDB::GlobalTable','AWS::Logs::LogGroup'], ResourceType)].[ResourceType,PhysicalResourceId]" \
    --output text > "$MANIFEST"
  echo "Retained-resource manifest: $MANIFEST"
  sed 's/^/  /' "$MANIFEST"
  confirm MftCoreStack "This destroys MftCoreStack: pipeline, alarms, budget, partner records and alert topic. The resources above stay (and keep costing a little) until purged."
  run aws cloudformation update-termination-protection --stack-name MftCoreStack --no-enable-termination-protection
  run npx cdk destroy MftCoreStack --force --profile "$AWS_PROFILE"
  $DRY || echo "Partner secrets were deleted with the stack. If a later deploy fails because a secret"
  $DRY || echo "name is scheduled for deletion, that name is still in its recovery window (unverified for"
  $DRY || echo "CloudFormation deletes)."
else
  echo "MftCoreStack: not deployed."
fi
$PURGE || { echo "Done. Retained data stays; purge later with: scripts/teardown.sh --purge ${MANIFEST:-<manifest>}"; exit 0; }

# --- Level 3: purge retained resources ---------------------------------------
[ -n "$MANIFEST" ] && [ -r "$MANIFEST" ] || { echo "No manifest to purge from."; exit 2; }
if stack_exists MftCoreStack && ! $DRY; then
  echo "MftCoreStack still exists; destroy it first (--all)."; exit 2
fi
confirm "delete data" "This permanently deletes every object version in the buckets, the audit table and the log groups, and schedules the KMS key for deletion in 7 days. It cannot be undone."

empty_bucket() {
  local b="$1" batch
  while :; do
    batch="$(aws s3api list-object-versions --bucket "$b" --max-items 400 --output json \
      --query '{Objects: [Versions || `[]`, DeleteMarkers || `[]`][].{Key: Key, VersionId: VersionId}, Quiet: `true`}')"
    case "$batch" in *'"Objects": []'*) return 0 ;; esac
    run aws s3api delete-objects --bucket "$b" --delete "$batch" > /dev/null
    $DRY && return 0
  done
}

buckets=() log_bucket=""
while IFS=$'\t' read -r type id; do
  case "$type" in
    AWS::S3::Bucket)
      # The access-log bucket goes last: the others write logs into it.
      if [[ "$id" == *accesslogs* ]]; then log_bucket="$id"; else buckets+=("$id"); fi ;;
  esac
done < "$MANIFEST"
for b in "${buckets[@]}" ${log_bucket:+"$log_bucket"}; do
  if aws s3api head-bucket --bucket "$b" > /dev/null 2>&1; then
    echo "Bucket $b"
    empty_bucket "$b"
    run aws s3api delete-bucket --bucket "$b"
  else
    echo "Bucket $b: already gone."
  fi
done

while IFS=$'\t' read -r type id; do
  case "$type" in
    AWS::DynamoDB::GlobalTable)
      if aws dynamodb describe-table --table-name "$id" > /dev/null 2>&1; then
        run aws dynamodb update-table --table-name "$id" --no-deletion-protection-enabled > /dev/null
        $DRY || aws dynamodb wait table-exists --table-name "$id"
        run aws dynamodb delete-table --table-name "$id" > /dev/null
      else echo "Table $id: already gone."; fi ;;
    AWS::Logs::LogGroup)
      if [ -n "$(aws logs describe-log-groups --log-group-name-prefix "$id" --query "logGroups[?logGroupName=='$id'].logGroupName" --output text)" ]; then
        run aws logs delete-log-group --log-group-name "$id"
      else echo "Log group $id: already gone."; fi ;;
    AWS::KMS::Key)
      state="$(aws kms describe-key --key-id "$id" --query KeyMetadata.KeyState --output text 2>/dev/null || echo Missing)"
      if [ "$state" = Enabled ] || [ "$state" = Disabled ]; then
        run aws kms schedule-key-deletion --key-id "$id" --pending-window-in-days 7 > /dev/null
        $DRY || echo "KMS key $id: deletion scheduled in 7 days (cancel with: aws kms cancel-key-deletion --key-id $id)."
      else echo "KMS key $id: $state."; fi ;;
  esac
done < "$MANIFEST"
echo "Purge done. The CDKToolkit bootstrap stack is untouched."
