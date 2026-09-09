// Package fieldlimits is the single source of truth for user-visible text
// lengths. Request schemas derive from these constants through the named
// types in httpapi/apimodel, Postgres CHECK constraints repeat them as
// literals in migrations/0001_init.sql and TestColumnLimits asserts the two
// agree, and cmd/openapi renders them for the Python pipeline.
package fieldlimits

import (
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Limits count runes, matching huma's maxLength and Postgres char_length.
const (
	WorkspaceName        = 80
	WorkspaceDescription = 500
	ChapterName          = 60
	FileName             = 120
	MaterialTitle        = FileName
	ConversationTitle    = 60
	EventTitle           = 60
	EventLocation        = 100
	TaskTitle            = 80
	LabelName            = 35
	TagValue             = 35
	Email                = 254
	UserName             = 60
)

// Columns lists every constrained column as "table.column" so the database
// test can verify each CHECK against the constant it mirrors.
var Columns = map[string]int{
	"users.name":                       UserName,
	"users.email":                      Email,
	"workspaces.name":                  WorkspaceName,
	"workspaces.description":           WorkspaceDescription,
	"chapters.name":                    ChapterName,
	"files.name":                       FileName,
	"materials.workspace_name":         WorkspaceName,
	"materials.title":                  MaterialTitle,
	"attempts.quiz_name":               MaterialTitle,
	"attempts.workspace_name":          WorkspaceName,
	"tags.name":                        TagValue,
	"labels.name":                      LabelName,
	"events.title":                     EventTitle,
	"events.location":                  EventLocation,
	"tasks.title":                      TaskTitle,
	"canvases.name":                    MaterialTitle,
	"workspace_invites.email":          Email,
	"conversations.title":              ConversationTitle,
	"editor_assets.name":               FileName,
	"upload_sessions.chapter_name":     ChapterName,
	"upload_sessions.name":             FileName,
	"reconcile_runs.requested_by_name": UserName,
}

// Clamp trims s and cuts it to max runes. It is for values the user did not
// type (provider profiles, model output, derived titles), which must land in
// a bounded column instead of failing the request.
func Clamp(s string, max int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:max]))
}

// ClampFileName cuts name to FileName runes while keeping its extension, which
// sourceupload and editor asset rules read to pick a kind and parser.
func ClampFileName(name string) string {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) <= FileName {
		return name
	}
	ext := filepath.Ext(name)
	if utf8.RuneCountInString(ext) > 12 {
		ext = ""
	}
	base := strings.TrimSuffix(name, ext)
	return Clamp(base, FileName-utf8.RuneCountInString(ext)) + ext
}
