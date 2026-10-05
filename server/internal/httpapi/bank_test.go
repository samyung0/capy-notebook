package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/bankmigrations"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

type bankAssetSink struct{ count int }

func (s *bankAssetSink) PutObject(_ context.Context, _ string, r io.Reader, _, _ string) error {
	s.count++
	_, err := io.Copy(io.Discard, r)
	return err
}

// openTestBank creates a migrated bank database beside the test database with
// exam e, subject s and topic t, dropped when the test ends.
func openTestBank(t *testing.T, st *store.Store, dsn string) (string, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	db := fmt.Sprintf("bank_http_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, "CREATE DATABASE "+pgx.Identifier{db}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(dsn)
	parsed.Path = "/" + db
	bankDSN := parsed.String()
	pool, err := pgxpool.New(ctx, bankDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = st.Pool().Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{db}.Sanitize()+" WITH (FORCE)")
	})
	if err := store.MigrateFS(ctx, pool, bankmigrations.FS); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO exams VALUES('e','Exam',1);INSERT INTO subjects VALUES('s','e','Subject',1);INSERT INTO topics VALUES('t','s','Topic',1)`); err != nil {
		t.Fatal(err)
	}
	return bankDSN, pool
}

func TestBankHTTPPermissionsAssetsAndComments(t *testing.T) {
	ctx := context.Background()
	dsn := testdb.URL(t)
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	user := fmt.Sprintf("bank_editor_%d", time.Now().UnixNano())
	learner := user + "_learner"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users(id,name,email)VALUES($1,'Bank Editor','bank@example.test'),($2,'Learner','learner@example.test')`, user, learner); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = st.Pool().Exec(ctx, `DELETE FROM users WHERE id=ANY($1)`, []string{user, learner}) }()
	if _, err := st.Pool().Exec(ctx, `INSERT INTO bank_editors(user_id)VALUES($1)`, user); err != nil {
		t.Fatal(err)
	}
	bankDSN, pool := openTestBank(t, st, dsn)
	q := `{"id":"q","stem":[{"type":"text","text":"Stem"}],"parts":[{"id":"p","blocks":[{"type":"text","text":"Answer this"}],"answer":{"type":"open","accepted":["secret-answer"],"hints":[]},"marks":1,"markscheme":[{"text":"secret-scheme","marks":1}],"solution":[{"type":"text","text":"secret-solution"}]}],"layout":"paper","labels":"letters"}`
	if _, err := pool.Exec(ctx, `INSERT INTO questions(id,topic_id,position,content,run)VALUES('q','t',1,$1,'test')`, q); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO questions(id,topic_id,position,content,run)VALUES('q2','t',2,$1,'test')`, strings.Replace(q, `"id":"q"`, `"id":"q2"`, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE library_books(id text,title text,authors jsonb,edition text,license text,license_url text,source_url text);
 CREATE TABLE library_book_versions(book_id text,version int,content_id text);
 CREATE TABLE library_excerpts(id text,book_id text,content_id text);
 INSERT INTO library_books VALUES('book','Source book','["Author"]','Edition','CC BY-SA 4.0','https://creativecommons.org/licenses/by-sa/4.0/','https://source.example/book');
 INSERT INTO library_book_versions VALUES('book',1,'old'),('book',2,'new');
 INSERT INTO library_excerpts VALUES('excerpt','book','old');
 UPDATE questions SET sources='[{"kind":"library","excerptId":"excerpt","bookId":"book","version":1}]' WHERE id='q';
 UPDATE questions SET sources='[{"kind":"web","url":"https://open.example/essay","title":"An essay","authors":["Writer"],"license":"CC BY 4.0","retrievedAt":"2026-10-02"}]' WHERE id='q2'`); err != nil {
		t.Fatal(err)
	}
	bankStore := bank.New(bankDSN, bankDSN, "https://bank.example/assets", bankDSN)
	defer bankStore.Close()
	sink := &bankAssetSink{}
	sender := mail.NewRecordingSender(&mail.LogSender{})
	config := httpapi.Config{AuthDisabled: true, DevUserID: user, Bank: bankStore, BankAssets: sink, BankAssetsURL: "https://bank.example/assets", BankCommentEmail: "review@example.test", MailSender: sender, AppURL: "https://app.example"}
	handler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", config)
	request := func(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	get := request(handler, "GET", "/api/bank/questions/q", "")
	if get.Code != 200 || !strings.Contains(get.Body.String(), "secret-answer") {
		t.Fatalf("editor get: %d %s", get.Code, get.Body.String())
	}
	var credited bank.Detail
	if err := json.Unmarshal(get.Body.Bytes(), &credited); err != nil {
		t.Fatal(err)
	}
	if credited.Provenance == nil || credited.Provenance.License != "CC BY-SA 4.0" || len(credited.Provenance.Books) != 1 || credited.Provenance.Books[0].Version != 1 {
		t.Fatalf("historical attribution: %#v", credited.Provenance)
	}
	learnerConfig := config
	learnerConfig.DevUserID = learner
	learnerHandler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", learnerConfig)
	get = request(learnerHandler, "GET", "/api/bank/questions/q", "")
	if get.Code != 200 || strings.Contains(get.Body.String(), "secret-") {
		t.Fatalf("learner leak: %d %s", get.Code, get.Body.String())
	}
	batch := request(handler, "GET", "/api/bank/questions?ids=q2,q", "")
	var page struct{ Questions []bank.Detail }
	if err := json.Unmarshal(batch.Body.Bytes(), &page); err != nil || batch.Code != 200 {
		t.Fatalf("batch: %d %s", batch.Code, batch.Body.String())
	}
	if web := page.Questions[0].Provenance; web == nil || len(web.Web) != 1 || web.Web[0].URL != "https://open.example/essay" || len(web.Books) != 0 || web.License != "" {
		t.Fatalf("web attribution: %#v", web)
	}
	if len(page.Questions) != 2 || page.Questions[0].Question["id"] != "q2" || page.Questions[1].Provenance == nil || !strings.Contains(batch.Body.String(), "secret-answer") {
		t.Fatalf("batch order or attribution: %s", batch.Body.String())
	}
	if batch = request(learnerHandler, "GET", "/api/bank/questions?ids=q,q2", ""); batch.Code != 200 || strings.Contains(batch.Body.String(), "secret-") {
		t.Fatalf("learner batch leak: %d %s", batch.Code, batch.Body.String())
	}
	if batch = request(handler, "GET", "/api/bank/questions?ids=q,missing", ""); batch.Code != 404 {
		t.Fatalf("batch with unknown id: %d", batch.Code)
	}
	denied := request(learnerHandler, "PUT", "/api/bank/questions/q/review", `{"reviewed":true}`)
	if denied.Code != 404 {
		t.Fatalf("learner write: %d", denied.Code)
	}
	configRead := config
	readOnly := bank.New(bankDSN, "", "https://bank.example/assets", bankDSN)
	defer readOnly.Close()
	configRead.Bank = readOnly
	roHandler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", configRead)
	denied = request(roHandler, "PUT", "/api/bank/questions/q/review", `{"reviewed":true}`)
	if denied.Code != 404 || !strings.Contains(denied.Body.String(), "bank_read_only") {
		t.Fatalf("read-only write: %d %s", denied.Code, denied.Body.String())
	}
	reviewed := request(handler, "PUT", "/api/bank/questions/q/review", `{"reviewed":true}`)
	if reviewed.Code != 200 {
		t.Fatalf("review: %d %s", reviewed.Code, reviewed.Body.String())
	}
	var detail bank.Detail
	if err := json.Unmarshal(reviewed.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	detail.Question["stem"] = []any{map[string]any{"type": "text", "text": "Edited"}}
	payload, _ := json.Marshal(map[string]any{"question": detail.Question, "updatedAt": detail.UpdatedAt})
	saved := request(handler, "PUT", "/api/bank/questions/q", string(payload))
	if saved.Code != 200 || !strings.Contains(saved.Body.String(), `"reviewerName":"Bank Editor"`) {
		t.Fatalf("save: %d %s", saved.Code, saved.Body.String())
	}
	stale := request(handler, "PUT", "/api/bank/questions/q", string(payload))
	if stale.Code != 409 {
		t.Fatalf("stale: %d %s", stale.Code, stale.Body.String())
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, _ := form.CreateFormFile("file", "graph.svg")
	_, _ = file.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>`))
	_ = form.Close()
	uploadBytes := append([]byte(nil), body.Bytes()...)
	upload := httptest.NewRequest("POST", "/api/bank/assets", &body)
	upload.Header.Set("Content-Type", form.FormDataContentType())
	uploaded := httptest.NewRecorder()
	handler.ServeHTTP(uploaded, upload)
	if uploaded.Code != 201 || sink.count != 1 || !strings.Contains(uploaded.Body.String(), "https://bank.example/assets/") {
		t.Fatalf("upload: %d %s", uploaded.Code, uploaded.Body.String())
	}
	var asset struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(uploaded.Body.Bytes(), &asset); err != nil {
		t.Fatal(err)
	}
	detail.Question["stem"] = []any{map[string]any{"type": "image", "image": map[string]any{"url": asset.URL}, "width": float64(10), "height": float64(10), "description": "Uploaded figure"}}
	if err := bankStore.Validate(detail.Question); err != nil {
		t.Fatalf("uploaded URL rejected by bank validator: %v", err)
	}
	blockedUpload := httptest.NewRequest("POST", "/api/bank/assets", bytes.NewReader(uploadBytes))
	blockedUpload.Header.Set("Content-Type", form.FormDataContentType())
	blockedResult := httptest.NewRecorder()
	learnerHandler.ServeHTTP(blockedResult, blockedUpload)
	if blockedResult.Code != 404 || sink.count != 1 {
		t.Fatalf("learner upload: %d", blockedResult.Code)
	}
	comment := request(handler, "POST", "/api/bank/questions/q/comments", `{"text":"Please check the answer."}`)
	if comment.Code != 204 || len(sender.Captured()) != 1 {
		t.Fatalf("comment: %d %s", comment.Code, comment.Body.String())
	}
	if !strings.Contains(sender.Captured()[0].Text, "https://app.example/bank/t/q?mode=edit") {
		t.Fatal("comment link missing")
	}
	configNoMail := config
	configNoMail.BankCommentEmail = ""
	noMail := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", configNoMail)
	comment = request(noMail, "POST", "/api/bank/questions/q/comments", `{"text":"Disabled"}`)
	if comment.Code != 404 || len(sender.Captured()) != 1 {
		t.Fatalf("disabled comment: %d", comment.Code)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE users SET suspended_at=now(),suspended_reason='test suspension' WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	denied = request(handler, "PUT", "/api/bank/questions/q/review", `{"reviewed":false}`)
	if denied.Code != 403 {
		t.Fatalf("suspended editor: %d %s", denied.Code, denied.Body.String())
	}
}
