package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// libraryTestPool creates a sibling database in the test container, applies
// the schema fixture (kept identical to LIBRARY_SCHEMA by
// pipeline/tests/test_library.py) and seeds one reviewable book at version 2
// with version 1 retained.
func libraryTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	appDSN := integrationDSN(t)
	appPool, err := pgxpool.New(ctx, appDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	name := fmt.Sprintf("library_ops_%d", time.Now().UnixNano())
	if _, err := appPool.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(appDSN)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	pool, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	schema, err := os.ReadFile("testdata/library_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(schema)); err != nil {
		t.Fatalf("apply library schema: %v", err)
	}
	seedLibrary(t, pool)
	return pool
}

func seedLibrary(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	statements := []string{
		`INSERT INTO workspaces VALUES ('library', 'deepinfra', 'Qwen/Qwen3-Embedding-4B', 1, 2560)`,
		`INSERT INTO files (id, name) VALUES ('ahss', 'Advanced High School Statistics')`,
		`INSERT INTO rag_contents VALUES ('ahss_v1', 'ready'), ('ahss_v2', 'ready')`,
		`INSERT INTO rag_file_contents VALUES ('ahss', 'library', 'ahss_v2')`,
		`INSERT INTO library_books VALUES
			('ahss', 'Advanced High School Statistics', '["Diez"]', '4e',
			 'https://openintro.org', 'https://openintro.org/ahss.pdf', 'CC BY-SA 4.0',
			 'https://creativecommons.org/licenses/by-sa/4.0/', 'OpenIntro', 'book-sha',
			 1024, 500, 12, 'ahss_v2', 2, '[]', '[]')`,
		`INSERT INTO library_book_versions
			(book_id, version, content_id, status, source_run, corpus_identity,
			 parser_release, parser_fingerprint, chunker_version, descriptor, summary,
			 object_key, note)
			VALUES
			('ahss', 1, 'ahss_v1', 'retained', 'run-1', 'corpus-1', 'odl-2026-09-16',
			 'odl-fp-1', 'v10', 'older stats', 'older summary', 'books/book-sha.pdf', 'pilot'),
			('ahss', 2, 'ahss_v2', 'current', 'run-2', 'corpus-2', 'odl-2026-09-17',
			 'odl-fp', 'v10', 'stats', 'summary', 'books/book-sha.pdf', 'reparse')`,
		`INSERT INTO library_topics VALUES
			('linear-regression', 'Linear regression', '["least squares"]',
			 'Fitting lines', 'AHSS 8')`,
		`INSERT INTO library_excerpts VALUES
			('ahss_v2', 'e_intro_v2', 'ahss', 'Ch 8 > Intro', '{c_intro_v2}', '{340}', '[]',
			 '{fig_1_v2}', 'Regression introduces a fitted line', 'tagged',
			 '{introduction}', '{linear-regression}', 0.95, 'quoted evidence', true,
			 'synopsis', NULL, '{}')`,
		`INSERT INTO library_excerpts VALUES
			('ahss_v2', 'e_review_v2', 'ahss', 'Ch 8 > Exercises', '{c_review_v2}', '{352}', '[]',
			 '{}', 'Exercises nobody verified', 'tagged', '{exercise}',
			 '{linear-regression}', 0.4, 'weak evidence', false, 'synopsis',
			 'regression-exercises', '{low_confidence}')`,
		// The retained version is invisible to every current-content read.
		`INSERT INTO library_excerpts VALUES
			('ahss_v1', 'e_intro_v1', 'ahss', 'Ch 8 > Intro', '{c_intro_v1}', '{340}', '[]',
			 '{}', 'Older parse of the same section', 'tagged', '{introduction}',
			 '{linear-regression}', 0.95, 'quoted evidence', true, 'synopsis', NULL, '{}')`,
		`INSERT INTO library_chunks VALUES
			('c_intro_v2', 'library', 'ahss_v2', 0, 'Ch 8 > Intro',
			 'Regression introduces a fitted line', 'regression fitted line', 340, 341,
			 '[{"page":340,"bbox":[10,20,30,40]}]', 'en', 0.88, '{ocr_page}',
			 to_tsvector('english', 'regression fitted line'), true, 'ahss', 'e_intro_v2', false)`,
		`INSERT INTO library_chunks VALUES
			('c_review_v2', 'library', 'ahss_v2', 1, 'Ch 8 > Exercises',
			 'Exercises nobody verified', 'exercises', 352, 352, '[]', 'en', 0.5,
			 '{low_text_layer}', to_tsvector('english', 'exercises'), false, 'ahss',
			 'e_review_v2', true)`,
		`INSERT INTO library_chunks VALUES
			('c_intro_v1', 'library', 'ahss_v1', 0, 'Ch 8 > Intro',
			 'Older parse of the same section', 'older parse', 340, 341, '[]', 'en', 0.7,
			 '{}', to_tsvector('english', 'older parse'), true, 'ahss', 'e_intro_v1', false)`,
		`INSERT INTO library_figures VALUES
			('ahss_v2', 'fig_1_v2', 'ahss', 340, '{10,20,300,400}', '{10,410,300,430}', 'page',
			 'native', 3, '{"text":"Figure 8.1"}', '{}', 'Ch 8 > Intro', false, '{}',
			 'captures/fig_1.png', '{800,600}')`,
		`INSERT INTO library_model_runs VALUES
			('ahss', 'ahss_v2', 'tagging', 'claude-code', 'sonnet-4.6', 2, '{"crops":16}',
			 '{"input":100,"output":40}', 1.25, '2026-09-16T10:00:00Z',
			 '2026-09-16T10:30:00Z', 'runs/tagging.json')`,
		`INSERT INTO library_model_runs VALUES
			('ahss', 'ahss_v1', 'tagging', 'claude-code', 'sonnet-4.6', 1, '{}', '{}',
			 0.5, NULL, NULL, 'runs/tagging-v1.json')`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("seed library: %v\n%s", err, statement)
		}
	}
}

