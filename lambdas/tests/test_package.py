"""Phase 0 smoke tests: the package imports and moto works in this environment."""

import boto3
from moto import mock_aws

import mft_lambdas


def test_package_version() -> None:
    assert mft_lambdas.__version__ == "0.1.0"


@mock_aws
def test_moto_s3_in_zurich() -> None:
    s3 = boto3.client("s3", region_name="eu-central-2")
    s3.create_bucket(
        Bucket="mft-hub-test",
        CreateBucketConfiguration={"LocationConstraint": "eu-central-2"},
    )
    names = [b["Name"] for b in s3.list_buckets()["Buckets"]]
    assert names == ["mft-hub-test"]
