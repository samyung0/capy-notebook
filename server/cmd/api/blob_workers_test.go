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
