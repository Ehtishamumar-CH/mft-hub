#!/usr/bin/env bash
# D23: post-deploy smoke test. Uploads three files over SFTP as one partner and
# asserts routing, tags, DynamoDB records and an empty landing area.
#
#   1. <P>_<today>_smoke<time>.csv   valid             -> VALIDATED, processed bucket
#   2. <P>_<today>_smoke<time>.pdf   text, not a PDF   -> REJECTED CONTENT_MISMATCH
#   3. <P>_<today>_smoke <time>.csv  space in the name -> REJECTED INVALID_FILENAME
#
# Usage: scripts/smoke-test.sh [PARTNER]   (default ACMEBANK)
# Env:   AWS_PROFILE (default mft-hub), AWS_REGION (default eu-central-2),
#        KEY_FILE (default .keys/<PARTNER>), TIMEOUT_SECONDS (default 120)
# Needs: aws CLI v2, OpenSSH sftp, both stacks deployed. Exit code 0 = pass.
set -euo pipefail

PARTNER="${1:-ACMEBANK}"
export AWS_PROFILE="${AWS_PROFILE:-mft-hub}"
export AWS_REGION="${AWS_REGION:-eu-central-2}"
# The Windows AWS CLI ends lines with CRLF; strip CR so comparisons work in
# Git Bash. pipefail keeps the CLI's exit code.
aws() { command aws "$@" | tr -d '\r'; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${KEY_FILE:-$ROOT/.keys/$PARTNER}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"

output() { # stack, output key
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

[ -r "$KEY_FILE" ] || { echo "No private key at $KEY_FILE (D23: generate into .keys/)"; exit 2; }
ENDPOINT="$(output MftSftpStack SftpEndpoint)"
LANDING="$(output MftCoreStack LandingBucketName)"
PROCESSED="$(output MftCoreStack ProcessedBucketName)"
QUARANTINE="$(output MftCoreStack QuarantineBucketName)"
TABLE="$(output MftCoreStack TransfersTableName)"
for v in ENDPOINT LANDING PROCESSED QUARANTINE TABLE; do
  [ -n "${!v}" ] && [ "${!v}" != "None" ] || { echo "Missing stack output for $v. Are both stacks deployed?"; exit 2; }
done

STAMP="$(date -u +%H%M%S)"
DAY="$(date -u +%Y%m%d)"
VALID="${PARTNER}_${DAY}_smoke${STAMP}.csv"
BADPDF="${PARTNER}_${DAY}_smoke${STAMP}.pdf"
SPACED="${PARTNER}_${DAY}_smoke ${STAMP}.csv"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
printf 'id,amount,currency\n1,100.00,CHF\n' > "$WORK/$VALID"
printf 'plain text pretending to be a PDF\n' > "$WORK/$BADPDF"
printf 'id,amount\n1,1\n' > "$WORK/$SPACED"
cat > "$WORK/batch" <<SFTP
cd /inbound
lcd "$WORK"
put "$VALID"
put "$BADPDF"
put "$SPACED"
SFTP

echo "Uploading 3 files as $PARTNER to $ENDPOINT"
sftp -q -i "$KEY_FILE" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -b "$WORK/batch" "$PARTNER@$ENDPOINT" > /dev/null

record() { # file name -> "STATUS REASON DESTKEY" (tab separated), empty until final
  aws dynamodb query --table-name "$TABLE" \
    --key-condition-expression "partnerId = :p" \
    --filter-expression "sourceKey = :k AND #s <> :r" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":p\":{\"S\":\"$PARTNER\"},\":k\":{\"S\":\"inbound/$PARTNER/$1\"},\":r\":{\"S\":\"RECEIVED\"}}" \
    --query "Items[0].[status.S, reason.S, destKey.S]" --output text
}

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
for f in "$VALID" "$BADPDF" "$SPACED"; do
  until r="$(record "$f")" && [ -n "$r" ] && [ "$r" != "None" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "FAIL: no final record for '$f' after ${TIMEOUT_SECONDS}s"; exit 1; }
    sleep 3
  done
done

fails=0
check() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "  ok    $1"; else echo "  FAIL  $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi
}
exists() { # bucket key -> yes/no
  aws s3api head-object --bucket "$1" --key "$2" > /dev/null 2>&1 && echo yes || echo no
}
tag() { # bucket key tag
  aws s3api get-object-tagging --bucket "$1" --key "$2" --query "TagSet[?Key=='$3'].Value | [0]" --output text
}

echo "Results:"
check "valid file VALIDATED" "VALIDATED	None	$PARTNER/$VALID" "$(record "$VALID")"
check "valid file in processed bucket" yes "$(exists "$PROCESSED" "$PARTNER/$VALID")"
check "fake PDF REJECTED (CONTENT_MISMATCH)" "REJECTED	CONTENT_MISMATCH	rejected/$PARTNER/$BADPDF" "$(record "$BADPDF")"
check "fake PDF tagged with reason" CONTENT_MISMATCH "$(tag "$QUARANTINE" "rejected/$PARTNER/$BADPDF" mft-reason)"
check "spaced name REJECTED (INVALID_FILENAME)" "REJECTED	INVALID_FILENAME	rejected/$PARTNER/$SPACED" "$(record "$SPACED")"
check "spaced name in quarantine" yes "$(exists "$QUARANTINE" "rejected/$PARTNER/$SPACED")"
for f in "$VALID" "$BADPDF" "$SPACED"; do
  check "'$f' removed from landing" no "$(exists "$LANDING" "inbound/$PARTNER/$f")"
done

if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails checks)"; exit 1; fi
