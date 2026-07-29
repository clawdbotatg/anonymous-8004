// Claim normalization, predicate-program encoding, and predicateProgramHash.
//
// predicateProgramHash is NOT defined by zkID or 1/OPENAC (see research doc 03
// §3.6) — this file is ACTA's normative definition, v1:
//
//   predicateProgramHash = Poseidon14([
//     VERSION,
//     packParams(nClaims, maxPredicates, maxLogicTokens, valueBits),
//     predLeaf[0..3],    // (claimRef ‖ op ‖ compareValue) packed, one per slot
//     tokenLeaf[0..7],   // two 16-bit (type ‖ arg) tokens per leaf
//   ])
//
// The hash is over the *compiled* fixed-shape form (not the DSL), and is
// recomputed inside the circuit from the same private inputs, so a proof is
// unusable for any other policy. The circuit's ProgramHash template MUST match
// this byte-for-byte; test/parity.test.js pins both to committed vectors.

import { poseidon14 } from 'poseidon-lite';
import { CIRCUIT_PARAMS, FIELD_MODULUS, FORMAT, OP, TOKEN, VERSION } from './constants.js';

const B8 = 1n << 8n;
const B16 = 1n << 16n;
const B64 = 1n << 64n;

/** Normalize a JS claim value to a field scalar per its format tag (1/OPENAC rules). */
export function normalizeClaim(value, format) {
  switch (format) {
    case FORMAT.BOOL: {
      if (value !== true && value !== false) throw new Error(`invalid bool claim: ${value}`);
      return value ? 1n : 0n;
    }
    case FORMAT.UINT: {
      const v = BigInt(value);
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
        const c = ch.codePointAt(0);
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
export function packParams(p = CIRCUIT_PARAMS) {
  for (const k of ['nClaims', 'maxPredicates', 'maxLogicTokens', 'valueBits']) {
    if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] >= 1 << 16) throw new Error(`bad param ${k}`);
  }
  return (
    BigInt(p.nClaims) * B16 ** 3n +
    BigInt(p.maxPredicates) * B16 ** 2n +
    BigInt(p.maxLogicTokens) * B16 +
    BigInt(p.valueBits)
  );
}

/**
 * Validate + pad a predicate program to the fixed circuit shape.
 * predicates: [{claimRef, op, compareValue}]; tokens: [{type, arg}].
 * Enforces the 1/OPENAC mandatory rejections and stack validity, and returns
 * {predicates, tokens} padded to maxPredicates / maxLogicTokens.
 */
export function compileProgram(predicates, tokens, params = CIRCUIT_PARAMS) {
  if (predicates.length === 0) throw new Error('empty predicate list');
  if (predicates.length > params.maxPredicates)
    throw new Error(`too many predicates: ${predicates.length} > ${params.maxPredicates}`);
  if (tokens.length > params.maxLogicTokens)
    throw new Error(`too many logic tokens: ${tokens.length} > ${params.maxLogicTokens}`);

  const preds = predicates.map((p, i) => {
    const claimRef = BigInt(p.claimRef);
    const op = BigInt(p.op);
    const compareValue = BigInt(p.compareValue);
    if (claimRef < 0n || claimRef >= BigInt(params.nClaims))
      throw new Error(`predicate ${i}: claimRef out of range`);
    if (![0n, 1n, 2n].includes(op)) throw new Error(`predicate ${i}: unknown op ${p.op}`);
    if (compareValue < 0n) throw new Error(`predicate ${i}: negative compareValue`);
    if (compareValue >= 1n << BigInt(params.valueBits))
      throw new Error(`predicate ${i}: compareValue >= 2^valueBits`);
    return { claimRef, op, compareValue };
  });

  // Stack validity: every REF in range, operators have operands, ends with one value.
  let depth = 0;
  const toks = tokens.map((t, i) => {
    const type = BigInt(t.type);
    const arg = BigInt(t.arg ?? 0);
    if (type === BigInt(TOKEN.REF)) {
      if (arg < 0n || arg >= BigInt(preds.length))
        throw new Error(`token ${i}: REF ${arg} out of range`);
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

  while (preds.length < params.maxPredicates)
    preds.push({ claimRef: 0n, op: BigInt(OP.EQ), compareValue: 0n });
  while (toks.length < params.maxLogicTokens)
    toks.push({ type: BigInt(TOKEN.PAD), arg: 0n });

  return { predicates: preds, tokens: toks };
}

/** One packed leaf per predicate slot: claimRef·2^72 + op·2^64 + compareValue. */
export function predicateLeaves({ predicates }) {
  return predicates.map((p) => p.claimRef * B8 ** 9n + p.op * B64 + p.compareValue);
}

/** Two 16-bit (type·2^8 + arg) tokens per leaf, big-endian: 16 tokens → 8 leaves. */
export function tokenLeaves({ tokens }, params = CIRCUIT_PARAMS) {
  const leaves = [];
  for (let i = 0; i < params.maxLogicTokens; i += 2) {
    const hi = tokens[i].type * B8 + tokens[i].arg;
    const lo = tokens[i + 1].type * B8 + tokens[i + 1].arg;
    leaves.push(hi * B16 + lo);
  }
  return leaves;
}

/** ACTA predicateProgramHash v1 over a compiled (padded) program. */
export function predicateProgramHash(compiled, params = CIRCUIT_PARAMS) {
  const leaves = [
    VERSION,
    packParams(params),
    ...predicateLeaves(compiled),
    ...tokenLeaves(compiled, params),
  ];
  if (leaves.length !== 14) throw new Error(`expected 14 hash leaves, got ${leaves.length}`);
  return poseidon14(leaves) % FIELD_MODULUS;
}

/** Independent (non-circuit) evaluator, used to cross-check witnesses fail-fast. */
export function evaluateProgram(compiled, claims, params = CIRCUIT_PARAMS) {
  if (claims.length !== params.nClaims) throw new Error('claims length != nClaims');
  const results = compiled.predicates.map((p) => {
    const v = claims[Number(p.claimRef)];
    if (v < 0n || v >= 1n << BigInt(params.valueBits))
      throw new Error(`claim ${p.claimRef} out of [0, 2^valueBits)`);
    if (p.op === BigInt(OP.LE)) return v <= p.compareValue;
    if (p.op === BigInt(OP.GE)) return v >= p.compareValue;
    return v === p.compareValue;
  });
  const stack = [];
  for (const t of compiled.tokens) {
    if (t.type === BigInt(TOKEN.REF)) stack.push(results[Number(t.arg)]);
    else if (t.type === BigInt(TOKEN.AND) || t.type === BigInt(TOKEN.OR)) {
      const b = stack.pop();
      const a = stack.pop();
      stack.push(t.type === BigInt(TOKEN.AND) ? a && b : a || b);
    } else if (t.type === BigInt(TOKEN.NOT)) stack.push(!stack.pop());
    // PAD: no-op
  }
  if (stack.length !== 1) throw new Error('program did not reduce to one value');
  return stack[0];
}

/**
 * Small DSL compiler: {all|any|not|{claim,op,value}} nested → compiled program.
 * schema maps claim names to slot indices + formats.
 */
export function compileDsl(expr, schema, params = CIRCUIT_PARAMS) {
  const predicates = [];
  const tokens = [];
  const OPS = { '<=': OP.LE, '>=': OP.GE, '==': OP.EQ };
  const walk = (e) => {
    if (e.all || e.any) {
      const list = e.all ?? e.any;
      if (!Array.isArray(list) || list.length === 0) throw new Error('empty all/any');
      list.forEach((sub, i) => {
        walk(sub);
        if (i > 0) tokens.push({ type: e.all ? TOKEN.AND : TOKEN.OR, arg: 0 });
      });
    } else if (e.not) {
      walk(e.not);
      tokens.push({ type: TOKEN.NOT, arg: 0 });
    } else if (e.claim) {
      const slot = schema.findIndex((s) => s.name === e.claim);
      if (slot < 0) throw new Error(`unknown claim: ${e.claim}`);
      if (!(e.op in OPS)) throw new Error(`unknown op: ${e.op}`);
      predicates.push({
        claimRef: slot,
        op: OPS[e.op],
        compareValue: normalizeClaim(e.value, schema[slot].format),
      });
      tokens.push({ type: TOKEN.REF, arg: predicates.length - 1 });
    } else {
      throw new Error(`bad DSL node: ${JSON.stringify(e)}`);
    }
  };
  walk(expr);
  return compileProgram(predicates, tokens, params);
}
