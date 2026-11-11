#!/usr/bin/env bash
# D17: replay every message in the dead-letter queue into the processing queue.
# Safe to run: processing is idempotent per object version (D30), so files
# that already finished are skipped as duplicates.
#
# Usage: scripts/redrive-dlq.sh
# Env:   AWS_PROFILE (default mft-hub), AWS_REGION (default eu-central-2)
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-mft-hub}"
export AWS_REGION="${AWS_REGION:-eu-central-2}"
# The Windows AWS CLI ends lines with CRLF; strip CR so comparisons work in
# Git Bash. pipefail keeps the CLI's exit code.
aws() { command aws "$@" | tr -d '\r'; }

output() {
  aws cloudformation describe-stacks --stack-name MftCoreStack \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
DLQ_ARN="$(output DeadLetterQueueArn)"
QUEUE_ARN="$(output ProcessingQueueArn)"
DLQ_URL="$(aws sqs get-queue-url --queue-name "${DLQ_ARN##*:}" --query QueueUrl --output text)"

count="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
echo "Messages in DLQ: $count"
[ "$count" -gt 0 ] || { echo "Nothing to redrive."; exit 0; }

# The destination is explicit: messages that EventBridge could not deliver
# never came from the processing queue, so the default "original source" would not work.
aws sqs start-message-move-task --source-arn "$DLQ_ARN" --destination-arn "$QUEUE_ARN" \
  --query TaskHandle --output text
echo "Redrive started. Progress:"
echo "  aws sqs list-message-move-tasks --source-arn $DLQ_ARN"
