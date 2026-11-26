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
	// Author is who made a mark on a submission's file, where staff share their
	// marks; a private mark has none. Read only: a save ignores it.
	Author *PDFAnnotationAuthor `json:"author,omitempty" readOnly:"true"`
}

// PDFAnnotationAuthor names a shared mark's maker in the Marks list and the
// comment margin.
type PDFAnnotationAuthor struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl"`
}

// PDFAnnotationList is the marks on the bytes sourceIdentity names: the
// caller's own, or on a submission's file every staff mark (Shared). ReadOnly:
// the caller may not change them (a member reading their feedback).
type PDFAnnotationList struct {
	SourceIdentity string          `json:"sourceIdentity"`
	Marks          []PDFAnnotation `json:"marks" nullable:"false"`
	Shared         bool            `json:"shared"`
	ReadOnly       bool            `json:"readOnly"`
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

// submissionGradeShownSQL holds for a submission's file f (its attempt t,
// its assignment a) once its grade is decided: a hand-in's saved, a paper's
// answers all marked (no waiting answer, as attemptView hides the grade). Its member sees marks, and a Word file's copy, from then on
// unless Manual grades wait for release.
const submissionGradeShownSQL = `CASE WHEN f.hand_in_assignment_id IS NOT NULL
				THEN EXISTS (SELECT 1 FROM assignment_grades g WHERE g.assignment_id=a.id AND g.user_id=f.user_id)
				ELSE t.submitted_at IS NOT NULL AND COALESCE(t.waiting_answers, 0) = 0 END`

// submissionMarksShownSQL: its member sees staff's marks on f now.
const submissionMarksShownSQL = `(NOT (a.grades_shown = 'manual' AND a.grades_released_at IS NULL) AND ` + submissionGradeShownSQL + `)`

// annotationScope is what annotationLock found: the bytes' identity, and for
// a submission's file whether its marks are staff's shared ones, whether the
// caller may change them, and whether they are still hidden from the caller.
type annotationScope struct {
	identity string
	shared   bool
	readOnly bool
	hidden   bool
	// onePage: a photo, marked as a page its own size (T2).
	onePage bool
	// word: a .docx, marked on its PDF copy (C1) once copied.
	word, copied bool
}

// submissionMarkAccess reads who marks a submission's file (Epo 2026-11-25,
// mock B6H1Z7o4byVFBVyCRSUK3B: T1, T3, S1), locking its row. Staff of the
// class read it once handed in (as HandInFileBlob and PaperFileBlob) and mark
// it when the assignment is graded: a graded quiz, or an Assignment graded on
// points; every staff member reads and changes every staff mark. Its member
// reads the marks, never changes them, and sees none until they see the grade:
// a hand-in's saved and a paper's marks decided, under Manual once released.
// A PDF or a photo takes marks, a photo on its one page (T2), and a .docx on
// its PDF copy once staff stored one (C1, marked_copies.go).
// ok is false for a file that is no submission's.
func (s *Store) submissionMarkAccess(ctx context.Context, tx pgx.Tx, actor, file string) (scope annotationScope, ok bool, err error) {
	var owner, wsID, kind, name string
	var revision int64
	var graded, gradesHidden, handedIn, gradeShown, copied bool
	err = tx.QueryRow(ctx, `SELECT f.user_id, a.workspace_id, f.kind, f.name, f.revision, f.marked_copy_path IS NOT NULL,
			a.kind = 'marked' OR a.points IS NOT NULL,
			a.grades_shown = 'manual' AND a.grades_released_at IS NULL,
			CASE WHEN f.hand_in_assignment_id IS NOT NULL
				THEN EXISTS (SELECT 1 FROM assignment_done d WHERE d.assignment_id=a.id AND d.user_id=f.user_id)
				ELSE t.submitted_at IS NOT NULL END,
			`+submissionGradeShownSQL+`
		FROM files f LEFT JOIN attempts t ON t.id=f.attempt_id
		JOIN assignments a ON a.id=COALESCE(f.hand_in_assignment_id, t.assignment_id)
		WHERE f.id=$1 AND f.trashed_at IS NULL AND f.submission_position IS NOT NULL
		FOR UPDATE OF f`, file).Scan(&owner, &wsID, &kind, &name, &revision, &copied, &graded, &gradesHidden, &handedIn, &gradeShown)
	if isNoRows(err) {
		return annotationScope{}, false, nil
	}
	if err != nil {
		return annotationScope{}, false, err
	}
	scope = annotationScope{identity: fmt.Sprintf("revision:%d", revision), shared: true}
	switch {
	case owner == actor:
		scope.readOnly = true
		scope.hidden = gradesHidden || !gradeShown
	case handedIn:
		staff, err := s.assignmentStaff(ctx, tx, actor, wsID)
		if errors.Is(err, ErrNotFound) || (err == nil && !staff) {
			return annotationScope{}, true, ErrNotFound
		}
		if err != nil {
			return annotationScope{}, true, err
		}
		// An ungraded one takes no marks (T3); staff still read the file.
		scope.readOnly = !graded
	default:
		return annotationScope{}, true, ErrNotFound
	}
	scope.onePage = kind == string(FileImage)
	scope.word = SourceEditFormat(name, kind) == "docx"
	scope.copied = copied
	if kind != string(FilePDF) && !scope.onePage && !scope.word {
		return annotationScope{}, true, ErrForbidden
	}
	return scope, true, nil
}

// annotationLock admits any reader of the file, a hidden question paper's
// starters too (FileReadRole: their own marks on it, never its room), and on
// a submission's file its staff and member (submissionMarkAccess). Saving or
// deleting a mark (write) is a content edit, refused when the actor or the
// file's payer is frozen or the payer is at its storage limit; a submission's
// file is charged to no one, so there only the marking staff member's own
// account decides (mock B6H1Z7o4byVFBVyCRSUK3B), and its member never writes.
func (s *Store) annotationLock(ctx context.Context, tx pgx.Tx, actor, file string, write bool) (annotationScope, error) {
	scope, submission, err := s.submissionMarkAccess(ctx, tx, actor, file)
	if submission {
		if err != nil {
			return annotationScope{}, err
		}
		// A .docx has nothing to mark until its copy is stored.
		if scope.word && !scope.copied {
			return annotationScope{}, ErrForbidden
		}
		if write {
			if scope.readOnly {
				return annotationScope{}, ErrForbidden
			}
			if err := s.assertContentEditableTx(ctx, tx, actor, actor); err != nil {
				return annotationScope{}, err
			}
		}
		return scope, nil
	}
	if err != nil {
		return annotationScope{}, err
	}
	_, _, err = s.sourceLockTx(ctx, tx, file, []string{actor}, false, nil, false)
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
		return annotationScope{}, err
	}
	if write {
		payer, err := filePayer(ctx, tx, file)
		if err != nil {
			return annotationScope{}, err
		}
		if err := s.assertContentEditableTx(ctx, tx, payer, actor); err != nil {
			return annotationScope{}, err
		}
	}
	var kind string
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT kind,revision FROM files WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, file).
		Scan(&kind, &revision); err != nil {
		return annotationScope{}, err
	}
	if kind != "pdf" {
		return annotationScope{}, ErrForbidden
	}
	return annotationScope{identity: fmt.Sprintf("revision:%d", revision)}, nil
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

