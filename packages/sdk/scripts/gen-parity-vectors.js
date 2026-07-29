// Generates docs/parity-vectors.json — the cross-implementation pin.
// The circuit witness tests (packages/circuits) MUST reproduce these values
// exactly; any drift is a breaking change (audit pitfall 14).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SCHEMA_V1, compileDsl, predicateProgramHash, issueCredential, nullifier, packParams,
  predicateLeaves, tokenLeaves,
} from '@acta/sdk';

const ISSUER_KEY = 'acta-parity-issuer-key-v1';
const MASTER_SECRET = 4242424242424242424242n;
const CLAIMS = { auditScore: 85, jurisdiction: 'CH', capabilities: 5, validUntil: 1893456000 };
const CONTEXT_HASH = 987654321987654321n;

const DSL = {
  all: [
    { claim: 'auditScore', op: '>=', value: 80 },
    { not: { claim: 'jurisdiction', op: '==', value: 'IR' } },
  ],
};

const program = compileDsl(DSL, SCHEMA_V1);
const cred = issueCredential(ISSUER_KEY, MASTER_SECRET, CLAIMS);

const s = (v) => v.toString();
const vectors = {
  _comment: 'Cross-implementation parity pin (SDK <-> circuit). Regenerate ONLY on a deliberate VERSION bump: node scripts/gen-parity-vectors.js',
  inputs: {
    issuerKeySeed: ISSUER_KEY,
    masterSecret: s(MASTER_SECRET),
    claimsRaw: CLAIMS,
    contextHash: s(CONTEXT_HASH),
    policyDsl: DSL,
  },
  outputs: {
    claims: cred.claims.map(s),
    holderCommitment: s(cred.holderCommitment),
    credentialMessage: s(cred.message),
    signature: { R8x: s(cred.signature.R8x), R8y: s(cred.signature.R8y), S: s(cred.signature.S) },
    issuerPublicKey: { Ax: s(cred.issuerPublicKey.Ax), Ay: s(cred.issuerPublicKey.Ay) },
    issuerPubKeyHash: s(cred.issuerPubKeyHash),
    nullifier: s(nullifier(MASTER_SECRET, CONTEXT_HASH)),
    packedParams: s(packParams()),
    predicateLeaves: predicateLeaves(program).map(s),
    tokenLeaves: tokenLeaves(program).map(s),
    predicateProgramHash: s(predicateProgramHash(program)),
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'parity-vectors.json');
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(`predicateProgramHash = ${vectors.outputs.predicateProgramHash}`);
