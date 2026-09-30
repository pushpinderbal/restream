# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS frontend
WORKDIR /build/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY web/index.html web/tsconfig*.json web/vite.config.ts ./
COPY web/src/ ./src/
COPY web/public/ ./public/
RUN bun run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine3.24 AS backend
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /restream ./cmd/restream

FROM alpine:3.24 AS runtime
LABEL org.opencontainers.image.title="Restream" \
    org.opencontainers.image.description="A shared browser player for Stalker IPTV portals" \
    org.opencontainers.image.source="https://github.com/pushpinderbal/restream" \
    org.opencontainers.image.licenses="MIT"
RUN apk add --no-cache ffmpeg ca-certificates tzdata \
    && mkdir -p /data /app/web \
    && chown 10001:10001 /data
COPY --from=backend /restream /app/restream
COPY LICENSE /app/
ENV LISTEN_ADDR=:8080 DATA_DIR=/data WEB_DIR=/app/web
WORKDIR /app
USER 10001:10001
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/app/restream"]

FROM runtime AS production
COPY --from=frontend /build/web/dist/ /app/web/