// scanAnnotation reads annotationColumns and then the author's id, name and
// avatar, empty for a private mark.
func scanAnnotation(row pgx.Row) (PDFAnnotation, error) {
	var out PDFAnnotation
	var rects, strokes []byte
	var author PDFAnnotationAuthor
	err := row.Scan(&out.ID, &out.Page, &out.Kind, &out.Color, &rects, &strokes, &out.Width, &out.Size, &out.Text, &out.Comment,
		&author.ID, &author.Name, &author.AvatarURL)
	if err == nil {
		err = json.Unmarshal(rects, &out.Rects)
		if err == nil {
			err = json.Unmarshal(strokes, &out.Strokes)
		}
	}
	if author.ID != "" {
		out.Author = &author
	}
	return out, err
}

// ListPDFAnnotations is the caller's own marks on the file's current bytes,
// or on a submission's file every staff mark with its author (none while its
// member may not see them yet). A trashed PDF's trash readers read theirs too,
// read-only (Epo 2026-11-12).
func (s *Store) ListPDFAnnotations(ctx context.Context, actor, file string) (PDFAnnotationList, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PDFAnnotationList{}, err
	}
	defer tx.Rollback(ctx)
	scope, err := s.annotationLock(ctx, tx, actor, file, false)
	if errors.Is(err, ErrNotFound) || isNoRows(err) {
		scope = annotationScope{}
		scope.identity, err = s.trashedAnnotationIdentity(ctx, tx, actor, file)
	}
	if err != nil {
		return PDFAnnotationList{}, err
	}
	out := PDFAnnotationList{SourceIdentity: scope.identity, Marks: []PDFAnnotation{},
		Shared: scope.shared, ReadOnly: scope.readOnly}
	if scope.hidden {
		return out, tx.Commit(ctx)
	}
	query := `SELECT ` + annotationColumns + `, '', '', '' FROM pdf_annotations
		WHERE file_id=$1 AND author_id=$2 AND source_identity=$3 ORDER BY page,created_at,id`
	args := []any{file, actor, scope.identity}
	if scope.shared {
		query = `SELECT p.` + strings.ReplaceAll(annotationColumns, ",", ",p.") + `, p.author_id,
				COALESCE(NULLIF(u.name,''), ''), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, '')
			FROM pdf_annotations p LEFT JOIN users u ON u.id=p.author_id
			WHERE p.file_id=$1 AND p.source_identity=$2 ORDER BY p.page,p.created_at,p.id`
		args = []any{file, scope.identity}
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return PDFAnnotationList{}, err
	}
	defer rows.Close()
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
// marks in one transaction; on a submission's file, any staff mark, the last
// save winning and a mark keeping its maker (mock B6H1Z7o4byVFBVyCRSUK3B). A
// mark ID is the viewer's, so its marks draw and change before any save
// lands; one held by another author (a private mark) or file, or saved on
// other bytes, is a conflict. Removing a mark already gone is no error: a
// later queue, another tab or another staff member removed it first.
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
	scope, err := s.annotationLock(ctx, tx, actor, file, true)
	if err != nil {
		return err
	}
	identity := scope.identity
	if identity != in.SourceIdentity {
		return ErrConflict
	}
	if scope.onePage {
		for _, mark := range in.Save {
			if mark.Page != 1 {
				return ErrInvalidPDFAnnotation
			}
		}
	}
	if len(in.Remove) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM pdf_annotations WHERE file_id=$1 AND ($2 OR author_id=$3) AND id=ANY($4)`,
			file, scope.shared, actor, in.Remove); err != nil {
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
			WHERE pdf_annotations.file_id=EXCLUDED.file_id AND ($14 OR pdf_annotations.author_id=EXCLUDED.author_id)
				AND pdf_annotations.source_identity=EXCLUDED.source_identity`,
			mark.ID, file, actor, identity, mark.Page, mark.Kind, mark.Color, rects, strokes, mark.Width, mark.Size, mark.Text, mark.Comment, scope.shared)
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
