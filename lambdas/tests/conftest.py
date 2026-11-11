"""Test environment: no X-Ray daemon locally, so Powertools tracing is off."""

import os

os.environ.setdefault("POWERTOOLS_TRACE_DISABLED", "true")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-2")
