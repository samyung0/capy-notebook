package bank

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// AssetMaxBytes is flat: the platform pays for bank figures, not a plan
// (human/question-bank.md 2026-10-09). The browser shrinks larger images.
const AssetMaxBytes = 4 << 20
const SVGMaxBytes = 256 << 10
const ImmutableCache = "public, max-age=31536000, immutable"

var svgResource = regexp.MustCompile(`(?i)url\s*\([^)]*\)`)
var svgLocalResource = regexp.MustCompile(`(?i)^url\s*\(\s*["']?#[A-Za-z0-9_-]+["']?\s*\)$`)

type AssetWriter interface {
	PutObject(context.Context, string, io.Reader, string, string) error
}

func UploadAsset(ctx context.Context, writer AssetWriter, base string, data []byte) (string, error) {
	if writer == nil {
		return "", ErrUnavailable
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrUnavailable
	}
	mime, ext, err := ValidateAsset(data)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	key := hex.EncodeToString(sum[:]) + ext
	if err := writer.PutObject(ctx, key, bytes.NewReader(data), mime, ImmutableCache); err != nil {
		return "", fmt.Errorf("%w: asset upload failed", ErrUnavailable)
	}
	return strings.TrimRight(base, "/") + "/" + key, nil
}

func ValidateAsset(data []byte) (string, string, error) {
	if len(data) == 0 || len(data) > AssetMaxBytes {
		return "", "", errors.New("asset must be between 1 byte and 4 MiB")
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/png":
		return mime, ".png", nil
	case "image/jpeg":
		return mime, ".jpg", nil
	case "image/gif":
		return mime, ".gif", nil
	case "image/webp":
		return mime, ".webp", nil
	}
	if len(data) > SVGMaxBytes {
		return "", "", errors.New("SVG exceeds 256 KiB")
	}
	if err := validateSVG(data); err != nil {
		return "", "", err
	}
	return "image/svg+xml", ".svg", nil
}

// Public SVGs can be navigated to directly. Restrict them to static drawing primitives.
func validateSVG(data []byte) error {
	allowed := map[string]bool{"svg": true, "g": true, "path": true, "rect": true, "circle": true, "ellipse": true, "line": true, "polyline": true, "polygon": true, "text": true, "tspan": true, "defs": true, "clipPath": true, "use": true, "marker": true, "title": true, "desc": true, "linearGradient": true, "radialGradient": true, "stop": true}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	root := false
	ended := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return errors.New("invalid SVG XML")
		}
		switch v := token.(type) {
		case xml.StartElement:
			if ended || !allowed[v.Name.Local] || (v.Name.Space != "" && v.Name.Space != "http://www.w3.org/2000/svg") {
				return errors.New("unsupported SVG element")
			}
			if !root {
				if v.Name.Local != "svg" {
					return errors.New("asset must be a supported image or SVG")
				}
				root = true
			}
			depth++
			for _, a := range v.Attr {
				key := strings.ToLower(a.Name.Local)
				value := strings.ToLower(strings.TrimSpace(a.Value))
				if strings.ContainsAny(value, "\\@") {
					return errors.New("escaped SVG attributes are forbidden")
				}
				if strings.HasPrefix(key, "on") || key == "src" || key == "base" {
					return errors.New("active SVG attributes are forbidden")
				}
				if key == "href" && !strings.HasPrefix(value, "#") {
					return errors.New("external SVG references are forbidden")
				}
				for _, resource := range svgResource.FindAllString(value, -1) {
					if !svgLocalResource.MatchString(resource) {
						return errors.New("external SVG resources are forbidden")
					}
				}
				if key == "style" && strings.Contains(value, "expression") {
					return errors.New("active SVG styles are forbidden")
				}
			}
		case xml.EndElement:
			depth--
			if depth == 0 {
				ended = true
			}
		case xml.Directive:
			return errors.New("SVG directives are forbidden")
		case xml.ProcInst:
			if v.Target != "xml" {
				return errors.New("SVG processing instructions are forbidden")
			}
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(v)) != "" {
				return errors.New("text outside SVG")
			}
		}
	}
	if !root || !ended {
		return errors.New("invalid SVG")
	}
	return nil
}
