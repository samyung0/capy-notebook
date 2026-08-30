// Package sourceupload contains the shared source-file rules used by uploads,
// imports, and the frontend upload policy endpoint.
package sourceupload

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// ParseModeFast is the live CPU parser (Marker + RapidOCR on scans).
	ParseModeFast = "fast"
	ParseModeNone = "none"

	// Per-file source caps, independent of plan storage quota and of editor
	// assets (which have their own purpose ladder). GPU/LLM cost is metered
	// separately; these bounds only stop a single upload from being enormous.
	FreeSourceMaxBytes = 10 << 20
	ProSourceMaxBytes  = 30 << 20
	// Absolute ceiling used as the HTTP body limit so a request is rejected
	// before we look up the owner's plan. Must be >= ProSourceMaxBytes.
	ParseMaxBytes  = ProSourceMaxBytes
	UploadMaxBytes = ParseMaxBytes + (4 << 20)

	// ProcessingPlanVersion changes whenever the enqueue-time contract changes
	// incompatibly. Workers reject versions they do not understand instead of
	// guessing from a file kind or extension.
	ProcessingPlanVersion = 1

	RouteStoreOnly       = "store_only"
	RouteRawText         = "raw_text"
	RouteDelimitedText   = "delimited_text"
	RouteImageCaption    = "image_caption"
	RouteAudioTranscript = "audio_transcription"
	RouteDocumentParse   = "document_parse"

	CaptionNone       = "none"
	CaptionStandalone = "standalone"
	CaptionEmbedded   = "embedded"
)

// ProcessingPlan is the server-owned, versioned contract consumed by ingest
// workers. Format selection happens once, when the job is enqueued. The stages
// and resources are declarative: the worker still owns retries, telemetry, and
// the implementation of each stage.
type ProcessingPlan struct {
	Version       int      `json:"version"`
	Format        string   `json:"format"`
	Route         string   `json:"route"`
	ParserRoute   string   `json:"parserRoute,omitempty"`
	CaptionMode   string   `json:"captionMode"`
	OfficePreview bool     `json:"officePreview"`
	Stages        []string `json:"stages"`
	Resources     []string `json:"resources"`
}

// SourceMaxBytes is the per-file cap for the workspace owner's plan.
func SourceMaxBytes(pro bool) int64 {
	if pro {
		return ProSourceMaxBytes
	}
	return FreeSourceMaxBytes
}

// explicitKindExtensions mirrors AddSourceDialog's KIND_BY_EXT. Text/code
// extensions are added below, without overriding these explicit kinds.
var explicitKindExtensions = map[string][]string{
	"pdf":    {"pdf"},
	"doc":    {"docx", "doc"},
	"md":     {"md", "markdown", "mdx", "mdc"},
	"image":  {"png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp", "svg", "avif", "tif", "tiff", "heic", "heif", "ico"},
	"sheet":  {"xlsx", "xls", "csv", "tsv"},
	"slides": {"pptx", "ppt"},
	"audio":  {"mp3", "wav", "m4a", "ogg", "flac", "aac", "webm", "mp4", "mpeg", "mpga", "opus"},
	"json":   {"json", "map"},
}

