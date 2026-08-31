package planlimits

import "testing"

func TestSeededCatalogValuesValidate(t *testing.T) {
	free := Limits{
		StorageBytes: 100_000_000, CreditMicros: 1_000_000_000,
		SourceFileBytes: 10 << 20, MaterialRevisions: 3,
		FilesPerWorkspace: 100, FilesPerUpload: 20,
	}
	pro := Limits{
		StorageBytes: 1_000_000_000, CreditMicros: 20_000_000_000,
		SourceFileBytes: 30 << 20, MaterialRevisions: 30,
		FilesPerWorkspace: 100, FilesPerUpload: 20,
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

func TestCatalogRejectsUploadCapAboveWorkspaceCap(t *testing.T) {
	err := validate(TierFree, Limits{
		StorageBytes: 1, CreditMicros: 1, SourceFileBytes: 1,
		MaterialRevisions: 1, FilesPerWorkspace: 10, FilesPerUpload: 11,
	})
	if err == nil {
		t.Fatal("invalid file caps were accepted")
	}
}
