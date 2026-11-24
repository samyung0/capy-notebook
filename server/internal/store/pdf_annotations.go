package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

type PDFRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type PDFPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// PDFAnnotation is one private mark. Coordinates are page units on the
// unrotated page, its longer side 1000 on both axes, so ink keeps its shape.
// Highlights and underlines hold a band per line (rects) and the text they
// cover; text boxes, notes, rectangles and ellipses one rect; pens and
// markers strokes (a pen's strokes drawn close together are one mark); an
// arrow one stroke of its two ends. Stroke kinds keep a width, a text box its
// size, and any mark a comment (a note is one).
type PDFAnnotation struct {
	ID      string       `json:"id" pattern:"^ann_[0-9a-f]{10,32}$"`
	Page    int          `json:"page" minimum:"1"`
	Kind    string       `json:"kind" enum:"highlight,underline,marker,pen,text,note,rectangle,ellipse,arrow"`
	Color   string       `json:"color" pattern:"^#[0-9a-fA-F]{6}$"`
	Rects   []PDFRect    `json:"rects" nullable:"false" maxItems:"1000"`
	Strokes [][]PDFPoint `json:"strokes" nullable:"false" maxItems:"512"`
	Width   float64      `json:"width" minimum:"0" maximum:"80"`
	Size    float64      `json:"size" minimum:"0" maximum:"80"`
	Text    string       `json:"text" maxLength:"2000"`
	Comment string       `json:"comment" maxLength:"3000"`
}

// PDFAnnotationList is the caller's marks on the bytes sourceIdentity names.
type PDFAnnotationList struct {
	SourceIdentity string          `json:"sourceIdentity"`
	Marks          []PDFAnnotation `json:"marks" nullable:"false"`
}

// PDFAnnotationChanges saves and removes marks in one write: the viewer
// queues edits and sends them together, never waiting on a save to draw.
type PDFAnnotationChanges struct {
	SourceIdentity string          `json:"sourceIdentity"`
	Save           []PDFAnnotation `json:"save" nullable:"false" maxItems:"200"`
	Remove         []string        `json:"remove" nullable:"false" maxItems:"2000"`
}

const (
	// pdfMarkPoints caps one mark's points across its strokes.
	pdfMarkPoints = 4096
	pdfMarkUnits  = 1000
	// pdfMarkBound lets a rounded corner (x+width) sit a float's hair over the
	// page: the client rounds to hundredths.
	pdfMarkBound = pdfMarkUnits + 0.01
	// pdfMarkStyle caps a stroke's width and a text box's size, in page units.
	pdfMarkStyle = 80
)

var (
	annotationColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	annotationID    = regexp.MustCompile(`^ann_[0-9a-f]{10,32}$`)
)

// ErrInvalidPDFAnnotation rejects a mark whose shape the schema cannot express.
var ErrInvalidPDFAnnotation = errors.New("invalid pdf annotation")

// within reports finite values from 0 to max.
func within(max float64, values ...float64) bool {
	for _, v := range values {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > max {
			return false
		}
	}
	return true
}