// textExtensions is the complete TEXT_EXT list from AddSourceDialog. Keep
// this list in sync with the frontend source list; explicit kinds above win
// for overlapping entries such as csv, md, and markdown.
var textExtensions = []string{
	"3dml",
	"appcache",
	"asm",
	"c",
	"cc",
	"coffee",
	"conf",
	"cpp",
	"css",
	"curl",
	"cxx",
	"dcurl",
	"def",
	"dic",
	"dsc",
	"etx",
	"f",
	"f77",
	"f90",
	"flx",
	"fly",
	"for",
	"ged",
	"gv",
	"h",
	"hbs",
	"hh",
	"htm",
	"html",
	"htc",
	"ics",
	"ifb",
	"in",
	"ini",
	"jad",
	"jade",
	"java",
	"js",
	"jsx",
	"less",
	"list",
	"litcoffee",
	"log",
	"lua",
	"man",
	"manifest",
	"m",
	"markdown",
	"mcurl",
	"md",
	"mdx",
	"me",
	"mjs",
	"mkd",
	"mml",
	"ms",
	"n3",
	"nfo",
	"opml",
	"org",
	"p",
	"pas",
	"pde",
	"roff",
	"rtf",
	"rtx",
	"s",
	"sass",
	"scss",
	"scurl",
	"sgm",
	"sgml",
	"shex",
	"shtml",
	"slim",
	"slm",
	"spdx",
	"spot",
	"styl",
	"stylus",
	"sub",
	"t",
	"text",
	"tr",
	"ts",
	"tsv",
	"tsx",
	"ttl",
	"txt",
	"uri",
	"uris",
	"urls",
	"uu",
	"vcard",
	"vcf",
	"vcs",
	"vtt",
	"wgsl",
	"wml",
	"wmls",
	"xml",
	"yaml",
	"yml",
	"adb",
	"ads",
	"al",
	"asc",
	"asd",
	"ass",
	"automount",
	"bib",
	"c++",
	"cbl",
	"cl",
	"cls",
	"cmake",
	"cob",
	"cr",
	"cs",
	"csvs",
	"d",
	"dart",
	"dcl",
	"device",
	"di",
	"diff",
	"dot",
	"dsl",
	"dtd",
	"dtx",
	"e",
	"eif",
	"el",
	"ent",
	"erl",
	"es",
	"ex",
	"exs",
	"f95",
	"fasl",
	"feature",
	"fo",
	"gcode",
	"gcrd",
	"gedcom",
	"go",
	"gradle",
	"groovy",
	"gs",
	"gsh",
	"gvp",
	"gvy",
	"gy",
	"h++",
	"hp",
	"hpp",
	"hs",
	"hxx",
	"ico",
	"idl",
	"ime",
	"imy",
	"ins",
	"iptables",
	"jsm",
	"ksy",
	"kt",
	"latex",
	"ldif",
	"lhs",
	"lisp",
	"ltx",
	"ly",
	"lyx",
	"mak",
	"mc2",
	"mk",
	"ml",
	"mli",
	"mm",
	"mo",
	"moc",
	"mof",
	"mount",
	"mrl",
	"mrml",
	"mup",
	"not",
	"ocl",
	"ooc",
	"owl",
	"patch",
	"path",
	"perl",
	"pl",
	"pm",
	"po",
	"pod",
	"pot",
	"py",
	"py3",
	"py3x",
	"pyi",
	"pyx",
	"qml",
	"qmlproject",
	"qmltypes",
	"rdf",
	"rdfs",
	"reg",
	"rej",
	"rng",
	"ros",
	"rs",
	"rss",
	"rst",
	"rt",
	"sage",
	"sc",
	"scala",
	"scm",
	"scope",
	"service",
	"sfv",
	"sh",
	"slice",
	"slk",
	"socket",
	"spec",
	"sql",
	"ss",
	"ssa",
	"sty",
	"sv",
	"svh",
	"swap",
	"sylk",
	"t2t",
	"target",
	"tcl",
	"tex",
	"texi",
	"texinfo",
	"timer",
	"tk",
	"twig",
	"uil",
	"uue",
	"v",
	"vala",
	"vapi",
	"vbs",
	"vct",
	"vhd",
	"vhdl",
	"wsgi",
	"xbl",
	"xmi",
	"xsd",
	"xslfo",
	"ymp",
}

var extensionKinds = buildExtensionKinds()

func buildExtensionKinds() map[string]string {
	out := make(map[string]string, len(textExtensions)+32)
	for kind, extensions := range explicitKindExtensions {
		for _, ext := range extensions {
			out[strings.ToLower(ext)] = kind
		}
	}
	for _, ext := range textExtensions {
		ext = strings.ToLower(ext)
		if _, exists := out[ext]; !exists {
			out[ext] = "txt"
		}
	}
	return out
}

