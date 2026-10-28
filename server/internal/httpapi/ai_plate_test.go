package httpapi

import (
	"strings"
	"testing"
)

func TestGhostTextReqValidation(t *testing.T) {
	valid := ghostTextReq{Title: "Cell respiration", Before: "Glycolysis splits glucose into", After: " in the cytoplasm."}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	full := ghostTextReq{Before: strings.Repeat("字", maxGhostContextBytes/3)}
	if err := full.validate(); err != nil {
		t.Fatalf("a full window was rejected: %v", err)
	}
	if err := (ghostTextReq{Title: "Empty"}).validate(); err == nil {
		t.Fatal("empty text before the caret was accepted")
	}
}
