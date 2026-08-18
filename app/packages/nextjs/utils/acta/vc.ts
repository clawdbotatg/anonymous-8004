/**
 * W3C Verifiable Credential envelope around the ACTA credential (doc 13).
 *
 * The envelope is packaging, not a crypto change: the exact same claim
 * vector, message, and EdDSA-BJJ signature go into the circuit as before —
 * this just makes the stored object legible to anyone who knows the VC data
 * model, and gives the wallet a self-contained thing to import/export.
 */
import {
  Credential,
  FORMAT,
  SCHEMA_V1,
  claimsToVector,
  credentialMessageFromCommitment,
  issuerPubKeyHash,
} from "./actaSdk";
import { verifySignature } from "@zk-kit/eddsa-poseidon";

export const VC_TYPE = "AgentCapabilityCredential";
export const VC_PROOF_TYPE = "ActaEddsaBabyJubJubSignature2026";

export type ActaVerifiableCredential = {
  "@context": string[];
  type: string[];
  issuer: string; // did:acta:issuer:<poseidon hash of the BJJ pubkey>
  credentialSubject: Record<string, string> & { id: string }; // id = did:acta:holder:<commitment>
  proof: { type: string; Ax: string; Ay: string; R8x: string; R8y: string; S: string };
};

/** Decode a normalized field scalar back to its human value (inverse of normalizeClaim). */
export function decodeClaim(value: bigint, format: number): string {
  switch (format) {
    case FORMAT.BOOL:
      return value === 1n ? "true" : "false";
    case FORMAT.STRING: {
      let v = value;
      let out = "";
      while (v > 0n) {
        out = String.fromCharCode(Number(v % 256n)) + out;
        v /= 256n;
      }
      return out;
    }
    case FORMAT.ISO_DATE: {
      const y = value / 10000n;
      const m = (value / 100n) % 100n;
      const d = value % 100n;
      return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
    }
    default:
      return value.toString();
  }
}

/** Wrap an in-memory Credential as a VC. Reserved all-zero slots are omitted. */
export function credentialToVC(cred: Credential): ActaVerifiableCredential {
  const credentialSubject: ActaVerifiableCredential["credentialSubject"] = {
    id: `did:acta:holder:${cred.holderCommitment.toString()}`,
  };
  SCHEMA_V1.forEach((slot, i) => {
    if (cred.claims[i] !== 0n || !slot.name.startsWith("reserved")) {
      credentialSubject[slot.name] = decodeClaim(cred.claims[i], slot.format);
    }
  });
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", VC_TYPE],
    issuer: `did:acta:issuer:${cred.issuerPubKeyHash.toString()}`,
    credentialSubject,
    proof: {
      type: VC_PROOF_TYPE,
      Ax: cred.issuerPublicKey.Ax.toString(),
      Ay: cred.issuerPublicKey.Ay.toString(),
      R8x: cred.signature.R8x.toString(),
      R8y: cred.signature.R8y.toString(),
      S: cred.signature.S.toString(),
    },
  };
}

/**
 * Parse + verify a received VC without ever needing the master secret:
 * rebuild the claim vector, recompute the signed message from the holder
 * commitment, and check the issuer's EdDSA-BJJ signature.
 */
export function vcToCredential(vc: ActaVerifiableCredential): { cred: Credential; sigOk: boolean } {
  if (!vc.type?.includes(VC_TYPE)) throw new Error(`not an ${VC_TYPE}`);
  if (vc.proof?.type !== VC_PROOF_TYPE) throw new Error(`unknown proof type: ${vc.proof?.type}`);
  const commitment = BigInt(vc.credentialSubject.id.replace("did:acta:holder:", ""));
  const claimObj: Record<string, unknown> = {};
  for (const slot of SCHEMA_V1) {
    if (slot.name in vc.credentialSubject) claimObj[slot.name] = vc.credentialSubject[slot.name];
  }
  const claims = claimsToVector(claimObj);
  const message = credentialMessageFromCommitment(commitment, claims);
  const publicKey: [bigint, bigint] = [BigInt(vc.proof.Ax), BigInt(vc.proof.Ay)];
  const signature = { R8: [BigInt(vc.proof.R8x), BigInt(vc.proof.R8y)] as [bigint, bigint], S: BigInt(vc.proof.S) };
  const sigOk = verifySignature(message, signature, publicKey);
  return {
    cred: {
      claims,
      message,
      signature: { R8x: signature.R8[0], R8y: signature.R8[1], S: signature.S },
      issuerPublicKey: { Ax: publicKey[0], Ay: publicKey[1] },
      issuerPubKeyHash: issuerPubKeyHash(publicKey),
      holderCommitment: commitment,
    },
    sigOk,
  };
}

// ------------------------------------------------ URL-fragment hand-off
// Fragments never reach a server, so a credential can move issuer-tab →
// wallet-tab with no intermediary. ASCII-only JSON, so btoa is safe.

const toB64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

export function encodeVCFragment(vc: ActaVerifiableCredential): string {
  return toB64url(JSON.stringify(vc));
}

export function decodeVCFragment(fragment: string): ActaVerifiableCredential {
  return JSON.parse(fromB64url(fragment));
}

/** A verifier's proof request, same hand-off mechanism: /wallet#request=… */
export function encodeRequestFragment(policyId: bigint): string {
  return toB64url(JSON.stringify({ policyId: policyId.toString() }));
}

export function decodeRequestFragment(fragment: string): bigint {
  return BigInt(JSON.parse(fromB64url(fragment)).policyId);
}
