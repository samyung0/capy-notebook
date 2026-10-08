// Local owner-only bank migration, exam catalogs, insert-only publication and status.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/aws/smithy-go"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/bankmigrations"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"golang.org/x/sync/errgroup"
)

type node struct {
	ID                string `json:"id"`
	Label             string `json:"label"`
	Position          int    `json:"position"`
	SyllabusReference string `json:"syllabus_reference"`
}
type entry struct {
	Content map[string]any  `json:"content"`
	Sources json.RawMessage `json:"sources"`
	SHA256  string          `json:"sha256"`
}
type publication struct {
	Syllabus struct {
		Exam    node `json:"exam"`
		Subject node `json:"subject"`
		Topic   node `json:"topic"`
	} `json:"syllabus"`
	Run       string  `json:"run"`
	Questions []entry `json:"questions"`
}

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func required(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}
func loadEnv() error {
	for _, p := range []string{".env.local", "../.env.local"} {
		data, e := os.ReadFile(p)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil {
			return e
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "#") {
				continue
			}
			k, v, ok := strings.Cut(line, "=")
			if ok && os.Getenv(strings.TrimSpace(k)) == "" {
				_ = os.Setenv(strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), "\"'"))
			}
		}
		return nil
	}
	return nil
}
func b2(prefix string) (*blob.B2, error) {
	values := map[string]string{}
	for _, k := range []string{"ENDPOINT", "REGION", "BUCKET", "KEY_ID", "APP_KEY"} {
		v, e := required(prefix + k)
		if e != nil {
			return nil, e
		}
		values[k] = v
	}
	return blob.NewB2(blob.B2Config{Endpoint: values["ENDPOINT"], Region: values["REGION"], Bucket: values["BUCKET"], KeyID: values["KEY_ID"], AppKey: values["APP_KEY"]})
}
func uploadOnce(ctx context.Context, b *blob.B2, key string, data []byte, contentType, cache string) error {
	_, err := b.Head(ctx, key)
	if err == nil {
		return nil
	}
	var api smithy.APIError
	if !errors.As(err, &api) || (api.ErrorCode() != "NotFound" && api.ErrorCode() != "NoSuchKey") {
		return errors.New("object existence check failed")
	}
	return b.PutObject(ctx, key, bytes.NewReader(data), contentType, cache)
}

func loadPublication(dir, base string) (publication, []byte, error) {
	var p publication
	raw, err := os.ReadFile(filepath.Join(dir, "publish.json"))
	if err != nil {
		return p, nil, err
	}
	if err = json.Unmarshal(raw, &p); err != nil {
		return p, nil, err
	}
	if p.Run == "" || len(p.Questions) == 0 {
		return p, nil, errors.New("empty publication")
	}
	for _, n := range []node{p.Syllabus.Exam, p.Syllabus.Subject, p.Syllabus.Topic} {
		if n.ID == "" || n.Label == "" || n.Position < 0 {
			return p, nil, errors.New("invalid syllabus record")
		}
	}
	if p.Syllabus.Topic.SyllabusReference == "" {
		return p, nil, errors.New("verified syllabus reference required")
	}
	all := make([]map[string]any, 0, len(p.Questions))
	for _, q := range p.Questions {
		id, ok := q.Content["id"].(string)
		if !ok || strings.ContainsAny(id, "/\\") {
			return p, nil, errors.New("invalid question id")
		}
		data, e := os.ReadFile(filepath.Join(dir, "questions", id+".json"))
		if e != nil || digest(data) != q.SHA256 {
			return p, nil, errors.New("publication content is stale")
		}
		var actual map[string]any
		if json.Unmarshal(data, &actual) != nil {
			return p, nil, errors.New("invalid question JSON")
		}
		a, _ := json.Marshal(actual)
		b, _ := json.Marshal(q.Content)
		if !bytes.Equal(a, b) {
			return p, nil, errors.New("publication differs from question file")
		}
		if _, err := parseSources(q.Sources); err != nil {
			return p, nil, err
		}
		all = append(all, q.Content)
	}
	if err = questions.ValidateAll(all, questions.Policy{Bank: true, BankAssetsURL: base}); err != nil {
		return p, nil, err
	}
	var comparisons []struct {
		ID     string
		SHA256 string
		Agreed bool
	}
	var copies []struct {
		ID       string
		SHA256   string
		Overlaps map[string]json.RawMessage
	}
	var renders map[string]string
	for name, target := range map[string]any{"compare.json": &comparisons, "copycheck.json": &copies, "render/manifest.json": &renders} {
		data, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			return p, nil, e
		}
		if e = json.Unmarshal(data, target); e != nil {
			return p, nil, e
		}
	}
	for _, q := range p.Questions {
		id := q.Content["id"].(string)
		compared, copied := false, false
		for _, row := range comparisons {
			if row.ID == id && row.SHA256 == q.SHA256 && row.Agreed {
				compared = true
			}
		}
		for _, row := range copies {
			if row.ID == id && row.SHA256 == q.SHA256 && len(row.Overlaps) == 0 {
				copied = true
			}
		}
		if !compared || !copied || renders[id] != q.SHA256 {
			return p, nil, errors.New("publication evidence is missing, failed or stale")
		}
	}
	return p, raw, nil
}

