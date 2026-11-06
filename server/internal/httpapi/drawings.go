package httpapi

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A drawing answer's board, and its marking image, sent with Done (assignments)
// or with Check (practice). The board is the drawing board's saved Yjs
// document; only a browser opening it checks its contents (boardLoad.ts).

// drawingMaxBody bounds a request carrying one board and one image as base64.
const drawingMaxBody = (fieldlimits.DrawingBoardBytes+fieldlimits.DrawingImageBytes)*4/3 + 4<<10

// drawingCache keeps a student's drawing out of shared caches.
const drawingCache = "private, max-age=3600"

var drawingImageTypes = map[string]string{
	"webp": "image/webp",
	"jpeg": "image/jpeg",
	"png":  "image/png",
}

type drawingUpload struct {
	Board []byte `json:"board" doc:"The board's saved document, base64" maxLength:"400000"`
	Image []byte `json:"image,omitempty" doc:"The marking image (WebP, or JPEG or PNG where the browser makes no WebP), base64; left out when nothing will mark it" maxLength:"420000"`
}

type assignmentDrawingInput struct {
	ID     string `path:"id"`
	PartID string `path:"partId" maxLength:"128"`
	Body   drawingUpload
}

type drawingSavedOutput struct {
	Body struct {
		ID string `json:"id" doc:"The stored drawing; the part's answer is {\"drawing\": id}"`
	}
}

func (a *api) registerDrawings(api huma.API) {
	regWithMaxBody(api, "PUT", "/api/assignment-attempts/{id}/drawings/{partId}", "saveAssignmentDrawing", "assignments",
		"Store a drawing part's board (and its marking image) for a running attempt", 200, drawingMaxBody, a.saveAssignmentDrawing)
	reg(api, "GET", "/api/drawings/{id}", "getDrawing", "assignments",
		"A drawing answer's board, as a link that lasts the hour", 200, a.getDrawing)
}

type drawingIDInput struct {
	ID string `path:"id" maxLength:"64"`
}

type drawingOutput struct {
	Body struct {
		ID       string `json:"id"`
		PartID   string `json:"partId"`
		BoardURL string `json:"boardUrl" doc:"The board's saved document; the link is the same all hour and lasts two"`
		Bytes    int64  `json:"bytes"`
	}
}

func (a *api) getDrawing(ctx context.Context, in *drawingIDInput) (*drawingOutput, error) {
	d, err := a.s.ReadableDrawing(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, hErr(errors.New("blob store not configured"))
	}
	url, err := a.blob.PresignStableGet(ctx, d.BoardKey)
	if err != nil {
		return nil, hErr(err)
	}
	out := &drawingOutput{}
	out.Body.ID, out.Body.PartID, out.Body.BoardURL, out.Body.Bytes = d.ID, d.PartID, url, d.BoardBytes
	return out, nil
}

// checkedDrawing checks a board and an image a browser sent, before anything
// reaches the bucket.
func checkedDrawing(in drawingUpload) (imageType string, err error) {
	if len(in.Board) == 0 || len(in.Board) > fieldlimits.DrawingBoardBytes {
		return "", huma.Error422UnprocessableEntity("this drawing is too big to save")
	}
	if len(in.Image) == 0 {
		return "", nil
	}
	if len(in.Image) > fieldlimits.DrawingImageBytes {
		return "", huma.Error422UnprocessableEntity("this drawing's image is too big")
	}
	format, width, height, err := imagecheck.Size(bytes.NewReader(in.Image))
	contentType, allowed := drawingImageTypes[format]
	if err != nil || !allowed {
		return "", huma.Error400BadRequest("the drawing's image is not a WebP, JPEG or PNG")
	}
	if width > fieldlimits.DrawingImageSide || height > fieldlimits.DrawingImageSide {
		return "", huma.Error422UnprocessableEntity("this drawing's image is too big")
	}
	return contentType, nil
}

// putDrawingObjects writes a checked board and image to the bucket under the
// attempt; the drawing row that names them is written after.
func (a *api) putDrawingObjects(ctx context.Context, attemptID string, in drawingUpload, imageType string) (store.DrawingObject, *store.DrawingObject, error) {
	if a.blob == nil {
		return store.DrawingObject{}, nil, errors.New("blob store not configured")
	}
	board := store.DrawingObject{
		Key:   "drawings/" + attemptID + "/" + store.ObjectKeyID("board") + ".ydoc",
		Bytes: int64(len(in.Board)),
		Type:  "application/octet-stream",
	}
	if _, err := a.blob.PutObjectOnce(ctx, board.Key, bytes.NewReader(in.Board), board.Type, drawingCache); err != nil {
		return store.DrawingObject{}, nil, err
	}
	if imageType == "" {
		return board, nil, nil
	}
	image := &store.DrawingObject{
		Key:   "drawings/" + attemptID + "/" + store.ObjectKeyID("image") + drawingExtension(imageType),
		Bytes: int64(len(in.Image)),
		Type:  imageType,
	}
	if _, err := a.blob.PutObjectOnce(ctx, image.Key, bytes.NewReader(in.Image), imageType, drawingCache); err != nil {
		return store.DrawingObject{}, nil, err
	}
	return board, image, nil
}

func drawingExtension(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	}
	return ".webp"
}

func (a *api) saveAssignmentDrawing(ctx context.Context, in *assignmentDrawingInput) (*drawingSavedOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	imageType, err := checkedDrawing(in.Body)
	if err != nil {
		return nil, err
	}
	board, image, err := a.putDrawingObjects(ctx, in.ID, in.Body, imageType)
	if err != nil {
		return nil, hErr(err)
	}
	saved, err := a.s.SaveAssignmentDrawing(ctx, userID(ctx), in.ID, in.PartID, board, image, time.Now())
	if errors.Is(err, store.ErrNotDrawingPart) {
		return nil, huma.Error422UnprocessableEntity("that part takes no drawing")
	}
	if err != nil {
		return nil, assignmentError(err)
	}
	out := &drawingSavedOutput{}
	out.Body.ID = saved.ID
	return out, nil
}

// keepCheckDrawings puts a practice check's boards in the bucket, and the image
// of a part left Not marked, so Check again can mark it later (Epo 2026-11-06);
// a marked part's image is dropped.
func (a *api) keepCheckDrawings(ctx context.Context, plan gradePlan, graded map[string]any) (map[string]store.QuizDrawing, error) {
	if len(plan.drawings) == 0 {
		return nil, nil
	}
	waiting := map[string]bool{}
	parts, _ := graded["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		if pending, _ := p["pending"].(bool); pending {
			id, _ := p["id"].(string)
			waiting[id] = true
		}
	}
	out := make(map[string]store.QuizDrawing, len(plan.drawings))
	for partID, drawing := range plan.drawings {
		imageType := plan.open[partID].imageType
		if !waiting[partID] {
			imageType = ""
		}
		board, image, err := a.putDrawingObjects(ctx, userID(ctx), drawing, imageType)
		if err != nil {
			return nil, err
		}
		out[partID] = store.QuizDrawing{Board: board, Image: image}
	}
	return out, nil
}
