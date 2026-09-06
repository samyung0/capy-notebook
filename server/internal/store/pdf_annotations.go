package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

type PDFRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type PDFAnnotationBody struct {
	SourceIdentity string    `json:"sourceIdentity"`
	Page           int       `json:"page" minimum:"1"`
	Kind           string    `json:"kind" enum:"highlight,rectangle,ellipse"`
	Rects          []PDFRect `json:"rects" nullable:"false" minItems:"1" maxItems:"1000"`
	Color          string    `json:"color" pattern:"^#[0-9a-fA-F]{6}$"`
}
type PDFAnnotation struct {
	PDFAnnotationBody
	ID        string    `json:"id"`
	FileID    string    `json:"fileId"`
	AuthorID  string    `json:"authorId"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

var annotationColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validatePDFAnnotation(in PDFAnnotationBody) error {
	if in.Page < 1 || !annotationColor.MatchString(in.Color) || len(in.Rects) < 1 || len(in.Rects) > 1000 {
		return ErrConflict
	}
	if in.Kind != "highlight" && in.Kind != "rectangle" && in.Kind != "ellipse" {
		return ErrConflict
	}
	if in.Kind != "highlight" && len(in.Rects) != 1 {
		return ErrConflict
	}
	for _, r := range in.Rects {
		for _, v := range []float64{r.X, r.Y, r.Width, r.Height} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return ErrConflict
			}
		}
		if r.X < 0 || r.Y < 0 || r.Width <= 0 || r.Height <= 0 || r.X+r.Width > 1000 || r.Y+r.Height > 1000 {
			return ErrConflict
		}
	}
	return nil
}
func (s *Store) annotationLock(ctx context.Context, tx pgx.Tx, actor, file string) (string, error) {
	_, _, err := s.sourceLockTx(ctx, tx, file, []string{actor}, false)
	if err != nil {
		return "", err
	}
	var kind string
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT kind,revision FROM files WHERE id=$1 FOR UPDATE`, file).Scan(&kind, &revision); err != nil {
		return "", err
	}
	if kind != "pdf" {
		return "", ErrForbidden
	}
	return fmt.Sprintf("revision:%d", revision), nil
}

const annotationColumns = `id,file_id,author_id,source_identity,page,kind,rects,color,created_at,updated_at`

func scanAnnotation(row pgx.Row) (PDFAnnotation, error) {
	var out PDFAnnotation
	var rects []byte
	err := row.Scan(&out.ID, &out.FileID, &out.AuthorID, &out.SourceIdentity, &out.Page, &out.Kind, &rects, &out.Color, &out.CreatedAt, &out.UpdatedAt)
	if err == nil {
		err = json.Unmarshal(rects, &out.Rects)
	}
	if isNoRows(err) {
		err = ErrNotFound
	}
	return out, err
}
func (s *Store) ListPDFAnnotations(ctx context.Context, actor, file string) ([]PDFAnnotation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	identity, err := s.annotationLock(ctx, tx, actor, file)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT `+annotationColumns+` FROM pdf_annotations WHERE file_id=$1 AND author_id=$2 AND source_identity=$3 ORDER BY page,created_at,id`, file, actor, identity)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PDFAnnotation{}
	for rows.Next() {
		row, e := scanAnnotation(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, row)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return out, tx.Commit(ctx)
}
func (s *Store) SavePDFAnnotation(ctx context.Context, actor, file, id string, in PDFAnnotationBody) (PDFAnnotation, error) {
	if err := validatePDFAnnotation(in); err != nil {
		return PDFAnnotation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PDFAnnotation{}, err
	}
	defer tx.Rollback(ctx)
	identity, err := s.annotationLock(ctx, tx, actor, file)
	if err != nil {
		return PDFAnnotation{}, err
	}
	if identity != in.SourceIdentity {
		return PDFAnnotation{}, ErrConflict
	}
	rects, err := json.Marshal(in.Rects)
	if err != nil {
		return PDFAnnotation{}, err
	}
	var row pgx.Row
	if id == "" {
		row = tx.QueryRow(ctx, `INSERT INTO pdf_annotations(id,file_id,author_id,source_identity,page,kind,rects,color) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+annotationColumns, uid("ann"), file, actor, in.SourceIdentity, in.Page, in.Kind, rects, in.Color)
	} else {
		row = tx.QueryRow(ctx, `UPDATE pdf_annotations SET page=$4,kind=$5,rects=$6,color=$7,updated_at=now() WHERE id=$1 AND file_id=$2 AND author_id=$3 AND source_identity=$8 RETURNING `+annotationColumns, id, file, actor, in.Page, in.Kind, rects, in.Color, identity)
	}
	out, err := scanAnnotation(row)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *Store) DeletePDFAnnotation(ctx context.Context, actor, file, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = s.annotationLock(ctx, tx, actor, file); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `DELETE FROM pdf_annotations WHERE id=$1 AND file_id=$2 AND author_id=$3`, id, file, actor)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}
