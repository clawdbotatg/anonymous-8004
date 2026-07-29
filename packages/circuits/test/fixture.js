// Shared known-good witness fixture (same fixed inputs as
// scripts/gen-parity-vectors.js — the parity pin).
import { createRequire } from 'node:module';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import {
  SCHEMA_V1, compileDsl, predicateProgramHash, issueCredential,
  normalizeClaim, FORMAT,
} from '@acta/sdk';

const require = createRequire(import.meta.url);
const { newMemEmptyTrie } = require('circomlibjs');

export const ISSUER_KEY = 'acta-parity-issuer-key-v1';
export const MASTER_SECRET = 4242424242424242424242n;
export const CLAIMS = { auditScore: 85, jurisdiction: 'CH', capabilities: 5, validUntil: 1893456000 };
export const CONTEXT_HASH = 987654321987654321n;
export const CURRENT_TIME = 1753700000n;
export const SESSION_NONCE = 777n;
export const DSL = {
  all: [
    { claim: 'auditScore', op: '>=', value: 80 },
    { not: { claim: 'jurisdiction', op: '==', value: 'IR' } },
  ],
};
export const SANCTIONED = ['IR', 'KP', 'SY', 'CU'].map((s) => normalizeClaim(s, FORMAT.STRING));

/** Build the honest full witness input (+ the SMT field object for reuse). */
export async function buildBaseInput() {
  const cred = issueCredential(ISSUER_KEY, MASTER_SECRET, CLAIMS);

  const imt = new LeanIMT((a, b) => poseidon2([a, b]));
  imt.insert(111n);
  imt.insert(222n);
  imt.insert(cred.holderCommitment);
  imt.insert(333n);
  const proof = imt.generateProof(2);
  const anchorSiblings = [...proof.siblings];
  while (anchorSiblings.length < 16) anchorSiblings.push(0n);

  const tree = await newMemEmptyTrie();
  const smtF = tree.F;
  for (const k of SANCTIONED) await tree.insert(k, 1n);
  const ex = await tree.find(cred.claims[1]);
  if (ex.found) throw new Error('fixture jurisdiction unexpectedly sanctioned');
  const smtSiblings = ex.siblings.map((s) => smtF.toObject(s));
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
  return { input, cred, smtF };
}
