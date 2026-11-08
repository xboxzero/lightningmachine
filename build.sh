#!/usr/bin/env bash
# Builds the Rust physics core to WebAssembly (SIMD enabled) and copies it next to index.html.
set -euo pipefail
cd "$(dirname "$0")/core"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint" \
  cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/lightning_core.wasm ../lightning.wasm
ls -l ../lightning.wasm
