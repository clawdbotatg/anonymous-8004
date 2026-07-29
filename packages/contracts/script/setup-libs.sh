#!/usr/bin/env bash
# re-fetch the test lib after a clean clone (pinned)
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf lib/forge-std
git clone --depth 1 --branch v1.9.7 https://github.com/foundry-rs/forge-std lib/forge-std
rm -rf lib/forge-std/.git

# copy npm Solidity libs into lib/ (foundry allowed-paths friendly)
mkdir -p lib/lean-imt lib/poseidon-solidity
cp ../../node_modules/@zk-kit/lean-imt.sol/*.sol lib/lean-imt/
cp ../../node_modules/poseidon-solidity/PoseidonT3.sol lib/poseidon-solidity/
