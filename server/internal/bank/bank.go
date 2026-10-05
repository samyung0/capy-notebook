// Package bank serves the shared exam bank independently of the application database.
package bank

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

var (
	ErrUnconfigured = errors.New("bank_unconfigured")
	ErrReadOnly     = errors.New("bank_read_only")
	ErrUnavailable  = errors.New("bank_unavailable")
	ErrNotFound     = errors.New("bank question not found")
	ErrConflict     = errors.New("bank_conflict")
)

type lazyPool struct {
	dsn  string
	mu   sync.Mutex
	pool *pgxpool.Pool
}

func (p *lazyPool) connect(ctx context.Context) (*pgxpool.Pool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pool != nil {
		return p.pool, nil
	}
	cfg, err := pgxpool.ParseConfig(p.dsn)
	if err != nil {
		return nil, ErrUnavailable
	}
	cfg.MaxConns = 2
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, ErrUnavailable
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, ErrUnavailable
	}
	p.pool = pool
	return pool, nil
}
func (p *lazyPool) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pool != nil {
		p.pool.Close()
		p.pool = nil
	}
}

type Store struct {
	reader, editor, library lazyPool
	assetsURL               string
}

func New(readerURL, editorURL, assetsURL, libraryURL string) *Store {
	return &Store{reader: lazyPool{dsn: readerURL}, editor: lazyPool{dsn: editorURL}, library: lazyPool{dsn: libraryURL}, assetsURL: assetsURL}
}
func (s *Store) Configured() bool { return s != nil && s.reader.dsn != "" }
func (s *Store) Editable() bool   { return s.Configured() && s.editor.dsn != "" }
func (s *Store) Close()           { s.reader.close(); s.editor.close(); s.library.close() }
func (s *Store) pool(ctx context.Context, write bool) (*pgxpool.Pool, error) {
	if !s.Configured() {
		return nil, ErrUnconfigured
	}
	if write {
		if !s.Editable() {
			return nil, ErrReadOnly
		}
		return s.editor.connect(ctx)
	}
	return s.reader.connect(ctx)
}
func dbError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

type Topic struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Total    int    `json:"total"`
	Reviewed int    `json:"reviewed"`
}
type Subject struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Topics []Topic `json:"topics"`
}
type Exam struct {
	ID       string    `json:"id"`
	Label    string    `json:"label"`
	Subjects []Subject `json:"subjects"`
}
type Syllabus struct {
	Exams     []Exam `json:"exams"`
	Editor    bool   `json:"editor"`
	AssetsURL string `json:"assetsUrl"`
}

func (s *Store) Syllabus(ctx context.Context) (Syllabus, error) {
	out := Syllabus{Exams: []Exam{}, AssetsURL: s.assetsURL}
	p, err := s.pool(ctx, false)
	if err != nil {
		return out, err
	}
	rows, err := p.Query(ctx, `SELECT e.id,e.label,s.id,s.label,t.id,t.label,count(q.id),count(q.reviewed_at)
 FROM exams e LEFT JOIN subjects s ON s.exam_id=e.id LEFT JOIN topics t ON t.subject_id=s.id
 LEFT JOIN questions q ON q.topic_id=t.id GROUP BY e.id,s.id,t.id ORDER BY e.position,e.id,s.position,s.id,t.position,t.id`)
	if err != nil {
		return out, dbError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var eid, el string
		var sid, sl, tid, tl *string
		var total, reviewed int
		if err := rows.Scan(&eid, &el, &sid, &sl, &tid, &tl, &total, &reviewed); err != nil {
			return out, dbError(err)
		}
		if len(out.Exams) == 0 || out.Exams[len(out.Exams)-1].ID != eid {
			out.Exams = append(out.Exams, Exam{ID: eid, Label: el, Subjects: []Subject{}})
		}
		e := &out.Exams[len(out.Exams)-1]
		if sid == nil {
			continue
		}
		if len(e.Subjects) == 0 || e.Subjects[len(e.Subjects)-1].ID != *sid {
			e.Subjects = append(e.Subjects, Subject{ID: *sid, Label: *sl, Topics: []Topic{}})
		}
		if tid != nil {
			subject := &e.Subjects[len(e.Subjects)-1]
			subject.Topics = append(subject.Topics, Topic{ID: *tid, Label: *tl, Total: total, Reviewed: reviewed})
		}
	}
	return out, dbError(rows.Err())
}

type Row struct {
	ID           string     `json:"id"`
	Position     int        `json:"position"`
	Preview      string     `json:"preview"`
	Marks        int        `json:"marks"`
	HasFigure    bool       `json:"hasFigure"`
	HasTable     bool       `json:"hasTable"`
	ReviewedAt   *time.Time `json:"reviewedAt"`
	ReviewedBy   string     `json:"reviewedBy"`
	ReviewerName string     `json:"reviewerName"`
}

