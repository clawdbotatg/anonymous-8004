#!/usr/bin/env bash
# Compile ActaPresentation.circom -> build/ (r1cs + wasm witness gen + sym),
# and record `snarkjs r1cs info` into docs/r1cs-info.txt (pitfall 26: every
# number measured and committed).
set -euo pipefail
cd "$(dirname "$0")/.."

CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
ROOT="$(cd ../.. && pwd)"

mkdir -p build
"$CIRCOM" src/ActaPresentation.circom \
  --r1cs --wasm --sym \
  -o build \
  -l "$ROOT/node_modules/circomlib/circuits" \
  -l "$ROOT/node_modules/@zk-kit/binary-merkle-root.circom/src" \
  -l src

# the generated witness calculator is CJS; keep node from treating it as ESM
echo '{"type":"commonjs"}' > build/ActaPresentation_js/package.json

npx snarkjs r1cs info build/ActaPresentation.r1cs | tee "$ROOT/docs/r1cs-info.txt"
