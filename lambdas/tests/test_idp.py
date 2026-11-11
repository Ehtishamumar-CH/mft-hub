"""Tests for the Transfer Family identity provider (D4, D20)."""

import json

import boto3
import pytest
from moto import mock_aws

from mft_lambdas import idp

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIoTVMmYTO3uNGowwziM0qw9tX/LHtw4AMRzt3JyCKd8 a@b"
CFG = idp.Config(
    secret_prefix="mft/partners/",
    role_arn="arn:aws:iam::111111111111:role/partner",
    landing_bucket="landing-b",
    processed_bucket="processed-b",
    quarantine_bucket="quarantine-b",
    kms_key_arn="arn:aws:kms:eu-central-2:111111111111:key/k",
)


def record(**overrides):
    base = {
        "partnerId": "ACMEBANK",
        "name": "Acme",
        "enabled": True,
        "publicKeys": [KEY],
        "sourceIps": [],
    }
    return {**base, **overrides}


def event(**overrides):
    base = {
        "username": "ACMEBANK",
        "password": "",
        "protocol": "SFTP",
        "serverId": "s-123",
        "sourceIp": "203.0.113.7",
    }
    return {**base, **overrides}


def run(evt, rec=None):
    store = {"mft/partners/ACMEBANK": rec if rec is not None else record()}
    return idp.authenticate(evt, CFG, store.get)


# --- allow path -------------------------------------------------------------


def test_valid_partner_gets_role_keys_policy_and_logical_home():
    resp, reason = run(event())
    assert reason == "ok"
    assert resp["Role"] == CFG.role_arn
    assert resp["PublicKeys"] == [KEY]
    assert resp["HomeDirectoryType"] == "LOGICAL"
    assert json.loads(resp["HomeDirectoryDetails"]) == [
        {"Entry": "/inbound", "Target": "/landing-b/inbound/ACMEBANK"},
        {"Entry": "/processed", "Target": "/processed-b/ACMEBANK"},
        {"Entry": "/rejected", "Target": "/quarantine-b/rejected/ACMEBANK"},
    ]


def test_session_policy_is_scoped_to_the_partner():
    resp, _ = run(event())
    policy = json.loads(resp["Policy"])
    text = resp["Policy"]
    assert "GLOBEX" not in text
    resources = json.dumps([s["Resource"] for s in policy["Statement"]])
    for arn in [
        "arn:aws:s3:::landing-b/inbound/ACMEBANK/*",
        "arn:aws:s3:::processed-b/ACMEBANK/*",
        "arn:aws:s3:::quarantine-b/rejected/ACMEBANK/*",
        CFG.kms_key_arn,
    ]:
        assert arn in resources
    write = next(s for s in policy["Statement"] if s["Sid"] == "WriteInbound")
    assert "s3:DeleteObject" not in write["Action"]
    read = next(s for s in policy["Statement"] if s["Sid"] == "ReadResults")
    assert "s3:PutObject" not in read["Action"]


def test_session_policy_fits_limit_with_longest_names():
    longest = idp.Config(
        secret_prefix="mft/partners/",
        role_arn=CFG.role_arn,
        landing_bucket="l" * 63,
        processed_bucket="p" * 63,
        quarantine_bucket="q" * 63,
        kms_key_arn="arn:aws:kms:eu-central-2:111111111111:key/" + "0" * 36,
    )
    text = idp.session_policy("Z" * 32, longest)
    assert len(text) <= idp.MAX_SESSION_POLICY_CHARS


@pytest.mark.parametrize(
    ("allowlist", "ip", "allowed"),
    [
        ([], "198.51.100.1", True),
        (["203.0.113.0/24"], "203.0.113.7", True),
        (["203.0.113.7"], "203.0.113.7", True),
        (["203.0.113.0/24"], "198.51.100.1", False),
        (["not-an-ip"], "203.0.113.7", False),
        (["203.0.113.0/24"], "garbage", False),
        (["2001:db8::/32"], "2001:db8::1", True),
    ],
)
def test_source_ip_allowlist(allowlist, ip, allowed):
    assert idp.source_ip_allowed(ip, allowlist) is allowed


# --- deny paths -------------------------------------------------------------


@pytest.mark.parametrize(
    ("evt", "rec", "reason"),
    [
        (event(password="hunter2"), None, "password auth not allowed"),
        (event(protocol="FTP"), None, "protocol not SFTP"),
        (event(username="acmebank"), None, "invalid username"),
        (event(username="../ACMEBANK"), None, "invalid username"),
        (event(username="GLOBEX"), None, "unknown partner"),
        (event(), record(enabled=False), "partner disabled"),
        (event(), record(partnerId="GLOBEX"), "partner disabled"),
        (event(), record(publicKeys=[]), "no public keys"),
        (event(), record(sourceIps=["198.51.100.0/24"]), "source IP not allowed"),
    ],
)
def test_denials_return_empty_response(evt, rec, reason):
    resp, got = run(evt, rec)
    assert resp == {}
    assert got == reason


# --- handler with Secrets Manager (moto) -------------------------------------


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-central-2")
    for k, v in {
        "PARTNER_SECRET_PREFIX": CFG.secret_prefix,
        "PARTNER_ROLE_ARN": CFG.role_arn,
        "LANDING_BUCKET": CFG.landing_bucket,
        "PROCESSED_BUCKET": CFG.processed_bucket,
        "QUARANTINE_BUCKET": CFG.quarantine_bucket,
        "KMS_KEY_ARN": CFG.kms_key_arn,
    }.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(idp, "_secrets_client", None)


@mock_aws
def test_handler_reads_secret_and_allows(env):
    boto3.client("secretsmanager").create_secret(
        Name="mft/partners/ACMEBANK", SecretString=json.dumps(record())
    )
    resp = idp.handler(event(), None)
    assert resp["Role"] == CFG.role_arn
    assert resp["PublicKeys"] == [KEY]


@mock_aws
def test_handler_denies_unknown_partner(env):
    assert idp.handler(event(username="GLOBEX"), None) == {}


@mock_aws
def test_handler_denies_on_unexpected_error(env, monkeypatch):
    monkeypatch.delenv("PARTNER_ROLE_ARN")
    assert idp.handler(event(), None) == {}


@mock_aws
def test_handler_never_logs_password(env, caplog):
    idp.handler(event(password="s3cret-value"), None)
    assert "s3cret-value" not in caplog.text
