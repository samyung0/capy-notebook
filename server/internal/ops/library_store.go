package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Read-only view of the shared knowledge library (deploy/docker-compose.library-db.yml).
// The schema belongs to the library loader, mirrored for tests in
// testdata/library_schema.sql; pipeline/pipeline/retrieval/library.py owns it.
// One live library: books carry versions, and every read here follows the
// current content through rag_file_contents unless a version is asked for.
// Reviewers need locators, not edits, so nothing here mutates.

const (
	// The library's one workspace row, matching library.WORKSPACE in Python.
	libraryWorkspace        = "library"
	libraryBookLimit        = 200
	libraryBookVersionLimit = 1000
	libraryTopicLimit       = 500
	libraryRoleRowLimit     = 5000
	libraryExcerptPage      = 50
	libraryExcerptMaxPage   = 1000
	libraryChunkLimit       = 200
	libraryFigureLimit      = 200
	libraryModelRunLimit    = 500
	libraryIDMaxLen         = 128
	libraryMaxBookVersion   = 10000
	// Export bounds. One book's export is assembled in memory because the
	// sha256 header has to precede the body.
	libraryExportExcerptLimit = 2000
	libraryExportChunkLimit   = 20000
	libraryExportFigureLimit  = 2000
)

var libraryRoles = []string{
	"introduction", "formal", "worked_example", "exercise", "summary", "reference",
}

// LibraryOverview is the live library at a glance: what curate mode can reach
// right now, counted over every book's current version.
type LibraryOverview struct {
	DataAsOf time.Time `json:"dataAsOf"`
	Books    int       `json:"books"`
	Topics   int       `json:"topics"`
	Excerpts int       `json:"excerpts"`
	Chunks   int       `json:"chunks"`
	Figures  int       `json:"figures"`
}

// LibraryBookVersion is one publish of one book: what produced it, the prose
// written from its content, and where its source object lives. Retained
// versions stay exportable.
type LibraryBookVersion struct {
	Version           int       `json:"version"`
	Status            string    `json:"status"`
	PublishedAt       time.Time `json:"publishedAt"`
	SourceRun         string    `json:"sourceRun"`
	CorpusIdentity    string    `json:"corpusIdentity"`
	ParserRelease     string    `json:"parserRelease"`
	ParserFingerprint string    `json:"parserFingerprint"`
	ChunkerVersion    string    `json:"chunkerVersion"`
	Descriptor        string    `json:"descriptor"`
	Summary           string    `json:"summary"`
	ObjectKey         string    `json:"objectKey"`
	Note              string    `json:"note"`
}

type LibraryBook struct {
	ID               string          `json:"id"`
	Title            string          `json:"title"`
	Authors          json.RawMessage `json:"authors"`
	Edition          string          `json:"edition"`
	SourceURL        string          `json:"sourceUrl"`
	DownloadURL      string          `json:"downloadUrl"`
	License          string          `json:"license"`
	LicenseURL       string          `json:"licenseUrl"`
	Attribution      string          `json:"attribution"`
	SHA256           string          `json:"sha256"`
	Bytes            int64           `json:"bytes"`
	Pages            int             `json:"pages"`
	FirstContentPage int             `json:"firstContentPage"`
	ContentID        string          `json:"contentId"`
	Version          int             `json:"version"`
	RightsNotes      json.RawMessage `json:"rightsNotes"`
	FigureExclusions json.RawMessage `json:"figureExclusions"`
	// Descriptor and Summary belong to the version row, so these are the
	// prose of the version this record reports.
	Descriptor   string               `json:"descriptor"`
	Summary      string               `json:"summary"`
	ExcerptCount int                  `json:"excerptCount"`
	ChunkCount   int                  `json:"chunkCount"`
	FigureCount  int                  `json:"figureCount"`
	Versions     []LibraryBookVersion `json:"versions"`
}

// LibrarySubject is one entry of the committed subjects fixture, with what the
// live library holds under it.
type LibrarySubject struct {
	ID       string `json:"id"`
	Area     string `json:"area"`
	Label    string `json:"label"`
	Topics   int    `json:"topics"`
	Excerpts int    `json:"excerpts"`
}

