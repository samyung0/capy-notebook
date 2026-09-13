-- Per-chunk extraction confidence, computed at ingest from the source PDF's
-- text layer (pipeline/retrieval/confidence.py) and shown on passage headers
-- below the prompt threshold. Null for sources without a page model. Existing
-- chunks are re-scored on their next parse: the parser switch changed
-- pipeline_identity, so every existing source re-parses anyway.
ALTER TABLE rag_chunks
  ADD COLUMN IF NOT EXISTS confidence real,
  ADD COLUMN IF NOT EXISTS confidence_reasons text[] NOT NULL DEFAULT '{}';