// Source is where a bank question's material came from: a library excerpt,
// or an openly licensed web page recorded as it read when the passage was adapted.
type Source struct {
	Kind        string   `json:"kind"`
	ExcerptID   string   `json:"excerptId,omitempty"`
	BookID      string   `json:"bookId,omitempty"`
	Version     int      `json:"version,omitempty"`
	URL         string   `json:"url,omitempty"`
	Title       string   `json:"title,omitempty"`
	Authors     []string `json:"authors,omitempty"`
	Publisher   string   `json:"publisher,omitempty"`
	License     string   `json:"license,omitempty"`
	LicenseURL  string   `json:"licenseUrl,omitempty"`
	RetrievedAt string   `json:"retrievedAt,omitempty"`
}

// reusable rejects licences that forbid adapting or commercial use: learners
// see bank passages, and passages are always adapted.
var unusableLicense = regexp.MustCompile(`(?i)\b(ND|NC)\b|no ?deriv|non-?commercial`)

// Check validates a source's own fields; Provenance resolves library excerpts.
func (src Source) Check() error {
	switch src.Kind {
	case "library":
		if strings.TrimSpace(src.ExcerptID) == "" || strings.TrimSpace(src.BookID) == "" || src.Version < 1 || src.URL != "" || src.Title != "" || len(src.Authors) > 0 || src.Publisher != "" || src.License != "" || src.LicenseURL != "" || src.RetrievedAt != "" {
			return errors.New("library sources take excerptId, bookId and a positive version only")
		}
	case "web":
		if src.ExcerptID != "" || src.BookID != "" || src.Version != 0 {
			return errors.New("web sources take no excerpt fields")
		}
		if _, err := time.Parse(time.DateOnly, src.RetrievedAt); err != nil {
			return errors.New("web sources need retrievedAt as YYYY-MM-DD")
		}
		if strings.TrimSpace(src.License) == "" || unusableLicense.MatchString(src.License) {
			return errors.New("web sources need a licence that allows adapted commercial reuse")
		}
	default:
		return errors.New(`sources need kind "library" or "web"`)
	}
	return nil
}

type Detail struct {
	Question     map[string]any    `json:"question"`
	Sources      []Source          `json:"sources"`
	Provenance   *store.Provenance `json:"provenance,omitempty"`
	UpdatedAt    time.Time         `json:"updatedAt"`
	ReviewedAt   *time.Time        `json:"reviewedAt"`
	ReviewedBy   string            `json:"reviewedBy"`
	ReviewerName string            `json:"reviewerName"`
	Editor       bool              `json:"editor"`
	TopicID      string            `json:"topicId"`
	Position     int               `json:"position"`
	ExamLabel    string            `json:"examLabel"`
	SubjectLabel string            `json:"subjectLabel"`
	TopicLabel   string            `json:"topicLabel"`
}

func (s *Store) List(ctx context.Context, topic string) ([]Row, error) {
	out := []Row{}
	p, err := s.pool(ctx, false)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err = p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM topics WHERE id=$1)`, topic).Scan(&exists); err != nil {
		return nil, dbError(err)
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.Query(ctx, `SELECT id,position,content,reviewed_at,COALESCE(reviewed_by,'') FROM questions WHERE topic_id=$1 ORDER BY position,id`, topic)
	if err != nil {
		return nil, dbError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var row Row
		var q map[string]any
		if err := rows.Scan(&row.ID, &row.Position, &q, &row.ReviewedAt, &row.ReviewedBy); err != nil {
			return nil, dbError(err)
		}
		row.Marks = questions.Marks(q)
		if stem, ok := q["stem"].([]any); ok {
			for _, v := range stem {
				b, _ := v.(map[string]any)
				if b["type"] == "text" {
					if text, ok := b["text"].(string); ok && strings.TrimSpace(text) != "" {
						r := []rune(text)
						if len(r) > 160 {
							r = r[:160]
						}
						row.Preview = string(r)
						break
					}
				}
			}
		}
		scanBlocks(q, &row)
		if row.Preview == "" {
			parts, _ := q["parts"].([]any)
			for _, raw := range parts {
				part, _ := raw.(map[string]any)
				blocks, _ := part["blocks"].([]any)
				for _, raw := range blocks {
					block, _ := raw.(map[string]any)
					if block["type"] == "text" {
						text, _ := block["text"].(string)
						if strings.TrimSpace(text) != "" {
							r := []rune(text)
							if len(r) > 160 {
								r = r[:160]
							}
							row.Preview = string(r)
							break
						}
					}
				}
				if row.Preview != "" {
					break
				}
			}
		}
		out = append(out, row)
	}
	return out, dbError(rows.Err())
}

// PageQuestion is one question of a topic as the chat agent lists it.
type PageQuestion struct {
	ID            string         `json:"id"`
	Question      map[string]any `json:"question"`
	QuestionTypes []string       `json:"questionTypes"`
}

// Page is a topic's question count and one page of its questions in bank
// order; an unknown topic is ErrNotFound.
func (s *Store) Page(ctx context.Context, topic string, offset, limit int) (int, []PageQuestion, error) {
	p, err := s.pool(ctx, false)
	if err != nil {
		return 0, nil, err
	}
	var total int
	var exists bool
	if err = p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM topics WHERE id=$1), (SELECT count(*) FROM questions WHERE topic_id=$1)`, topic).
		Scan(&exists, &total); err != nil {
		return 0, nil, dbError(err)
	}
	if !exists {
		return 0, nil, ErrNotFound
	}
	rows, err := p.Query(ctx, `SELECT id,content,question_types FROM questions WHERE topic_id=$1 ORDER BY position,id OFFSET $2 LIMIT $3`, topic, offset, limit)
	if err != nil {
		return 0, nil, dbError(err)
	}
	defer rows.Close()
	out := []PageQuestion{}
	for rows.Next() {
		var q PageQuestion
		if err := rows.Scan(&q.ID, &q.Question, &q.QuestionTypes); err != nil {
			return 0, nil, dbError(err)
		}
		out = append(out, q)
	}
	return total, out, dbError(rows.Err())
}

