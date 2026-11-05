package planlimits

import "testing"

func TestSeededCatalogValuesValidate(t *testing.T) {
	free := Limits{
		StorageBytes: 100_000_000, CreditMicros: 1_000_000_000,
		SourceFileBytes:   10 << 20,
		FilesPerWorkspace: 100, FilesPerUpload: 20,
		ImageBytes: 2 << 20, TextFileBytes: 2 << 20, TopicsPerWorkspace: 10,
	}
	pro := Limits{
		StorageBytes: 1_000_000_000, CreditMicros: 20_000_000_000,
		SourceFileBytes:   30 << 20,
		FilesPerWorkspace: 100, FilesPerUpload: 20,
		ImageBytes: 2 << 20, TextFileBytes: 2 << 20, TopicsPerWorkspace: 20,
	}
	if err := validate(TierFree, free); err != nil {
		t.Fatal(err)
	}
	if err := validate(TierPro, pro); err != nil {
		t.Fatal(err)
	}
	if err := validateUpgrade(free, pro); err != nil {
		t.Fatal(err)
	}
}

// Q629, Q630: text files take the flat cap whatever the plan; Excel, and
// every other file, the plan's.
func TestFileBytesHoldsTextFilesToTheTextCap(t *testing.T) {
	limits := Limits{SourceFileBytes: 30 << 20, TextFileBytes: 2 << 20}
	for _, name := range []string{"a.txt", "a.md", "a.json", "a.py", "a.csv", "A.TSV"} {
		if got := limits.FileBytes(name); got != limits.TextFileBytes {
			t.Errorf("%s: %d, want the text cap", name, got)
		}
	}
	for _, name := range []string{"a.xlsx", "a.xls", "a.pdf", "a.docx", "a.png", "a.zip", "README"} {
		if got := limits.FileBytes(name); got != limits.SourceFileBytes {
			t.Errorf("%s: %d, want the plan's cap", name, got)
		}
	}
}

func TestCatalogRejectsUploadCapAboveWorkspaceCap(t *testing.T) {
	err := validate(TierFree, Limits{
		StorageBytes: 1, CreditMicros: 1, SourceFileBytes: 1,
		FilesPerWorkspace: 10, FilesPerUpload: 11, ImageBytes: 1, TextFileBytes: 1, TopicsPerWorkspace: 1,
	})
	if err == nil {
		t.Fatal("invalid file caps were accepted")
	}
}
