/**
 * Browser port of @acta/sdk (packages/sdk/src/{constants,encoding,credential}.js).
 *
 * WHY A PORT: the Node SDK loads @zk-kit/eddsa-poseidon through
 * createRequire() to dodge a node-22 CJS-interop bug; webpack bundles the
 * package's ESM build fine, so the browser uses a static import instead.
 * Everything else is byte-for-byte the same math.
 *
 * PARITY CONTRACT: this file MUST stay in lockstep with packages/sdk —
 * both are pinned to the circuit by docs/parity-vectors.json. If you touch
 * an encoding here, change the SDK first and re-run its parity tests.
 */
import { derivePublicKey, signMessage, verifySignature } from "@zk-kit/eddsa-poseidon";
import { poseidon1, poseidon2, poseidon9, poseidon14 } from "poseidon-lite";

// ---------------------------------------------------------------- constants

/** BN254 scalar field modulus (the SNARK field). */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const VERSION = 1n;

/** Fixed circuit shape. Baked into predicateProgramHash via packParams(). */
export const CIRCUIT_PARAMS = {
  nClaims: 8,
  maxPredicates: 4,
  maxLogicTokens: 16,
  valueBits: 64,
  anchorTreeDepth: 16,
  sanctionsTreeDepth: 32,
};

/** Predicate comparison operators (1/OPENAC normative codes). */
export const OP = { LE: 0, GE: 1, EQ: 2 };

/** Postfix logic token types. REF/AND/OR/NOT are 1/OPENAC; PAD fills unused slots. */
export const TOKEN = { REF: 0, AND: 1, OR: 2, NOT: 3, PAD: 4 };

/** Claim format tags (1/OPENAC normative codes). */
export const FORMAT = { BOOL: 0, UINT: 1, ISO_DATE: 2, ROC_DATE: 3, STRING: 4 };

export type SchemaSlot = { name: string; format: number };

/** AgentCapabilityCredential v1 claim schema: fixed slot layout. */
export const SCHEMA_V1: SchemaSlot[] = [
  { name: "auditScore", format: FORMAT.UINT },
  { name: "jurisdiction", format: FORMAT.STRING },
  { name: "capabilities", format: FORMAT.UINT },
  { name: "validUntil", format: FORMAT.UINT },
  { name: "reserved4", format: FORMAT.UINT },
  { name: "reserved5", format: FORMAT.UINT },
  { name: "reserved6", format: FORMAT.UINT },
  { name: "reserved7", format: FORMAT.UINT },
];

// ----------------------------------------------------------------- encoding

const B8 = 1n << 8n;
const B16 = 1n << 16n;
const B64 = 1n << 64n;

export type Predicate = { claimRef: bigint; op: bigint; compareValue: bigint };
export type LogicToken = { type: bigint; arg: bigint };
export type CompiledProgram = { predicates: Predicate[]; tokens: LogicToken[] };
export type DslExpr =
  | { all: DslExpr[]; any?: never; not?: never; claim?: never }
  | { any: DslExpr[]; all?: never; not?: never; claim?: never }
  | { not: DslExpr; all?: never; any?: never; claim?: never }
  | { claim: string; op: "<=" | ">=" | "=="; value: unknown; all?: never; any?: never; not?: never };

