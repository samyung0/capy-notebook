
CREATE EXTENSION IF NOT EXISTS vector;
-- Production-shaped index tables; one workspace row, 'library', carries the
-- embedding pin, and rag_file_contents points each book at its current content.
CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, embedding_provider_slug text NOT NULL, embedding_model_slug text NOT NULL, embedding_model_version int NOT NULL, embedding_dim int NOT NULL);
CREATE TABLE IF NOT EXISTS files (id text PRIMARY KEY, name text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(), trashed_at timestamptz);
CREATE TABLE IF NOT EXISTS rag_contents (id text PRIMARY KEY, status text NOT NULL);
CREATE TABLE IF NOT EXISTS rag_file_contents (file_id text PRIMARY KEY REFERENCES files, workspace_id text NOT NULL REFERENCES workspaces, content_id text NOT NULL REFERENCES rag_contents);
CREATE TABLE IF NOT EXISTS library_chunks (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces, content_id text NOT NULL REFERENCES rag_contents,
  chunk_idx int NOT NULL, section_path text NOT NULL, text text NOT NULL, indexed_text text NOT NULL,
  page_start int, page_end int, regions jsonb NOT NULL, lang text NOT NULL, confidence double precision,
  confidence_reasons text[] NOT NULL, search tsvector NOT NULL, searchable boolean NOT NULL,
  book_id text NOT NULL, excerpt_id text NOT NULL, reference boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS library_chunks_search_idx ON library_chunks USING gin(search);
CREATE INDEX IF NOT EXISTS library_chunks_content_idx ON library_chunks (content_id, chunk_idx);
CREATE INDEX IF NOT EXISTS library_chunks_excerpt_idx ON library_chunks (excerpt_id);
CREATE OR REPLACE VIEW rag_chunks AS SELECT id,workspace_id,content_id,chunk_idx,section_path,text,indexed_text,page_start,page_end,regions,lang,confidence,confidence_reasons,search FROM library_chunks WHERE searchable;
CREATE TABLE IF NOT EXISTS rag_chunk_vectors_2560 (chunk_id text PRIMARY KEY REFERENCES library_chunks, workspace_id text NOT NULL, embedding halfvec(2560) NOT NULL);
-- ponytail: exact vector scans, matching the pilot; add an HNSW index when the corpus outgrows them.
CREATE TABLE IF NOT EXISTS library_books (
  id text PRIMARY KEY, title text NOT NULL, authors jsonb NOT NULL,
  edition text NOT NULL, source_url text NOT NULL, download_url text NOT NULL, license text NOT NULL, license_url text NOT NULL,
  attribution text NOT NULL, sha256 text NOT NULL, bytes bigint NOT NULL, pages int NOT NULL, first_content_page int NOT NULL,
  -- The current version and the content it published; the parse and chunker
  -- identity of that content is a receipt on the version row.
  content_id text NOT NULL REFERENCES rag_contents, version int NOT NULL,
  rights_notes jsonb NOT NULL, figure_exclusions jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS library_book_versions (
  book_id text NOT NULL REFERENCES library_books, version int NOT NULL,
  content_id text NOT NULL REFERENCES rag_contents, published_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('current', 'retained', 'retired')),
  source_run text NOT NULL, corpus_identity text NOT NULL, parser_release text NOT NULL,
  parser_fingerprint text NOT NULL, chunker_version text NOT NULL,
  -- Written from this version's content, so a rollback restores them with it.
  descriptor text NOT NULL, summary text NOT NULL,
  -- books/<sha256>.pdf in the knowledge-base bucket; null until the object exists.
  object_key text, note text NOT NULL DEFAULT '',
  PRIMARY KEY (book_id, version)
);
-- The catalog is library-wide; a publish upserts the topics it uses.
CREATE TABLE IF NOT EXISTS library_topics (
  id text PRIMARY KEY, label text NOT NULL, aliases jsonb NOT NULL,
  scope text NOT NULL, source_sections text NOT NULL
);
CREATE TABLE IF NOT EXISTS library_excerpts (
  content_id text NOT NULL REFERENCES rag_contents, id text NOT NULL, book_id text NOT NULL, section_path text NOT NULL,
  chunk_ids text[] NOT NULL, pages int[] NOT NULL, regions jsonb NOT NULL, figure_ids text[] NOT NULL, text text NOT NULL,
  tag_status text NOT NULL CHECK (tag_status IN ('tagged', 'failed')),
  roles text[] NOT NULL, topic_ids text[] NOT NULL, confidence double precision, evidence text NOT NULL,
  evidence_verified boolean NOT NULL, synopsis text NOT NULL, proposed_topic text, review_reasons text[] NOT NULL,
  PRIMARY KEY (content_id, id)
);
CREATE INDEX IF NOT EXISTS library_excerpts_id_idx ON library_excerpts (id);
CREATE TABLE IF NOT EXISTS library_figures (
  content_id text NOT NULL REFERENCES rag_contents, id text NOT NULL, book_id text NOT NULL, page int NOT NULL,
  bbox int[] NOT NULL, caption_bbox int[], space text NOT NULL, geometry_kind text NOT NULL, block_index int NOT NULL,
  original_caption jsonb NOT NULL, original_footnote jsonb NOT NULL, section_path text NOT NULL, excluded boolean NOT NULL,
  exclusion_evidence jsonb NOT NULL, capture_path text, capture_pixel_size int[], PRIMARY KEY (content_id, id)
);
CREATE TABLE IF NOT EXISTS library_model_runs (
  book_id text NOT NULL, content_id text NOT NULL REFERENCES rag_contents, stage text NOT NULL,
  transport text NOT NULL, model text NOT NULL,
  attempts int NOT NULL, collection jsonb NOT NULL, usage jsonb NOT NULL, approximate_cost_usd double precision,
  request_start_utc text, request_end_utc text, results_path text NOT NULL, PRIMARY KEY (book_id, content_id, stage)
);