func TestLibraryReadsFollowTheCurrentBookVersion(t *testing.T) {
	ctx := context.Background()
	read := &ReadStore{}
	read.SetLibraryPool(libraryTestPool(t))
	if !read.LibraryConfigured() {
		t.Fatal("library pool was not registered")
	}

	overview, err := read.LibraryOverview(ctx)
	if err != nil {
		t.Fatalf("library overview: %v", err)
	}
	if overview.Books != 1 || overview.Topics != 1 || overview.Excerpts != 2 ||
		overview.Chunks != 2 || overview.Figures != 1 {
		t.Fatalf("overview = %+v, want only the current version counted", overview)
	}

	books, err := read.LibraryBooks(ctx)
	if err != nil {
		t.Fatalf("library books: %v", err)
	}
	if len(books) != 1 || books[0].SHA256 != "book-sha" || books[0].Version != 2 ||
		books[0].ExcerptCount != 2 || books[0].ChunkCount != 2 || books[0].FigureCount != 1 {
		t.Fatalf("books = %+v", books)
	}
	if books[0].Descriptor != "stats" || books[0].Summary != "summary" {
		t.Fatalf("book prose = %q / %q, want the current version's", books[0].Descriptor, books[0].Summary)
	}
	if len(books[0].Versions) != 2 || books[0].Versions[0].Version != 2 ||
		books[0].Versions[0].Status != "current" ||
		books[0].Versions[1].Status != "retained" ||
		books[0].Versions[0].ObjectKey != "books/book-sha.pdf" ||
		books[0].Versions[1].SourceRun != "run-1" ||
		books[0].Versions[1].Descriptor != "older stats" {
		t.Fatalf("book versions = %+v", books[0].Versions)
	}

	topics, err := read.LibraryTopics(ctx)
	if err != nil {
		t.Fatalf("library topics: %v", err)
	}
	if len(topics) != 1 ||
		topics[0].ByRole["introduction"] != 1 || topics[0].ByRole["exercise"] != 1 ||
		topics[0].VerifiedByRole["introduction"] != 1 ||
		topics[0].VerifiedByRole["exercise"] != 0 ||
		topics[0].RetrievableByRole["introduction"] != 1 ||
		topics[0].RetrievableByRole["exercise"] != 0 {
		t.Fatalf("topic role counts = %+v", topics)
	}

	all, err := read.LibraryExcerpts(ctx, LibraryExcerptFilter{})
	if err != nil {
		t.Fatalf("library excerpts: %v", err)
	}
	if all.Total != 2 || len(all.Items) != 2 || all.PageSize != libraryExcerptPage {
		t.Fatalf("excerpt page = %+v, want the retained version excluded", all)
	}
	review, err := read.LibraryExcerpts(ctx, LibraryExcerptFilter{
		Book: "ahss", Topic: "linear-regression", Role: "exercise", Review: true,
	})
	if err != nil {
		t.Fatalf("filtered excerpts: %v", err)
	}
	if review.Total != 1 || len(review.Items) != 1 || review.Items[0].ID != "e_review_v2" {
		t.Fatalf("review filter = %+v", review)
	}
	if review.Items[0].ProposedTopic != "regression-exercises" ||
		len(review.Items[0].ReviewReasons) != 1 {
		t.Fatalf("review locators missing: %+v", review.Items[0])
	}

	detail, err := read.LibraryExcerpt(ctx, "e_intro_v2")
	if err != nil {
		t.Fatalf("excerpt detail: %v", err)
	}
	if detail.Book.SHA256 != "book-sha" || detail.Book.Version != 2 ||
		detail.Book.ParserFingerprint != "odl-fp" ||
		detail.Book.ChunkerVersion != "v10" || detail.Evidence != "quoted evidence" {
		t.Fatalf("excerpt locators = %+v", detail)
	}
	if len(detail.Chunks) != 1 || detail.Chunks[0].ID != "c_intro_v2" ||
		!detail.Chunks[0].Searchable || detail.Chunks[0].Reference ||
		len(detail.Chunks[0].ConfidenceReasons) != 1 {
		t.Fatalf("excerpt chunks = %+v", detail.Chunks)
	}
	if len(detail.Figures) != 1 || detail.Figures[0].CapturePath != "captures/fig_1.png" ||
		len(detail.Figures[0].BBox) != 4 {
		t.Fatalf("excerpt figures = %+v", detail.Figures)
	}
	for _, missing := range []string{"missing", "e_intro_v1"} {
		if _, err := read.LibraryExcerpt(ctx, missing); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("excerpt %q error = %v, want not found", missing, err)
		}
	}

	runs, err := read.LibraryModelRuns(ctx)
	if err != nil {
		t.Fatalf("model runs: %v", err)
	}
	if len(runs) != 1 || runs[0].BookID != "ahss" || runs[0].Version != 2 ||
		runs[0].ResultsPath != "runs/tagging.json" {
		t.Fatalf("model runs = %+v, want only the current version's receipts", runs)
	}

	export, err := read.LibraryExport(ctx, "ahss", 0)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if export.Truncated || export.Version != 2 || len(export.Excerpts) != 2 ||
		len(export.Figures) != 1 {
		t.Fatalf("export = %+v", export)
	}
	if len(export.Excerpts[0].Chunks) != 1 || export.Excerpts[0].Chunks[0].Text == "" {
		t.Fatalf("export chunks = %+v", export.Excerpts[0])
	}
	retained, err := read.LibraryExport(ctx, "ahss", 1)
	if err != nil {
		t.Fatalf("retained export: %v", err)
	}
	if retained.Version != 1 || len(retained.Excerpts) != 1 ||
		retained.Excerpts[0].ID != "e_intro_v1" ||
		retained.Book.Descriptor != "older stats" {
		t.Fatalf("retained export = %+v, want the retained version readable", retained)
	}
	// The book block describes what the export contains, not what is live.
	if retained.Book.Version != 1 || retained.Book.ContentID != "ahss_v1" {
		t.Fatalf("retained export book = version %d content %q, want the exported version's",
			retained.Book.Version, retained.Book.ContentID)
	}
	if _, err := read.LibraryExport(ctx, "missing", 0); !errors.Is(
		err, store.ErrNotFound,
	) {
		t.Fatalf("unknown book error = %v, want not found", err)
	}
	if _, err := read.LibraryExport(ctx, "ahss", 9); !errors.Is(
		err, store.ErrNotFound,
	) {
		t.Fatalf("unknown version error = %v, want not found", err)
	}
}

