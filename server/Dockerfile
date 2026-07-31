# Build the gateway as a small static binary.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api && \
    CGO_ENABLED=0 go build -trimpath -o /out/reconcile ./cmd/reconcile

FROM alpine:3.20
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/api /api
COPY --from=build /out/reconcile /app/reconcile
EXPOSE 8080
ENTRYPOINT ["/api"]
