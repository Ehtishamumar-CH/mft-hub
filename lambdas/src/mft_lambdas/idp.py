"""Transfer Family custom identity provider (D4, D20).

Transfer Family calls this function on every SFTP login. It returns the
partner's public keys, the shared access role, a per-partner session policy
and logical home directories. Returning ``{}`` denies the login.

Rules:
- SSH-key auth only: any request carrying a password is denied (the server is
  also configured for PUBLIC_KEY only; this is defence in depth).
- The username must be an onboarded partner ID with an enabled record in
  Secrets Manager under ``mft/partners/<ID>``.
- If the partner has a source-IP allowlist, the client IP must match it.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PARTNER_ID_RE = re.compile(r"^[A-Z0-9]{2,32}$")
MAX_SESSION_POLICY_CHARS = 2048  # Transfer Family limit
DENY: dict[str, Any] = {}


@dataclass(frozen=True)
class Config:
    secret_prefix: str
    role_arn: str
    landing_bucket: str
    processed_bucket: str
    quarantine_bucket: str
    kms_key_arn: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Config:
        return cls(
            secret_prefix=env["PARTNER_SECRET_PREFIX"],
            role_arn=env["PARTNER_ROLE_ARN"],
            landing_bucket=env["LANDING_BUCKET"],
            processed_bucket=env["PROCESSED_BUCKET"],
            quarantine_bucket=env["QUARANTINE_BUCKET"],
            kms_key_arn=env["KMS_KEY_ARN"],
        )


def home_directories(partner_id: str, cfg: Config) -> list[dict[str, str]]:
    """D20 logical home: /inbound (write), /processed and /rejected (read)."""
    return [
        {"Entry": "/inbound", "Target": f"/{cfg.landing_bucket}/inbound/{partner_id}"},
        {"Entry": "/processed", "Target": f"/{cfg.processed_bucket}/{partner_id}"},
        {"Entry": "/rejected", "Target": f"/{cfg.quarantine_bucket}/rejected/{partner_id}"},
    ]


def session_policy(partner_id: str, cfg: Config) -> str:
    """Scope the shared role down to one partner's prefixes.

    Policy variables are not supported with LOGICAL home directories, so the
    ARNs are concrete. Effective access is role ∩ this policy, which is why
    the KMS statement is repeated here.
    """

    def bucket(name: str) -> str:
        return f"arn:aws:s3:::{name}"

    def listing(sid: str, name: str, prefix: str) -> dict[str, Any]:
        return {
            "Sid": sid,
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": bucket(name),
            "Condition": {"StringLike": {"s3:prefix": [f"{prefix}/*", prefix]}},
        }

    p = partner_id
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            listing("ListInbound", cfg.landing_bucket, f"inbound/{p}"),
            listing("ListProcessed", cfg.processed_bucket, p),
            listing("ListRejected", cfg.quarantine_bucket, f"rejected/{p}"),
            {
                "Sid": "WriteInbound",
                "Effect": "Allow",
                "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
                "Resource": f"{bucket(cfg.landing_bucket)}/inbound/{p}/*",
            },
            {
                "Sid": "ReadResults",
                "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:GetObjectVersion"],
                "Resource": [
                    f"{bucket(cfg.processed_bucket)}/{p}/*",
                    f"{bucket(cfg.quarantine_bucket)}/rejected/{p}/*",
                ],
            },
            {
                "Sid": "UseDataKey",
                "Effect": "Allow",
                "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
                "Resource": cfg.kms_key_arn,
            },
        ],
    }
    text = json.dumps(policy, separators=(",", ":"))
    if len(text) > MAX_SESSION_POLICY_CHARS:
        raise ValueError(f"session policy is {len(text)} chars (max {MAX_SESSION_POLICY_CHARS})")
    return text


def source_ip_allowed(source_ip: str, allowlist: list[str]) -> bool:
    """An empty allowlist allows any IP. Malformed entries never match."""
    if not allowlist:
        return True
    try:
        ip = ipaddress.ip_address(source_ip)
    except ValueError:
        return False
    for entry in allowlist:
        try:
            if ip in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            logger.warning("Ignoring malformed sourceIps entry %r", entry)
    return False


def authenticate(
    event: Mapping[str, Any],
    cfg: Config,
    fetch_record: Callable[[str], Mapping[str, Any] | None],
) -> tuple[dict[str, Any], str]:
    """Return (response, reason). An empty response denies the login."""
    username = str(event.get("username", ""))
    if event.get("protocol") != "SFTP":
        return DENY, "protocol not SFTP"
    if event.get("password"):
        return DENY, "password auth not allowed"
    if not PARTNER_ID_RE.fullmatch(username):
        return DENY, "invalid username"

    record = fetch_record(f"{cfg.secret_prefix}{username}")
    if record is None:
        return DENY, "unknown partner"
    if record.get("partnerId") != username or record.get("enabled") is not True:
        return DENY, "partner disabled"
    keys = [k for k in record.get("publicKeys", []) if isinstance(k, str) and k]
    if not keys:
        return DENY, "no public keys"
    if not source_ip_allowed(str(event.get("sourceIp", "")), list(record.get("sourceIps", []))):
        return DENY, "source IP not allowed"

    return {
        "Role": cfg.role_arn,
        "PublicKeys": keys,
        "Policy": session_policy(username, cfg),
        "HomeDirectoryType": "LOGICAL",
        "HomeDirectoryDetails": json.dumps(home_directories(username, cfg)),
    }, "ok"


_secrets_client = None


def _fetch_secret_json(secret_id: str) -> Mapping[str, Any] | None:
    import boto3  # provided by the Lambda runtime
    from botocore.exceptions import ClientError

    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager")
    try:
        value = _secrets_client.get_secret_value(SecretId=secret_id)
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return None
        raise
    return json.loads(value["SecretString"])


def handler(event: Mapping[str, Any], _context: object) -> dict[str, Any]:
    # Never log the event: it may contain a password.
    who = {
        "username": str(event.get("username", ""))[:64],
        "sourceIp": event.get("sourceIp"),
        "serverId": event.get("serverId"),
    }
    try:
        response, reason = authenticate(event, Config.from_env(), _fetch_secret_json)
    except Exception:
        logger.exception("IdP error, denying login %s", json.dumps(who))
        return DENY
    logger.info(json.dumps({"decision": "allow" if response else "deny", "reason": reason, **who}))
    return response
