package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// agentFigure is a library figure an agent placed in a note
// (`![caption](figure:<id>)`), rendered by the retrieval service from the
// book's PDF: a crop of the figure's box as a JPEG. The note stores it as its
// own editor asset, like an image a user uploads.
type agentFigure struct {
	ID    string `json:"id"`
	Image []byte `json:"image"`
}

// agentFigures are one write's figures with the asset each becomes. The asset
// ids derive from the tool call, so a retried write finds the same assets.
type agentFigures struct {
	images map[string][]byte
	assets map[string]materialdoc.FigureAsset
	// The figures the converted markdown references, in order.
	used []string
}

func newAgentFigures(assistantMessageID, toolCallID string, figures []agentFigure) *agentFigures {
	f := &agentFigures{images: map[string][]byte{}, assets: map[string]materialdoc.FigureAsset{}}
	for _, figure := range figures {
		f.images[figure.ID] = figure.Image
		f.assets[figure.ID] = materialdoc.FigureAsset{
			ID:          store.ChatAssetID(assistantMessageID, toolCallID+"/figure/"+figure.ID),
			Name:        fieldlimits.ClampFileName(figure.ID + ".jpg"),
			ContentType: "image/jpeg",
			SizeBytes:   int64(len(figure.Image)),
		}
	}
	return f
}

// hashFigures adds a write's figures to its request identity, each figure's
// id with the digest of its image; a write without figures keeps the identity
// it had before figures existed.
func hashFigures(payload map[string]any, figures []agentFigure) map[string]any {
	if len(figures) == 0 {
		return payload
	}
	digests := make(map[string]string, len(figures))
	for _, figure := range figures {
		sum := sha256.Sum256(figure.Image)
		digests[figure.ID] = hex.EncodeToString(sum[:])
	}
	payload["figures"] = digests
	return payload
}

// resolve points the converted markdown's figure images at their assets and
// records which figures it used. A figure the request did not render is
// refused naming it.
func (f *agentFigures) resolve(content string) (string, error) {
	refs, err := materialdoc.FigureRefs(content)
	if err != nil || len(refs) == 0 {
		return content, err
	}
	for _, ref := range refs {
		if _, ok := f.assets[ref]; !ok {
			return "", refusal(agenttools.ErrInvalidInput, "figure %s was not rendered for this write", ref)
		}
		if !slices.Contains(f.used, ref) {
			f.used = append(f.used, ref)
		}
	}
	return materialdoc.ResolveFigureRefs(content, f.assets)
}

// put checks each used figure against the payer's image cap and writes its
// object. On error nothing is left behind; otherwise the caller deletes the
// returned objects of assets it did not insert (deleteAgentAssets).
func (a *api) putAgentFigures(ctx context.Context, f *agentFigures, imageMaxBytes int64) ([]store.AgentAsset, error) {
	if a.blob == nil {
		return nil, errors.New("blob store not configured")
	}
	assets := make([]store.AgentAsset, 0, len(f.used))
	for _, ref := range f.used {
		image, meta := f.images[ref], f.assets[ref]
		if !editorAssetSignatureAllowed("image", ".jpg", image) {
			a.deleteAgentAssets(ctx, assets)
			return nil, refusal(agenttools.ErrInvalidInput, "figure %s is not a JPEG image", ref)
		}
		if meta.SizeBytes > imageMaxBytes {
			a.deleteAgentAssets(ctx, assets)
			return nil, refusal(agenttools.ErrQuotaRejected, "figure %s is %d bytes, over the plan's image cap of %d", ref, meta.SizeBytes, imageMaxBytes)
		}
		asset := store.AgentAsset{
			ID: meta.ID, Name: meta.Name, ObjectPath: editorAssetObjectKey(meta.ID, ".jpg"),
			ContentType: meta.ContentType, SizeBytes: meta.SizeBytes,
		}
		if err := a.blob.PutObjectOnce(ctx, asset.ObjectPath, image, asset.ContentType, ""); err != nil {
			a.deleteAgentAssets(ctx, assets)
			return nil, err
		}
		assets = append(assets, asset)
	}
	return assets, nil
}

// ensureFigureAssets stores an edit's figures as assets of the note it edits,
// under the note's payer's image cap and quota, and returns the ids of the
// assets it added (a retried edit adds none).
func (a *api) ensureFigureAssets(ctx context.Context, req internalDocumentsEditReq, f *agentFigures) ([]string, error) {
	_, imageMaxBytes, err := a.s.EditorAssetMaterial(ctx, req.Target.ID)
	if err != nil {
		return nil, err
	}
	assets, err := a.putAgentFigures(ctx, f, imageMaxBytes)
	if err != nil {
		return nil, err
	}
	created, err := a.s.EnsureAgentAssets(ctx, req.UserID, req.Target.ID, assets)
	if err != nil {
		a.deleteAgentAssets(ctx, assets)
		return nil, err
	}
	unused := slices.DeleteFunc(slices.Clone(assets), func(asset store.AgentAsset) bool {
		return slices.Contains(created, asset.ID)
	})
	a.deleteAgentAssets(ctx, unused)
	return created, nil
}

// deleteAgentAssets removes the objects of assets whose rows were never
// inserted. Uncancelled: a pipeline timeout that failed the insert must not
// also cancel the delete, or the object stays with no row.
func (a *api) deleteAgentAssets(ctx context.Context, assets []store.AgentAsset) {
	for _, asset := range assets {
		_ = a.blob.Delete(context.WithoutCancel(ctx), asset.ObjectPath)
	}
}