func TestLibraryExcerptFilterRejectsUnknownRoleAndPage(t *testing.T) {
	read := &ReadStore{}
	ctx := context.Background()
	if _, err := read.LibraryExcerpts(ctx, LibraryExcerptFilter{
		Role: "lecture",
	}); !IsValidation(err) {
		t.Fatalf("unknown role error = %v, want validation", err)
	}
	if _, err := read.LibraryExcerpts(ctx, LibraryExcerptFilter{
		Page: 1001,
	}); !IsValidation(err) {
		t.Fatalf("oversized page error = %v, want validation", err)
	}
	if _, err := read.LibraryExport(
		ctx, strings.Repeat("b", libraryIDMaxLen+1), 0,
	); !IsValidation(err) {
		t.Fatalf("oversized book error = %v, want validation", err)
	}
	if _, err := read.LibraryExport(ctx, "ahss", libraryMaxBookVersion+1); !IsValidation(err) {
		t.Fatalf("oversized version error = %v, want validation", err)
	}
}

func TestLibraryRoutesRefuseWithoutPermissionOrDatabase(t *testing.T) {
	handler := NewHandler(&ReadStore{}, nil, nil, HandlerConfig{})
	viewer := httptest.NewRequest(http.MethodGet, "/api/ops/library", nil)
	viewer = viewer.WithContext(context.WithValue(
		viewer.Context(), principalContextKey{},
		Principal{UserID: "viewer", Role: RoleViewer},
	))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, viewer)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}

	operator := httptest.NewRequest(http.MethodGet, "/api/ops/library", nil)
	operator = operator.WithContext(context.WithValue(
		operator.Context(), principalContextKey{},
		Principal{UserID: "admin", Role: RoleAdmin, Permissions: []string{PermReadAll}},
	))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, operator)
	if response.Code != http.StatusNotFound ||
		!strings.Contains(response.Body.String(), "library_unconfigured") {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

// The library lives on another host, so an unreachable one is a Library-only
// failure: the pool opens on first use and the routes answer 503.
func TestUnreachableLibraryFailsOnlyItsOwnRoutes(t *testing.T) {
	read := &ReadStore{}
	read.SetLibraryDSN("postgres://capy:capy@127.0.0.1:1/library?connect_timeout=1")
	if !read.LibraryConfigured() {
		t.Fatal("a configured library reports configured before it is reached")
	}
	t.Cleanup(read.CloseLibrary)
	if _, err := read.LibraryOverview(t.Context()); !errors.Is(err, ErrLibraryUnavailable) {
		t.Fatalf("overview error = %v, want the unavailable sentinel", err)
	}
	if _, err := read.LibraryBooks(t.Context()); !errors.Is(err, ErrLibraryUnavailable) {
		t.Fatalf("books error = %v, want the unavailable sentinel", err)
	}

	handler := NewHandler(read, nil, nil, HandlerConfig{})
	request := httptest.NewRequest(http.MethodGet, "/api/ops/library", nil)
	request = request.WithContext(context.WithValue(
		request.Context(), principalContextKey{},
		Principal{UserID: "admin", Role: RoleAdmin, Permissions: []string{PermReadAll}},
	))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable ||
		!strings.Contains(response.Body.String(), "library_unavailable") {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}

func TestLibraryExportCarriesItsDigest(t *testing.T) {
	read := &ReadStore{}
	read.SetLibraryPool(libraryTestPool(t))
	handler := NewHandler(read, nil, nil, HandlerConfig{})
	operator := func(path string) *http.Request {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		return request.WithContext(context.WithValue(
			request.Context(), principalContextKey{},
			Principal{UserID: "admin", Role: RoleAdmin, Permissions: []string{PermReadAll}},
		))
	}
	overview := httptest.NewRecorder()
	handler.ServeHTTP(overview, operator("/api/ops/library"))
	if overview.Code != http.StatusOK ||
		!strings.Contains(overview.Body.String(), `"books":1`) {
		t.Fatalf("overview status = %d body = %s", overview.Code, overview.Body.String())
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, operator("/api/ops/library/export/ahss?version=1"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	digest := response.Header().Get("X-Capy-Export-Sha256")
	if len(digest) != 64 {
		t.Fatalf("export digest = %q", digest)
	}
	var export LibraryExport
	if err := json.Unmarshal(response.Body.Bytes(), &export); err != nil {
		t.Fatal(err)
	}
	if export.Book.ID != "ahss" || export.Version != 1 || len(export.Excerpts) != 1 {
		t.Fatalf("export body = %+v", export)
	}
	if got := response.Header().Get("Content-Disposition"); !strings.Contains(
		got, "library-ahss-v1.json",
	) {
		t.Fatalf("Content-Disposition = %q", got)
	}
	bad := httptest.NewRecorder()
	handler.ServeHTTP(bad, operator("/api/ops/library/export/ahss?version=0"))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("version=0 status = %d body = %s", bad.Code, bad.Body.String())
	}
}
