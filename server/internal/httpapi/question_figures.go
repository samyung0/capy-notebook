package httpapi

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/assetthumb"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

const (
	// figureEdge is a question image's long side as the grader is sent it, the
	// answer pages' (paper.py GRADE_EDGE).
	figureEdge    = 1568
	figureQuality = 85
	// figureReadMax bounds a stored image read: editor images and bank
	// figures are both far smaller.
	figureReadMax = 16 << 20
)

var figureClient = &http.Client{Timeout: 20 * time.Second}

// figureCache keeps a run's figures by asset id or link, so a class's answers
// to one question read its images once. Nil reads every time.
type figureCache struct {
	mu   sync.Mutex
	urls map[string]string
}

func newFigureCache() *figureCache { return &figureCache{urls: map[string]string{}} }

// questionFigures reads a part's question images, in the order its grading
// text numbers them (questions.GradingTextAndFigures), as JPEG data URLs
// (Epo 2026-11-23). An editor image must be a ready, untrashed image of the
// quiz checked or of the assignment's frozen copy (as sampleImage's); a
// copied bank question's figure must sit under the bank's asset base. One
// that isn't, or can't be read, fails the part, which stays Not marked:
// grading without it would judge the answer on less than the question shows.
func (a *api) questionFigures(ctx context.Context, owner sampleOwner, figures []map[string]any, cache *figureCache) ([]string, error) {
	out := make([]string, 0, len(figures))
	for _, image := range figures {
		assetID, _ := image["assetId"].(string)
		link, _ := image["url"].(string)
		key := assetID
		if key == "" {
			key = link
		}
		if cache != nil {
			cache.mu.Lock()
			hit, ok := cache.urls[key]
			cache.mu.Unlock()
			if ok {
				out = append(out, hit)
				continue
			}
		}
		var data []byte
		var err error
		if assetID != "" {
			data, err = a.figureAsset(ctx, owner, assetID)
		} else {
			data, err = bankFigure(ctx, link)
		}
		if err != nil {
			return nil, err
		}
		fitted, err := assetthumb.Fit(data, figureEdge, figureQuality)
		if err != nil {
			return nil, fmt.Errorf("question image %s: %w", key, err)
		}
		dataURL := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(fitted)
		if cache != nil {
			cache.mu.Lock()
			cache.urls[key] = dataURL
			cache.mu.Unlock()
		}
		out = append(out, dataURL)
	}
	return out, nil
}

func (a *api) figureAsset(ctx context.Context, owner sampleOwner, assetID string) ([]byte, error) {
	asset, err := a.s.GetEditorAsset(ctx, assetID)
	if err != nil {
		return nil, err
	}
	belongs := (owner.materialID != "" && asset.MaterialID == owner.materialID) ||
		(owner.assignmentID != "" && asset.AssignmentID == owner.assignmentID)
	if !belongs || asset.Purpose != "image" || asset.Status != "ready" || asset.Trashed || a.blob == nil {
		return nil, fmt.Errorf("question image %s is not this quiz's stored image", assetID)
	}
	r, err := a.blob.Open(ctx, asset.ObjectPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return readAtMost(r, assetID)
}

// bankFigure reads a copied bank question's figure from the bank's public
// asset base, the only links a quiz's figure may hold.
func bankFigure(ctx context.Context, link string) ([]byte, error) {
	base := strings.TrimRight(questions.QuizBankAssetsURL, "/")
	u, err := url.Parse(link)
	if base == "" || err != nil || u.Scheme != "https" || !strings.HasPrefix(link, base+"/") {
		return nil, fmt.Errorf("question image %s is not a bank figure", link)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, err
	}
	res, err := figureClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bank figure %s: status %d", link, res.StatusCode)
	}
	return readAtMost(res.Body, link)
}

func readAtMost(r io.Reader, name string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, figureReadMax+1))
	if err != nil {
		return nil, err
	}
	if len(data) > figureReadMax {
		return nil, fmt.Errorf("question image %s is too large", name)
	}
	return data, nil
}