/** Normalize a JS claim value to a field scalar per its format tag (1/OPENAC rules). */
export function normalizeClaim(value: unknown, format: number): bigint {
  switch (format) {
    case FORMAT.BOOL: {
      if (value !== true && value !== false) throw new Error(`invalid bool claim: ${value}`);
      return value ? 1n : 0n;
    }
    case FORMAT.UINT: {
      const v = BigInt(value as string | number | bigint);
      if (v < 0n || v >= B64) throw new Error(`uint claim out of [0, 2^64): ${value}`);
      return v;
    }
    case FORMAT.ISO_DATE: {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      if (!m) throw new Error(`invalid iso_date claim: ${value}`);
      return BigInt(m[1]) * 10000n + BigInt(m[2]) * 100n + BigInt(m[3]);
    }
    case FORMAT.ROC_DATE: {
      const m = /^(\d{1,3})-(\d{2})-(\d{2})$/.exec(String(value));
      if (!m) throw new Error(`invalid roc_date claim: ${value}`);
      return BigInt(m[1]) * 10000n + BigInt(m[2]) * 100n + BigInt(m[3]);
    }
    case FORMAT.STRING: {
      const s = String(value);
      if (s.length > 8) throw new Error(`string claim longer than 8 chars: ${s}`);
      let out = 0n;
      for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (c > 0x7f) throw new Error(`non-ASCII char in string claim: ${s}`);
        out = out * B8 + BigInt(c);
      }
      return out; // big-endian pack, no length prefix (1/OPENAC profile)
    }
    default:
      throw new Error(`unknown claim format: ${format}`);
  }
}

/** Pack the four circuit-shape parameters into one leaf (16 bits each). */
export function packParams(p = CIRCUIT_PARAMS): bigint {
  return (
    BigInt(p.nClaims) * B16 ** 3n +
    BigInt(p.maxPredicates) * B16 ** 2n +
    BigInt(p.maxLogicTokens) * B16 +
    BigInt(p.valueBits)
  );
}

/** Validate + pad a predicate program to the fixed circuit shape. */
export function compileProgram(
  predicates: { claimRef: number | bigint; op: number | bigint; compareValue: bigint }[],
  tokens: { type: number | bigint; arg?: number | bigint }[],
  params = CIRCUIT_PARAMS,
): CompiledProgram {
  if (predicates.length === 0) throw new Error("empty predicate list");
  if (predicates.length > params.maxPredicates)
    throw new Error(`too many predicates: ${predicates.length} > ${params.maxPredicates}`);
  if (tokens.length > params.maxLogicTokens)
    throw new Error(`too many logic tokens: ${tokens.length} > ${params.maxLogicTokens}`);

  const preds = predicates.map((p, i) => {
    const claimRef = BigInt(p.claimRef);
    const op = BigInt(p.op);
    const compareValue = BigInt(p.compareValue);
    if (claimRef < 0n || claimRef >= BigInt(params.nClaims)) throw new Error(`predicate ${i}: claimRef out of range`);
    if (![0n, 1n, 2n].includes(op)) throw new Error(`predicate ${i}: unknown op ${p.op}`);
    if (compareValue < 0n) throw new Error(`predicate ${i}: negative compareValue`);
    if (compareValue >= 1n << BigInt(params.valueBits)) throw new Error(`predicate ${i}: compareValue >= 2^valueBits`);
    return { claimRef, op, compareValue };
  });

  // Stack validity: every REF in range, operators have operands, ends with one value.
  let depth = 0;
  const toks = tokens.map((t, i) => {
    const type = BigInt(t.type);
    const arg = BigInt(t.arg ?? 0);
    if (type === BigInt(TOKEN.REF)) {
      if (arg < 0n || arg >= BigInt(preds.length)) throw new Error(`token ${i}: REF ${arg} out of range`);
      depth += 1;
    } else if (type === BigInt(TOKEN.AND) || type === BigInt(TOKEN.OR)) {
      if (arg !== 0n) throw new Error(`token ${i}: nonzero arg on operator`);
      if (depth < 2) throw new Error(`token ${i}: stack underflow`);
      depth -= 1;
    } else if (type === BigInt(TOKEN.NOT)) {
      if (arg !== 0n) throw new Error(`token ${i}: nonzero arg on operator`);
      if (depth < 1) throw new Error(`token ${i}: stack underflow`);
    } else if (type === BigInt(TOKEN.PAD)) {
      throw new Error(`token ${i}: explicit PAD not allowed in input program`);
    } else {
      throw new Error(`token ${i}: unknown token type ${t.type}`);
    }
    return { type, arg };
  });
  if (depth !== 1) throw new Error(`program leaves ${depth} values on the stack (need 1)`);

  while (preds.length < params.maxPredicates) preds.push({ claimRef: 0n, op: BigInt(OP.EQ), compareValue: 0n });
  while (toks.length < params.maxLogicTokens) toks.push({ type: BigInt(TOKEN.PAD), arg: 0n });

  return { predicates: preds, tokens: toks };
}

