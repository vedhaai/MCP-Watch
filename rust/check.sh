#!/usr/bin/env bash
# Everything a CI job would check, as one command.
#
# This repository has no CI, and the Rust package is not the place to introduce it on its own.
# These are the checks a person will not think to run by hand, though, so they live here rather
# than in somebody's shell history:
#
#   - the MSRV claim, which is a promise to every consumer and breaks silently
#   - each feature on its own, because a feature that only builds when another is on is the
#     commonest Cargo packaging bug and nothing else catches it
#   - Windows, where `command.rs` has code that never runs here
#
# If CI is ever added for the whole repo, the workflow is one line: `rust/check.sh`.
set -euo pipefail
cd "$(dirname "$0")"

MSRV=$(grep -m1 '^rust-version' Cargo.toml | cut -d'"' -f2)
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "format"
cargo fmt --all --check

step "lint (all features)"
cargo clippy --all-targets --features full -- -D warnings

step "tests (all features)"
cargo test --features full

step "docs build without warnings"
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --features full

step "each feature on its own"
for feature in "" rmcp tower actix proxy; do
	if [ -z "$feature" ]; then
		echo "  --no-default-features"
		cargo check --no-default-features --quiet
	else
		echo "  --features $feature"
		cargo check --no-default-features --features "$feature" --quiet
	fi
done

step "minimum supported Rust ($MSRV)"
if rustup toolchain list | grep -q "^$MSRV"; then
	RUSTUP_TOOLCHAIN="$MSRV" cargo check --features full --quiet
else
	echo "  skipped: rustup toolchain install $MSRV"
fi

step "windows"
if rustup target list --installed | grep -q x86_64-pc-windows-msvc; then
	cargo check --target x86_64-pc-windows-msvc --features full --quiet
else
	echo "  skipped: rustup target add x86_64-pc-windows-msvc"
fi

printf '\n\033[1mAll checks passed.\033[0m\n'
