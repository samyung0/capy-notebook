# The gateway as server/Dockerfile builds it, with the loadtest tag
# (server/cmd/api/loadtest.go) and only the API binary. Built with the server/
# directory as its context.
FROM golang:1.26.10-alpine3.24@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -tags loadtest -o /out/api ./cmd/api

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/api /api
EXPOSE 8080
ENTRYPOINT ["/api"]