func parseSources(raw json.RawMessage) ([]bank.Source, error) {
	var sources []bank.Source
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&sources); err != nil || sources == nil || len(sources) > 1024 {
		return nil, errors.New("sources must be an explicit array of at most 1024 references")
	}
	for _, source := range sources {
		if err := source.Check(); err != nil {
			return nil, err
		}
	}
	return sources, nil
}

func publish(ctx context.Context, pool *pgxpool.Pool, dir string) error {
	base, err := required("BANK_ASSETS_URL")
	if err != nil {
		return err
	}
	p, raw, err := loadPublication(dir, base)
	if err != nil {
		return err
	}
	library := bank.New("", "", base, os.Getenv("LIBRARY_DATABASE_URL"))
	defer library.Close()
	for _, question := range p.Questions {
		sources, e := parseSources(question.Sources)
		if e != nil {
			return e
		}
		if _, e = library.Provenance(ctx, sources); e != nil {
			return fmt.Errorf("question %s: source references could not be verified", question.Content["id"])
		}
	}
	public, err := b2("BANK_PUBLIC_B2_")
	if err != nil {
		return err
	}
	private, err := b2("BANK_PRIVATE_B2_")
	if err != nil {
		return err
	}
	// Assets have already been rendered locally. Verify their content-addressed names before upload.
	assets, err := filepath.Glob(filepath.Join(dir, "assets", "*"))
	if err != nil {
		return err
	}
	for _, path := range assets {
		data, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		kind, ext, e := bank.ValidateAsset(data)
		if e != nil {
			return e
		}
		key := digest(data) + ext
		if filepath.Base(path) != key {
			return errors.New("asset filename must match its content hash")
		}
		if e = uploadOnce(ctx, public, key, data, kind, bank.ImmutableCache); e != nil {
			return e
		}
	}
	// Confirm every referenced asset exists; never insert dangling local placeholders.
	var inspect func(any) error
	inspect = func(value any) error {
		switch v := value.(type) {
		case map[string]any:
			for k, item := range v {
				if k == "url" {
					url, ok := item.(string)
					if !ok || !strings.HasPrefix(url, strings.TrimRight(base, "/")+"/") {
						return errors.New("asset outside configured bank URL")
					}
					if _, e := public.Head(ctx, strings.TrimPrefix(url, strings.TrimRight(base, "/")+"/")); e != nil {
						return errors.New("referenced public asset is unavailable")
					}
				}
				if e := inspect(item); e != nil {
					return e
				}
			}
		case []any:
			for _, item := range v {
				if e := inspect(item); e != nil {
					return e
				}
			}
		}
		return nil
	}
	for _, q := range p.Questions {
		if err = inspect(q.Content); err != nil {
			return err
		}
	}
	archive := []string{"references", "style.md", "receipts", "topic.json", "compare.json", "copycheck.json", "publish.json", "render"}
	uploads, uploadCtx := errgroup.WithContext(ctx)
	uploads.SetLimit(4)
	var processed atomic.Int64
	runPrefix := "runs/" + digest(raw) + "/"
	for _, name := range archive {
		path := filepath.Join(dir, name)
		if _, e := os.Stat(path); e != nil {
			err = fmt.Errorf("missing publication evidence %s", name)
			break
		}
		err = filepath.WalkDir(path, func(path string, d fs.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if e := uploadCtx.Err(); e != nil {
				return e
			}
			if d.Type()&os.ModeSymlink != 0 {
				return errors.New("archive symlinks are forbidden")
			}
			if d.IsDir() {
				return nil
			}
			uploads.Go(func() error {
				if e := uploadCtx.Err(); e != nil {
					return e
				}
				data, e := os.ReadFile(path)
				if e != nil {
					return e
				}
				rel, e := filepath.Rel(dir, path)
				if e != nil {
					return e
				}
				kind := mime.TypeByExtension(filepath.Ext(path))
				if kind == "" {
					kind = "application/octet-stream"
				}
				key := runPrefix + digest(data) + "/" + filepath.ToSlash(rel)
				if e := uploadOnce(uploadCtx, private, key, data, kind, "private, max-age=31536000, immutable"); e != nil {
					return e
				}
				if count := processed.Add(1); count%50 == 0 {
					fmt.Fprintf(os.Stderr, "Archived %d files\n", count)
				}
				return nil
			})
			return nil
		})
		if err != nil {
			break
		}
	}
	if uploadErr := uploads.Wait(); uploadErr != nil {
		return uploadErr
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Archived %d files; inserting questions\n", processed.Load())
	return insertPublication(ctx, pool, p)
}

func insertPublication(ctx context.Context, pool *pgxpool.Pool, p publication) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// One publication at a time prevents collisions in per-topic positions.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(72398423)"); err != nil {
		return err
	}
	e, s, t := p.Syllabus.Exam, p.Syllabus.Subject, p.Syllabus.Topic
	// Exams come only from the catalogs (bank exams), which own their covers.
	var known bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM exams WHERE id=$1)", e.ID).Scan(&known); err != nil {
		return err
	}
	if !known {
		return fmt.Errorf("exam %q is not in the bank; run bank exams first", e.ID)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO subjects(id,exam_id,label,position) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET label=excluded.label,position=excluded.position WHERE subjects.exam_id=excluded.exam_id", s.ID, e.ID, s.Label, s.Position); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO topics(id,subject_id,label,position) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET label=excluded.label,position=excluded.position WHERE topics.subject_id=excluded.subject_id", t.ID, s.ID, t.Label, t.Position); err != nil {
		return err
	}
	var parent string
	if err = tx.QueryRow(ctx, "SELECT subject_id FROM topics WHERE id=$1", t.ID).Scan(&parent); err != nil || parent != s.ID {
		return errors.New("topic belongs to another subject")
	}
	if err = tx.QueryRow(ctx, "SELECT exam_id FROM subjects WHERE id=$1", s.ID).Scan(&parent); err != nil || parent != e.ID {
		return errors.New("subject belongs to another exam")
	}
	var position int
	if err = tx.QueryRow(ctx, "SELECT COALESCE(MAX(position),0)+1 FROM questions WHERE topic_id=$1", t.ID).Scan(&position); err != nil {
		return err
	}
	inserted, skipped := []string{}, []string{}
	for _, q := range p.Questions {
		id := q.Content["id"].(string)
		content, _ := json.Marshal(q.Content)
		tag, e := tx.Exec(ctx, "INSERT INTO questions(id,topic_id,position,content,sources,run) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING", id, t.ID, position, content, q.Sources, p.Run)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 1 {
			inserted = append(inserted, id)
			position++
		} else {
			skipped = append(skipped, id)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"inserted": inserted, "skipped": skipped})
}