func validatePDFAnnotation(in PDFAnnotation) error {
	if !annotationID.MatchString(in.ID) || in.Page < 1 || !annotationColor.MatchString(in.Color) ||
		len(in.Rects) > 1000 || len(in.Strokes) > 512 ||
		utf8.RuneCountInString(in.Text) > fieldlimits.PDFAnnotationText ||
		utf8.RuneCountInString(in.Comment) > fieldlimits.Comment ||
		!within(pdfMarkStyle, in.Width, in.Size) {
		return ErrInvalidPDFAnnotation
	}
	for _, r := range in.Rects {
		if !within(pdfMarkBound, r.X, r.Y, r.X+r.Width, r.Y+r.Height) || r.Width <= 0 || r.Height <= 0 {
			return ErrInvalidPDFAnnotation
		}
	}
	points := 0
	for _, stroke := range in.Strokes {
		if len(stroke) < 2 {
			return ErrInvalidPDFAnnotation
		}
		points += len(stroke)
		for _, p := range stroke {
			if !within(pdfMarkBound, p.X, p.Y) {
				return ErrInvalidPDFAnnotation
			}
		}
	}
	stroked := in.Width > 0
	var ok bool
	switch in.Kind {
	case "highlight", "underline":
		ok = len(in.Rects) >= 1 && len(in.Strokes) == 0 && !stroked && in.Size == 0
	case "pen", "marker":
		ok = len(in.Rects) == 0 && len(in.Strokes) >= 1 && points <= pdfMarkPoints && stroked && in.Size == 0 && in.Text == ""
	case "arrow":
		ok = len(in.Rects) == 0 && len(in.Strokes) == 1 && points == 2 && stroked && in.Size == 0 && in.Text == ""
	case "rectangle", "ellipse":
		ok = len(in.Rects) == 1 && len(in.Strokes) == 0 && stroked && in.Size == 0 && in.Text == ""
	case "text":
		ok = len(in.Rects) == 1 && len(in.Strokes) == 0 && !stroked && in.Size > 0 && strings.TrimSpace(in.Text) != ""
	case "note":
		ok = len(in.Rects) == 1 && len(in.Strokes) == 0 && !stroked && in.Size == 0 && in.Text == "" && strings.TrimSpace(in.Comment) != ""
	}
	if !ok {
		return ErrInvalidPDFAnnotation
	}
	return nil
}

// annotationLock admits any reader of the file, a hidden question paper's
// starters too (FileReadRole: their own marks on it, never its room). Saving
// or deleting a mark (write) is a content edit, refused when the actor or the
// file's payer is frozen or the payer is at its storage limit.
func (s *Store) annotationLock(ctx context.Context, tx pgx.Tx, actor, file string, write bool) (string, error) {
	_, _, err := s.sourceLockTx(ctx, tx, file, []string{actor}, false, nil, false)
	if errors.Is(err, ErrNotFound) {
		// readsAsPaper holds their membership, so the role check is skipped
		// (admitted); the owner's lifecycle still refuses them.
		var paper bool
		if paper, err = readsAsPaper(ctx, tx, file, actor); err == nil {
			err = ErrNotFound
			if paper {
				_, _, err = s.sourceLockTx(ctx, tx, file, []string{actor}, false, nil, true)
			}
		}
	}
	if err != nil {
		return "", err
	}
	if write {
		payer, err := filePayer(ctx, tx, file)
		if err != nil {
			return "", err
		}
		if err := s.assertContentEditableTx(ctx, tx, payer, actor); err != nil {
			return "", err
		}
	}
	var kind string
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT kind,revision FROM files WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, file).Scan(&kind, &revision); err != nil {
		return "", err
	}
	if kind != "pdf" {
		return "", ErrForbidden
	}
	return fmt.Sprintf("revision:%d", revision), nil
}

// trashedAnnotationIdentity is a trashed PDF's source identity for one of its
// trash readers (trashReaderSQL); anyone else, or a live file, is ErrNotFound.
func (s *Store) trashedAnnotationIdentity(ctx context.Context, tx pgx.Tx, actor, file string) (string, error) {
	var kind string
	var revision int64
	err := tx.QueryRow(ctx, `SELECT f.kind, f.revision FROM files f
		WHERE f.id=$1 AND f.trashed_at IS NOT NULL AND `+trashReaderSQL("f.user_id", "f.workspace_id"), file, actor).Scan(&kind, &revision)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if kind != "pdf" {
		return "", ErrForbidden
	}
	return fmt.Sprintf("revision:%d", revision), nil
}

const annotationColumns = `id,page,kind,color,rects,strokes,width,size,text,comment`

func scanAnnotation(row pgx.Row) (PDFAnnotation, error) {
	var out PDFAnnotation
	var rects, strokes []byte
	err := row.Scan(&out.ID, &out.Page, &out.Kind, &out.Color, &rects, &strokes, &out.Width, &out.Size, &out.Text, &out.Comment)
	if err == nil {
		err = json.Unmarshal(rects, &out.Rects)
		if err == nil {
			err = json.Unmarshal(strokes, &out.Strokes)
		}
	}
	return out, err
}

