#!/usr/bin/env bash
# DEV-ONLY Groth16 phase-2 setup for ActaPresentation.
# This is NOT a production ceremony: single contributor, deterministic-ish
# entropy. Label every artifact accordingly (audit pitfall: say so, loudly).
# A real deployment runs a multi-party ceremony (p0tion or snarkjs round-robin).
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(cd ../.. && pwd)"
PTAU_DIR="${PTAU_DIR:-$ROOT/.ptau}"
PTAU="$PTAU_DIR/powersOfTau28_hez_final_16.ptau"

mkdir -p "$PTAU_DIR" build

if [ ! -f "$PTAU" ]; then
  echo ">> downloading Hermez ptau 2^16 (~36 MB)"
  curl -fL -o "$PTAU" https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau
fi

npx snarkjs groth16 setup build/ActaPresentation.r1cs "$PTAU" build/acta_0000.zkey
npx snarkjs zkey contribute build/acta_0000.zkey build/acta_dev.zkey \
  --name="ACTA dev contribution (NOT a production ceremony)" -v \
  -e="dev-entropy-$(date +%s)"
npx snarkjs zkey verify build/ActaPresentation.r1cs "$PTAU" build/acta_dev.zkey
npx snarkjs zkey export verificationkey build/acta_dev.zkey build/verification_key.json
npx snarkjs zkey export solidityverifier build/acta_dev.zkey build/Groth16Verifier.sol

echo ">> dev ceremony complete: build/acta_dev.zkey, verification_key.json, Groth16Verifier.sol"
