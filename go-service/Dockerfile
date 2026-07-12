# ---- build stage ----
FROM golang:1.26 AS build
WORKDIR /src

# Vendored deps are committed, so the build never reaches the network.
COPY go.mod go.sum ./
COPY vendor/ vendor/
COPY cmd/ cmd/
COPY internal/ internal/

# CGO_ENABLED=0 makes a fully static binary that runs on scratch.
# -trimpath and -ldflags strip paths and debug info for a smaller image.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -mod=vendor -trimpath -ldflags="-s -w" \
    -o /out/server ./cmd/server

# ---- final stage ----
FROM scratch
# TLS to RDS needs the CA bundle even with sslmode=require's handshake.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/server /server

EXPOSE 8080
# scratch has no shell, so exec form with the absolute path is required.
ENTRYPOINT ["/server"]
