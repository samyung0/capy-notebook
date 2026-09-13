# odl-ccl-feedback-p1

Page 1 of lab source `ccl-feedback` (`/opt/capy-odl-third-pass-20260909/refined-final-r1/ccl-feedback`
on the ingest host), extracted with PyMuPDF `select([0])`. The page embeds a
Type1 font whose `ToUnicode` map contradicts its explicit Latin encoding, so
the text layer decodes as CJK until `parser/odl/fonts.py` rebuilds the map
(`repaired_fonts: 1` in the lab run). The parser ships the repaired bytes as
the bundle's `parsed.pdf`; `tests/test_confidence.py` scores these lab chunks
against both copies.

- `source.pdf` — the unrepaired page (sha256 `dc62c57600b5fc22e841ed9de412f26dabfc69f0500f883401ba7845b8334070`).
- `chunks.json` — the lab's four chunks on that page.
