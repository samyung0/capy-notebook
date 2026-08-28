package models

import "github.com/danielgtaylor/huma/v2"

// Surface identifies one product use of a configured model.
type Surface string

// UserModelSurface is the subset exposed by the account model picker.
type UserModelSurface Surface

const (
	SurfaceChat      = "chat"
	SurfaceGenerate  = "generate"
	SurfaceEditor    = "editor"
	SurfaceQuiz      = "quiz"
	SurfaceIngest    = "ingest"
	SurfaceEmbedding = "embedding"
	SurfaceVision    = "vision"
)

var allSurfaces = []Surface{
	SurfaceChat,
	SurfaceGenerate,
	SurfaceEditor,
	SurfaceQuiz,
	SurfaceIngest,
	SurfaceEmbedding,
	SurfaceVision,
}

var userModelSurfaces = []UserModelSurface{
	SurfaceChat,
	SurfaceGenerate,
	SurfaceEditor,
	SurfaceQuiz,
}

var agenticLoopSurfaces = []Surface{SurfaceChat}

// AllSurfaces returns every model surface in display order.
func AllSurfaces() []Surface {
	return append([]Surface(nil), allSurfaces...)
}

// ParseSurface validates a persisted or client-supplied surface string.
func ParseSurface(value string) (Surface, bool) {
	surface := Surface(value)
	for _, candidate := range allSurfaces {
		if surface == candidate {
			return surface, true
		}
	}
	return "", false
}

// AgenticLoopSurfaces returns the policy list used by registry writes.
func AgenticLoopSurfaces() []Surface {
	return append([]Surface(nil), agenticLoopSurfaces...)
}

// RequiresAgenticLoop reports whether models assigned to the surface must
// pass the recorded two-turn tool-loop certification.
func RequiresAgenticLoop(surface Surface) bool {
	for _, candidate := range agenticLoopSurfaces {
		if surface == candidate {
			return true
		}
	}
	return false
}

// Schema emits one reusable OpenAPI enum for Orval and other generators.
func (Surface) Schema(r huma.Registry) *huma.Schema {
	const name = "Surface"
	if r.Map()[name] == nil {
		values := make([]any, len(allSurfaces))
		for index, surface := range allSurfaces {
			values[index] = string(surface)
		}
		r.Map()[name] = &huma.Schema{Type: huma.TypeString, Enum: values}
	}
	return &huma.Schema{Ref: "#/components/schemas/" + name}
}

// Schema keeps the user-selectable subset separate from operator-only model
// surfaces while still generating one reusable frontend type.
func (UserModelSurface) Schema(r huma.Registry) *huma.Schema {
	const name = "UserModelSurface"
	if r.Map()[name] == nil {
		values := make([]any, len(userModelSurfaces))
		for index, surface := range userModelSurfaces {
			values[index] = string(surface)
		}
		r.Map()[name] = &huma.Schema{Type: huma.TypeString, Enum: values}
	}
	return &huma.Schema{Ref: "#/components/schemas/" + name}
}
