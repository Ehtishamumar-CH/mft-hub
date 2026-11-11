"""Tests for the file processor (D5, D6, D12, D17, D18, D30)."""

import json

import boto3
import pytest
from moto import mock_aws

from mft_lambdas import processor as p

REGION = "eu-central-2"
CFG = p.Config(
    landing_bucket="landing-b",
    processed_bucket="processed-b",
    quarantine_bucket="quarantine-b",
    table_name="transfers",
)


def s3_event(key, version_id="v1", size=10, bucket="landing-b", detail_type="Object Created"):
    return {
        "version": "0",
        "id": "e-1",
        "detail-type": detail_type,
        "source": "aws.s3",
        "time": "2026-11-11T12:00:00Z",
        "detail": {
            "bucket": {"name": bucket},
            "object": {"key": key, "size": size, "etag": "abc", "version-id": version_id},
            "reason": "PutObject",
        },
    }


# --- pure functions ---------------------------------------------------------


class TestParseEvent:
    def test_object_created(self):
        src = p.parse_event(json.dumps(s3_event("inbound/ACME/a.csv")))
        assert src == p.SourceObject("landing-b", "inbound/ACME/a.csv", "v1", 10, "abc")

    def test_ignores_other_detail_types(self):
        assert p.parse_event(s3_event("inbound/ACME/a.csv", detail_type="Object Deleted")) is None

    def test_ignores_folder_markers(self):
        assert p.parse_event(s3_event("inbound/ACME/sub/", size=0)) is None

    def test_requires_version_id(self):
        event = s3_event("inbound/ACME/a.csv")
        del event["detail"]["object"]["version-id"]
        with pytest.raises(ValueError, match="version-id"):
            p.parse_event(event)


class TestLocate:
    def test_partner_file(self):
        assert p.locate("inbound/ACME/f.csv") == p.Location("ACME", "f.csv", True)

    @pytest.mark.parametrize(
        "key",
        ["inbound/ACME/sub/f.csv", "inbound/f.csv", "other/ACME/f.csv", "inbound/acme/f.csv"],
    )
    def test_invalid_paths(self, key):
        assert p.locate(key).valid is False

    def test_unknown_partner_cannot_collide_with_real_ids(self):
        loc = p.locate("inbound/f.csv")
        assert loc.partner_id == p.UNKNOWN_PARTNER
        assert not p.PARTNER_ID_RE.fullmatch(loc.partner_id)


class TestCheckMetadata:
    def loc(self, name, partner="ACME"):
        return p.Location(partner, name, True)

    @pytest.mark.parametrize(
        "name",
        [
            "ACME_20261111_orders.csv",
            "ACME_20261111_orders.v2.json",
            "ACME_20261111_a-b_c.XML",
            "ACME_20261111_report.pdf",
        ],
    )
    def test_valid(self, name):
        assert p.check_metadata(self.loc(name), 10) is None

    @pytest.mark.parametrize(
        ("name", "size", "reason"),
        [
            ("orders.csv", 10, p.INVALID_FILENAME),
            ("ACME_2026111_orders.csv", 10, p.INVALID_FILENAME),
            ("ACME_20261341_orders.csv", 10, p.INVALID_FILENAME),
            ("ACME_20261111_.csv", 10, p.INVALID_FILENAME),
            ("ACME_20261111_my file.csv", 10, p.INVALID_FILENAME),
            ("GLOBEX_20261111_orders.csv", 10, p.PARTNER_MISMATCH),
            ("ACME_20261111_orders.exe", 10, p.EXTENSION_NOT_ALLOWED),
            ("ACME_20261111_orders.csv", 0, p.EMPTY_FILE),
            ("ACME_20261111_orders.csv", p.MAX_BYTES + 1, p.TOO_LARGE),
        ],
    )
    def test_rejections(self, name, size, reason):
        assert p.check_metadata(self.loc(name), size) == reason

    def test_max_size_is_inclusive(self):
        assert p.check_metadata(self.loc("ACME_20261111_a.csv"), p.MAX_BYTES) is None

    def test_invalid_path_wins(self):
        assert p.check_metadata(p.Location("ACME", "x/y.csv", False), 10) == p.INVALID_PATH


class TestSniff:
    @pytest.mark.parametrize(
        ("ext", "head", "ok"),
        [
            ("pdf", b"%PDF-1.7\n", True),
            ("pdf", b"hello", False),
            ("json", b'\xef\xbb\xbf  {"a":1}', True),
            ("json", b"[1,2]", True),
            ("json", b"a,b\n", False),
            ("xml", b"\n<?xml version='1.0'?>", True),
            ("xml", b"{}", False),
            ("csv", b"a,b\n1,2\n", True),
            ("csv", b"PK\x03\x04zip", False),
            ("csv", b"%PDF-1.4", False),
            ("csv", b"a,\x00b", False),
            ("exe", b"MZ", False),
        ],
    )
    def test_sniff(self, ext, head, ok):
        assert p.sniff_ok(ext, head) is ok


