// AgentCapabilityCredential v1: issuance, commitments, nullifiers.
//
// Cryptographic layout (must match ActaPresentation.circom exactly — pinned by
// the parity vectors):
//   holderCommitment = Poseidon1([masterSecret])                (ADR-0003)
//   M                = Poseidon9([holderCommitment, claims[0..7]])
//   signature        = EdDSA-BabyJubJub-Poseidon over M (issuer key)
//   issuerPubKeyHash = Poseidon2([Ax, Ay])
//   nullifier        = Poseidon2([masterSecret, contextHash])
//
// No fallbacks anywhere: if a primitive is unavailable, throw (audit pitfall 12).

import { createRequire } from 'node:module';
import { poseidon1, poseidon2, poseidon9 } from 'poseidon-lite';

// The package's ESM build breaks on node 22 (CJS named-export detection fails
// for its blakejs import), so load the CJS build. Default entry = Blake1-keyed
// EdDSA, the variant circomlib's EdDSAPoseidonVerifier expects.
const require = createRequire(import.meta.url);
const { derivePublicKey, deriveSecretScalar, signMessage, verifySignature } =
  require('@zk-kit/eddsa-poseidon');
import { CIRCUIT_PARAMS, SCHEMA_V1 } from './constants.js';
import { normalizeClaim } from './encoding.js';

/** Normalize a {name: value} claim object to the fixed SCHEMA_V1 slot vector. */
export function claimsToVector(claimObj, schema = SCHEMA_V1) {
  const known = new Set(schema.map((s) => s.name));
  for (const k of Object.keys(claimObj)) {
    if (!known.has(k)) throw new Error(`claim not in schema: ${k}`);
  }
  return schema.map((s) =>
    s.name in claimObj ? normalizeClaim(claimObj[s.name], s.format) : 0n
  );
}

export function holderCommitment(masterSecret) {
  return poseidon1([masterSecret]);
}

/** The signed message: binds holder + all claim slots. */
export function credentialMessage(masterSecret, claims) {
  if (claims.length !== CIRCUIT_PARAMS.nClaims) throw new Error('claims length != nClaims');
  return poseidon9([holderCommitment(masterSecret), ...claims]);
}

export function issuerPubKeyHash(publicKey) {
  return poseidon2([publicKey[0], publicKey[1]]);
}

/**
 * Issue a credential: sign the credential message with the issuer's EdDSA-BJJ key.
 * issuerPrivateKey: any Buffer/string seed accepted by @zk-kit/eddsa-poseidon.
 * Returns everything the holder needs to build a witness.
 */
export function issueCredential(issuerPrivateKey, masterSecret, claimObj) {
  const claims = claimsToVector(claimObj);
  const M = credentialMessage(masterSecret, claims);
  const signature = signMessage(issuerPrivateKey, M);
  const publicKey = derivePublicKey(issuerPrivateKey);
  if (!verifySignature(M, signature, publicKey)) {
    throw new Error('self-check failed: signature does not verify');
  }
  return {
    claims,
    message: M,
    signature: { R8x: signature.R8[0], R8y: signature.R8[1], S: signature.S },
    issuerPublicKey: { Ax: publicKey[0], Ay: publicKey[1] },
    issuerPubKeyHash: issuerPubKeyHash(publicKey),
    holderCommitment: holderCommitment(masterSecret),
  };
}

export function nullifier(masterSecret, contextHash) {
  return poseidon2([masterSecret, contextHash]);
}

export { deriveSecretScalar };
