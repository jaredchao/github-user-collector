# ---- build stage ----
#
# --platform=$BUILDPLATFORM pins this stage to the machine doing the build,
# and GOARCH=$TARGETARCH cross-compiles from there. Without it, `buildx
# --platform linux/arm64` runs the whole stage under QEMU, and emulating the
# Go compiler costs an order of magnitude — on an x86 CI runner that is the
# difference between a minute and half an hour. Go cross-compiles natively,
# so the emulation buys nothing.
#
# It costs nothing on an ARM64 developer machine either: there BUILDPLATFORM
# and TARGETARCH already agree and this is a plain native build.
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETARCH
WORKDIR /src

# Vendored deps are committed, so the build never reaches the network.
COPY go.mod go.sum ./
COPY vendor/ vendor/
COPY cmd/ cmd/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build \
    -mod=vendor -trimpath -ldflags="-s -w" \
    -o /out/cleaner ./cmd/cleaner

# ---- final stage ----
FROM scratch
# Needed for TLS to both RDS and the CloudWatch Logs endpoint.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/cleaner /cleaner

EXPOSE 8080
ENTRYPOINT ["/cleaner"]
