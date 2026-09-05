package models

import "github.com/danielgtaylor/huma/v2"

// Slot is one named place the product calls a model. Each slot holds one
// default pin; the user-selectable slots also hold a per-user preference.
// Retrieval and captioning are separate slots because the row that fills them
// is a different model from the text model: no single model both runs the
// chat agent loop and emits vectors.
type Slot string

// UserModelSlot is the subset exposed by the account model picker.
type UserModelSlot Slot

const (
	SlotChat       = "chat"
	SlotGenerate   = "generate"
	SlotEditor     = "editor"
	SlotQuiz       = "quiz"
	SlotIngest     = "ingest"
	SlotRetrieval  = "retrieval"
	SlotCaptioning = "captioning"
)

var allSlots = []Slot{
	SlotChat,
	SlotGenerate,
	SlotEditor,
	SlotQuiz,
	SlotIngest,
	SlotRetrieval,
	SlotCaptioning,
}

var userModelSlots = []UserModelSlot{
	SlotChat,
	SlotGenerate,
	SlotEditor,
	SlotQuiz,
}

// llmSlots are the slots served by a text model: they need a context window
// and thinking levels. Retrieval and captioning rows omit both.
var llmSlots = []Slot{SlotChat, SlotGenerate, SlotEditor, SlotQuiz, SlotIngest}

// Capability is something a catalog row must be able to do to sit in a slot.
// Vision, pdf and embedding are set by operators on the row. AgenticLoop is
// derived from the checked-in certification file and can never be set by hand.
type Capability string

const (
	CapabilityVision      = "vision"
	CapabilityPDF         = "pdf"
	CapabilityEmbedding   = "embedding"
	CapabilityAgenticLoop = "agentic_loop"
)

var operatorCapabilities = []Capability{
	CapabilityVision,
	CapabilityPDF,
	CapabilityEmbedding,
}

// slotRequirements is the only place the slot -> capability policy lives.
var slotRequirements = map[Slot][]Capability{
	SlotChat:       {CapabilityAgenticLoop},
	SlotRetrieval:  {CapabilityEmbedding},
	SlotCaptioning: {CapabilityVision},
}

// AllSlots returns every model slot in display order.
func AllSlots() []Slot {
	return append([]Slot(nil), allSlots...)
}

// ParseSlot validates a persisted or client-supplied slot string.
func ParseSlot(value string) (Slot, bool) {
	slot := Slot(value)
	for _, candidate := range allSlots {
		if slot == candidate {
			return slot, true
		}
	}
	return "", false
}

// IsLLMSlot reports whether the slot is served by a text model.
func IsLLMSlot(slot string) bool {
	for _, candidate := range llmSlots {
		if Slot(slot) == candidate {
			return true
		}
	}
	return false
}

// OperatorCapabilities returns the capabilities an operator may set on a row.
func OperatorCapabilities() []Capability {
	return append([]Capability(nil), operatorCapabilities...)
}

// ParseCapability validates an operator-set capability string.
func ParseCapability(value string) (Capability, bool) {
	capability := Capability(value)
	for _, candidate := range operatorCapabilities {
		if capability == candidate {
			return capability, true
		}
	}
	return "", false
}

// SlotRequirements returns the capabilities a row needs to serve the slot.
func SlotRequirements(slot Slot) []Capability {
	return append([]Capability(nil), slotRequirements[slot]...)
}

// MissingCapability returns the first capability the row lacks for the slot.
// capabilities are the row's operator-set values; certified is whether the
// exact provider/model pair has an agentic-loop certificate.
func MissingCapability(slot Slot, capabilities []string, certified bool) (Capability, bool) {
	for _, required := range slotRequirements[slot] {
		if required == CapabilityAgenticLoop {
			if !certified {
				return required, true
			}
			continue
		}
		if !containsString(capabilities, string(required)) {
			return required, true
		}
	}
	return "", false
}

// Schema emits one reusable OpenAPI enum for Orval and other generators.
func (Slot) Schema(r huma.Registry) *huma.Schema {
	const name = "Slot"
	if r.Map()[name] == nil {
		values := make([]any, len(allSlots))
		for index, slot := range allSlots {
			values[index] = string(slot)
		}
		r.Map()[name] = &huma.Schema{Type: huma.TypeString, Enum: values}
	}
	return &huma.Schema{Ref: "#/components/schemas/" + name}
}

// Schema keeps the user-selectable subset separate from operator-only model
// slots while still generating one reusable frontend type.
func (UserModelSlot) Schema(r huma.Registry) *huma.Schema {
	const name = "UserModelSlot"
	if r.Map()[name] == nil {
		values := make([]any, len(userModelSlots))
		for index, slot := range userModelSlots {
			values[index] = string(slot)
		}
		r.Map()[name] = &huma.Schema{Type: huma.TypeString, Enum: values}
	}
	return &huma.Schema{Ref: "#/components/schemas/" + name}
}
