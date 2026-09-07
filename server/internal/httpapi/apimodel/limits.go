package apimodel

import (
	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// Bounded string types. Each one carries its maximum into the request schema
// through huma.SchemaTransformer, so the OpenAPI document, the orval
// validators, and request validation all read fieldlimits instead of tags.
// Field-level tags such as minLength still apply on top.
type (
	WorkspaceName        string
	WorkspaceDescription string
	ChapterName          string
	FileName             string
	MaterialTitle        string
	ConversationTitle    string
	EventTitle           string
	EventLocation        string
	TaskTitle            string
	LabelName            string
	TagValue             string
	Email                string
)

func withMax(s *huma.Schema, max int) *huma.Schema {
	s.MaxLength = &max
	return s
}

func (WorkspaceName) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.WorkspaceName)
}
func (WorkspaceDescription) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.WorkspaceDescription)
}
func (ChapterName) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.ChapterName)
}
func (FileName) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.FileName)
}
func (MaterialTitle) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.MaterialTitle)
}
func (ConversationTitle) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.ConversationTitle)
}
func (EventTitle) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.EventTitle)
}
func (EventLocation) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.EventLocation)
}
func (TaskTitle) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.TaskTitle)
}
func (LabelName) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.LabelName)
}
func (TagValue) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.TagValue)
}
func (Email) TransformSchema(_ huma.Registry, s *huma.Schema) *huma.Schema {
	return withMax(s, fieldlimits.Email)
}

// Str dereferences an optional bounded field.
func Str[T ~string](p *T) *string {
	if p == nil {
		return nil
	}
	s := string(*p)
	return &s
}