// ListPDFAnnotations is the caller's own marks on the file's current bytes. A
// trashed PDF's trash readers read theirs too, read-only (Epo 2026-11-12).
func (s *Store) ListPDFAnnotations(ctx context.Context, actor, file string) (PDFAnnotationList, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PDFAnnotationList{}, err
	}
	defer tx.Rollback(ctx)
	identity, err := s.annotationLock(ctx, tx, actor, file, false)
	if errors.Is(err, ErrNotFound) || isNoRows(err) {
		identity, err = s.trashedAnnotationIdentity(ctx, tx, actor, file)
	}
	if err != nil {
		return PDFAnnotationList{}, err
	}
	rows, err := tx.Query(ctx, `SELECT `+annotationColumns+` FROM pdf_annotations WHERE file_id=$1 AND author_id=$2 AND source_identity=$3 ORDER BY page,created_at,id`, file, actor, identity)
	if err != nil {
		return PDFAnnotationList{}, err
	}
	defer rows.Close()
	out := PDFAnnotationList{SourceIdentity: identity, Marks: []PDFAnnotation{}}
	for rows.Next() {
		mark, e := scanAnnotation(rows)
		if e != nil {
			return PDFAnnotationList{}, e
		}
		out.Marks = append(out.Marks, mark)
	}
	if err = rows.Err(); err != nil {
		return PDFAnnotationList{}, err
	}
	rows.Close()
	return out, tx.Commit(ctx)
}

// ChangePDFAnnotations saves (inserts or replaces) and removes the caller's
// marks in one transaction. A mark ID is the viewer's, so its marks draw and
// change before any save lands; one held by another author or file, or saved
// on other bytes, is a conflict. Removing a mark already gone is no error: a
// later queue or another tab removed it first.
func (s *Store) ChangePDFAnnotations(ctx context.Context, actor, file string, in PDFAnnotationChanges) error {
	for _, mark := range in.Save {
		if err := validatePDFAnnotation(mark); err != nil {
			return err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	identity, err := s.annotationLock(ctx, tx, actor, file, true)
	if err != nil {
		return err
	}
	if identity != in.SourceIdentity {
		return ErrConflict
	}
	if len(in.Remove) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM pdf_annotations WHERE file_id=$1 AND author_id=$2 AND id=ANY($3)`, file, actor, in.Remove); err != nil {
			return err
		}
	}
	if len(in.Save) == 0 {
		return tx.Commit(ctx)
	}
	batch := &pgx.Batch{}
	for _, mark := range in.Save {
		rects, err := json.Marshal(mark.Rects)
		if err != nil {
			return err
		}
		strokes, err := json.Marshal(mark.Strokes)
		if err != nil {
			return err
		}
		batch.Queue(`INSERT INTO pdf_annotations(id,file_id,author_id,source_identity,page,kind,color,rects,strokes,width,size,text,comment)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
			ON CONFLICT (id) DO UPDATE SET page=EXCLUDED.page,kind=EXCLUDED.kind,color=EXCLUDED.color,rects=EXCLUDED.rects,
				strokes=EXCLUDED.strokes,width=EXCLUDED.width,size=EXCLUDED.size,text=EXCLUDED.text,comment=EXCLUDED.comment,updated_at=now()
			WHERE pdf_annotations.file_id=EXCLUDED.file_id AND pdf_annotations.author_id=EXCLUDED.author_id
				AND pdf_annotations.source_identity=EXCLUDED.source_identity`,
			mark.ID, file, actor, identity, mark.Page, mark.Kind, mark.Color, rects, strokes, mark.Width, mark.Size, mark.Text, mark.Comment)
	}
	results := tx.SendBatch(ctx, batch)
	for range in.Save {
		tag, err := results.Exec()
		if err == nil && tag.RowsAffected() == 0 {
			err = ErrConflict
		}
		if err != nil {
			results.Close()
			return err
		}
	}
	if err := results.Close(); err != nil {
		return err
	}
	if err := assertAnnotationRoomTx(ctx, tx, file); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
