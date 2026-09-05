package models

import (
	"reflect"
	"testing"
)

func TestAllSlotsAndParsingStayInSync(t *testing.T) {
	want := []Slot{
		SlotChat,
		SlotGenerate,
		SlotEditor,
		SlotQuiz,
		SlotIngest,
		SlotRetrieval,
		SlotCaptioning,
	}
	if got := AllSlots(); !reflect.DeepEqual(got, want) {
		t.Fatalf("slots = %v, want %v", got, want)
	}
	for _, slot := range want {
		parsed, ok := ParseSlot(string(slot))
		if !ok || parsed != slot {
			t.Fatalf("ParseSlot(%q) = %q, %t", slot, parsed, ok)
		}
	}
	if _, ok := ParseSlot("embedding"); ok {
		t.Fatal("retired slot name must fail parsing")
	}
}

func TestSlotRequirements(t *testing.T) {
	cases := []struct {
		slot         Slot
		capabilities []string
		certified    bool
		missing      Capability
	}{
		{SlotChat, nil, true, ""},
		{SlotChat, []string{CapabilityVision}, false, CapabilityAgenticLoop},
		{SlotRetrieval, []string{CapabilityEmbedding}, false, ""},
		{SlotRetrieval, nil, true, CapabilityEmbedding},
		{SlotCaptioning, []string{CapabilityVision, CapabilityPDF}, false, ""},
		{SlotCaptioning, []string{CapabilityPDF}, false, CapabilityVision},
		{SlotGenerate, nil, false, ""},
		{SlotIngest, nil, false, ""},
	}
	for _, tc := range cases {
		missing, ok := MissingCapability(tc.slot, tc.capabilities, tc.certified)
		if ok != (tc.missing != "") || missing != tc.missing {
			t.Fatalf("MissingCapability(%q, %v, %t) = %q, %t; want %q",
				tc.slot, tc.capabilities, tc.certified, missing, ok, tc.missing)
		}
	}
	if _, ok := ParseCapability(CapabilityAgenticLoop); ok {
		t.Fatal("agentic_loop is derived and must not be operator-settable")
	}
	for _, slot := range AllSlots() {
		if got, want := IsLLMSlot(string(slot)), slot != SlotRetrieval && slot != SlotCaptioning; got != want {
			t.Fatalf("IsLLMSlot(%q) = %t, want %t", slot, got, want)
		}
	}
}
