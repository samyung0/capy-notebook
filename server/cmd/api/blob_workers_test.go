package main

import "testing"

func TestBlobSweepCoversOfficePreviews(t *testing.T) {
	for _, prefix := range sweptPrefixes {
		if prefix == "previews/" {
			return
		}
	}
	t.Fatal("report-only blob sweep does not cover previews/")
}

func TestBlobSweepCoversDerivedTextCrashOrphans(t *testing.T) {
	for _, prefix := range sweptPrefixes {
		if prefix == "derived-text/" {
			return
		}
	}
	t.Fatal("report-only blob sweep does not cover derived-text/")
}

func TestBlobSweepCoversParseBundleCrashOrphans(t *testing.T) {
	for _, prefix := range sweptPrefixes {
		if prefix == "parse-bundles/" {
			return
		}
	}
	t.Fatal("report-only blob sweep does not cover parse-bundles/")
}