/** One packed leaf per predicate slot: claimRef·2^72 + op·2^64 + compareValue. */
export function predicateLeaves({ predicates }: CompiledProgram): bigint[] {
  return predicates.map(p => p.claimRef * B8 ** 9n + p.op * B64 + p.compareValue);
}

/** Two 16-bit (type·2^8 + arg) tokens per leaf, big-endian: 16 tokens → 8 leaves. */
export function tokenLeaves({ tokens }: CompiledProgram, params = CIRCUIT_PARAMS): bigint[] {
  const leaves: bigint[] = [];
  for (let i = 0; i < params.maxLogicTokens; i += 2) {
    const hi = tokens[i].type * B8 + tokens[i].arg;
    const lo = tokens[i + 1].type * B8 + tokens[i + 1].arg;
    leaves.push(hi * B16 + lo);
  }
  return leaves;
}

/** ACTA predicateProgramHash v1 over a compiled (padded) program. */
export function predicateProgramHash(compiled: CompiledProgram, params = CIRCUIT_PARAMS): bigint {
  const leaves = [VERSION, packParams(params), ...predicateLeaves(compiled), ...tokenLeaves(compiled, params)];
  if (leaves.length !== 14) throw new Error(`expected 14 hash leaves, got ${leaves.length}`);
  return poseidon14(leaves) % FIELD_MODULUS;
}

/** Independent (non-circuit) evaluator, used to cross-check witnesses fail-fast. */
export function evaluateProgram(compiled: CompiledProgram, claims: bigint[], params = CIRCUIT_PARAMS): boolean {
  if (claims.length !== params.nClaims) throw new Error("claims length != nClaims");
  const results = compiled.predicates.map(p => {
    const v = claims[Number(p.claimRef)];
    if (v < 0n || v >= 1n << BigInt(params.valueBits)) throw new Error(`claim ${p.claimRef} out of [0, 2^valueBits)`);
    if (p.op === BigInt(OP.LE)) return v <= p.compareValue;
    if (p.op === BigInt(OP.GE)) return v >= p.compareValue;
    return v === p.compareValue;
  });
  const stack: boolean[] = [];
  for (const t of compiled.tokens) {
    if (t.type === BigInt(TOKEN.REF)) stack.push(results[Number(t.arg)]);
    else if (t.type === BigInt(TOKEN.AND) || t.type === BigInt(TOKEN.OR)) {
      const b = stack.pop()!;
      const a = stack.pop()!;
      stack.push(t.type === BigInt(TOKEN.AND) ? a && b : a || b);
    } else if (t.type === BigInt(TOKEN.NOT)) stack.push(!stack.pop());
    // PAD: no-op
  }
  if (stack.length !== 1) throw new Error("program did not reduce to one value");
  return stack[0];
}

