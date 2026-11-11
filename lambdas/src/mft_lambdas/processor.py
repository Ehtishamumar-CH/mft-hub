"""File processor: validate and route every partner upload (D5, D6, D17, D18).

S3 (landing bucket) -> EventBridge "Object Created" -> SQS -> this function.
Each SQS message body is one EventBridge event for one object version.

Per object version:

1. Write a ``RECEIVED`` record with a conditional put (idempotency, D18/D30).
   The record key is derived from the object version, so a duplicate event
   maps to the same record. A record already in a final state means the
   event is a duplicate and is skipped; a ``RECEIVED`` record means an
   earlier attempt stopped part-way, and processing resumes.
2. Validate (D5): path, filename pattern, extension, size, content sniff,
   and record the SHA-256.
3. Copy to ``processed/<partner>/...`` or ``rejected/<partner>/...``
   (quarantine bucket), tagged with status and reason.
4. Delete from landing (a delete marker; the version stays recoverable
   until the 7-day noncurrent expiry).
5. Set the final status ``VALIDATED`` or ``REJECTED``.

The final status is written last, so a crash at any step leaves the record
in ``RECEIVED`` and the SQS retry redoes the remaining steps. Every step is
safe to repeat: the source is read by version ID, the copy overwrites the
same destination key, and a second delete marker changes nothing.

Failures raise, and the message is reported in ``batchItemFailures`` so SQS
retries it and moves it to the DLQ after ``maxReceiveCount`` (D17).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote_plus, urlencode

from aws_lambda_powertools import Logger, Metrics, Tracer, single_metric
from aws_lambda_powertools.metrics import MetricUnit

# D21: Powertools from the AWS-managed layer. Service name and namespace are
# fixed here so tests and the deployed function report the same names.
SERVICE = "file-processor"
METRICS_NAMESPACE = "MftHub"
logger = Logger(service=SERVICE)
metrics = Metrics(namespace=METRICS_NAMESPACE, service=SERVICE)
tracer = Tracer(service=SERVICE)

INBOUND_PREFIX = "inbound/"
PARTNER_ID_RE = re.compile(r"^[A-Z0-9]{2,32}$")
# <PARTNERID>_<YYYYMMDD>_<name>.<ext> (D5). The name may contain dots; the
# extension is the last dot-separated part.
FILENAME_RE = re.compile(
    r"^(?P<partner>[A-Z0-9]{2,32})_(?P<date>\d{8})_"
    r"(?P<name>[A-Za-z0-9][A-Za-z0-9._-]{0,99})\.(?P<ext>[A-Za-z0-9]{1,10})$"
)
ALLOWED_EXTENSIONS = frozenset({"csv", "xml", "json", "pdf"})
MAX_BYTES = 100 * 1024 * 1024  # 100 MiB (D5)
SNIFF_BYTES = 8 * 1024
READ_CHUNK = 1024 * 1024
UNKNOWN_PARTNER = "_INVALID"  # cannot collide: partner IDs have no underscore

RECEIVED, VALIDATED, REJECTED = "RECEIVED", "VALIDATED", "REJECTED"
FINAL_STATUSES = frozenset({VALIDATED, REJECTED})

# Rejection reasons. Stable codes: they appear in DynamoDB, object tags and
# (Phase 4) the FilesRejected{reason} metric.
INVALID_PATH = "INVALID_PATH"
INVALID_FILENAME = "INVALID_FILENAME"
PARTNER_MISMATCH = "PARTNER_MISMATCH"
EXTENSION_NOT_ALLOWED = "EXTENSION_NOT_ALLOWED"
EMPTY_FILE = "EMPTY_FILE"
TOO_LARGE = "TOO_LARGE"
CONTENT_MISMATCH = "CONTENT_MISMATCH"

# Leading bytes of common binary formats that must never pass as CSV.
_BINARY_MAGIC = (
    b"%PDF-",
    b"PK\x03\x04",
    b"\x7fELF",
    b"MZ",
    b"\x89PNG",
    b"\xff\xd8\xff",
    b"GIF8",
    b"\x1f\x8b",
    b"Rar!",
    b"7z\xbc\xaf",
)
_BOM = b"\xef\xbb\xbf"


@dataclass(frozen=True)
class Config:
    landing_bucket: str
    processed_bucket: str
    quarantine_bucket: str
    table_name: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Config:
        return cls(
            landing_bucket=env["LANDING_BUCKET"],
            processed_bucket=env["PROCESSED_BUCKET"],
            quarantine_bucket=env["QUARANTINE_BUCKET"],
            table_name=env["TABLE_NAME"],
        )


# --- Pure functions (unit-tested without AWS) ------------------------------


@dataclass(frozen=True)
class SourceObject:
    bucket: str
    key: str
    version_id: str
    size: int
    etag: str


def parse_event(body: str | Mapping[str, Any]) -> SourceObject | None:
    """Extract the object from an EventBridge S3 "Object Created" event.

    Returns ``None`` for events this function does not handle (other detail
    types, folder markers). Raises ``ValueError`` for malformed events.
    """
    event = json.loads(body) if isinstance(body, str) else body
    if event.get("source") != "aws.s3" or event.get("detail-type") != "Object Created":
        return None
    detail = event["detail"]
    obj = detail["object"]
    key = str(obj["key"])
    if key.endswith("/"):
        return None  # folder marker from an SFTP mkdir, not a file
    version_id = obj.get("version-id")
    if not version_id:
        raise ValueError("event has no version-id: the landing bucket must be versioned")
    return SourceObject(
        bucket=str(detail["bucket"]["name"]),
        key=key,
        version_id=str(version_id),
        size=int(obj.get("size", 0)),
        etag=str(obj.get("etag", "")),
    )


@dataclass(frozen=True)
class Location:
    """Where an inbound key belongs: partner and path below its folder."""

    partner_id: str
    relative_path: str
    valid: bool


def locate(key: str) -> Location:
    """Split ``inbound/<PARTNER>/<file>`` into partner and file.

    Anything else (missing partner folder, subfolders) is an invalid path.
    The session policy should prevent it; it is still routed to quarantine.
    """
    if key.startswith(INBOUND_PREFIX):
        parts = key[len(INBOUND_PREFIX) :].split("/")
        if len(parts) >= 2 and PARTNER_ID_RE.fullmatch(parts[0]):
            rest = "/".join(parts[1:])
            return Location(parts[0], rest, valid=len(parts) == 2 and rest != "")
    return Location(UNKNOWN_PARTNER, key, valid=False)


def check_metadata(loc: Location, size: int) -> str | None:
    """D5 checks that need no object content. Returns a reason or ``None``."""
    if not loc.valid:
        return INVALID_PATH
    match = FILENAME_RE.fullmatch(loc.relative_path)
    if match is None:
        return INVALID_FILENAME
    try:
        datetime.strptime(match["date"], "%Y%m%d")
    except ValueError:
        return INVALID_FILENAME
    if match["partner"] != loc.partner_id:
        return PARTNER_MISMATCH
    if match["ext"].lower() not in ALLOWED_EXTENSIONS:
        return EXTENSION_NOT_ALLOWED
    if size <= 0:
        return EMPTY_FILE
    if size > MAX_BYTES:
        return TOO_LARGE
    return None


def sniff_ok(extension: str, head: bytes) -> bool:
    """Light magic-byte check (D5) on the first bytes of the file."""
    ext = extension.lower()
    if ext == "pdf":
        return head.startswith(b"%PDF-")
    text = head.removeprefix(_BOM).lstrip()
    if ext == "json":
        return text[:1] in (b"{", b"[")
    if ext == "xml":
        return text[:1] == b"<"
    if ext == "csv":
        return b"\x00" not in head and not head.startswith(_BINARY_MAGIC)
    return False


def extension_of(relative_path: str) -> str:
    return relative_path.rsplit(".", 1)[-1] if "." in relative_path else ""


@dataclass
class Digest:
    sha256: str
    head: bytes


def digest(chunks: Iterable[bytes]) -> Digest:
    """Stream the object once: SHA-256 of everything, first bytes for sniffing."""
    h = hashlib.sha256()
    head = bytearray()
    for chunk in chunks:
        h.update(chunk)
        if len(head) < SNIFF_BYTES:
            head.extend(chunk[: SNIFF_BYTES - len(head)])
    return Digest(h.hexdigest(), bytes(head))


def destination(loc: Location, status: str, cfg: Config) -> tuple[str, str]:
    """D6/D20: processed bucket ``<partner>/...``, quarantine ``rejected/<partner>/...``."""
    if status == VALIDATED:
        return cfg.processed_bucket, f"{loc.partner_id}/{loc.relative_path}"
    return cfg.quarantine_bucket, f"rejected/{loc.partner_id}/{loc.relative_path}"


def record_key(loc: Location, src: SourceObject, transfer_ts: str) -> dict[str, str]:
    """D12/D30 record key: deterministic per object version.

    ``transferTs`` is the version's LastModified, so duplicate events for the
    same version always produce the same key; the version ID makes the key
    unique even for two uploads of one filename in the same second.
    """
    return {"partnerId": loc.partner_id, "sk": f"{transfer_ts}#{src.key}#{src.version_id}"}


def iso(ts: datetime) -> str:
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- AWS side ---------------------------------------------------------------


@dataclass
class Outcome:
    status: str  # VALIDATED | REJECTED | DUPLICATE | IGNORED
    reason: str | None = None
    dest: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _error_code(err: Exception) -> str:
    return str(getattr(err, "response", {}).get("Error", {}).get("Code", ""))


class Processor:
    def __init__(self, cfg: Config, s3: Any, table: Any) -> None:
        self.cfg = cfg
        self.s3 = s3
        self.table = table

    def _head(self, src: SourceObject) -> tuple[SourceObject, Mapping[str, Any], bool]:
        """HEAD the exact version. Retries once with a URL-decoded key, in case
        the event key is URL-encoded. The third value says whether the decoded
        key was needed; it is logged as ``keyDecoded``."""
        try:
            head = self.s3.head_object(Bucket=src.bucket, Key=src.key, VersionId=src.version_id)
            return src, head, False
        except Exception as err:
            decoded = unquote_plus(src.key)
            if _error_code(err) not in ("404", "NoSuchKey", "NoSuchVersion") or decoded == src.key:
                raise
        src = SourceObject(src.bucket, decoded, src.version_id, src.size, src.etag)
        head = self.s3.head_object(Bucket=src.bucket, Key=src.key, VersionId=src.version_id)
        return src, head, True

    def _claim(self, key: dict[str, str], item: dict[str, Any]) -> str | None:
        """Conditional put of the RECEIVED record. Returns the existing status
        if the record already exists, else ``None``."""
        try:
            self.table.put_item(
                Item={**key, **item},
                ConditionExpression="attribute_not_exists(partnerId)",
            )
            return None
        except Exception as err:
            if _error_code(err) != "ConditionalCheckFailedException":
                raise
        existing = self.table.get_item(Key=key, ConsistentRead=True).get("Item", {})
        return str(existing.get("status", RECEIVED))

    @tracer.capture_method(capture_response=False)
    def process(self, src: SourceObject) -> Outcome:
        if src.bucket != self.cfg.landing_bucket:
            return Outcome("IGNORED", reason=f"not the landing bucket: {src.bucket}")
        src, head, key_decoded = self._head(src)
        logger.append_keys(sourceKey=src.key, versionId=src.version_id, keyDecoded=key_decoded)
        loc = locate(src.key)
        size = int(head.get("ContentLength", src.size))
        transfer_ts = iso(head["LastModified"])
        key = record_key(loc, src, transfer_ts)

        existing = self._claim(
            key,
            {
                "status": RECEIVED,
                "transferTs": transfer_ts,
                "sourceKey": src.key,
                "sourceVersionId": src.version_id,
                "eTag": src.etag,
                "sizeBytes": size,
                "receivedAt": iso(datetime.now(UTC)),
            },
        )
        if existing in FINAL_STATUSES:
            return Outcome("DUPLICATE", reason=existing)

        reason = check_metadata(loc, size)
        sha256: str | None = None
        if 0 < size <= MAX_BYTES:
            # Hash every file small enough to read, rejected ones included.
            body = self.s3.get_object(Bucket=src.bucket, Key=src.key, VersionId=src.version_id)[
                "Body"
            ]
            d = digest(body.iter_chunks(READ_CHUNK))
            sha256 = d.sha256
            if reason is None and not sniff_ok(extension_of(loc.relative_path), d.head):
                reason = CONTENT_MISMATCH
        status = VALIDATED if reason is None else REJECTED

        dest_bucket, dest_key = destination(loc, status, self.cfg)
        tags = {"mft-status": status, "mft-partner": loc.partner_id}
        if reason:
            tags["mft-reason"] = reason
        if sha256:
            tags["mft-sha256"] = sha256
        self.s3.copy(
            {"Bucket": src.bucket, "Key": src.key, "VersionId": src.version_id},
            dest_bucket,
            dest_key,
            ExtraArgs={"Tagging": urlencode(tags), "TaggingDirective": "REPLACE"},
        )
        self.s3.delete_object(Bucket=src.bucket, Key=src.key)

        names = {"#s": "status"}
        values: dict[str, Any] = {
            ":s": status,
            ":received": RECEIVED,
            ":db": dest_bucket,
            ":dk": dest_key,
            ":at": iso(datetime.now(UTC)),
        }
        update = "SET #s = :s, destBucket = :db, destKey = :dk, processedAt = :at"
        if reason:
            update += ", reason = :r"
            values[":r"] = reason
        if sha256:
            update += ", sha256 = :h"
            values[":h"] = sha256
        try:
            self.table.update_item(
                Key=key,
                UpdateExpression=update,
                ConditionExpression="#s = :received",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except Exception as err:
            # A concurrent duplicate delivery finished first: same result.
            if _error_code(err) != "ConditionalCheckFailedException":
                raise
            return Outcome("DUPLICATE", reason="finished concurrently")
        return Outcome(
            status,
            reason=reason,
            dest=f"s3://{dest_bucket}/{dest_key}",
            extra={"partnerId": loc.partner_id, "sha256": sha256, "sizeBytes": size},
        )


def record_metrics(outcome: Outcome) -> None:
    """D21: FilesValidated, FilesRejected (total, for the rate alarm) and
    FilesRejected by reason. Duplicates and ignored events are not counted."""
    if outcome.status == VALIDATED:
        metrics.add_metric(name="FilesValidated", unit=MetricUnit.Count, value=1)
    elif outcome.status == REJECTED:
        metrics.add_metric(name="FilesRejected", unit=MetricUnit.Count, value=1)
        with single_metric(
            name="FilesRejected",
            unit=MetricUnit.Count,
            value=1,
            namespace=METRICS_NAMESPACE,
            default_dimensions={"service": SERVICE},
        ) as metric:
            metric.add_dimension(name="reason", value=str(outcome.reason))


_processor: Processor | None = None


def _get_processor() -> Processor:
    global _processor
    if _processor is None:
        import boto3  # provided by the Lambda runtime

        cfg = Config.from_env()
        _processor = Processor(
            cfg, boto3.client("s3"), boto3.resource("dynamodb").Table(cfg.table_name)
        )
    return _processor


def handle_batch(event: Mapping[str, Any], processor: Processor) -> dict[str, Any]:
    """SQS batch with ReportBatchItemFailures: only failed messages are retried."""
    failures = []
    for record in event.get("Records", []):
        message_id = record.get("messageId")
        # One log context per message: the EventBridge event ID is the
        # correlation ID that ties together all lines for one upload.
        logger.remove_keys(["sourceKey", "versionId", "keyDecoded"])
        logger.append_keys(messageId=message_id)
        try:
            body = json.loads(record["body"])
            logger.set_correlation_id(body.get("id"))
            src = parse_event(body)
            if src is None:
                logger.info("event ignored", extra={"outcome": "IGNORED"})
                continue
            outcome = processor.process(src)
            record_metrics(outcome)
            logger.info(
                "file processed",
                extra={
                    "outcome": outcome.status,
                    "reason": outcome.reason,
                    "dest": outcome.dest,
                    **outcome.extra,
                },
            )
        except Exception:
            logger.exception("processing failed")
            metrics.add_metric(name="ProcessingFailures", unit=MetricUnit.Count, value=1)
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


@logger.inject_lambda_context(clear_state=True)
@tracer.capture_lambda_handler(capture_response=False)
@metrics.log_metrics
def handler(event: Mapping[str, Any], _context: object) -> dict[str, Any]:
    return handle_batch(event, _get_processor())