type LibraryTopic struct {
	ID             string          `json:"id"`
	SubjectID      string          `json:"subjectId"`
	Label          string          `json:"label"`
	Aliases        json.RawMessage `json:"aliases"`
	Scope          string          `json:"scope"`
	SourceSections string          `json:"sourceSections"`
	// Excerpts carrying this topic, by role. VerifiedByRole counts the subset
	// the tagger could verify; RetrievableByRole further applies the curate
	// confidence floor, so it is what curate-mode search can return.
	ByRole            map[string]int `json:"byRole"`
	VerifiedByRole    map[string]int `json:"verifiedByRole"`
	RetrievableByRole map[string]int `json:"retrievableByRole"`
}

// libraryRetrievableConfidence mirrors the pipeline's
// CAPY_LIBRARY_TAG_MIN_CONFIDENCE default; ops has no pipeline config to read.
const libraryRetrievableConfidence = 0.8

type LibraryExcerpt struct {
	ID               string   `json:"id"`
	BookID           string   `json:"bookId"`
	BookTitle        string   `json:"bookTitle"`
	SectionPath      string   `json:"sectionPath"`
	Pages            []int32  `json:"pages"`
	Roles            []string `json:"roles"`
	TopicIDs         []string `json:"topicIds"`
	Confidence       *float64 `json:"confidence"`
	TagStatus        string   `json:"tagStatus"`
	EvidenceVerified bool     `json:"evidenceVerified"`
	ReviewReasons    []string `json:"reviewReasons"`
	ProposedTopic    string   `json:"proposedTopic"`
	Synopsis         string   `json:"synopsis"`
	ChunkIDs         []string `json:"chunkIds"`
	FigureIDs        []string `json:"figureIds"`
}

type LibraryExcerptPage struct {
	Page     int              `json:"page"`
	PageSize int              `json:"pageSize"`
	Total    int              `json:"total"`
	Items    []LibraryExcerpt `json:"items"`
}

type LibraryChunk struct {
	ID                string          `json:"id"`
	Index             int             `json:"index"`
	SectionPath       string          `json:"sectionPath"`
	Text              string          `json:"text"`
	PageStart         *int            `json:"pageStart"`
	PageEnd           *int            `json:"pageEnd"`
	Regions           json.RawMessage `json:"regions"`
	Lang              string          `json:"lang"`
	Confidence        *float64        `json:"confidence"`
	ConfidenceReasons []string        `json:"confidenceReasons"`
	Searchable        bool            `json:"searchable"`
	Reference         bool            `json:"reference"`
}

type LibraryFigure struct {
	ID                string          `json:"id"`
	Page              int             `json:"page"`
	BBox              []int32         `json:"bbox"`
	CaptionBBox       []int32         `json:"captionBbox"`
	Space             string          `json:"space"`
	GeometryKind      string          `json:"geometryKind"`
	BlockIndex        int             `json:"blockIndex"`
	OriginalCaption   json.RawMessage `json:"originalCaption"`
	OriginalFootnote  json.RawMessage `json:"originalFootnote"`
	SectionPath       string          `json:"sectionPath"`
	Excluded          bool            `json:"excluded"`
	ExclusionEvidence json.RawMessage `json:"exclusionEvidence"`
	CapturePath       string          `json:"capturePath"`
	CapturePixelSize  []int32         `json:"capturePixelSize"`
}

// LibraryBookLocator is what a reviewer needs to find the source PDF and
// reparse it: the file identity plus the version that produced this excerpt.
type LibraryBookLocator struct {
	ID                string `json:"id"`
	Title             string `json:"title"`
	Edition           string `json:"edition"`
	SHA256            string `json:"sha256"`
	SourceURL         string `json:"sourceUrl"`
	DownloadURL       string `json:"downloadUrl"`
	License           string `json:"license"`
	Version           int    `json:"version"`
	ParserFingerprint string `json:"parserFingerprint"`
	ChunkerVersion    string `json:"chunkerVersion"`
	FirstContentPage  int    `json:"firstContentPage"`
}

type LibraryExcerptDetail struct {
	Excerpt  LibraryExcerpt     `json:"excerpt"`
	Text     string             `json:"text"`
	Evidence string             `json:"evidence"`
	Regions  json.RawMessage    `json:"regions"`
	Book     LibraryBookLocator `json:"book"`
	Chunks   []LibraryChunk     `json:"chunks"`
	Figures  []LibraryFigure    `json:"figures"`
}

