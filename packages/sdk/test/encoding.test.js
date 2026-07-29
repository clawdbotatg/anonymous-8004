import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CIRCUIT_PARAMS, FORMAT, OP, TOKEN, SCHEMA_V1,
  normalizeClaim, packParams, compileProgram, compileDsl,
  predicateLeaves, tokenLeaves, predicateProgramHash, evaluateProgram,
} from '@acta/sdk';

test('normalizeClaim: string packs big-endian ASCII', () => {
  assert.equal(normalizeClaim('IR', FORMAT.STRING), 0x4952n);
  assert.equal(normalizeClaim('CH', FORMAT.STRING), 0x4348n);
  assert.equal(normalizeClaim('', FORMAT.STRING), 0n);
  assert.throws(() => normalizeClaim('TOOLONGXX', FORMAT.STRING));
  assert.throws(() => normalizeClaim('é', FORMAT.STRING));
});

test('normalizeClaim: dates and uints', () => {
  assert.equal(normalizeClaim('2026-07-28', FORMAT.ISO_DATE), 20260728n);
  assert.equal(normalizeClaim(85, FORMAT.UINT), 85n);
  assert.throws(() => normalizeClaim(-1, FORMAT.UINT));
  assert.throws(() => normalizeClaim(1n << 64n, FORMAT.UINT));
  assert.throws(() => normalizeClaim('2026-7-28', FORMAT.ISO_DATE));
});

test('compileProgram: validity rules (1/OPENAC mandatory rejections)', () => {
  const p = { claimRef: 0, op: OP.GE, compareValue: 80 };
  const ref0 = { type: TOKEN.REF, arg: 0 };
  // valid single predicate
  const c = compileProgram([p], [ref0]);
  assert.equal(c.predicates.length, CIRCUIT_PARAMS.maxPredicates);
  assert.equal(c.tokens.length, CIRCUIT_PARAMS.maxLogicTokens);
  assert.equal(c.tokens[1].type, BigInt(TOKEN.PAD));
  // rejections
  assert.throws(() => compileProgram([], []), /empty/);
  assert.throws(() => compileProgram([p], [ref0, ref0]), /stack/); // two values left
  assert.throws(() => compileProgram([p], [ref0, { type: TOKEN.AND, arg: 0 }]), /underflow/);
  assert.throws(() => compileProgram([p], [{ type: TOKEN.REF, arg: 1 }]), /out of range/);
  assert.throws(() => compileProgram([{ ...p, compareValue: 1n << 64n }], [ref0]), /valueBits/);
  assert.throws(() => compileProgram([{ ...p, compareValue: -1 }], [ref0]), /negative/);
  assert.throws(() => compileProgram([{ ...p, op: 9 }], [ref0]), /unknown op/);
  assert.throws(() => compileProgram([p], [{ type: TOKEN.PAD, arg: 0 }]), /PAD/);
});

test('compileDsl: non-OFAC ∧ score≥80 compiles to expected program', () => {
  const dsl = {
    all: [
      { claim: 'auditScore', op: '>=', value: 80 },
      { not: { claim: 'jurisdiction', op: '==', value: 'IR' } },
    ],
  };
  const c = compileDsl(dsl, SCHEMA_V1);
  assert.deepEqual(
    c.predicates.slice(0, 2).map((p) => [p.claimRef, p.op, p.compareValue]),
    [[0n, BigInt(OP.GE), 80n], [1n, BigInt(OP.EQ), 0x4952n]]
  );
  assert.deepEqual(
    c.tokens.slice(0, 4).map((t) => [t.type, t.arg]),
    [[BigInt(TOKEN.REF), 0n], [BigInt(TOKEN.REF), 1n], [BigInt(TOKEN.NOT), 0n], [BigInt(TOKEN.AND), 0n]]
  );
});

test('evaluateProgram: truth table over the demo policy', () => {
  const dsl = {
    all: [
      { claim: 'auditScore', op: '>=', value: 80 },
      { not: { claim: 'jurisdiction', op: '==', value: 'IR' } },
    ],
  };
  const c = compileDsl(dsl, SCHEMA_V1);
  const claims = (score, jur) => {
    const v = new Array(8).fill(0n);
    v[0] = BigInt(score);
    v[1] = normalizeClaim(jur, FORMAT.STRING);
    return v;
  };
  assert.equal(evaluateProgram(c, claims(85, 'CH')), true);
  assert.equal(evaluateProgram(c, claims(79, 'CH')), false);
  assert.equal(evaluateProgram(c, claims(85, 'IR')), false);
  assert.equal(evaluateProgram(c, claims(80, 'US')), true); // GE boundary
});

test('packing layouts are exact', () => {
  assert.equal(packParams(), 8n * 2n ** 48n + 4n * 2n ** 32n + 16n * 2n ** 16n + 64n);
  const c = compileProgram(
    [{ claimRef: 1, op: OP.EQ, compareValue: 0x4952n }],
    [{ type: TOKEN.REF, arg: 0 }]
  );
  const leaves = predicateLeaves(c);
  assert.equal(leaves[0], 1n * 2n ** 72n + 2n * 2n ** 64n + 0x4952n);
  assert.equal(leaves[3], 2n * 2n ** 64n); // padding: (0, EQ, 0)
  const tl = tokenLeaves(c);
  // leaf0 = (REF,0)(PAD,0) = 0x0000_0400
  assert.equal(tl[0], 0x0400n);
  assert.equal(tl[7], 0x0400n * 2n ** 16n + 0x0400n); // (PAD,0)(PAD,0)
  assert.equal(tl.length, 8);
});

test('predicateProgramHash: deterministic and program-sensitive', () => {
  const a = compileProgram([{ claimRef: 0, op: OP.GE, compareValue: 80 }], [{ type: TOKEN.REF, arg: 0 }]);
  const b = compileProgram([{ claimRef: 0, op: OP.GE, compareValue: 81 }], [{ type: TOKEN.REF, arg: 0 }]);
  assert.equal(predicateProgramHash(a), predicateProgramHash(a));
  assert.notEqual(predicateProgramHash(a), predicateProgramHash(b));
});
