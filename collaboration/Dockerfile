FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY collaboration/package.json collaboration/tsconfig.json ./collaboration/
RUN pnpm install --frozen-lockfile --filter @evo-notes/collaboration...
RUN pnpm --filter @evo-notes/collaboration deploy --prod /output
COPY collaboration/src ./collaboration/src
RUN pnpm --filter @evo-notes/collaboration build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /output ./
COPY --from=build /workspace/collaboration/dist ./dist
USER node
EXPOSE 1234
CMD ["node", "dist/server.js"]
