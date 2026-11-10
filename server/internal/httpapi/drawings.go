package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"regexp"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A drawing answer's board, and its marking image, sent with Done (assignments)
// or with Check (practice). The board is the drawing board's saved Yjs
// document; only a browser opening it checks its contents (boardLoad.ts).

// picturesMaxBody is one board's pictures at their most, as base64.
const picturesMaxBody = fieldlimits.BoardPictures * fieldlimits.BoardPictureBytes * 4 / 3

// drawingMaxBody bounds a request carrying one board, its marking image and
// its pictures as base64.
const drawingMaxBody = (fieldlimits.DrawingBoardBytes+fieldlimits.DrawingImageBytes)*4/3 + picturesMaxBody + 8<<10

// drawingCache keeps a student's drawing out of shared caches.
const drawingCache = "private, max-age=3600"

var drawingImageTypes = map[string]string{
	"webp": "image/webp",
	"jpeg": "image/jpeg",
	"png":  "image/png",
}

// drawingPictureTypes are what the browser's compressor hands over: the
// marking image's types, and an animated GIF kept as it is (Epo 2026-11-09).
var drawingPictureTypes = map[string]string{
	"webp": "image/webp",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"gif":  "image/gif",
}

// pictureSourceID is BlockSuite's hash of the pasted file, base64url.
var pictureSourceID = regexp.MustCompile(`^[A-Za-z0-9_=-]{1,128}$`)

// drawingPicture is one picture on the board, by the id its image block names.
type drawingPicture struct {
	SourceID string `json:"sourceId" minLength:"1" maxLength:"128" pattern:"^[A-Za-z0-9_=-]+$"`
	Data     []byte `json:"data" doc:"The picture as the browser compressed it (WebP, JPEG, PNG or GIF), base64" maxLength:"1400000"`
}

type drawingUpload struct {
	Board []byte `json:"board" doc:"The board's saved document, base64" maxLength:"400000"`
	Image []byte `json:"image,omitempty" doc:"The marking image (WebP, or JPEG or PNG where the browser makes no WebP), base64; left out when nothing will mark it" maxLength:"420000"`
	// Pictures are every picture on the board, each time: the ones stored
	// before are replaced.
	Pictures []drawingPicture `json:"pictures,omitempty" maxItems:"10" doc:"The pictures pasted on the board"`
}

// The attempt's id names the bucket folder its objects go under, so it is
// bounded and patterned; a part id is bounded as questions bound it.
type assignmentDrawingInput struct {
	ID     string `path:"id" maxLength:"64" pattern:"^[A-Za-z0-9_-]+$"`
	PartID string `path:"partId" minLength:"1" maxLength:"128" pattern:"^[^/]+$"`
	Body   drawingUpload
}

type drawingSavedOutput struct {
	Body struct {
		ID string `json:"id" doc:"The stored drawing; the part's answer is {drawing: id}"`
	}
}

func (a *api) registerDrawings(api huma.API) {
	regWithMaxBody(api, "PUT", "/api/assignment-attempts/{id}/drawings/{partId}", "saveAssignmentDrawing", "assignments",
		"Store a drawing part's board (its marking image and its pictures) for a running attempt", 200, drawingMaxBody, a.saveAssignmentDrawing)
	reg(api, "DELETE", "/api/assignment-attempts/{id}/drawings/{partId}", "deleteAssignmentDrawing", "assignments",
		"Forget a drawing part's stored drawing in a running attempt (Done on an emptied board)", 204, a.deleteAssignmentDrawing)
	reg(api, "GET", "/api/drawings/{id}", "getDrawing", "assignments",
		"A drawing answer's board, as a link that lasts the hour", 200, a.getDrawing)
	reg(api, "GET", "/api/drawings", "listDrawings", "assignments",
		"The caller's marked drawings, newest first (Files › Canvas)", 200, a.listDrawings)
	reg(api, "DELETE", "/api/drawings/{id}", "deleteDrawing", "assignments",
		"Delete one of the caller's marked drawings; its marks stay", 200, a.deleteDrawing)
	reg(api, "DELETE", "/api/drawings", "deleteAllDrawings", "assignments",
		"Delete every marked drawing the caller pays for; their marks stay", 200, a.deleteAllDrawings)
}

