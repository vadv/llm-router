# Static aarch64/musl build for OpenWrt routers (verified target:
# GL-MT6000, OpenWrt 24.10.1, mediatek/filogic, aarch64_cortex-a53).
# Build on Apple Silicon natively:
#   docker buildx build --platform linux/arm64 -f build/openwrt.Dockerfile \
#     -o dist/openwrt .
# Recipe follows the old llm-gateway build/openwrt.Dockerfile: same pinned
# toolchain, inline atomics (Debian musl-tools outline-atomics are
# glibc-built), static verification (no INTERP, no NEEDED) and SHA256SUMS.
#
# Dependency caching: a dummy-main layer precompiles every dependency in
# all three profiles (release, test, clippy) keyed ONLY by Cargo.lock —
# editing src/ never rebuilds dependencies again. BuildKit cache mounts
# persist the target dir on top of that for warm rebuilds.
# The web UI is built first and embedded into the binary, so the router gets
# one file with no static directory beside it.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS build
RUN test "$(uname -m)" = aarch64 || \
    { echo 'FATAL: use docker buildx build --platform linux/arm64' >&2; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools perl make binutils \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add aarch64-unknown-linux-musl \
    && rustup component add clippy
# Keep atomics inline: Debian's outline-atomic helpers are built for glibc.
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc \
    CC_aarch64_unknown_linux_musl=musl-gcc \
    CFLAGS_aarch64_unknown_linux_musl=-mno-outline-atomics
WORKDIR /src

# Built by the web stage; the Rust build then embeds it instead of calling npm.
COPY --from=web /web/dist ./web/dist
ENV LLM_ROUTER_SKIP_WEB_BUILD=1

# --- Dependency-only layer: invalidated only by Cargo.lock changes ---
# build.rs rides along: without it cargo builds the package without a build
# script, OUT_DIR is never set, and src/web.rs fails to compile.
COPY Cargo.toml Cargo.lock build.rs ./
RUN --mount=type=cache,id=llm-router-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=llm-router-target,target=/src/target \
    mkdir -p src \
    && echo 'fn main() {}' > src/main.rs \
    && cargo build --locked --target aarch64-unknown-linux-musl --release \
    && cargo test --locked --target aarch64-unknown-linux-musl --all-targets --no-run \
    && cargo clippy --locked --target aarch64-unknown-linux-musl --all-targets -- -D warnings

# --- Real sources: only llm-router itself recompiles ---
COPY src ./src
RUN --mount=type=cache,id=llm-router-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=llm-router-target,target=/src/target \
    touch src/main.rs \
    && cargo build --locked --release --target aarch64-unknown-linux-musl \
    && install -D target/aarch64-unknown-linux-musl/release/llm-router /out/llm-router-openwrt-aarch64 \
    && readelf -h /out/llm-router-openwrt-aarch64 | grep -q 'Machine:.*AArch64' \
    && /out/llm-router-openwrt-aarch64 2>&1 | grep -q 'config.yaml' \
    && readelf -l /out/llm-router-openwrt-aarch64 > /tmp/program-headers \
    && ! grep -q INTERP /tmp/program-headers \
    && readelf -d /out/llm-router-openwrt-aarch64 > /tmp/dynamic-section \
    && ! grep -q NEEDED /tmp/dynamic-section \
    && cd /out && sha256sum llm-router-openwrt-aarch64 > SHA256SUMS

FROM scratch
COPY --from=build /out/ /