func extensionKey(name string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
}

// Extension returns the normalized extension including its leading dot.
func Extension(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return ""
	}
	return ext
}

// KindFromName returns the server-owned kind for a recognized extension.
// Unrecognized names intentionally remain "unknown": they are valid
// store-only sources, so adding a viewer later does not require users to
// upload the bytes again.
func KindFromName(name string) string {
	ext := extensionKey(name)
	if ext == "" {
		return "unknown"
	}
	if kind, ok := extensionKinds[ext]; ok {
		return kind
	}
	return "unknown"
}

func IsTextKind(kind string) bool {
	return kind == "txt" || kind == "md" || kind == "json"
}

func DefaultParseMode(name, kind string) string {
	if IsTextKind(kind) {
		// Text is never sent to the document parser. The worker reads the bytes and
		// chunks them; parseMode=none still enqueues that job (see NeedsIngestJob).
		return ParseModeNone
	}
	if parseExtensions[extensionKey(name)] {
		return ParseModeFast
	}
	return ParseModeNone
}

// BuildProcessingPlan resolves a file into one ingest route. It deliberately
// keys the exceptional routes by normalized format instead of broad category:
// CSV/TSV are normalized as delimited text, while legacy Office files remain
// store-only even though they share a category with supported OOXML files.
func BuildProcessingPlan(name, kind, mode string, captionImages bool) (ProcessingPlan, error) {
	ext := extensionKey(name)
	expectedKind := KindFromName(name)
	if kind == "" {
		kind = expectedKind
	}
	if kind != expectedKind {
		return ProcessingPlan{}, fmt.Errorf("file kind %q does not match extension %q", kind, Extension(name))
	}
	if mode != ParseModeNone && mode != ParseModeFast {
		return ProcessingPlan{}, fmt.Errorf("unknown parse mode %q", mode)
	}

	plan := ProcessingPlan{
		Version:     ProcessingPlanVersion,
		Format:      ext,
		Route:       RouteStoreOnly,
		CaptionMode: CaptionNone,
		Stages:      []string{},
		Resources:   []string{},
	}
	directStages := []string{"fetch_source", "chunk", "index", "generate_derivatives"}
	directResources := []string{"object_storage_read", "embedding_model", "ingest_model"}

	switch {
	case ext == "csv" || ext == "tsv":
		plan.Route = RouteDelimitedText
		plan.Stages = insertStage(directStages, 1, "normalize_delimited")
		plan.Resources = directResources
	case IsTextKind(kind):
		plan.Route = RouteRawText
		plan.Stages = directStages
		plan.Resources = directResources
	case kind == "image":
		plan.Route = RouteImageCaption
		plan.CaptionMode = CaptionStandalone
		plan.Stages = []string{"fetch_source", "caption_image", "persist_derived_text", "chunk", "index", "generate_derivatives"}
		plan.Resources = appendResource(directResources, "vision_model", "object_storage_write")
	case kind == "audio":
		plan.Route = RouteAudioTranscript
		plan.Stages = []string{"fetch_source", "transcribe_audio", "persist_derived_text", "chunk", "index", "generate_derivatives"}
		plan.Resources = appendResource(directResources, "audio_transcription", "object_storage_write")
	case mode == ParseModeFast && parseExtensions[ext]:
		plan.Route = RouteDocumentParse
		plan.ParserRoute = ParseModeFast
		plan.OfficePreview = ext == "docx" || ext == "pptx" || ext == "xlsx"
		plan.Stages = []string{"fetch_source", "parse_document"}
		if plan.OfficePreview {
			plan.Stages = append(plan.Stages, "persist_office_preview")
		}
		plan.Resources = appendResource(directResources, "document_parser", "shared_parse_spool")
		if plan.OfficePreview {
			plan.Resources = appendResource(plan.Resources, "object_storage_write")
		}
		if captionImages {
			plan.CaptionMode = CaptionEmbedded
			plan.Stages = append(plan.Stages, "caption_images", "persist_captions")
			plan.Resources = appendResource(plan.Resources, "vision_model", "object_storage_write")
		}
		plan.Stages = append(plan.Stages, "chunk", "index", "generate_derivatives")
	}
	return plan, nil
}

