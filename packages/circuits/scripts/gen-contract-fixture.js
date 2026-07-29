// Generates packages/contracts/test/fixtures/presentation.json — a REAL
// Groth16 proof + every value the Foundry e2e test needs. The contextHash is
// bound to (CONTEXT_DOMAIN, VERIFIER_ADDR, POLICY_ID), so the forge test
// deploys PredicateVerifier at exactly VERIFIER_ADDR (deployCodeTo).
// Regenerate after any circuit or dev-zkey change: node scripts/gen-contract-fixture.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, encodeAbiParameters, toHex, getAddress } from 'viem';
import * as snarkjs from 'snarkjs';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import { createRequire } from 'node:module';
import {
  SCHEMA_V1, FIELD_MODULUS, compileDsl, predicateProgramHash, issueCredential,
  normalizeClaim, FORMAT,
} from '@acta/sdk';
import {
  ISSUER_KEY, MASTER_SECRET, CLAIMS, CURRENT_TIME, SESSION_NONCE, DSL, SANCTIONED,
} from '../test/fixture.js';

const require = createRequire(import.meta.url);
const { newMemEmptyTrie } = require('circomlibjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build');

// Must match the forge test constants exactly
const VERIFIER_ADDR = getAddress('0x00000000000000000000000000000000ac7a0001');
const ISSUER_ADDR = getAddress('0x0000000000000000000000000000000015540001');
const POLICY_ID = 0n;
const CONTEXT_DOMAIN = keccak256(toHex('ACTA_CONTEXT_V1', { size: undefined }));

const contextHash =
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [CONTEXT_DOMAIN, VERIFIER_ADDR, POLICY_ID]
      )
    )
  ) % FIELD_MODULUS;

// credential + anchor set (decoys + ours, insertion order matters on-chain)
const cred = issueCredential(ISSUER_KEY, MASTER_SECRET, CLAIMS);
const anchorLeaves = [111n, 222n, cred.holderCommitment, 333n];
const imt = new LeanIMT((a, b) => poseidon2([a, b]));
for (const l of anchorLeaves) imt.insert(l);
const proofM = imt.generateProof(2);
const anchorSiblings = [...proofM.siblings];
while (anchorSiblings.length < 16) anchorSiblings.push(0n);

// sanctions SMT
const tree = await newMemEmptyTrie();
const F = tree.F;
for (const k of SANCTIONED) await tree.insert(k, 1n);
const ex = await tree.find(cred.claims[1]);
if (ex.found) throw new Error('fixture jurisdiction sanctioned?');
const smtSiblings = ex.siblings.map((s) => F.toObject(s));
while (smtSiblings.length < 32) smtSiblings.push(0n);

const program = compileDsl(DSL, SCHEMA_V1);

const input = {
  masterSecret: MASTER_SECRET,
  claims: cred.claims,
  Ax: cred.issuerPublicKey.Ax,
  Ay: cred.issuerPublicKey.Ay,
  R8x: cred.signature.R8x,
  R8y: cred.signature.R8y,
  S: cred.signature.S,
  anchorDepth: BigInt(proofM.siblings.length),
  anchorIndex: BigInt(proofM.index),
  anchorSiblings,
  smtSiblings,
  smtOldKey: ex.isOld0 ? 0n : F.toObject(ex.notFoundKey),
  smtOldValue: ex.isOld0 ? 0n : F.toObject(ex.notFoundValue),
  smtIsOld0: ex.isOld0 ? 1n : 0n,
  predClaimRef: program.predicates.map((p) => p.claimRef),
  predOp: program.predicates.map((p) => p.op),
  predValue: program.predicates.map((p) => p.compareValue),
  tokType: program.tokens.map((t) => t.type),
  tokArg: program.tokens.map((t) => t.arg),
  anchorRoot: imt.root,
  sanctionsRoot: F.toObject(tree.root),
  predicateHash: predicateProgramHash(program),
  contextHash,
  currentTime: CURRENT_TIME,
  sessionNonce: SESSION_NONCE,
};
const json = JSON.parse(JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const wtns = { type: 'mem' };
await snarkjs.wtns.calculate(json, join(BUILD, 'ActaPresentation_js', 'ActaPresentation.wasm'), wtns);
const { proof, publicSignals } = await snarkjs.groth16.prove(join(BUILD, 'acta_dev.zkey'), wtns);
const vkey = JSON.parse(readFileSync(join(BUILD, 'verification_key.json'), 'utf8'));
if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error('proof invalid');

const fixture = {
  _comment: 'Real Groth16 proof for the dev zkey. Regenerate: node scripts/gen-contract-fixture.js (circuits pkg).',
  verifierAddr: VERIFIER_ADDR,
  issuerAddr: ISSUER_ADDR,
  policyId: POLICY_ID.toString(),
  currentTime: CURRENT_TIME.toString(),
  a: [proof.pi_a[0], proof.pi_a[1]],
  // swapped G2 coordinate order, as the snarkjs Solidity verifier expects
  b: [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
  c: [proof.pi_c[0], proof.pi_c[1]],
  signals: publicSignals, // [nullifier, issuerKeyHash, anchorRoot, sanctionsRoot, predicateHash, contextHash, currentTime, sessionNonce]
  anchorLeaves: anchorLeaves.map(String),
  policy: {
    predicateHash: input.predicateHash.toString(),
    issuerKeyHash: cred.issuerPubKeyHash.toString(),
    sanctionsRoot: input.sanctionsRoot.toString(),
    predClaimRef: json.predClaimRef,
    predOp: json.predOp,
    predValue: json.predValue,
    tokType: json.tokType,
    tokArg: json.tokArg,
  },
};

const outDir = join(HERE, '..', '..', 'contracts', 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'presentation.json'), JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote contracts/test/fixtures/presentation.json');
console.log('nullifier:', publicSignals[0]);
process.exit(0);
