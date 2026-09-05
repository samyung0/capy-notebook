# Capy Notebook email editor

This is the standalone Maily frontend used to edit locale sources in
`emails/templates/`.

Run it from the repository root:

```bash
pnpm email:dev
```

Saving changes a JSON source file only. Run `pnpm email:build` afterward to
regenerate the Go HTML and plain-text templates embedded by the API.
