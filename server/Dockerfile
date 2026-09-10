# Build the gateway as a small static binary.
FROM golang:1.25-alpine AS build
WORKDIR /src
# Coolify injects the build arguments as ARG lines near the top of this file and
# their values change per deployment, so no layer below them is ever reused.
# Cache mounts live outside the layer cache and survive that.
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
