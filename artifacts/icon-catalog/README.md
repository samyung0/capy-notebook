# Curated icon catalog

The approved September 14, 2026 selection contains 87 static SVGs: 12 Slice,
12 Sprouts, 16 Critters, 24 Avataaars, 12 Notionists and 11 Waves.

- `src/lib/icon-catalog.json` is the picker inventory; `public/icons/` holds the shipped artwork and notices.
- `src/lib/icon-credits.json` supplies the Credits page's authors, sources and licenses.
- `manifest.json` preserves generation recipes and edits; `id-mapping.json` maps the review gallery's old IDs to the final IDs.

Final IDs are persisted by users and workspaces. Keep them stable when adding
future selections. The application serves SVGs directly and has no DiceBear
runtime dependency. Preserve the artwork notices and generator license.