type LibraryModelRun struct {
	BookID             string          `json:"bookId"`
	Version            int             `json:"version"`
	Stage              string          `json:"stage"`
	Transport          string          `json:"transport"`
	Model              string          `json:"model"`
	Attempts           int             `json:"attempts"`
	Collection         json.RawMessage `json:"collection"`
	Usage              json.RawMessage `json:"usage"`
	ApproximateCostUSD *float64        `json:"approximateCostUsd"`
	RequestStartUTC    string          `json:"requestStartUtc"`
	RequestEndUTC      string          `json:"requestEndUtc"`
	ResultsPath        string          `json:"resultsPath"`
}

type LibraryExportExcerpt struct {
	LibraryExcerpt
	Text     string          `json:"text"`
	Evidence string          `json:"evidence"`
	Regions  json.RawMessage `json:"regions"`
	Chunks   []LibraryChunk  `json:"chunks"`
}

type LibraryExport struct {
	Version     int                    `json:"version"`
	ContentID   string                 `json:"contentId"`
	GeneratedAt time.Time              `json:"generatedAt"`
	Book        LibraryBook            `json:"book"`
	Excerpts    []LibraryExportExcerpt `json:"excerpts"`
	Figures     []LibraryFigure        `json:"figures"`
	// Truncated says a bound cut the export rather than the book ending.
	Truncated bool `json:"truncated"`
}

// ErrLibraryUnavailable means the library database is configured but could not
// be reached. It is a Library-section failure only: every other ops page reads
// the app database and keeps working.
var ErrLibraryUnavailable = errors.New("the knowledge library database is unreachable")

// libraryDB opens the library pool on first use. The library lives on the
// ingest host behind WireGuard, so an unreachable one must not stop the ops
// dashboard from starting, the way NewLazyAdminStore keeps admin writes out of
// startup.
type libraryDB struct {
	dsn  string
	mu   sync.Mutex
	pool *pgxpool.Pool
}

func (d *libraryDB) connect(ctx context.Context) (*pgxpool.Pool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pool != nil {
		return d.pool, nil
	}
	config, err := pgxpool.ParseConfig(d.dsn)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid connection string", ErrLibraryUnavailable)
	}
	config.MaxConns = 2
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLibraryUnavailable, err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("%w: %v", ErrLibraryUnavailable, err)
	}
	d.pool = pool
	return pool, nil
}

func (d *libraryDB) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	pool, err := d.connect(ctx)
	if err != nil {
		return nil, err
	}
	return pool.Query(ctx, sql, args...)
}

// QueryRow returns a row that reports a connection failure from Scan, which is
// where every caller already handles errors.
func (d *libraryDB) QueryRow(ctx context.Context, sql string, args ...any) scanner {
	pool, err := d.connect(ctx)
	if err != nil {
		return failedRow{err}
	}
	return pool.QueryRow(ctx, sql, args...)
}

func (d *libraryDB) Close() {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pool != nil {
		d.pool.Close()
		d.pool = nil
	}
}

type failedRow struct{ err error }

func (r failedRow) Scan(...any) error { return r.err }

// SetLibraryDSN registers the library connection string; the pool opens on the
// first Library request.
func (s *ReadStore) SetLibraryDSN(dsn string) {
	s.library = &libraryDB{dsn: dsn}
}

// SetLibraryPool registers an already open pool (tests).
func (s *ReadStore) SetLibraryPool(pool *pgxpool.Pool) {
	s.library = &libraryDB{pool: pool}
}

func (s *ReadStore) LibraryConfigured() bool {
	return s.library != nil
}

func (s *ReadStore) CloseLibrary() {
	s.library.Close()
}

func libraryID(name, value string) (string, error) {
	if value == "" {
		return "", validation("%s is required", name)
	}
	if len(value) > libraryIDMaxLen {
		return "", validation("%s must be at most %d characters", name, libraryIDMaxLen)
	}
	return value, nil
}