type assignmentDrawingPartInput struct {
	ID     string `path:"id" maxLength:"64" pattern:"^[A-Za-z0-9_-]+$"`
	PartID string `path:"partId" minLength:"1" maxLength:"128" pattern:"^[^/]+$"`
}

func (a *api) deleteAssignmentDrawing(ctx context.Context, in *assignmentDrawingPartInput) (*Empty, error) {
	return &Empty{}, assignmentError(a.s.DeleteAssignmentDrawing(ctx, userID(ctx), in.ID, in.PartID, time.Now()))
}

type drawingListInput struct {
	Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

type drawingListOutput struct {
	Body store.MarkedDrawings
}

func (a *api) listDrawings(ctx context.Context, in *drawingListInput) (*drawingListOutput, error) {
	page, err := a.s.ListMarkedDrawings(ctx, userID(ctx), in.Cursor, in.Limit)
	if err != nil {
		return nil, hErr(err)
	}
	return &drawingListOutput{Body: page}, nil
}

type drawingsDeletedOutput struct {
	Body struct {
		Deleted int `json:"deleted"`
	}
}

// deleteDrawing deletes a marked drawing its payer names; one still waiting on
// marking, or anyone else's, is not found.
func (a *api) deleteDrawing(ctx context.Context, in *drawingIDInput) (*drawingsDeletedOutput, error) {
	n, err := a.s.DeleteMarkedDrawings(ctx, userID(ctx), []string{in.ID})
	if err != nil {
		return nil, hErr(err)
	}
	if n == 0 {
		return nil, hErr(store.ErrNotFound)
	}
	out := &drawingsDeletedOutput{}
	out.Body.Deleted = n
	return out, nil
}

func (a *api) deleteAllDrawings(ctx context.Context, _ *struct{}) (*drawingsDeletedOutput, error) {
	n, err := a.s.DeleteMarkedDrawings(ctx, userID(ctx), nil)
	if err != nil {
		return nil, hErr(err)
	}
	out := &drawingsDeletedOutput{}
	out.Body.Deleted = n
	return out, nil
}

type drawingIDInput struct {
	ID string `path:"id" maxLength:"64"`
}

type drawingOutput struct {
	Body struct {
		ID       string               `json:"id"`
		PartID   string               `json:"partId"`
		BoardURL string               `json:"boardUrl" doc:"The board's saved document, gzipped; the link is the same all hour and lasts two"`
		Bytes    int64                `json:"bytes"`
		Pictures []drawingPictureLink `json:"pictures" nullable:"false" doc:"The pictures on the board, each by the id its image block names, as links that last as the board's does"`
	}
}

type drawingPictureLink struct {
	SourceID string `json:"sourceId"`
	URL      string `json:"url"`
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
	out.Body.Pictures = []drawingPictureLink{}
	if d.PictureBytes == 0 {
		return out, nil
	}
	pictures, err := a.s.DrawingPictures(ctx, d.ID)
	if err != nil {
		return nil, hErr(err)
	}
	for _, picture := range pictures {
		link, err := a.blob.PresignStableGet(ctx, picture.Object.Key)
		if err != nil {
			return nil, hErr(err)
		}
		out.Body.Pictures = append(out.Body.Pictures, drawingPictureLink{SourceID: picture.SourceID, URL: link})
	}
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

// checkedPictures checks the pictures a board came with, before anything
// reaches the bucket, and answers each one's content type: at most
// BoardPictures, each a WebP, JPEG, PNG or GIF of at most BoardPictureBytes,
// under an id no other has.
func checkedPictures(in []drawingPicture) ([]string, error) {
	if len(in) > fieldlimits.BoardPictures {
		return nil, huma.Error422UnprocessableEntity("this drawing holds too many pictures")
	}
	types := make([]string, len(in))
	seen := map[string]bool{}
	for i, picture := range in {
		if !pictureSourceID.MatchString(picture.SourceID) || seen[picture.SourceID] {
			return nil, huma.Error400BadRequest("a picture's id is missing, malformed or repeated")
		}
		seen[picture.SourceID] = true
		if len(picture.Data) == 0 || len(picture.Data) > fieldlimits.BoardPictureBytes {
			return nil, huma.Error422UnprocessableEntity("a picture on this drawing is too big")
		}
		format, _, _, err := imagecheck.Size(bytes.NewReader(picture.Data))
		contentType, allowed := drawingPictureTypes[format]
		if err != nil || !allowed {
			return nil, huma.Error400BadRequest("a picture on this drawing is not a WebP, JPEG, PNG or GIF")
		}
		types[i] = contentType
	}
	return types, nil
}

// pictureBytes is what a board's pictures hold together.
func pictureBytes(in []drawingPicture) int64 {
	var size int64
	for _, picture := range in {
		size += int64(len(picture.Data))
	}
	return size
}

// putDrawingPictures writes a board's checked pictures to the bucket under
// folder, beside its board.
func (a *api) putDrawingPictures(ctx context.Context, folder string, pictures []drawingPicture, types []string) ([]store.DrawingPicture, error) {
	out := make([]store.DrawingPicture, 0, len(pictures))
	for i, picture := range pictures {
		object := store.DrawingObject{
			Key:   "drawings/" + folder + "/" + store.ObjectKeyID("img") + drawingExtension(types[i]),
			Bytes: int64(len(picture.Data)),
			Type:  types[i],
		}
		if _, err := a.blob.PutObjectOnce(ctx, object.Key, bytes.NewReader(picture.Data), object.Type, drawingCache); err != nil {
			return nil, err
		}
		out = append(out, store.DrawingPicture{SourceID: picture.SourceID, Object: object})
	}
	return out, nil
}

// putDrawingObjects writes a checked, gzipped board (packed) and the image to
// the bucket under folder, once the caller is authorized; the drawing row that
// names them is written after.
func (a *api) putDrawingObjects(ctx context.Context, folder string, packed, img []byte, imageType string) (store.DrawingObject, *store.DrawingObject, error) {
	if a.blob == nil {
		return store.DrawingObject{}, nil, errors.New("blob store not configured")
	}
	board := store.DrawingObject{
		Key:   "drawings/" + folder + "/" + store.ObjectKeyID("board") + ".ydoc.gz",
		Bytes: int64(len(packed)),
		Type:  "application/gzip",
	}
	if _, err := a.blob.PutObjectOnce(ctx, board.Key, bytes.NewReader(packed), board.Type, drawingCache); err != nil {
		return store.DrawingObject{}, nil, err
	}
	if imageType == "" {
		return board, nil, nil
	}
	image := &store.DrawingObject{
		Key:   "drawings/" + folder + "/" + store.ObjectKeyID("image") + drawingExtension(imageType),
		Bytes: int64(len(img)),
		Type:  imageType,
	}
	if _, err := a.blob.PutObjectOnce(ctx, image.Key, bytes.NewReader(img), imageType, drawingCache); err != nil {
		return store.DrawingObject{}, nil, err
	}
	return board, image, nil
}

// keptImage is a drawing's marking image read back from the bucket.
type keptImage struct {
	data        []byte
	contentType string
}

// keptDrawingImages reads the kept marking images of the attempt's parts being
// marked (partIDs), for a part left Not marked that is marked later. A part
// whose image is gone (marked already, or marked by hand) is absent and stays
// as it is, as is one whose image can't be read: the rest still mark.
func (a *api) keptDrawingImages(ctx context.Context, attemptID string, partIDs []string) (map[string]keptImage, error) {
	if len(partIDs) == 0 {
		return nil, nil
	}
	drawings, err := a.s.AttemptDrawings(ctx, attemptID)
	if err != nil {
		return nil, err
	}
	out := map[string]keptImage{}
	for _, partID := range partIDs {
		d := drawings[partID]
		if d.ImageKey == "" {
			continue
		}
		data, err := a.readKeptImage(ctx, d.ImageKey)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "drawing_image"})
			continue
		}
		out[partID] = keptImage{data: data, contentType: d.ImageType}
	}
	return out, nil
}

