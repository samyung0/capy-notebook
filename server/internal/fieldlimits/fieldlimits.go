// Package fieldlimits is the single source of truth for user-visible text
// lengths. Request schemas derive from these constants through the named
// types in httpapi/apimodel, Postgres CHECK constraints repeat them as
// literals in migrations/0001_init.sql and TestColumnLimits asserts the two
// agree, and cmd/openapi renders selected limits for TypeScript and Python.
package fieldlimits

import (
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits count runes, matching huma's maxLength and Postgres char_length.
const (
	WorkspaceName        = 80
	WorkspaceDescription = 500
	// WorkspaceTags is a workspace's tag count (CreateWorkspaceReq's
	// maxItems), a count rather than characters.
	WorkspaceTags = 5
	TopicName     = 60
	// TopicDescription is a topic's optional one line on what it covers.
	TopicDescription = 200
	FileName         = 120
	MaterialTitle    = FileName
	AssignmentTitle  = 120
	// An agent-made material's or file's made-from line: at most
	// MaterialSources entries of at most MaterialSource characters.
	MaterialSources   = 20
	MaterialSource    = 200
	ConversationTitle = 60
	ChatMessage       = 5_000
	// VoiceInputSeconds is the longest chat voice recording, in seconds
	// rather than characters (Epo 2026-10-23); its transcript stays well
	// under ChatMessage.
	VoiceInputSeconds = 120
	// Comment bounds the plain text of one note comment.
	Comment           = 3_000
	EventTitle        = 60
	EventLocation     = 100
	TaskTitle         = 80
	LabelName         = 35
	TagValue          = 35
	Email             = 254
	UserName          = 60
	PDFAnnotationText = 2_000
	QuestionCount     = 200
	QuestionID        = 128
	QuestionParts     = 26
	QuestionBlocks    = 40
	QuestionText      = 12_000
	QuestionMetadata  = 1_000
	// QuestionDescription bounds an image's or graph's description outside
	// the bank (quizzes and notes); bank questions take QuestionText.
	QuestionDescription  = 500
	QuestionAnswers      = 100
	QuestionMarkscheme   = 20
	QuestionMarkItem     = 1_000
	QuestionMarks        = 20
	QuestionUnit         = 100
	QuestionTableRows    = 30
	QuestionTableColumns = 10
	QuestionChartLabels  = 50
	QuestionChartSeries  = 6
	// A chart's title and axis titles, each series name and category label,
	// and each value's magnitude (Epo 2026-10-17).
	QuestionChartTitle      = 100
	QuestionChartSeriesName = 60
	QuestionChartLabel      = 60
	QuestionChartValue      = 1_000_000_000_000
	QuestionGraphElements   = 60
	QuestionGraphTerm       = 200
	QuestionGraphPolygon    = 12
	// A graph's label text (wrapped on the board) and its point names and
	// angle labels (Epo 2026-10-17).
	QuestionGraphLabel = 60
	QuestionGraphName  = 20
	// A graph's width and height in pixels: its text is drawn at 12px, so a
	// larger board shrinks it past reading in a note column; 120 keeps short
	// box plots (Epo 2026-10-17).
	QuestionGraphDimensionMin = 120
	QuestionGraphDimensionMax = 1_200
	// A plot block: curves of [x, y] points, and reference lines and
	// labelled points, each list at most QuestionPlotMarks long.
	QuestionPlotSeries = 4
	QuestionPlotPoints = 60
	QuestionPlotMarks  = 8
	// A plot's title, axis titles and unit, and each series name and line or
	// mark label, bounded as a chart's (Epo 2026-10-17).
	QuestionPlotTitle      = QuestionChartTitle
	QuestionPlotLabel      = QuestionChartSeriesName
	QuestionSVGBytes       = 256 << 10
	QuestionImageDimension = 10_000
	QuestionAssetURL       = 4_096
	// User quizzes (not the question bank) are bounded tighter: 100 parts,
	// all of which may be AI-marked (open) parts, so a whole past paper fits
	// one quiz (Epo 2026-11-03; it was 20), each with at most 5 marking items.
	// Each open part is graded in its own request.
	QuizParts         = 100
	QuizQuestionParts = 7
	QuizOpenParts     = 100
	QuizMarkscheme    = 5
	QuizOpenAnswer    = 5_000
	// A Make a quiz run reads at most ExtractionPaperFiles question files and
	// ExtractionAnswerFiles answer files, and at most ExtractionPages picked pages across
	// them (Epo 2026-11-05). Each saved question costs ExtractionQuestionCredits.
	ExtractionPages           = 40
	ExtractionPaperFiles      = 5
	ExtractionAnswerFiles     = 3
	ExtractionQuestionCredits = 4
	// A drawing answer's saved board (undo history stripped) and its marking
	// image, each at most this many bytes (Epo 2026-11-06: 250 KB and 300 KB),
	// the image at most DrawingImageSide px on its longer side, as the browser
	// makes it (Epo 2026-11-06, "go with 1568px").
	DrawingBoardBytes = 250 << 10
	DrawingImageBytes = 300 << 10
	DrawingImageSide  = 1_568
	// A flashcard's front and back (human/frontend/plate-editor.md for the
	// back); the collaboration server reads them from the embed catalog.
	CardFront = 200
	CardBack  = 1_000
)

// QuestionBounds is exported into frontend and pipeline contracts; the
// collaboration server reads them from the embed catalog (internal/embeds).
var QuestionBounds = map[string]int{
	"QUESTION_COUNT_MAX":             QuestionCount,
	"DRAWING_BOARD_MAX":              DrawingBoardBytes,
	"DRAWING_IMAGE_MAX":              DrawingImageBytes,
	"DRAWING_IMAGE_SIDE_MAX":         DrawingImageSide,
	"QUESTION_ID_MAX":                QuestionID,
	"QUESTION_PARTS_MAX":             QuestionParts,
	"QUESTION_BLOCKS_MAX":            QuestionBlocks,
	"QUESTION_TEXT_MAX":              QuestionText,
	"QUESTION_METADATA_MAX":          QuestionMetadata,
	"QUESTION_DESCRIPTION_MAX":       QuestionDescription,
	"QUESTION_ANSWERS_MAX":           QuestionAnswers,
	"QUESTION_MARKSCHEME_MAX":        QuestionMarkscheme,
	"QUESTION_MARK_ITEM_MAX":         QuestionMarkItem,
	"QUESTION_MARKS_MAX":             QuestionMarks,
	"QUESTION_UNIT_MAX":              QuestionUnit,
	"QUESTION_TABLE_ROWS_MAX":        QuestionTableRows,
	"QUESTION_TABLE_COLUMNS_MAX":     QuestionTableColumns,
	"QUESTION_CHART_LABELS_MAX":      QuestionChartLabels,
	"QUESTION_CHART_SERIES_MAX":      QuestionChartSeries,
	"QUESTION_CHART_TITLE_MAX":       QuestionChartTitle,
	"QUESTION_CHART_SERIES_NAME_MAX": QuestionChartSeriesName,
	"QUESTION_CHART_LABEL_MAX":       QuestionChartLabel,
	"QUESTION_CHART_VALUE_MAX":       QuestionChartValue,
	"QUESTION_GRAPH_ELEMENTS_MAX":    QuestionGraphElements,
	"QUESTION_GRAPH_TERM_MAX":        QuestionGraphTerm,
	"QUESTION_GRAPH_POLYGON_MAX":     QuestionGraphPolygon,
	"QUESTION_GRAPH_LABEL_MAX":       QuestionGraphLabel,
	"QUESTION_GRAPH_NAME_MAX":        QuestionGraphName,
	"QUESTION_GRAPH_DIMENSION_MIN":   QuestionGraphDimensionMin,
	"QUESTION_GRAPH_DIMENSION_MAX":   QuestionGraphDimensionMax,
	"QUESTION_PLOT_SERIES_MAX":       QuestionPlotSeries,
	"QUESTION_PLOT_POINTS_MAX":       QuestionPlotPoints,
	"QUESTION_PLOT_MARKS_MAX":        QuestionPlotMarks,
	"QUESTION_PLOT_TITLE_MAX":        QuestionPlotTitle,
	"QUESTION_PLOT_LABEL_MAX":        QuestionPlotLabel,
	"QUESTION_SVG_BYTES_MAX":         QuestionSVGBytes,
	"QUESTION_IMAGE_DIMENSION_MAX":   QuestionImageDimension,
	"QUESTION_ASSET_URL_MAX":         QuestionAssetURL,
	"QUIZ_PARTS_MAX":                 QuizParts,
	"QUIZ_QUESTION_PARTS_MAX":        QuizQuestionParts,
	"QUIZ_OPEN_PARTS_MAX":            QuizOpenParts,
	"QUIZ_MARKSCHEME_MAX":            QuizMarkscheme,
	"QUIZ_OPEN_ANSWER_MAX":           QuizOpenAnswer,
}

// QuestionBoundNames lists QuestionBounds' names in order, for generated files.
func QuestionBoundNames() []string {
	names := make([]string, 0, len(QuestionBounds))
	for name := range QuestionBounds {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Columns lists every constrained column as "table.column" so the database
// test can verify each CHECK against the constant it mirrors.
var Columns = map[string]int{
	"users.name":                       UserName,
	"users.email":                      Email,
	"workspaces.name":                  WorkspaceName,
	"workspaces.description":           WorkspaceDescription,
	"topics.name":                      TopicName,
	"topics.description":               TopicDescription,
	"files.name":                       FileName,
	"materials.workspace_name":         WorkspaceName,
	"materials.title":                  MaterialTitle,
	"assignments.title":                AssignmentTitle,
	"attempts.quiz_name":               MaterialTitle,
	"question_extractions.title":       MaterialTitle,
	"attempts.workspace_name":          WorkspaceName,
	"tags.name":                        TagValue,
	"labels.name":                      LabelName,
	"events.title":                     EventTitle,
	"events.location":                  EventLocation,
	"tasks.title":                      TaskTitle,
	"workspace_invites.email":          Email,
	"conversations.title":              ConversationTitle,
	"editor_assets.name":               FileName,
	"upload_sessions.topic_name":       TopicName,
	"upload_sessions.name":             FileName,
	"reconcile_runs.requested_by_name": UserName,
	"pdf_annotations.text":             PDFAnnotationText,
	"material_comments.text":           Comment,
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

// ValidFileName reports a file name of 1 to FileName characters (trimmed)
// with no control character, bidi override or isolate character (the set
// Q313 refuses in comments) and no path separator (Epo 2026-10-24, Q346).
func ValidFileName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > FileName {
		return false
	}
	return !strings.ContainsFunc(name, func(r rune) bool {
		return unicode.IsControl(r) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) ||
			r == '/' || r == '\\'
	})
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
