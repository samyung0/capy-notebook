FROM oven/bun:1.3.14 AS bun
FROM rust:1.98-bookworm AS office
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY vendor/betteroffice/.github/actions/wasm-toolchain/action.yml /tmp/wasm-toolchain.yml
# The pinned BetterOffice checkout owns the optimizer version and checksum.
RUN <<'SH'
set -eu
if [ "$(uname -m)" != x86_64 ]; then
    echo 'BetterOffice pins an x86_64 Linux toolchain; build with --platform=linux/amd64.' >&2
    exit 1
fi
bun -e 'const {inputs} = Bun.YAML.parse(await Bun.file("/tmp/wasm-toolchain.yml").text()); console.log(inputs.binaryen.default, inputs.sha256.default)' > /tmp/binaryen-pin
read -r binaryen sha256 < /tmp/binaryen-pin
curl -fsSL -o /tmp/binaryen.tar.gz "https://github.com/WebAssembly/binaryen/releases/download/$binaryen/binaryen-$binaryen-x86_64-linux.tar.gz"
echo "$sha256  /tmp/binaryen.tar.gz" | sha256sum -c -
mkdir -p /opt/binaryen
tar -xzf /tmp/binaryen.tar.gz -C /opt/binaryen --strip-components=1
rm /tmp/binaryen.tar.gz /tmp/binaryen-pin /tmp/wasm-toolchain.yml
SH
ENV PATH="/opt/binaryen/bin:${PATH}"
RUN rustup target add wasm32-unknown-unknown
RUN cargo install wasm-pack --version 0.15.0 --locked
WORKDIR /office
COPY vendor/betteroffice ./
RUN bun install --frozen-lockfile
RUN bun scripts/build-office-wasm.ts

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY collaboration/package.json collaboration/tsconfig.json ./collaboration/
RUN pnpm install --frozen-lockfile --filter @capy-notebook/collaboration...
RUN pnpm --filter @capy-notebook/collaboration deploy --prod /output
COPY collaboration/src ./collaboration/src
RUN pnpm --filter @capy-notebook/collaboration build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /output ./
COPY --from=build /workspace/collaboration/dist ./dist
COPY --from=office /office/shared/office-checkpoint.mjs /vendor/betteroffice/shared/office-checkpoint.mjs
COPY --from=office /office/shared/office-runtime /vendor/betteroffice/shared/office-runtime
USER node
EXPOSE 1234
CMD ["node", "dist/server.js"]
