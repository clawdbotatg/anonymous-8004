import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from "node:module";
const { verifySignature } = createRequire(import.meta.url)("@zk-kit/eddsa-poseidon");
import {
  claimsToVector, credentialMessage, holderCommitment, issueCredential, nullifier,
} from '@acta/sdk';

const ISSUER_KEY = 'acta-test-issuer-key-do-not-use-in-prod';
const MASTER_SECRET = 12345678901234567890n;

const CLAIMS = {
  auditScore: 85,
  jurisdiction: 'CH',
  capabilities: 0b101,
  validUntil: 1893456000, // 2030-01-01
};

test('claimsToVector: schema slots, zero-filled reserved, unknown rejected', () => {
  const v = claimsToVector(CLAIMS);
  assert.equal(v.length, 8);
  assert.equal(v[0], 85n);
  assert.equal(v[1], 0x4348n);
  assert.equal(v[3], 1893456000n);
  assert.equal(v[7], 0n);
  assert.throws(() => claimsToVector({ nope: 1 }), /not in schema/);
});

test('issueCredential: signature verifies and binds holder + claims', () => {
  const cred = issueCredential(ISSUER_KEY, MASTER_SECRET, CLAIMS);
  assert.equal(cred.holderCommitment, holderCommitment(MASTER_SECRET));
  assert.equal(cred.message, credentialMessage(MASTER_SECRET, cred.claims));
  assert.ok(
    verifySignature(
      cred.message,
      { R8: [cred.signature.R8x, cred.signature.R8y], S: cred.signature.S },
      [cred.issuerPublicKey.Ax, cred.issuerPublicKey.Ay]
    )
  );
  // a different holder or claim changes the signed message
  assert.notEqual(cred.message, credentialMessage(MASTER_SECRET + 1n, cred.claims));
  const tampered = [...cred.claims];
  tampered[0] = 79n;
  assert.notEqual(cred.message, credentialMessage(MASTER_SECRET, tampered));
});

test('nullifier: context-scoped, unlinkable across contexts, no nonce input', () => {
  const ctxA = 111n, ctxB = 222n;
  assert.equal(nullifier(MASTER_SECRET, ctxA), nullifier(MASTER_SECRET, ctxA));
  assert.notEqual(nullifier(MASTER_SECRET, ctxA), nullifier(MASTER_SECRET, ctxB));
  assert.notEqual(nullifier(MASTER_SECRET + 1n, ctxA), nullifier(MASTER_SECRET, ctxA));
});