// examRecord is a syllabus catalog's exam (lab/questions/syllabi).
type examRecord struct {
	ID        string      `json:"id"`
	Label     string      `json:"label"`
	FullLabel string      `json:"full_label"`
	Position  int         `json:"position"`
	Cover     *bank.Cover `json:"cover"`
}

func loadExams(dir string) ([]examRecord, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	exams := []examRecord{}
	for _, path := range paths {
		raw, e := os.ReadFile(path)
		if e != nil {
			return nil, e
		}
		var catalog struct {
			Exam examRecord `json:"exam"`
		}
		if e = json.Unmarshal(raw, &catalog); e != nil {
			return nil, fmt.Errorf("%s: %w", path, e)
		}
		x := catalog.Exam
		if x.ID == "" || x.Label == "" || x.FullLabel == "" || x.Position < 1 {
			return nil, fmt.Errorf("%s: exam needs id, label, full_label and a position from 1", path)
		}
		if x.Cover != nil {
			if e = x.Cover.Check(); e != nil {
				return nil, fmt.Errorf("%s: %w", path, e)
			}
		}
		exams = append(exams, x)
	}
	if len(exams) == 0 {
		return nil, errors.New("no syllabus catalogs")
	}
	return exams, nil
}

// upsertExams writes every catalog exam; publication only files topics under them.
// A catalog without a cover keeps the stored one, and a new exam without one
// gets bank.DefaultCover.
func upsertExams(ctx context.Context, pool *pgxpool.Pool, exams []examRecord) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ids := []string{}
	for _, x := range exams {
		if _, err = tx.Exec(ctx, `INSERT INTO exams(id,label,full_label,position,cover) VALUES($1,$2,$3,$4,COALESCE($5::jsonb,$6::jsonb))
 ON CONFLICT(id) DO UPDATE SET label=excluded.label,full_label=excluded.full_label,position=excluded.position,cover=COALESCE($5::jsonb,exams.cover)`,
			x.ID, x.Label, x.FullLabel, x.Position, x.Cover, bank.DefaultCover(x.ID)); err != nil {
			return err
		}
		ids = append(ids, x.ID)
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"exams": ids})
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: bank migrate | exams <syllabi-dir> | validate <topic-dir> | publish <topic-dir> | status")
	}
	if err := loadEnv(); err != nil {
		return err
	}
	if os.Args[1] == "validate" {
		if len(os.Args) != 3 {
			return errors.New("validate requires topic directory")
		}
		return validateQuestions(os.Args[2], os.Getenv("BANK_ASSETS_URL"))
	}
	url, err := required("BANK_OWNER_DATABASE_URL")
	if err != nil {
		return err
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return errors.New("invalid BANK_OWNER_DATABASE_URL")
	}
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return errors.New("owner database connection failed")
	}
	defer pool.Close()
	switch os.Args[1] {
	case "migrate":
		return store.MigrateFS(ctx, pool, bankmigrations.FS)
	case "exams":
		if len(os.Args) != 3 {
			return errors.New("exams requires the syllabi directory")
		}
		exams, e := loadExams(os.Args[2])
		if e != nil {
			return e
		}
		return upsertExams(ctx, pool, exams)
	case "publish":
		if len(os.Args) != 3 {
			return errors.New("publish requires topic directory")
		}
		return publish(ctx, pool, os.Args[2])
	case "status":
		rows, e := pool.Query(ctx, "SELECT t.id,t.label,count(q.id),count(q.reviewed_at),max(q.created_at) FROM topics t LEFT JOIN questions q ON q.topic_id=t.id GROUP BY t.id,t.label ORDER BY t.id")
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			values, e := rows.Values()
			if e != nil {
				return e
			}
			if e = json.NewEncoder(os.Stdout).Encode(values); e != nil {
				return e
			}
		}
		return rows.Err()
	default:
		return errors.New("unknown command")
	}
}

// Validate rendered questions before spending calls on blind solving; no remote access.
func validateQuestions(dir, base string) error {
	paths, err := filepath.Glob(filepath.Join(dir, "questions", "*.json"))
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return errors.New("no questions to validate")
	}
	all := make([]map[string]any, 0, len(paths))
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var q map[string]any
		if err = json.Unmarshal(raw, &q); err != nil {
			return fmt.Errorf("%s: invalid question JSON", filepath.Base(path))
		}
		if err = questions.Validate(q, questions.Policy{Bank: true, BankAssetsURL: base}); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
		all = append(all, q)
	}
	if err = questions.ValidateAll(all, questions.Policy{Bank: true, BankAssetsURL: base}); err != nil {
		return err
	}
	fmt.Printf("Validated %d bank questions; no uploads or database writes.\n", len(all))
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
