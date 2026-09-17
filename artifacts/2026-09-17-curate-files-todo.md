# Todo: curate mode creating files, not only materials

Date: 2026-09-17. Owner: Epo. Not scheduled. Written so the pieces already in
place are not rebuilt when this starts.

## Already in place

- `files.provenance jsonb` (migration 0021) with the same record and licence rule
  as materials; returned on every file response; copied by the workspace clone.
- Licence family rule, merged-record bounds and the "undo keeps credit" rule apply
  to any provenance record, whatever row carries it.
- The ledger, `todo` marking and read-before-write enforcement live in
  `pipeline/pipeline/retrieval/tools.py` `curate_write`, keyed on "material target";
  a file target needs the same call with the file id.
- `edit_document` already edits source files (markdown, docx through BetterOffice);
  in curate mode it takes neither todo nor excerpt ids for a source file.

## What is missing

1. **A create tool.** `create_file {kind, name, content, scope?, excerpt_ids, todo}`
   in the Go contract (bump the version; `Retention: full`; `RequiredOperations:
   file.create` or the existing source-upload operation, decide which). Go creates
   the blob through the upload path (quota gate on bytes, `user_storage` deltas,
   the ingest job so the file is searchable), writes `files.provenance`, returns
   the receipt the pipeline turns into a ledger material entry. Supported kinds at
   first: markdown and docx; PDFs are exports, not authored files.
2. **Curate edits on a curated file.** `edit_document` on a `source_file` whose
   `files.provenance` is non-null should follow the material rules (todo, excerpt
   ids, provenance merge), so the carve-out becomes "a file without provenance",
   not "any source file". The merge on the file path needs the same Go handler
   the material edit uses, and the source authority needs the same in-transaction
   update the collaboration authority does for materials.
3. **Attribution inside the file.** A material's footer renders outside the
   editable document. A file leaves the app (download, export, share as a file),
   so the attribution has to travel in the bytes: a closing section for markdown,
   a final paragraph or footer for docx, with the "adapted from" line, one line per
   book and the licence line. Decide whether it is written once at creation and
   regenerated on every provenance change, and whether the user may delete it
   (the licence says no; the material design says outside the editable body).
4. **Downloads and shares.** Public file links and exports must carry the same
   footer; the public workspace summary stays the only exception.
5. **Playground.** The local `create_material` stub has a `create_file` twin that
   writes the bytes under the run directory and records the ledger entry.
6. **Ops.** Nothing: the library side is unchanged.

## Tests to add when this lands

- Go: create refused without excerpt ids after library reads; provenance on the
  new file; quota gate on the bytes; clone copies it.
- Pipeline: `create_file` marks its todo; read-before-write against the ledger;
  edit on a curated file merges provenance.
- Frontend: the in-file footer survives a save; download carries it.
- UAT journeys: one curate journey (see the journey assessment in the fix-round-3
  report) once the suite can seed a library-backed environment.
