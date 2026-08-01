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
	ParseModeAdvanced = "advanced"
	ParseModeNormal   = "normal"
	ParseModeNone     = "none"

	AdvancedMaxBytes = 100 << 20
	NormalMaxBytes   = 10 << 20
	NormalMaxPages   = 20
	UploadMaxBytes   = AdvancedMaxBytes + (4 << 20)
)

// explicitKindExtensions mirrors AddSourceDialog's KIND_BY_EXT. Text/code
// extensions are added below, without overriding these explicit kinds.
var explicitKindExtensions = map[string][]string{
	"pdf":    {"pdf"},
	"doc":    {"doc", "docx"},
	"md":     {"md", "markdown", "mdx", "mdc"},
	"image":  {"png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp", "svg", "avif"},
	"sheet":  {"xls", "xlsx", "csv"},
	"slides": {"ppt", "pptx"},
	"audio":  {"mp3", "wav", "m4a", "ogg", "flac", "aac"},
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

// KindFromName returns the server-owned kind for an allowed extension.
// Unsupported names, including names without an extension, return "unknown"
// and are rejected by Validate.
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
		// Text is inserted by the worker directly; keeping a job enqueued is
		// still required for indexing.
		return ParseModeAdvanced
	}
	if advancedParseExtensions[extensionKey(name)] {
		return ParseModeAdvanced
	}
	return ParseModeNone
}

func Validate(name, kind, mode string, size int64) error {
	expectedKind := KindFromName(name)
	if expectedKind == "unknown" {
		ext := Extension(name)
		if ext == "" {
			ext = "(none)"
		}
		return fmt.Errorf("file extension %q is not supported", ext)
	}
	if kind == "" {
		kind = expectedKind
	}
	if kind != expectedKind {
		return fmt.Errorf("file kind %q does not match extension %q", kind, Extension(name))
	}
	if size < 0 || size > AdvancedMaxBytes {
		return fmt.Errorf("uploads support files up to 100 MB")
	}
	if IsTextKind(kind) {
		return nil
	}

	switch mode {
	case ParseModeAdvanced:
		if !advancedParseExtensions[extensionKey(name)] {
			return fmt.Errorf("advanced parsing does not support %s files", Extension(name))
		}
		if size > AdvancedMaxBytes {
			return fmt.Errorf("advanced parsing supports files up to 100 MB")
		}
	case ParseModeNormal:
		if !normalParseExtensions[extensionKey(name)] {
			return fmt.Errorf("normal parsing does not support %s files", Extension(name))
		}
		if size > NormalMaxBytes {
			return fmt.Errorf("normal parsing supports files up to 10 MB")
		}
	case ParseModeNone:
	default:
		return fmt.Errorf("unknown parse mode %q", mode)
	}
	return nil
}

var normalParseExtensions = map[string]bool{
	"pdf": true, "png": true, "jpg": true, "jpeg": true, "jp2": true,
	"webp": true, "gif": true, "bmp": true, "docx": true, "pptx": true, "xlsx": true,
}

var advancedParseExtensions = map[string]bool{
	"pdf": true, "doc": true, "docx": true, "ppt": true, "pptx": true,
	"xls": true, "xlsx": true, "png": true, "jpg": true, "jpeg": true,
	"jp2": true, "webp": true, "gif": true, "bmp": true,
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
	var source map[string]bool
	switch mode {
	case ParseModeAdvanced:
		source = advancedParseExtensions
	case ParseModeNormal:
		source = normalParseExtensions
	default:
		return []string{}
	}
	out := make([]string, 0, len(source))
	for ext := range source {
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
