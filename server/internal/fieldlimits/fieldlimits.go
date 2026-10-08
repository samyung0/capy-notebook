// Package fieldlimits is the single source of truth for user-visible text
// lengths. Request schemas derive from these constants through the named
// types in httpapi/apimodel, Postgres CHECK constraints repeat them as
// literals in migrations/0001_init.sql and TestColumnLimits asserts the two
// agree, and cmd/openapi renders selected limits for TypeScript and Python.
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
	ChatMessage          = 5_000
	// Comment bounds the plain text of one note comment (its paragraphs joined).
	Comment                = 3_000
	LLMAPIKey              = 512
	EventTitle             = 60
	EventLocation          = 100
	TaskTitle              = 80
	LabelName              = 35
	TagValue               = 35
	Email                  = 254
	UserName               = 60
	PDFAnnotationText      = 2_000
	QuestionCount          = 200
	QuestionID             = 128
	QuestionParts          = 26
	QuestionBlocks         = 40
	QuestionText           = 12_000
	QuestionMetadata       = 1_000
	QuestionAnswers        = 100
	QuestionMarkscheme     = 20
	QuestionMarkItem       = 1_000
	QuestionMarks          = 20
	QuestionUnit           = 100
	QuestionTableRows      = 30
	QuestionTableColumns   = 10
	QuestionChartLabels    = 50
	QuestionChartSeries    = 8
	QuestionGraphElements  = 60
	QuestionGraphTerm      = 200
	QuestionGraphPolygon   = 12
	QuestionSVGBytes       = 256 << 10
	QuestionImageDimension = 10_000
	QuestionAssetURL       = 4_096
	// User quizzes (not the question bank) are bounded tighter, so one
	// attempt's open parts fit a single grading request: at most 20 open parts
	// of at most 5 marking items each.
	QuizParts         = 100
	QuizQuestionParts = 7
	QuizOpenParts     = 20
	QuizMarkscheme    = 5
	QuizOpenAnswer    = 5_000
	// AnonymousLocalID bounds the reporting id a signed-out browser sends.
	AnonymousLocalID = 64
)

// QuestionBounds is exported into frontend, sidecar and pipeline contracts.
var QuestionBounds = map[string]int{
	"QUESTION_COUNT_MAX":           QuestionCount,
	"QUESTION_ID_MAX":              QuestionID,
	"QUESTION_PARTS_MAX":           QuestionParts,
	"QUESTION_BLOCKS_MAX":          QuestionBlocks,
	"QUESTION_TEXT_MAX":            QuestionText,
	"QUESTION_METADATA_MAX":        QuestionMetadata,
	"QUESTION_ANSWERS_MAX":         QuestionAnswers,
	"QUESTION_MARKSCHEME_MAX":      QuestionMarkscheme,
	"QUESTION_MARK_ITEM_MAX":       QuestionMarkItem,
	"QUESTION_MARKS_MAX":           QuestionMarks,
	"QUESTION_UNIT_MAX":            QuestionUnit,
	"QUESTION_TABLE_ROWS_MAX":      QuestionTableRows,
	"QUESTION_TABLE_COLUMNS_MAX":   QuestionTableColumns,
	"QUESTION_CHART_LABELS_MAX":    QuestionChartLabels,
	"QUESTION_CHART_SERIES_MAX":    QuestionChartSeries,
	"QUESTION_GRAPH_ELEMENTS_MAX":  QuestionGraphElements,
	"QUESTION_GRAPH_TERM_MAX":      QuestionGraphTerm,
	"QUESTION_GRAPH_POLYGON_MAX":   QuestionGraphPolygon,
	"QUESTION_SVG_BYTES_MAX":       QuestionSVGBytes,
	"QUESTION_IMAGE_DIMENSION_MAX": QuestionImageDimension,
	"QUESTION_ASSET_URL_MAX":       QuestionAssetURL,
	"QUIZ_PARTS_MAX":               QuizParts,
	"QUIZ_QUESTION_PARTS_MAX":      QuizQuestionParts,
	"QUIZ_OPEN_PARTS_MAX":          QuizOpenParts,
	"QUIZ_MARKSCHEME_MAX":          QuizMarkscheme,
	"QUIZ_OPEN_ANSWER_MAX":         QuizOpenAnswer,
}

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
	"anonymous_grading_usage.local_id": AnonymousLocalID,
	"reconcile_runs.requested_by_name": UserName,
	"pdf_annotations.text":             PDFAnnotationText,
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
