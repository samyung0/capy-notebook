package materialdoc

import (
	"fmt"
	"strings"
)

// FigureRefPrefix marks a library figure an agent placed in a note,
// `![caption](figure:<figure id>)`: the markdown converter keeps the reference
// as the image's assetId until the server stores the rendered figure as the
// note's own editor asset and puts that asset in its place (ResolveFigureRefs).
const FigureRefPrefix = "figure:"

// FigureAsset is the editor asset a figure image points at once stored.
type FigureAsset struct {
	ID          string
	Name        string
	ContentType string
	SizeBytes   int64
}

// FigureRefs lists the figure ids a converted document's images name, once
// each, in document order.
func FigureRefs(raw string) ([]string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	var refs []string
	seen := map[string]bool{}
	walkFigureImages(doc.Value, func(node map[string]any, ref string) {
		if !seen[ref] {
			seen[ref] = true
			refs = append(refs, ref)
		}
	})
	return refs, nil
}

// ResolveFigureRefs points every figure image at its stored asset, with the
// fields an uploaded image node carries. A figure with no asset is ErrInvalid.
func ResolveFigureRefs(raw string, assets map[string]FigureAsset) (string, error) {
	doc, err := Parse(raw)
	if err != nil {
		return "", err
	}
	var missing string
	walkFigureImages(doc.Value, func(node map[string]any, ref string) {
		asset, ok := assets[ref]
		if !ok {
			missing = ref
			return
		}
		node["assetId"] = asset.ID
		node["name"] = asset.Name
		node["contentType"] = asset.ContentType
		node["sizeBytes"] = asset.SizeBytes
	})
	if missing != "" {
		return "", fmt.Errorf("%w: figure %s has no stored image", ErrInvalid, missing)
	}
	return Marshal(doc)
}

func walkFigureImages(nodes []map[string]any, visit func(node map[string]any, ref string)) {
	for _, node := range nodes {
		if assetID, _ := node["assetId"].(string); node["type"] == "img" && strings.HasPrefix(assetID, FigureRefPrefix) {
			visit(node, strings.TrimPrefix(assetID, FigureRefPrefix))
		}
		walkFigureImages(children(node), visit)
	}
}
