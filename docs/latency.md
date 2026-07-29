# Proving latency — measured

- Date: 2026-07-28 · Host: Apple M4 (10 cores), node v22.22.0
- Circuit: ActaPresentation v1, 45,438 constraints (see r1cs-info.txt)
- Prover: snarkjs 0.7.6 Groth16 wasm (same code path as browser), dev zkey
- Runs: 5

| Stage | median | min | max |
|---|---|---|---|
| witness calculation | 109 ms | 106 ms | 114 ms |
| Groth16 prove | 1022 ms | 998 ms | 1127 ms |
| **end-to-end** | **1130 ms** | | |

Proof JSON size: ~0.7 KB. zkey size: 21.5 MB (browser artifact download).

M1 go/no-go gate was < 15 s desktop (plan §6): **PASS**.
