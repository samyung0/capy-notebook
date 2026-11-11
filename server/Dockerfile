# Build the gateway as a small static binary.
FROM golang:1.26.11-alpine3.24@sha256:ae52b5bc6ed045a9ed26ab03dc19327a802a9cc9aa8b27ed57f5c6b60579b0bb AS build
WORKDIR /src
# Cache mounts keep compiled output across builds even when the layer cache
# misses. The image takes no build argument: the deploy's images job sets the
# revision as a label, so a new commit never invalidates these layers.
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
    CGO_ENABLED=0 go build -trimpath -o /out/assetthumbbackfill ./cmd/assetthumbbackfill && \
    CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/api /api
COPY --from=build /out/reconcile /app/reconcile
COPY --from=build /out/office-maintenance /app/office-maintenance
COPY --from=build /out/previewbackfill /app/previewbackfill
COPY --from=build /out/assetthumbbackfill /app/assetthumbbackfill
COPY --from=build /out/migrate /migrate
EXPOSE 8080
ENTRYPOINT ["/api"]