func scanBlocks(v any, row *Row) {
	switch v := v.(type) {
	case map[string]any:
		if v["type"] == "image" || v["type"] == "graph" || v["type"] == "chart" {
			row.HasFigure = true
		}
		if v["type"] == "table" {
			row.HasTable = true
		}
		for k, x := range v {
			if k != "solution" {
				scanBlocks(x, row)
			}
		}
	case []any:
		for _, x := range v {
			scanBlocks(x, row)
		}
	}
}
func (s *Store) Get(ctx context.Context, id string) (Detail, error) {
	var out Detail
	p, err := s.pool(ctx, false)
	if err != nil {
		return out, err
	}
	err = p.QueryRow(ctx, `SELECT q.content,q.sources,q.updated_at,q.reviewed_at,COALESCE(q.reviewed_by,''),q.topic_id,q.position,e.label,s.label,t.label
 FROM questions q JOIN topics t ON t.id=q.topic_id JOIN subjects s ON s.id=t.subject_id JOIN exams e ON e.id=s.exam_id WHERE q.id=$1`, id).
		Scan(&out.Question, &out.Sources, &out.UpdatedAt, &out.ReviewedAt, &out.ReviewedBy, &out.TopicID, &out.Position, &out.ExamLabel, &out.SubjectLabel, &out.TopicLabel)
	if err == nil {
		if invalid := s.Validate(out.Question); invalid != nil {
			return out, fmt.Errorf("%w: stored question is invalid", ErrUnavailable)
		}
	}
	return out, dbError(err)
}

// GetMany reads questions in the requested order; any unknown id fails the batch.
func (s *Store) GetMany(ctx context.Context, ids []string) ([]Detail, error) {
	p, err := s.pool(ctx, false)
	if err != nil {
		return nil, err
	}
	rows, err := p.Query(ctx, `SELECT q.content,q.sources,q.updated_at,q.reviewed_at,COALESCE(q.reviewed_by,''),q.topic_id,q.position,e.label,s.label,t.label
 FROM unnest($1::text[]) WITH ORDINALITY AS w(id,n) JOIN questions q ON q.id=w.id JOIN topics t ON t.id=q.topic_id JOIN subjects s ON s.id=t.subject_id JOIN exams e ON e.id=s.exam_id ORDER BY w.n`, ids)
	if err != nil {
		return nil, dbError(err)
	}
	defer rows.Close()
	out := []Detail{}
	for rows.Next() {
		var d Detail
		if err := rows.Scan(&d.Question, &d.Sources, &d.UpdatedAt, &d.ReviewedAt, &d.ReviewedBy, &d.TopicID, &d.Position, &d.ExamLabel, &d.SubjectLabel, &d.TopicLabel); err != nil {
			return nil, dbError(err)
		}
		if s.Validate(d.Question) != nil {
			return nil, fmt.Errorf("%w: stored question is invalid", ErrUnavailable)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, dbError(err)
	}
	if len(out) != len(ids) {
		return nil, ErrNotFound
	}
	return out, nil
}

// Provenance resolves the referenced historical edition, never the current pointer.
func (s *Store) Provenance(ctx context.Context, sources []Source) (*store.Provenance, error) {
	if len(sources) == 0 {
		return nil, nil
	}
	if len(sources) > 1024 {
		return nil, ErrUnavailable
	}
	result := &store.Provenance{Books: []store.ProvenanceBook{}}
	seen := map[string]bool{}
	excerptIDs, bookIDs := []string{}, []string{}
	versions := []int{}
	for _, source := range sources {
		if err := source.Check(); err != nil {
			return nil, fmt.Errorf("%w: %s", ErrUnavailable, err)
		}
		if source.Kind == "web" {
			if !seen["web "+source.URL] {
				seen["web "+source.URL] = true
				result.Web = append(result.Web, store.ProvenanceWeb{
					URL: source.URL, Title: source.Title, Authors: source.Authors, Publisher: source.Publisher,
					License: source.License, LicenseURL: source.LicenseURL, RetrievedAt: source.RetrievedAt,
				})
			}
			continue
		}
		key := fmt.Sprintf("library %s %s %d", source.ExcerptID, source.BookID, source.Version)
		if seen[key] {
			continue
		}
		seen[key] = true
		excerptIDs = append(excerptIDs, source.ExcerptID)
		bookIDs = append(bookIDs, source.BookID)
		versions = append(versions, source.Version)
	}
	if len(excerptIDs) > 0 {
		if err := s.libraryBooks(ctx, result, excerptIDs, bookIDs, versions); err != nil {
			return nil, err
		}
	}
	if _, err := store.ValidateStoredProvenance(result); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, err)
	}
	return result, nil
}