func (s *ReadStore) LibraryOverview(ctx context.Context) (LibraryOverview, error) {
	out := LibraryOverview{DataAsOf: time.Now().UTC()}
	err := s.library.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM library_books),
		       (SELECT count(*) FROM library_topics),
		       (SELECT count(*) FROM library_excerpts e
		          JOIN rag_file_contents fc ON fc.content_id = e.content_id
		         WHERE fc.workspace_id = $1),
		       (SELECT count(*) FROM library_chunks c
		          JOIN rag_file_contents fc ON fc.content_id = c.content_id
		         WHERE fc.workspace_id = $1),
		       (SELECT count(*) FROM library_figures f
		          JOIN rag_file_contents fc ON fc.content_id = f.content_id
		         WHERE fc.workspace_id = $1)`, libraryWorkspace).
		Scan(&out.Books, &out.Topics, &out.Excerpts, &out.Chunks, &out.Figures)
	return out, err
}

// LibraryBooks lists every book with the counts of its current version and its
// whole publish history, newest version first.
func (s *ReadStore) LibraryBooks(ctx context.Context) ([]LibraryBook, error) {
	out := []LibraryBook{}
	rows, err := s.library.Query(ctx, `
		SELECT b.id, b.title, b.authors, b.edition, b.source_url, b.download_url,
		       b.license, b.license_url, b.attribution, b.sha256, b.bytes, b.pages,
		       b.first_content_page, b.content_id, b.version, b.rights_notes,
		       b.figure_exclusions, v.descriptor, v.summary,
		       (SELECT count(*) FROM library_excerpts e WHERE e.content_id = b.content_id),
		       (SELECT count(*) FROM library_chunks c WHERE c.content_id = b.content_id),
		       (SELECT count(*) FROM library_figures f WHERE f.content_id = b.content_id)
		  FROM library_books b
		  JOIN library_book_versions v ON v.book_id = b.id AND v.version = b.version
		 ORDER BY b.title, b.id
		 LIMIT $1`, libraryBookLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	index := map[string]int{}
	for rows.Next() {
		book, err := scanLibraryBook(rows)
		if err != nil {
			return out, err
		}
		book.Versions = []LibraryBookVersion{}
		index[book.ID] = len(out)
		out = append(out, book)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	versionRows, err := s.library.Query(ctx, `
		SELECT book_id, version, status, published_at, source_run, corpus_identity,
		       parser_release, parser_fingerprint, chunker_version, descriptor,
		       summary, COALESCE(object_key, ''), note
		  FROM library_book_versions
		 ORDER BY book_id, version DESC
		 LIMIT $1`, libraryBookVersionLimit)
	if err != nil {
		return out, err
	}
	defer versionRows.Close()
	for versionRows.Next() {
		var bookID string
		var item LibraryBookVersion
		if err := versionRows.Scan(
			&bookID, &item.Version, &item.Status, &item.PublishedAt, &item.SourceRun,
			&item.CorpusIdentity, &item.ParserRelease, &item.ParserFingerprint,
			&item.ChunkerVersion, &item.Descriptor, &item.Summary, &item.ObjectKey,
			&item.Note,
		); err != nil {
			return out, err
		}
		if position, known := index[bookID]; known {
			out[position].Versions = append(out[position].Versions, item)
		}
	}
	return out, versionRows.Err()
}

// scanner is satisfied by both pgx.Rows and pgx.Row.
type scanner interface{ Scan(dest ...any) error }

func scanLibraryBook(rows scanner) (LibraryBook, error) {
	var book LibraryBook
	err := rows.Scan(
		&book.ID, &book.Title, &book.Authors, &book.Edition, &book.SourceURL,
		&book.DownloadURL, &book.License, &book.LicenseURL, &book.Attribution,
		&book.SHA256, &book.Bytes, &book.Pages, &book.FirstContentPage,
		&book.ContentID, &book.Version, &book.RightsNotes, &book.FigureExclusions,
		&book.Descriptor, &book.Summary,
		&book.ExcerptCount, &book.ChunkCount, &book.FigureCount,
	)
	return book, err
}

// LibrarySubjects lists every fixture subject with its topic count and the
// tagged excerpts of current book versions carrying one of its topics.
func (s *ReadStore) LibrarySubjects(ctx context.Context) ([]LibrarySubject, error) {
	out := []LibrarySubject{}
	rows, err := s.library.Query(ctx, `
		SELECT s.id, s.area, s.label,
		       (SELECT count(*) FROM library_topics t WHERE t.subject_id = s.id),
		       (SELECT count(*) FROM library_excerpts e
		          JOIN rag_file_contents fc ON fc.content_id = e.content_id
		         WHERE fc.workspace_id = $1 AND e.tag_status = 'tagged'
		           AND e.topic_ids && ARRAY(
		             SELECT t.id FROM library_topics t WHERE t.subject_id = s.id))
		  FROM library_subjects s
		 ORDER BY s.area, s.label
		 LIMIT $2`, libraryWorkspace, libraryTopicLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var subject LibrarySubject
		if err := rows.Scan(
			&subject.ID, &subject.Area, &subject.Label, &subject.Topics, &subject.Excerpts,
		); err != nil {
			return out, err
		}
		out = append(out, subject)
	}
	return out, rows.Err()
}

func (s *ReadStore) LibraryTopics(ctx context.Context) ([]LibraryTopic, error) {
	out := []LibraryTopic{}
	rows, err := s.library.Query(ctx, `
		SELECT id, subject_id, label, aliases, scope, source_sections
		  FROM library_topics ORDER BY id LIMIT $1`, libraryTopicLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	index := map[string]int{}
	for rows.Next() {
		var topic LibraryTopic
		if err := rows.Scan(
			&topic.ID, &topic.SubjectID, &topic.Label, &topic.Aliases, &topic.Scope,
			&topic.SourceSections,
		); err != nil {
			return out, err
		}
		topic.ByRole = map[string]int{}
		topic.VerifiedByRole = map[string]int{}
		topic.RetrievableByRole = map[string]int{}
		index[topic.ID] = len(out)
		out = append(out, topic)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	countRows, err := s.library.Query(ctx, `
		SELECT topic_id, role, count(*) AS total,
		       count(*) FILTER (
		         WHERE e.tag_status = 'tagged' AND e.evidence_verified
		       ) AS verified,
		       count(*) FILTER (
		         WHERE e.tag_status = 'tagged' AND e.evidence_verified
		           AND e.confidence >= $3
		       ) AS retrievable
		  FROM library_excerpts e
		  JOIN rag_file_contents fc ON fc.content_id = e.content_id
		  CROSS JOIN unnest(e.topic_ids) AS topic_id
		  CROSS JOIN unnest(e.roles) AS role
		 WHERE fc.workspace_id = $1
		 GROUP BY topic_id, role
		 ORDER BY topic_id, role
		 LIMIT $2`, libraryWorkspace, libraryRoleRowLimit, libraryRetrievableConfidence)
	if err != nil {
		return out, err
	}
	defer countRows.Close()
	for countRows.Next() {
		var topicID, role string
		var total, verified, retrievable int
		if err := countRows.Scan(&topicID, &role, &total, &verified, &retrievable); err != nil {
			return out, err
		}
		position, known := index[topicID]
		if !known {
			continue
		}
		out[position].ByRole[role] = total
		out[position].VerifiedByRole[role] = verified
		out[position].RetrievableByRole[role] = retrievable
	}
	return out, countRows.Err()
}

// LibraryExcerptFilter narrows the excerpt list. Empty facets pass everything;
// Review keeps only excerpts a reviewer should look at.
type LibraryExcerptFilter struct {
	Book   string
	Topic  string
	Role   string
	Review bool
	Page   int
}

const libraryExcerptWhere = `
		 WHERE fc.workspace_id = $1
		   AND ($2 = '' OR e.book_id = $2)
		   AND ($3 = '' OR e.topic_ids @> ARRAY[$3]::text[])
		   AND ($4 = '' OR e.roles @> ARRAY[$4]::text[])
		   AND (NOT $5::boolean
		        OR cardinality(e.review_reasons) > 0
		        OR e.tag_status <> 'tagged'
		        OR NOT e.evidence_verified)`

func (s *ReadStore) LibraryExcerpts(
	ctx context.Context,
	filter LibraryExcerptFilter,
) (LibraryExcerptPage, error) {
	out := LibraryExcerptPage{
		Page:     1,
		PageSize: libraryExcerptPage,
		Items:    []LibraryExcerpt{},
	}
	if filter.Page < 0 || filter.Page > libraryExcerptMaxPage {
		return out, validation("page must be between 1 and %d", libraryExcerptMaxPage)
	}
	if filter.Page > 0 {
		out.Page = filter.Page
	}
	if len(filter.Book) > libraryIDMaxLen || len(filter.Topic) > libraryIDMaxLen {
		return out, validation("book and topic filters must be at most %d characters", libraryIDMaxLen)
	}
	if filter.Role != "" && !containsString(libraryRoles, filter.Role) {
		return out, validation("role must be one of %v", libraryRoles)
	}
	if err := s.library.QueryRow(ctx,
		`SELECT count(*) FROM library_excerpts e
		  JOIN rag_file_contents fc ON fc.content_id = e.content_id`+libraryExcerptWhere,
		libraryWorkspace, filter.Book, filter.Topic, filter.Role, filter.Review,
	).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.library.Query(ctx, `
		SELECT e.id, e.book_id, b.title, e.section_path, e.pages, e.roles,
		       e.topic_ids, e.confidence, e.tag_status, e.evidence_verified,
		       e.review_reasons, COALESCE(e.proposed_topic, ''), e.synopsis,
		       e.chunk_ids, e.figure_ids
		  FROM library_excerpts e
		  JOIN rag_file_contents fc ON fc.content_id = e.content_id
		  JOIN library_books b ON b.id = e.book_id`+
		libraryExcerptWhere+`
		 ORDER BY e.book_id, e.pages[1], e.id
		 LIMIT $6 OFFSET $7`,
		libraryWorkspace, filter.Book, filter.Topic, filter.Role, filter.Review,
		libraryExcerptPage, (out.Page-1)*libraryExcerptPage)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		excerpt, err := scanLibraryExcerpt(rows)
		if err != nil {
			return out, err
		}
		out.Items = append(out.Items, excerpt)
	}
	return out, rows.Err()
}

func scanLibraryExcerpt(rows pgx.Rows) (LibraryExcerpt, error) {
	var item LibraryExcerpt
	err := rows.Scan(
		&item.ID, &item.BookID, &item.BookTitle, &item.SectionPath, &item.Pages,
		&item.Roles, &item.TopicIDs, &item.Confidence, &item.TagStatus,
		&item.EvidenceVerified, &item.ReviewReasons, &item.ProposedTopic,
		&item.Synopsis, &item.ChunkIDs, &item.FigureIDs,
	)
	return item, err
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func (s *ReadStore) LibraryExcerpt(
	ctx context.Context,
	excerptID string,
) (LibraryExcerptDetail, error) {
	out := LibraryExcerptDetail{Chunks: []LibraryChunk{}, Figures: []LibraryFigure{}}
	excerptID, err := libraryID("excerpt", excerptID)
	if err != nil {
		return out, err
	}
	var contentID string
	err = s.library.QueryRow(ctx, `
		SELECT e.id, e.book_id, b.title, e.section_path, e.pages, e.roles,
		       e.topic_ids, e.confidence, e.tag_status, e.evidence_verified,
		       e.review_reasons, COALESCE(e.proposed_topic, ''), e.synopsis,
		       e.chunk_ids, e.figure_ids, e.text, e.evidence, e.regions,
		       e.content_id, b.id, b.title, b.edition, b.sha256, b.source_url,
		       b.download_url, b.license, b.version, v.parser_fingerprint,
		       v.chunker_version, b.first_content_page
		  FROM library_excerpts e
		  JOIN rag_file_contents fc ON fc.content_id = e.content_id
		  JOIN library_books b ON b.id = e.book_id
		  JOIN library_book_versions v ON v.book_id = b.id AND v.version = b.version
		 WHERE fc.workspace_id = $1 AND e.id = $2`, libraryWorkspace, excerptID).
		Scan(
			&out.Excerpt.ID, &out.Excerpt.BookID, &out.Excerpt.BookTitle,
			&out.Excerpt.SectionPath, &out.Excerpt.Pages, &out.Excerpt.Roles,
			&out.Excerpt.TopicIDs, &out.Excerpt.Confidence, &out.Excerpt.TagStatus,
			&out.Excerpt.EvidenceVerified, &out.Excerpt.ReviewReasons,
			&out.Excerpt.ProposedTopic, &out.Excerpt.Synopsis, &out.Excerpt.ChunkIDs,
			&out.Excerpt.FigureIDs, &out.Text, &out.Evidence, &out.Regions,
			&contentID, &out.Book.ID, &out.Book.Title, &out.Book.Edition,
			&out.Book.SHA256, &out.Book.SourceURL, &out.Book.DownloadURL,
			&out.Book.License, &out.Book.Version, &out.Book.ParserFingerprint,
			&out.Book.ChunkerVersion, &out.Book.FirstContentPage,
		)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, store.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.Chunks, err = s.libraryChunks(
		ctx, contentID, "c.excerpt_id = $2", excerptID, libraryChunkLimit,
	)
	if err != nil {
		return out, err
	}
	out.Figures, err = s.libraryFigures(
		ctx, contentID, "f.id = ANY($2::text[])", out.Excerpt.FigureIDs, libraryFigureLimit,
	)
	return out, err
}

// libraryChunks reads one excerpt's or one book version's chunks in document
// order; predicate narrows the content-scoped set with $2.
func (s *ReadStore) libraryChunks(
	ctx context.Context,
	contentID, predicate string,
	key any,
	limit int,
) ([]LibraryChunk, error) {
	out := []LibraryChunk{}
	rows, err := s.library.Query(ctx, `
		SELECT c.id, c.chunk_idx, c.section_path, c.text, c.page_start, c.page_end,
		       c.regions, c.lang, c.confidence, c.confidence_reasons, c.searchable,
		       c.reference
		  FROM library_chunks c
		 WHERE c.content_id = $1 AND `+predicate+`
		 ORDER BY c.chunk_idx
		 LIMIT $3`, contentID, key, limit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var chunk LibraryChunk
		if err := rows.Scan(
			&chunk.ID, &chunk.Index, &chunk.SectionPath, &chunk.Text,
			&chunk.PageStart, &chunk.PageEnd, &chunk.Regions, &chunk.Lang,
			&chunk.Confidence, &chunk.ConfidenceReasons, &chunk.Searchable,
			&chunk.Reference,
		); err != nil {
			return out, err
		}
		out = append(out, chunk)
	}
	return out, rows.Err()
}

func (s *ReadStore) libraryFigures(
	ctx context.Context,
	contentID, predicate string,
	key any,
	limit int,
) ([]LibraryFigure, error) {
	out := []LibraryFigure{}
	rows, err := s.library.Query(ctx, `
		SELECT f.id, f.page, f.bbox, f.caption_bbox, f.space, f.geometry_kind,
		       f.block_index, f.original_caption, f.original_footnote,
		       f.section_path, f.excluded, f.exclusion_evidence,
		       COALESCE(f.capture_path, ''), f.capture_pixel_size
		  FROM library_figures f
		 WHERE f.content_id = $1 AND `+predicate+`
		 ORDER BY f.page, f.block_index
		 LIMIT $3`, contentID, key, limit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var figure LibraryFigure
		if err := rows.Scan(
			&figure.ID, &figure.Page, &figure.BBox, &figure.CaptionBBox,
			&figure.Space, &figure.GeometryKind, &figure.BlockIndex,
			&figure.OriginalCaption, &figure.OriginalFootnote, &figure.SectionPath,
			&figure.Excluded, &figure.ExclusionEvidence, &figure.CapturePath,
			&figure.CapturePixelSize,
		); err != nil {
			return out, err
		}
		out = append(out, figure)
	}
	return out, rows.Err()
}

// LibraryModelRuns reports the builder receipts of every book's current version.
func (s *ReadStore) LibraryModelRuns(ctx context.Context) ([]LibraryModelRun, error) {
	out := []LibraryModelRun{}
	rows, err := s.library.Query(ctx, `
		SELECT r.book_id, b.version, r.stage, r.transport, r.model, r.attempts,
		       r.collection, r.usage, r.approximate_cost_usd,
		       COALESCE(r.request_start_utc, ''), COALESCE(r.request_end_utc, ''),
		       r.results_path
		  FROM library_model_runs r
		  JOIN library_books b ON b.id = r.book_id AND b.content_id = r.content_id
		 ORDER BY r.book_id, r.stage
		 LIMIT $1`, libraryModelRunLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var run LibraryModelRun
		if err := rows.Scan(
			&run.BookID, &run.Version, &run.Stage, &run.Transport, &run.Model,
			&run.Attempts, &run.Collection, &run.Usage, &run.ApproximateCostUSD,
			&run.RequestStartUTC, &run.RequestEndUTC, &run.ResultsPath,
		); err != nil {
			return out, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// LibraryExport is the machine-readable record for an independent reviewer:
// one book version with its excerpts, their chunks and its figures. Version 0
// means the current one; a retained version stays exportable.
func (s *ReadStore) LibraryExport(
	ctx context.Context,
	bookID string,
	version int,
) (LibraryExport, error) {
	out := LibraryExport{
		GeneratedAt: time.Now().UTC(),
		Excerpts:    []LibraryExportExcerpt{},
		Figures:     []LibraryFigure{},
	}
	bookID, err := libraryID("book", bookID)
	if err != nil {
		return out, err
	}
	if version < 0 || version > libraryMaxBookVersion {
		return out, validation("version must be between 1 and %d", libraryMaxBookVersion)
	}
	err = s.library.QueryRow(ctx, `
		SELECT v.version, v.content_id
		  FROM library_book_versions v
		 WHERE v.book_id = $1
		   AND (($2::int = 0 AND v.status = 'current') OR v.version = $2::int)
		 LIMIT 1`, bookID, version).Scan(&out.Version, &out.ContentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, store.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	// The prose, content id and version come from the exported version, not
	// the current one: a retained export must describe what it contains.
	out.Book, err = scanLibraryBook(s.library.QueryRow(ctx, `
		SELECT b.id, b.title, b.authors, b.edition, b.source_url, b.download_url,
		       b.license, b.license_url, b.attribution, b.sha256, b.bytes, b.pages,
		       b.first_content_page, v.content_id, v.version, b.rights_notes,
		       b.figure_exclusions, v.descriptor, v.summary,
		       (SELECT count(*) FROM library_excerpts e WHERE e.content_id = $2),
		       (SELECT count(*) FROM library_chunks c WHERE c.content_id = $2),
		       (SELECT count(*) FROM library_figures f WHERE f.content_id = $2)
		  FROM library_books b
		  JOIN library_book_versions v ON v.book_id = b.id AND v.content_id = $2
		 WHERE b.id = $1
		 LIMIT 1`, bookID, out.ContentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return out, store.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.Book.Versions = []LibraryBookVersion{}
	rows, err := s.library.Query(ctx, `
		SELECT e.id, e.book_id, b.title, e.section_path, e.pages, e.roles,
		       e.topic_ids, e.confidence, e.tag_status, e.evidence_verified,
		       e.review_reasons, COALESCE(e.proposed_topic, ''), e.synopsis,
		       e.chunk_ids, e.figure_ids, e.text, e.evidence, e.regions
		  FROM library_excerpts e
		  JOIN library_books b ON b.id = e.book_id
		 WHERE e.content_id = $1
		 ORDER BY e.pages[1], e.id
		 LIMIT $2`, out.ContentID, libraryExportExcerptLimit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item LibraryExportExcerpt
		if err := rows.Scan(
			&item.ID, &item.BookID, &item.BookTitle, &item.SectionPath, &item.Pages,
			&item.Roles, &item.TopicIDs, &item.Confidence, &item.TagStatus,
			&item.EvidenceVerified, &item.ReviewReasons, &item.ProposedTopic,
			&item.Synopsis, &item.ChunkIDs, &item.FigureIDs, &item.Text,
			&item.Evidence, &item.Regions,
		); err != nil {
			return out, err
		}
		item.Chunks = []LibraryChunk{}
		out.Excerpts = append(out.Excerpts, item)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Excerpts) > libraryExportExcerptLimit {
		out.Excerpts = out.Excerpts[:libraryExportExcerptLimit]
		out.Truncated = true
	}
	chunks, err := s.libraryChunks(
		ctx, out.ContentID, "c.book_id = $2", bookID, libraryExportChunkLimit+1,
	)
	if err != nil {
		return out, err
	}
	if len(chunks) > libraryExportChunkLimit {
		chunks = chunks[:libraryExportChunkLimit]
		out.Truncated = true
	}
	byChunkID := map[string]LibraryChunk{}
	for _, chunk := range chunks {
		byChunkID[chunk.ID] = chunk
	}
	for index := range out.Excerpts {
		for _, chunkID := range out.Excerpts[index].ChunkIDs {
			if chunk, ok := byChunkID[chunkID]; ok {
				out.Excerpts[index].Chunks = append(out.Excerpts[index].Chunks, chunk)
			}
		}
	}
	figures, err := s.libraryFigures(
		ctx, out.ContentID, "f.book_id = $2", bookID, libraryExportFigureLimit+1,
	)
	if err != nil {
		return out, err
	}
	if len(figures) > libraryExportFigureLimit {
		figures = figures[:libraryExportFigureLimit]
		out.Truncated = true
	}
	out.Figures = figures
	return out, nil
}
