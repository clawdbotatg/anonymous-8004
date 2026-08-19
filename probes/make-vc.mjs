// Build a sample VC exactly as /demo's "hand to wallet" link would.
// Usage: node probes/make-vc.mjs > probes/vc.b64
import { issueCredential } from "../packages/sdk/src/credential.js";

const masterSecret = 123456789123456789n; // test-only identity
const cred = issueCredential("acta-web-demo-issuer-key-v1", masterSecret, {
  auditScore: 85,
  jurisdiction: "CH",
  capabilities: 5,
  validUntil: 1893456000,
});
const vc = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  type: ["VerifiableCredential", "AgentCapabilityCredential"],
  issuer: `did:acta:issuer:${cred.issuerPubKeyHash}`,
  credentialSubject: {
    id: `did:acta:holder:${cred.holderCommitment}`,
    auditScore: "85",
    jurisdiction: "CH",
    capabilities: "5",
    validUntil: "1893456000",
  },
  proof: {
    type: "ActaEddsaBabyJubJubSignature2026",
    Ax: cred.issuerPublicKey.Ax.toString(),
    Ay: cred.issuerPublicKey.Ay.toString(),
    R8x: cred.signature.R8x.toString(),
    R8y: cred.signature.R8y.toString(),
    S: cred.signature.S.toString(),
  },
};
const b64url = Buffer.from(JSON.stringify(vc)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
console.log(b64url);
