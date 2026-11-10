FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY ops/package.json ops/package.json
RUN pnpm install --frozen-lockfile --filter @capy-notebook/ops...
COPY ops ops
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_SENTRY_DSN
ARG VITE_APP_ENV
ARG VITE_RELEASE_SHA
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_APP_ENV=$VITE_APP_ENV
ENV VITE_RELEASE_SHA=$VITE_RELEASE_SHA
RUN pnpm --filter @capy-notebook/ops build

FROM golang:1.26.10-alpine3.24@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696 AS backend
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server .
RUN CGO_ENABLED=0 go build -trimpath -o /out/ops ./cmd/ops

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
# The server names Clerk's frontend host in its content security policy from
# this key (server/internal/ops/config.go), the one the bundle was built with.
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
WORKDIR /app
COPY --from=backend /out/ops /app/ops
COPY --from=web /src/ops/dist /app/static
USER app
EXPOSE 8082
ENTRYPOINT ["/app/ops"]
