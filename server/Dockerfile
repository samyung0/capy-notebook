# Build the gateway as a small static binary.
FROM golang:1.26.10-alpine3.24@sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca AS build
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
    CGO_ENABLED=0 go build -trimpath -o /out/office-maintenance ./cmd/office-maintenance && \
    CGO_ENABLED=0 go build -trimpath -o /out/previewbackfill ./cmd/previewbackfill && \
    CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/api /api
COPY --from=build /out/reconcile /app/reconcile
COPY --from=build /out/office-maintenance /app/office-maintenance
COPY --from=build /out/previewbackfill /app/previewbackfill
COPY --from=build /out/migrate /migrate
EXPOSE 8080
ENTRYPOINT ["/api"]