func insertStage(stages []string, at int, stage string) []string {
	out := make([]string, 0, len(stages)+1)
	out = append(out, stages[:at]...)
	out = append(out, stage)
	out = append(out, stages[at:]...)
	return out
}

func appendResource(resources []string, values ...string) []string {
	out := append([]string{}, resources...)
	seen := make(map[string]bool, len(out)+len(values))
	for _, resource := range out {
		seen[resource] = true
	}
	for _, value := range values {
		if !seen[value] {
			out = append(out, value)
			seen[value] = true
		}
	}
	return out
}

// NeedsIngestJob is whether an upload should be queued for searchable derived
// content. This is deliberately separate from parse mode: images are
// captioned, audio is transcribed, and CSV/TSV is normalized without using the
// document parser.
func NeedsIngestJob(name, kind, mode string) bool {
	plan, err := BuildProcessingPlan(name, kind, mode, false)
	return err == nil && plan.Route != RouteStoreOnly
}

// NormalizeCaptionImages clears a caption request that has nothing to act on.
// Captions are written onto the figures a parse extracted, so an unparsed blob
// or a plain-text source can never produce one, and letting the flag through
// would only put a misleading value on the job.
func NormalizeCaptionImages(kind, mode string, requested bool) bool {
	if !requested || mode == ParseModeNone || IsTextKind(kind) {
		return false
	}
	return true
}

func Validate(name, kind, mode string, size, maxBytes int64) error {
	expectedKind := KindFromName(name)
	if kind == "" {
		kind = expectedKind
	}
	if kind != expectedKind {
		return fmt.Errorf("file kind %q does not match extension %q", kind, Extension(name))
	}
	if maxBytes <= 0 {
		maxBytes = ProSourceMaxBytes
	}
	if size < 0 || size > maxBytes {
		return fmt.Errorf("uploads support files up to %d MB", maxBytes>>20)
	}
	if expectedKind == "unknown" {
		if mode != ParseModeNone {
			return fmt.Errorf("parsing does not support %s files", Extension(name))
		}
		return nil
	}
	if IsTextKind(kind) {
		return nil
	}

	switch strings.ToLower(mode) {
	case ParseModeFast:
		if !parseExtensions[extensionKey(name)] {
			return fmt.Errorf("parsing does not support %s files", Extension(name))
		}
	case ParseModeNone:
	default:
		return fmt.Errorf("unknown parse mode %q", mode)
	}
	return nil
}

// parseExtensions is the format list the document parser accepts.
var parseExtensions = map[string]bool{
	"pdf": true, "docx": true, "pptx": true,
	"xlsx": true,
}

func ExtensionsByKind() map[string][]string {
	out := make(map[string][]string)
	for ext, kind := range extensionKinds {
		out[kind] = append(out[kind], "."+ext)
	}
	for kind := range out {
		sort.Strings(out[kind])
	}
	return out
}

func ParseExtensions(mode string) []string {
	if strings.ToLower(mode) != ParseModeFast {
		return []string{}
	}
	out := make([]string, 0, len(parseExtensions))
	for ext := range parseExtensions {
		out = append(out, "."+ext)
	}
	sort.Strings(out)
	return out
}

func SupportedExtensions() []string {
	out := make([]string, 0, len(extensionKinds))
	for ext := range extensionKinds {
		out = append(out, "."+ext)
	}
	sort.Strings(out)
	return out
}
