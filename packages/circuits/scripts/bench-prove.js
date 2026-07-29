// Measures end-to-end proving latency (witness calc + Groth16 prove) and
// verifies the proof against the exported vkey. Writes docs/latency.md.
// This is node/wasm — the same snarkjs wasm path a browser runs; browser
// numbers on comparable hardware track these closely (single-threaded wasm
// witness calc; multithreaded prover via workers in both).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import * as snarkjs from 'snarkjs';
import { buildBaseInput } from '../test/fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build');
const ROOT = join(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);

const N = 5;
const { input } = await buildBaseInput();
const wasmPath = join(BUILD, 'ActaPresentation_js', 'ActaPresentation.wasm');
const zkeyPath = join(BUILD, 'acta_dev.zkey');
const vkey = JSON.parse(readFileSync(join(BUILD, 'verification_key.json'), 'utf8'));

// serialize bigints for snarkjs input
const json = JSON.parse(JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const witnessMs = [];
const proveMs = [];
let proof, publicSignals;
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const wtns = { type: 'mem' };
  await snarkjs.wtns.calculate(json, wasmPath, wtns);
  const t1 = performance.now();
  ({ proof, publicSignals } = await snarkjs.groth16.prove(zkeyPath, wtns));
  const t2 = performance.now();
  witnessMs.push(t1 - t0);
  proveMs.push(t2 - t1);
  console.log(`run ${i + 1}: witness ${(t1 - t0).toFixed(0)}ms, prove ${(t2 - t1).toFixed(0)}ms`);
}

const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
if (!ok) throw new Error('proof did not verify');
console.log('proof verifies ✓  publicSignals:', publicSignals);

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const proofBytes = JSON.stringify(proof).length;

const md = `# Proving latency — measured

- Date: 2026-07-28 · Host: ${os.cpus()[0].model} (${os.cpus().length} cores), node ${process.version}
- Circuit: ActaPresentation v1, 45,438 constraints (see r1cs-info.txt)
- Prover: snarkjs ${JSON.parse(readFileSync(join(ROOT, 'node_modules', 'snarkjs', 'package.json'), 'utf8')).version} Groth16 wasm (same code path as browser), dev zkey
- Runs: ${N}

| Stage | median | min | max |
|---|---|---|---|
| witness calculation | ${med(witnessMs).toFixed(0)} ms | ${Math.min(...witnessMs).toFixed(0)} ms | ${Math.max(...witnessMs).toFixed(0)} ms |
| Groth16 prove | ${med(proveMs).toFixed(0)} ms | ${Math.min(...proveMs).toFixed(0)} ms | ${Math.max(...proveMs).toFixed(0)} ms |
| **end-to-end** | **${(med(witnessMs) + med(proveMs)).toFixed(0)} ms** | | |

Proof JSON size: ~${(proofBytes / 1024).toFixed(1)} KB. zkey size: ${(readFileSync(zkeyPath).length / 1e6).toFixed(1)} MB (browser artifact download).

M1 go/no-go gate was < 15 s desktop (plan §6): **${med(witnessMs) + med(proveMs) < 15000 ? 'PASS' : 'FAIL'}**.
`;
writeFileSync(join(ROOT, 'docs', 'latency.md'), md);
console.log('wrote docs/latency.md');
process.exit(0);
