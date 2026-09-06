FROM oven/bun:1.3.14 AS bun
FROM rust:1.98-bookworm AS office
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends binaryen && rm -rf /var/lib/apt/lists/*
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