/** Small DSL compiler: {all|any|not|{claim,op,value}} nested → compiled program. */
export function compileDsl(expr: DslExpr, schema = SCHEMA_V1, params = CIRCUIT_PARAMS): CompiledProgram {
  const predicates: { claimRef: number; op: number; compareValue: bigint }[] = [];
  const tokens: { type: number; arg: number }[] = [];
  const OPS: Record<string, number> = { "<=": OP.LE, ">=": OP.GE, "==": OP.EQ };
  const walk = (e: DslExpr) => {
    if (e.all || e.any) {
      const list = (e.all ?? e.any)!;
      if (!Array.isArray(list) || list.length === 0) throw new Error("empty all/any");
      list.forEach((sub, i) => {
        walk(sub);
        if (i > 0) tokens.push({ type: e.all ? TOKEN.AND : TOKEN.OR, arg: 0 });
      });
    } else if (e.not) {
      walk(e.not);
      tokens.push({ type: TOKEN.NOT, arg: 0 });
    } else if (e.claim) {
      const slot = schema.findIndex(s => s.name === e.claim);
      if (slot < 0) throw new Error(`unknown claim: ${e.claim}`);
      if (!(e.op in OPS)) throw new Error(`unknown op: ${e.op}`);
      predicates.push({ claimRef: slot, op: OPS[e.op], compareValue: normalizeClaim(e.value, schema[slot].format) });
      tokens.push({ type: TOKEN.REF, arg: predicates.length - 1 });
    } else {
      throw new Error(`bad DSL node: ${JSON.stringify(e)}`);
    }
  };
  walk(expr);
  return compileProgram(predicates, tokens, params);
}

// --------------------------------------------------------------- credential

export type Credential = {
  claims: bigint[];
  message: bigint;
  signature: { R8x: bigint; R8y: bigint; S: bigint };
  issuerPublicKey: { Ax: bigint; Ay: bigint };
  issuerPubKeyHash: bigint;
  holderCommitment: bigint;
};

/** Normalize a {name: value} claim object to the fixed SCHEMA_V1 slot vector. */
export function claimsToVector(claimObj: Record<string, unknown>, schema = SCHEMA_V1): bigint[] {
  const known = new Set(schema.map(s => s.name));
  for (const k of Object.keys(claimObj)) {
    if (!known.has(k)) throw new Error(`claim not in schema: ${k}`);
  }
  return schema.map(s => (s.name in claimObj ? normalizeClaim(claimObj[s.name], s.format) : 0n));
}

export function holderCommitment(masterSecret: bigint): bigint {
  return poseidon1([masterSecret]);
}

/** The signed message from an already-computed holder commitment — what a
 * wallet that never sees the master secret uses to verify a received
 * credential. Same math as credentialMessage. */
export function credentialMessageFromCommitment(commitment: bigint, claims: bigint[]): bigint {
  if (claims.length !== CIRCUIT_PARAMS.nClaims) throw new Error("claims length != nClaims");
  return poseidon9([commitment, ...claims]);
}

/** The signed message: binds holder + all claim slots. */
export function credentialMessage(masterSecret: bigint, claims: bigint[]): bigint {
  return credentialMessageFromCommitment(holderCommitment(masterSecret), claims);
}

export function issuerPubKeyHash(publicKey: [bigint, bigint] | bigint[]): bigint {
  return poseidon2([publicKey[0], publicKey[1]]);
}

/** Issue a credential: sign the credential message with the issuer's EdDSA-BJJ key. */
export function issueCredential(
  issuerPrivateKey: string,
  masterSecret: bigint,
  claimObj: Record<string, unknown>,
): Credential {
  const claims = claimsToVector(claimObj);
  const M = credentialMessage(masterSecret, claims);
  const signature = signMessage(issuerPrivateKey, M);
  const publicKey = derivePublicKey(issuerPrivateKey);
  if (!verifySignature(M, signature, publicKey)) {
    throw new Error("self-check failed: signature does not verify");
  }
  return {
    claims,
    message: M,
    signature: { R8x: BigInt(signature.R8[0]), R8y: BigInt(signature.R8[1]), S: BigInt(signature.S) },
    issuerPublicKey: { Ax: BigInt(publicKey[0]), Ay: BigInt(publicKey[1]) },
    issuerPubKeyHash: issuerPubKeyHash([BigInt(publicKey[0]), BigInt(publicKey[1])]),
    holderCommitment: holderCommitment(masterSecret),
  };
}

export function nullifier(masterSecret: bigint, contextHash: bigint): bigint {
  return poseidon2([masterSecret, contextHash]);
}
