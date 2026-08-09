/**
 * In-browser witness building + Groth16 proving for ActaPresentation.
 *
 * Mirrors packages/demo-cli/demo.js step 5, but everything runs client-side:
 * the master secret, claims, and merkle paths never leave the tab. snarkjs
 * fetches the circuit artifacts from /circuits/ (see public/circuits/README).
 */
import { CIRCUIT_PARAMS, Credential, CompiledProgram, FORMAT, normalizeClaim } from "./actaSdk";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";

export const WASM_URL = "/circuits/ActaPresentation.wasm";
export const ZKEY_URL = "/circuits/acta_dev.zkey";

/** The demo's OFAC-style sanctions list — must match the verifier panel's root. */
export const SANCTIONED_JURISDICTIONS = ["IR", "KP", "SY", "CU"];

export type ProofCalldata = {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  signals: bigint[]; // [nullifier, issuerKeyHash, anchorRoot, sanctionsRoot, predicateHash, contextHash, currentTime, sessionNonce]
};

/** Rebuild the issuer's LeanIMT from its on-chain CommitmentAnchored events. */
export function rebuildAnchorTree(leaves: bigint[]): LeanIMT<bigint> {
  const imt = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  for (const l of leaves) imt.insert(l);
  return imt;
}

/**
 * Sanctions-exclusion SMT: build the fixed sanctions tree and a
 * non-membership proof for `jurisdictionField`. Throws if the jurisdiction
 * IS sanctioned (no exclusion witness exists — that is the whole point).
 */
export async function sanctionsExclusion(jurisdictionField: bigint) {
  const { newMemEmptyTrie } = await import("circomlibjs");
  const tree = await newMemEmptyTrie();
  const F = tree.F;
  for (const cc of SANCTIONED_JURISDICTIONS) await tree.insert(normalizeClaim(cc, FORMAT.STRING), 1n);
  const ex = await tree.find(jurisdictionField);
  if (ex.found) throw new Error("jurisdiction is on the sanctions list — no exclusion proof exists");
  const smtSiblings: bigint[] = ex.siblings.map((s: unknown) => F.toObject(s) as bigint);
  while (smtSiblings.length < CIRCUIT_PARAMS.sanctionsTreeDepth) smtSiblings.push(0n);
  return {
    sanctionsRoot: F.toObject(tree.root) as bigint,
    smtSiblings,
    smtOldKey: ex.isOld0 ? 0n : (F.toObject(ex.notFoundKey) as bigint),
    smtOldValue: ex.isOld0 ? 0n : (F.toObject(ex.notFoundValue) as bigint),
    smtIsOld0: ex.isOld0 ? 1n : 0n,
  };
}

export type WitnessParams = {
  masterSecret: bigint;
  cred: Credential;
  program: CompiledProgram;
  anchorLeaves: bigint[]; // the issuer's full on-chain leaf list, in insertion order
  predicateHash: bigint;
  contextHash: bigint;
  sessionNonce: bigint;
  currentTime?: bigint;
  /** For the tamper demo: override a claim slot AFTER signing. */
  tamperClaims?: (claims: bigint[]) => bigint[];
};

/** Build the full circuit input object (bigints; serialize with toJson before snarkjs). */
export async function buildWitnessInput(p: WitnessParams) {
  const imt = rebuildAnchorTree(p.anchorLeaves);
  const leafIndex = p.anchorLeaves.indexOf(p.cred.holderCommitment);
  if (leafIndex < 0) throw new Error("holder commitment is not anchored on-chain yet");
  const mProof = imt.generateProof(leafIndex);
  const anchorSiblings = [...mProof.siblings];
  while (anchorSiblings.length < CIRCUIT_PARAMS.anchorTreeDepth) anchorSiblings.push(0n);

  const claims = p.tamperClaims ? p.tamperClaims([...p.cred.claims]) : p.cred.claims;
  const smt = await sanctionsExclusion(claims[1]);

  return {
    masterSecret: p.masterSecret,
    claims,
    Ax: p.cred.issuerPublicKey.Ax,
    Ay: p.cred.issuerPublicKey.Ay,
    R8x: p.cred.signature.R8x,
    R8y: p.cred.signature.R8y,
    S: p.cred.signature.S,
    anchorDepth: BigInt(mProof.siblings.length),
    anchorIndex: BigInt(mProof.index),
    anchorSiblings,
    smtSiblings: smt.smtSiblings,
    smtOldKey: smt.smtOldKey,
    smtOldValue: smt.smtOldValue,
    smtIsOld0: smt.smtIsOld0,
    predClaimRef: p.program.predicates.map(x => x.claimRef),
    predOp: p.program.predicates.map(x => x.op),
    predValue: p.program.predicates.map(x => x.compareValue),
    tokType: p.program.tokens.map(t => t.type),
    tokArg: p.program.tokens.map(t => t.arg),
    anchorRoot: imt.root,
    sanctionsRoot: smt.sanctionsRoot,
    predicateHash: p.predicateHash,
    contextHash: p.contextHash,
    currentTime: p.currentTime ?? BigInt(Math.floor(Date.now() / 1000)),
    sessionNonce: p.sessionNonce,
  };
}

const toJson = (o: unknown) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

/**
 * Prove in the browser. onStage gets human-readable progress. Returns
 * calldata shaped for PredicateVerifier.verifyPresentation (b coords swapped
 * per Groth16 pairing convention).
 */
export async function proveInBrowser(
  input: Awaited<ReturnType<typeof buildWitnessInput>>,
  onStage?: (stage: string) => void,
): Promise<{ call: ProofCalldata; ms: number }> {
  onStage?.("loading snarkjs…");
  const snarkjs = await import("snarkjs");
  onStage?.("fetching circuit artifacts + computing witness (45,438 constraints)…");
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(toJson(input), WASM_URL, ZKEY_URL);
  const ms = Math.round(performance.now() - t0);
  onStage?.(`proof generated in ${ms}ms`);
  return {
    call: {
      a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
      b: [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
      ],
      c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
      signals: (publicSignals as string[]).map(BigInt),
    },
    ms,
  };
}
