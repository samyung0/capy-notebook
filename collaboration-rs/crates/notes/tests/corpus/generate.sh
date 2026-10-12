#!/usr/bin/env bash
# Regenerates the parity corpus from the Node collaboration server.
#   generate.sh <checkout> [families]
# <checkout>: a main checkout from before the Rust cutover removed the Node
# server (its collaboration/src is the oracle: edits, inspect, children and
# commands last regenerated on 0dad0d1c, markdown on 81637908 (agent markdown
# read without MDX, library figures), the other families on e2270ccc),
# with node_modules and collaboration/node_modules installed and
# collaboration/dist/markdown.bundle.mjs built (scripts/build-markdown.mjs).
# families: comma list, default all.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
checkout="$(cd "$1" && pwd)"
src="$checkout/collaboration/src"
cp "$here/generate.ts" "$src/zz-corpus.ts"
cat > "$checkout/collaboration/tsconfig.corpus.json" <<'JSON'
{
  "compilerOptions": {
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "target": "ES2023",
    "baseUrl": "..",
    "paths": {
      "@/i18n": ["./collaboration/scripts/i18n-stub.mjs"],
      "@/*": ["./src/*"]
    }
  }
}
JSON
trap 'rm -f "$src/zz-corpus.ts" "$checkout/collaboration/tsconfig.corpus.json"' EXIT
register="$(cd "$here" && node -p "require('node:url').pathToFileURL(require('node:path').resolve('raw-register.mjs')).href")"
cd "$checkout/collaboration"
CORPUS_OUT="$here" CORPUS_FAMILIES="${2:-projection,ops,multi,bootstrap,validation,edits,children,commands,inspect,markdown}" \
  NODE_OPTIONS="--max-old-space-size=8192 --import=$register" node_modules/.bin/tsx --tsconfig tsconfig.corpus.json src/zz-corpus.ts
