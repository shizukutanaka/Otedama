# ---- Build stage ----
FROM golang:1.24-alpine AS builder

# Install git for go module fetching and ca-certificates for TLS.
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /src

# Copy dependency manifests first so Docker layer cache is effective
# when only source files change.
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build a fully static binary.
COPY . .

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown

RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w \
        -X github.com/shizukutanaka/Otedama/internal/version.Version=${VERSION} \
        -X github.com/shizukutanaka/Otedama/internal/version.Commit=${COMMIT} \
        -X github.com/shizukutanaka/Otedama/internal/version.BuildDate=${BUILD_DATE}" \
    -o /out/otedama ./cmd/otedama

# ---- Final image ----
# gcr.io/distroless/static contains only the root CA bundle, timezone
# data, and a minimal libc shim — no shell, no package manager.
# This keeps the attack surface minimal and the image around 5 MB.
FROM gcr.io/distroless/static:nonroot

# Copy the binary.
COPY --from=builder /out/otedama /usr/local/bin/otedama

# Copy license documents (Apache 2.0 §4(d) requires NOTICE distribution).
COPY --from=builder /src/LICENSE /LICENSE
COPY --from=builder /src/NOTICE /NOTICE

# Copy timezone data (needed for correct timestamp formatting).
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Run as a non-root user (distroless 'nonroot' is uid 65532).
USER nonroot:nonroot

# Data directory for the Lightning wallet and other persistent state.
# Matches the mount path used throughout docs/DEPLOYMENT.md's Docker/
# Compose/Kubernetes examples; pass --data-dir/OTEDAMA_DATA_DIR=/var/lib/otedama
# (or bind-mount this path) so the wallet actually lands on the volume
# rather than the OS-default path config.DefaultDataDir() would otherwise
# resolve to inside the container ($HOME/.local/share/otedama).
VOLUME ["/var/lib/otedama"]

# Otedama has no listening ports of its own; it dials out to the pool.
EXPOSE 0

ENTRYPOINT ["/usr/local/bin/otedama"]
CMD ["run", "--help"]

LABEL org.opencontainers.image.title="Otedama" \
      org.opencontainers.image.description="Non-custodial compute arbitration software" \
      org.opencontainers.image.url="https://github.com/shizukutanaka/Otedama" \
      org.opencontainers.image.source="https://github.com/shizukutanaka/Otedama" \
      org.opencontainers.image.licenses="Apache-2.0"
