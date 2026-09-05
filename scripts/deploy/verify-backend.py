#!/usr/bin/env python3
"""A standalone ingest deploy may only use the matching backend's current SHA."""

import os
import re
import sys
import urllib.request

url = os.environ["DEPLOYMENT_API_URL"]
revision = os.environ.get("EXPECTED_REVISION", "")
print_only = sys.argv[1:] == ["--print"]
if not url.startswith("https://") or (
    not print_only and not re.fullmatch("[0-9a-f]{40}", revision)
):
    sys.exit("Invalid backend URL or release SHA")
try:
    request = urllib.request.Request(
        url.rstrip("/") + "/healthz",
        headers={
            "Accept": "application/json",
            "User-Agent": "Capy Notebook deployment",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        reported = response.headers.get("X-Capy-Release", "")
        if response.status != 200 or not re.fullmatch("[0-9a-f]{40}", reported):
            sys.exit("Backend does not report a healthy immutable revision")
        if not print_only and reported != revision:
            sys.exit("Backend does not serve this SHA; deploy the app first")
except OSError:
    sys.exit("Could not verify the backend revision")
print(reported if print_only else "Backend revision verified")