def test_digest_hashes_everything_but_keeps_only_the_head():
    chunks = [b"a" * 5000, b"b" * 5000, b"c" * 5000]
    d = p.digest(chunks)
    import hashlib

    assert d.sha256 == hashlib.sha256(b"".join(chunks)).hexdigest()
    assert len(d.head) == p.SNIFF_BYTES
    assert d.head.startswith(b"a" * 5000)


def test_destinations():
    loc = p.Location("ACME", "f.csv", True)
    assert p.destination(loc, p.VALIDATED, CFG) == ("processed-b", "ACME/f.csv")
    assert p.destination(loc, p.REJECTED, CFG) == ("quarantine-b", "rejected/ACME/f.csv")


# --- with moto --------------------------------------------------------------


@pytest.fixture
def aws():
    with mock_aws():
        s3 = boto3.client("s3", region_name=REGION)
        for name in (CFG.landing_bucket, CFG.processed_bucket, CFG.quarantine_bucket):
            s3.create_bucket(Bucket=name, CreateBucketConfiguration={"LocationConstraint": REGION})
            s3.put_bucket_versioning(Bucket=name, VersioningConfiguration={"Status": "Enabled"})
        ddb = boto3.resource("dynamodb", region_name=REGION)
        table = ddb.create_table(
            TableName=CFG.table_name,
            KeySchema=[
                {"AttributeName": "partnerId", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "partnerId", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield s3, table, p.Processor(CFG, s3, table)


def upload(s3, key, body):
    res = s3.put_object(Bucket=CFG.landing_bucket, Key=key, Body=body)
    return s3_event(key, version_id=res["VersionId"], size=len(body))


def sqs(*events, ids=None):
    ids = ids or [f"m{i}" for i in range(len(events))]
    return {
        "Records": [
            {"messageId": i, "body": json.dumps(e)} for i, e in zip(ids, events, strict=True)
        ]
    }


def items(table):
    return table.scan()["Items"]


def tags(s3, bucket, key):
    tag_set = s3.get_object_tagging(Bucket=bucket, Key=key)["TagSet"]
    return {t["Key"]: t["Value"] for t in tag_set}


def current_keys(s3, bucket):
    return [o["Key"] for o in s3.list_objects_v2(Bucket=bucket).get("Contents", [])]


def test_valid_file_is_processed(aws):
    s3, table, proc = aws
    body = b"id,amount\n1,10\n"
    result = p.handle_batch(sqs(upload(s3, "inbound/ACME/ACME_20261111_orders.csv", body)), proc)

    assert result == {"batchItemFailures": []}
    assert current_keys(s3, CFG.landing_bucket) == []
    got = s3.get_object(Bucket=CFG.processed_bucket, Key="ACME/ACME_20261111_orders.csv")
    assert got["Body"].read() == body
    t = tags(s3, CFG.processed_bucket, "ACME/ACME_20261111_orders.csv")
    assert t["mft-status"] == "VALIDATED"
    assert "mft-reason" not in t

    [item] = items(table)
    import hashlib

    assert item["partnerId"] == "ACME"
    assert item["status"] == "VALIDATED"
    assert item["sha256"] == hashlib.sha256(body).hexdigest()
    assert item["sizeBytes"] == len(body)
    assert item["destKey"] == "ACME/ACME_20261111_orders.csv"
    assert item["sk"].endswith(f"#inbound/ACME/ACME_20261111_orders.csv#{item['sourceVersionId']}")
    assert item["sk"].startswith(item["transferTs"])
    assert "reason" not in item


@pytest.mark.parametrize(
    ("key", "body", "reason"),
    [
        ("inbound/ACME/orders.csv", b"a,b\n", p.INVALID_FILENAME),
        ("inbound/ACME/ACME_20261111_x.exe", b"MZ..", p.EXTENSION_NOT_ALLOWED),
        ("inbound/ACME/ACME_20261111_x.csv", b"", p.EMPTY_FILE),
        ("inbound/ACME/ACME_20261111_x.pdf", b"not a pdf", p.CONTENT_MISMATCH),
        ("inbound/ACME/GLOBEX_20261111_x.csv", b"a,b\n", p.PARTNER_MISMATCH),
    ],
)
def test_invalid_file_is_quarantined_with_reason(aws, key, body, reason):
    s3, table, proc = aws
    assert p.handle_batch(sqs(upload(s3, key, body)), proc) == {"batchItemFailures": []}

    name = key.rsplit("/", 1)[-1]
    dest = f"rejected/ACME/{name}"
    assert current_keys(s3, CFG.landing_bucket) == []
    assert current_keys(s3, CFG.processed_bucket) == []
    t = tags(s3, CFG.quarantine_bucket, dest)
    assert t == {**t, "mft-status": "REJECTED", "mft-reason": reason}
    [item] = items(table)
    assert (item["status"], item["reason"], item["destKey"]) == ("REJECTED", reason, dest)


def test_invalid_path_goes_to_the_invalid_partner_folder(aws):
    s3, table, proc = aws
    p.handle_batch(sqs(upload(s3, "inbound/ACME/sub/ACME_20261111_x.csv", b"a")), proc)
    [item] = items(table)
    assert item["reason"] == p.INVALID_PATH
    assert item["partnerId"] == "ACME"
    assert item["destKey"] == "rejected/ACME/sub/ACME_20261111_x.csv"


def test_too_large_is_rejected_without_reading(aws, monkeypatch):
    s3, table, proc = aws
    monkeypatch.setattr(p, "MAX_BYTES", 4)
    p.handle_batch(sqs(upload(s3, "inbound/ACME/ACME_20261111_x.csv", b"a,b,c\n")), proc)
    [item] = items(table)
    assert item["reason"] == p.TOO_LARGE
    assert "sha256" not in item


def test_duplicate_event_is_skipped(aws):
    s3, table, proc = aws
    event = upload(s3, "inbound/ACME/ACME_20261111_orders.csv", b"a,b\n")
    p.handle_batch(sqs(event), proc)
    # Put something new at the destination: a reprocess would overwrite it.
    s3.put_object(Bucket=CFG.processed_bucket, Key="ACME/ACME_20261111_orders.csv", Body=b"x")

    assert p.handle_batch(sqs(event), proc) == {"batchItemFailures": []}
    assert len(items(table)) == 1
    got = s3.get_object(Bucket=CFG.processed_bucket, Key="ACME/ACME_20261111_orders.csv")
    assert got["Body"].read() == b"x"


def test_same_content_uploaded_again_is_a_new_transfer(aws):
    s3, table, proc = aws
    key = "inbound/ACME/ACME_20261111_orders.csv"
    p.handle_batch(sqs(upload(s3, key, b"a,b\n")), proc)
    p.handle_batch(sqs(upload(s3, key, b"a,b\n")), proc)  # same eTag, new version
    statuses = sorted(i["status"] for i in items(table))
    assert statuses == ["VALIDATED", "VALIDATED"]
    assert current_keys(s3, CFG.landing_bucket) == []


def test_retry_after_crash_resumes(aws, monkeypatch):
    s3, table, proc = aws
    event = upload(s3, "inbound/ACME/ACME_20261111_orders.csv", b"a,b\n")
    real_update = table.update_item
    calls = {"n": 0}

    def crash_once(**kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated crash after delete")
        return real_update(**kwargs)

    monkeypatch.setattr(table, "update_item", crash_once)
    first = p.handle_batch(sqs(event, ids=["m1"]), proc)
    assert first == {"batchItemFailures": [{"itemIdentifier": "m1"}]}
    assert items(table)[0]["status"] == "RECEIVED"
    assert current_keys(s3, CFG.landing_bucket) == []  # already deleted

    # The retry reads the source by version ID, so it can finish the job.
    assert p.handle_batch(sqs(event), proc) == {"batchItemFailures": []}
    [item] = items(table)
    assert item["status"] == "VALIDATED"
    assert "sha256" in item


def test_failures_are_reported_per_message(aws):
    s3, table, proc = aws
    good = upload(s3, "inbound/ACME/ACME_20261111_orders.csv", b"a,b\n")
    missing = s3_event("inbound/ACME/ACME_20261111_gone.csv", version_id="nope")
    result = p.handle_batch(sqs(good, missing, ids=["ok", "bad"]), proc)
    assert result == {"batchItemFailures": [{"itemIdentifier": "bad"}]}
    assert items(table)[0]["status"] == "VALIDATED"


def test_url_encoded_key_falls_back_to_decoded(aws):
    s3, table, proc = aws
    event = upload(s3, "inbound/ACME/ACME 20261111 x.csv", b"a")
    event["detail"]["object"]["key"] = "inbound/ACME/ACME+20261111+x.csv"
    assert p.handle_batch(sqs(event), proc) == {"batchItemFailures": []}
    [item] = items(table)
    assert item["sourceKey"] == "inbound/ACME/ACME 20261111 x.csv"
    assert item["reason"] == p.INVALID_FILENAME


def test_other_buckets_and_events_are_ignored(aws):
    s3, table, proc = aws
    other = s3_event("inbound/ACME/a.csv", bucket="someone-else")
    deleted = s3_event("inbound/ACME/a.csv", detail_type="Object Deleted")
    assert p.handle_batch(sqs(other, deleted), proc) == {"batchItemFailures": []}
    assert items(table) == []
