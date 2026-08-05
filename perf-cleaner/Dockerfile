# Mirrors go-service/Dockerfile: vendored deps, static binary, scratch image.
# ---- build stage ----
FROM golang:1.26 AS build
WORKDIR /src

COPY go.mod go.sum ./
COPY vendor/ vendor/
COPY cmd/ cmd/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=linux go build \
    -mod=vendor -trimpath -ldflags="-s -w" \
    -o /out/cleaner ./cmd/cleaner

# ---- final stage ----
FROM scratch
# Needed for TLS to both RDS and the CloudWatch Logs endpoint.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/cleaner /cleaner

EXPOSE 8080
ENTRYPOINT ["/cleaner"]
