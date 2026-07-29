// Witness-level tests for ActaPresentation.circom.
//
// Positive: a full honest witness generates, and the circuit's outputs match
// the SDK's values AND the committed parity vectors (docs/parity-vectors.json).
// Negative: every soundness property from the plan has a failing witness test
// (tamper, forge, sanctioned, expired, wrong policy) — audit pitfalls 2/4/14.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import {
  SCHEMA_V1, compileDsl, predicateProgramHash, issueCredential,
  nullifier as sdkNullifier, normalizeClaim, FORMAT,
} from '@acta/sdk';

const require = createRequire(import.meta.url);
const { newMemEmptyTrie } = require('circomlibjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const VECTORS = JSON.parse(readFileSync(join(ROOT, 'docs', 'parity-vectors.json'), 'utf8'));

// Same fixed inputs as scripts/gen-parity-vectors.js
const ISSUER_KEY = 'acta-parity-issuer-key-v1';
const MASTER_SECRET = 4242424242424242424242n;
const CLAIMS = { auditScore: 85, jurisdiction: 'CH', capabilities: 5, validUntil: 1893456000 };
const CONTEXT_HASH = 987654321987654321n;
const CURRENT_TIME = 1753700000n; // 2025-07-28-ish, < validUntil
const SESSION_NONCE = 777n;
const DSL = {
  all: [
    { claim: 'auditScore', op: '>=', value: 80 },
    { not: { claim: 'jurisdiction', op: '==', value: 'IR' } },
  ],
};
const SANCTIONED = ['IR', 'KP', 'SY', 'CU'].map((s) => normalizeClaim(s, FORMAT.STRING));

let calculateWitness; // (input) -> witness bigint[]
let baseInput;        // known-good full witness input
let smtF;             // circomlibjs field for conversions

before(async () => {
  const builder = require('../build/ActaPresentation_js/witness_calculator.js');
  const wasm = readFileSync(join(HERE, '..', 'build', 'ActaPresentation_js', 'ActaPresentation.wasm'));
  const wc = await builder(wasm);
  calculateWitness = (input) => wc.calculateWitness(input, true);

  // credential
  const cred = issueCredential(ISSUER_KEY, MASTER_SECRET, CLAIMS);

  // anchor LeanIMT: our holder among decoys
  const imt = new LeanIMT((a, b) => poseidon2([a, b]));
  imt.insert(111n); // decoys
  imt.insert(222n);
  imt.insert(cred.holderCommitment);
  imt.insert(333n);
  const proof = imt.generateProof(2);
  const anchorSiblings = [...proof.siblings];
  while (anchorSiblings.length < 16) anchorSiblings.push(0n);

  // sanctions SMT with exclusion proof for our jurisdiction
  const tree = await newMemEmptyTrie();
  smtF = tree.F;
  for (const k of SANCTIONED) await tree.insert(k, 1n);
  const ex = await tree.find(cred.claims[1]);
  assert.equal(ex.found, false);
  const smtSiblings = ex.siblings.map((s) => smtF.toObject(s));
  while (smtSiblings.length < 32) smtSiblings.push(0n);

  // policy
  const program = compileDsl(DSL, SCHEMA_V1);

  baseInput = {
    masterSecret: MASTER_SECRET,
    claims: cred.claims,
    Ax: cred.issuerPublicKey.Ax,
    Ay: cred.issuerPublicKey.Ay,
    R8x: cred.signature.R8x,
    R8y: cred.signature.R8y,
    S: cred.signature.S,
    anchorDepth: BigInt(proof.siblings.length),
    anchorIndex: BigInt(proof.index),
    anchorSiblings,
    smtSiblings,
    smtOldKey: ex.isOld0 ? 0n : smtF.toObject(ex.notFoundKey),
    smtOldValue: ex.isOld0 ? 0n : smtF.toObject(ex.notFoundValue),
    smtIsOld0: ex.isOld0 ? 1n : 0n,
    predClaimRef: program.predicates.map((p) => p.claimRef),
    predOp: program.predicates.map((p) => p.op),
    predValue: program.predicates.map((p) => p.compareValue),
    tokType: program.tokens.map((t) => t.type),
    tokArg: program.tokens.map((t) => t.arg),
    anchorRoot: imt.root,
    sanctionsRoot: smtF.toObject(tree.root),
    predicateHash: predicateProgramHash(program),
    contextHash: CONTEXT_HASH,
    currentTime: CURRENT_TIME,
    sessionNonce: SESSION_NONCE,
  };
});

test('honest witness generates; outputs match SDK and parity vectors', async () => {
  const w = await calculateWitness(baseInput);
  const nullifier = w[1];
  const issuerKeyHash = w[2];
  assert.equal(nullifier, sdkNullifier(MASTER_SECRET, CONTEXT_HASH));
  assert.equal(nullifier.toString(), VECTORS.outputs.nullifier);
  assert.equal(issuerKeyHash.toString(), VECTORS.outputs.issuerPubKeyHash);
  assert.equal(baseInput.predicateHash.toString(), VECTORS.outputs.predicateProgramHash);
});

const expectFail = (mutate, name) =>
  test(name, async () => {
    const input = structuredClone(baseInput);
    mutate(input);
    await assert.rejects(async () => calculateWitness(input), /Assert Failed|Error/);
  });

expectFail((i) => { i.claims = [...i.claims]; i.claims[0] = 79n; },
  'tampered claim (score 79 < 80) fails BOTH signature and predicate');

expectFail((i) => { i.S = i.S + 1n; },
  'forged signature (S+1) fails EdDSA verification');

expectFail((i) => { i.masterSecret = i.masterSecret + 1n; },
  'wrong master secret fails (commitment != signed holder binding)');

expectFail((i) => { i.currentTime = 1893456001n; },
  'expired credential (currentTime > validUntil) fails');

expectFail((i) => { i.predicateHash = i.predicateHash + 1n; },
  'mismatched predicateHash fails (proof bound to exact policy)');

expectFail((i) => { i.anchorRoot = i.anchorRoot + 1n; },
  'wrong anchor root fails (not in the anonymity set)');

expectFail((i) => { i.anchorDepth = 17n; },
  'anchor depth > MAX_DEPTH rejected in-circuit');

expectFail((i) => { i.predValue = [...i.predValue]; i.predValue[0] = 1n << 64n; },
  'compareValue >= 2^64 rejected (comparator range check)');

test('sanctioned jurisdiction (IR) cannot produce an exclusion witness', async () => {
  // Rebuild credential with jurisdiction IR; the SMT find() returns found=true,
  // and any fabricated exclusion witness must fail in-circuit.
  const cred = issueCredential(ISSUER_KEY, MASTER_SECRET, { ...CLAIMS, jurisdiction: 'IR' });
  const tree = await newMemEmptyTrie();
  for (const k of SANCTIONED) await tree.insert(k, 1n);
  const found = await tree.find(cred.claims[1]);
  assert.equal(found.found, true); // no honest exclusion proof exists
  const input = structuredClone(baseInput);
  input.claims = cred.claims;
  input.R8x = cred.signature.R8x;
  input.R8y = cred.signature.R8y;
  input.S = cred.signature.S;
  // reuse the old (now-invalid) exclusion witness for the new key
  await assert.rejects(async () => calculateWitness(input), /Assert Failed|Error/);
});

test('unlinkability: two contexts give unrelated nullifiers; same context is stable', async () => {
  const w1 = await calculateWitness(baseInput);
  const other = structuredClone(baseInput);
  other.contextHash = CONTEXT_HASH + 1n;
  const w2 = await calculateWitness(other);
  assert.notEqual(w1[1], w2[1]);
  const w3 = await calculateWitness(structuredClone(baseInput));
  assert.equal(w1[1], w3[1]);
});
