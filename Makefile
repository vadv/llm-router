.PHONY: build check test fmt fmt-check lint run clean docker-openwrt deploy-router

build:
	cargo build

check:
	cargo check --all-targets

# Full check: formatting, warnings (including test code), tests.
test: fmt-check lint
	cargo test

fmt:
	cargo fmt

fmt-check:
	cargo fmt --check

lint:
	cargo clippy --all-targets -- -D warnings

# Run with the default config path.
run:
	cargo run -- config.yaml

# Static aarch64/musl binary for OpenWrt. Output: dist/openwrt/.
docker-openwrt:
	docker buildx build --platform linux/arm64 -f build/openwrt.Dockerfile -o dist/openwrt .

clean:
	cargo clean

# Build + deploy to the router in one step.
deploy-router:
	$(MAKE) docker-openwrt
	scripts/deploy-router.sh
