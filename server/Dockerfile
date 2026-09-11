# Build the gateway as a small static binary.
FROM golang:1.25-alpine AS build
WORKDIR /src
# Cache mounts keep compiled output across deploys even when the layer cache
# misses (Coolify ARG injection must stay off, see the deployment runbook).
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api && \
    CGO_ENABLED=0 go build -trimpath -o /out/reconcile ./cmd/reconcile && \
    CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate

FROM alpine:3.20
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/api /api
COPY --from=build /out/reconcile /app/reconcile
COPY --from=build /out/migrate /migrate
EXPOSE 8080
ENTRYPOINT ["/api"]