func (a *api) readKeptImage(ctx context.Context, key string) ([]byte, error) {
	if a.blob == nil {
		return nil, errors.New("blob store not configured")
	}
	r, err := a.blob.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	data, err := io.ReadAll(io.LimitReader(r, fieldlimits.DrawingImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > fieldlimits.DrawingImageBytes {
		return nil, errors.New("a kept drawing image is over the image cap")
	}
	return data, nil
}

func gzipBoard(board []byte) ([]byte, error) {
	var out bytes.Buffer
	w, err := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(board); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func drawingExtension(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
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
	pictureTypes, err := checkedPictures(in.Body.Pictures)
	if err != nil {
		return nil, err
	}
	// Gzipped, it keeps about 44% of its bytes, and the payer pays for those
	// (Epo 2026-11-06: minimise drawing storage). Browsers inflate it on read.
	packed, err := gzipBoard(in.Body.Board)
	if err != nil {
		return nil, hErr(err)
	}
	// Nothing reaches the bucket before the attempt, the part and the payer's
	// storage pass (Q693); marked by hand, no marking image is written.
	manual, err := a.s.CheckAssignmentDrawing(ctx, userID(ctx), in.ID, in.PartID, time.Now())
	if err != nil {
		return nil, drawingSaveError(err)
	}
	if manual {
		imageType = ""
	}
	board, image, err := a.putDrawingObjects(ctx, in.ID, packed, in.Body.Image, imageType)
	if err != nil {
		return nil, hErr(err)
	}
	pictures, err := a.putDrawingPictures(ctx, in.ID, in.Body.Pictures, pictureTypes)
	if err != nil {
		return nil, hErr(err)
	}
	saved, err := a.s.SaveAssignmentDrawing(ctx, userID(ctx), in.ID, in.PartID, board, image, pictures, time.Now())
	if err != nil {
		return nil, drawingSaveError(err)
	}
	out := &drawingSavedOutput{}
	out.Body.ID = saved.ID
	return out, nil
}

func drawingSaveError(err error) error {
	if errors.Is(err, store.ErrNotDrawingPart) {
		return huma.Error422UnprocessableEntity("that part takes no drawing")
	}
	return assignmentError(err)
}

// packedCheckDrawings gzips a practice check's boards and counts what keeping
// them could take, images included, for the storage gate before marking (Q694).
func packedCheckDrawings(plan gradePlan) (map[string][]byte, int64, error) {
	packed := make(map[string][]byte, len(plan.drawings))
	var size int64
	for partID, drawing := range plan.drawings {
		board, err := gzipBoard(drawing.Board)
		if err != nil {
			return nil, 0, err
		}
		packed[partID] = board
		size += int64(len(board)) + pictureBytes(drawing.Pictures)
		if plan.open[partID].imageType != "" {
			size += int64(len(drawing.Image))
		}
	}
	return packed, size, nil
}

// keepCheckDrawings puts a practice check's boards in the bucket, and the image
// of a part left Not marked, so Check again can mark it later (Epo 2026-11-06);
// a marked part's image is dropped.
func (a *api) keepCheckDrawings(ctx context.Context, plan gradePlan, packed map[string][]byte, graded map[string]any) (map[string]store.QuizDrawing, error) {
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
		board, image, err := a.putDrawingObjects(ctx, userID(ctx), packed[partID], drawing.Image, imageType)
		if err != nil {
			return nil, err
		}
		pictures, err := a.putDrawingPictures(ctx, userID(ctx), drawing.Pictures, plan.pictureTypes[partID])
		if err != nil {
			return nil, err
		}
		out[partID] = store.QuizDrawing{Board: board, Image: image, Pictures: pictures}
	}
	return out, nil
}