// libraryBooks resolves excerpt references to the book versions they were read from.
func (s *Store) libraryBooks(ctx context.Context, result *store.Provenance, excerptIDs, bookIDs []string, versions []int) error {
	if s.library.dsn == "" {
		return ErrUnavailable
	}
	pool, err := s.library.connect(ctx)
	if err != nil {
		return err
	}
	rows, err := pool.Query(ctx, `SELECT w.excerpt_id,b.id,b.title,b.authors,b.edition,v.version,b.license,b.license_url,b.source_url
 FROM unnest($1::text[],$2::text[],$3::int[]) WITH ORDINALITY AS w(excerpt_id,book_id,version,position)
 JOIN library_books b ON b.id=w.book_id JOIN library_book_versions v ON v.book_id=b.id AND v.version=w.version
 JOIN library_excerpts e ON e.book_id=b.id AND e.content_id=v.content_id AND e.id=w.excerpt_id
 ORDER BY w.position`, excerptIDs, bookIDs, versions)
	if err != nil {
		return dbError(err)
	}
	defer rows.Close()
	indices := map[string]int{}
	count := 0
	for rows.Next() {
		var book store.ProvenanceBook
		var excerptID string
		if err := rows.Scan(&excerptID, &book.ID, &book.Title, &book.Authors, &book.Edition, &book.Version, &book.License, &book.LicenseURL, &book.SourceURL); err != nil {
			return dbError(err)
		}
		count++
		key := fmt.Sprintf("%s/%d", book.ID, book.Version)
		if i, ok := indices[key]; ok {
			result.Books[i].ExcerptIDs = append(result.Books[i].ExcerptIDs, excerptID)
		} else {
			indices[key] = len(result.Books)
			book.ExcerptIDs = []string{excerptID}
			result.Books = append(result.Books, book)
		}
	}
	if err := rows.Err(); err != nil {
		return dbError(err)
	}
	if count != len(excerptIDs) {
		return fmt.Errorf("%w: bank source could not be resolved", ErrUnavailable)
	}
	return nil
}
func (s *Store) Validate(q map[string]any) error {
	return questions.Validate(q, questions.Policy{Bank: true, BankAssetsURL: s.assetsURL})
}
func (s *Store) Save(ctx context.Context, id, user string, q map[string]any, updated time.Time) error {
	if q["id"] != id {
		return errors.New("question id must match the route")
	}
	if err := s.Validate(q); err != nil {
		return err
	}
	p, err := s.pool(ctx, true)
	if err != nil {
		return err
	}
	tag, err := p.Exec(ctx, `UPDATE questions SET content=$3,updated_at=clock_timestamp(),updated_by=$4 WHERE id=$1 AND updated_at=$2`, id, updated, q, user)
	if err != nil {
		return dbError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}
func (s *Store) Review(ctx context.Context, id, user string, reviewed bool) error {
	p, err := s.pool(ctx, true)
	if err != nil {
		return err
	}
	tag, err := p.Exec(ctx, `UPDATE questions SET reviewed_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,reviewed_by=CASE WHEN $3 THEN $2 ELSE NULL END WHERE id=$1`, id, user, reviewed)
	if err != nil {
		return dbError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
