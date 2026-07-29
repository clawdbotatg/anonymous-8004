pragma circom 2.1.5;

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

// ---------------------------------------------------------------------------
// Generalized-predicate gadgets (ACTA v1).
// Encodings must match @acta/sdk/src/encoding.js exactly — pinned by
// docs/parity-vectors.json.
// ---------------------------------------------------------------------------

// Evaluates one (claimRef, op, compareValue) triple over the claim vector.
// op: 0=LE, 1=GE, 2=EQ (1/OPENAC codes).
// Soundness notes:
//  - claimRef constrained to [0,8) via Num2Bits(3) + selector-sum === 1
//  - BOTH comparator sides range-checked to VALUE_BITS here, at the point of
//    comparison, regardless of upstream checks
//  - op constrained to {0,1,2} via one-hot sum === 1
template PredicateEval(N_CLAIMS, VALUE_BITS) {
    assert(N_CLAIMS == 8); // claimRef range check below assumes 3 bits

    signal input claimRef;
    signal input op;
    signal input compareValue;
    signal input claims[N_CLAIMS];
    signal output result;

    component refBits = Num2Bits(3);
    refBits.in <== claimRef;

    // value = claims[claimRef]
    component eqs[N_CLAIMS];
    signal terms[N_CLAIMS];
    var selSum = 0;
    var acc = 0;
    for (var j = 0; j < N_CLAIMS; j++) {
        eqs[j] = IsEqual();
        eqs[j].in[0] <== claimRef;
        eqs[j].in[1] <== j;
        terms[j] <== eqs[j].out * claims[j];
        selSum += eqs[j].out;
        acc += terms[j];
    }
    selSum === 1;
    signal value <== acc;

    component valueBits = Num2Bits(VALUE_BITS);
    valueBits.in <== value;
    component cmpBits = Num2Bits(VALUE_BITS);
    cmpBits.in <== compareValue;

    component le = LessEqThan(VALUE_BITS);
    le.in[0] <== value;
    le.in[1] <== compareValue;
    component ge = GreaterEqThan(VALUE_BITS);
    ge.in[0] <== value;
    ge.in[1] <== compareValue;
    component eq = IsEqual();
    eq.in[0] <== value;
    eq.in[1] <== compareValue;

    component opLE = IsEqual();
    opLE.in[0] <== op;
    opLE.in[1] <== 0;
    component opGE = IsEqual();
    opGE.in[0] <== op;
    opGE.in[1] <== 1;
    component opEQ = IsEqual();
    opEQ.in[0] <== op;
    opEQ.in[1] <== 2;
    opLE.out + opGE.out + opEQ.out === 1;

    signal rLE <== opLE.out * le.out;
    signal rGE <== opGE.out * ge.out;
    signal rEQ <== opEQ.out * eq.out;
    result <== rLE + rGE + rEQ;
    result * (result - 1) === 0;
}

// Verifies the evaluation of a postfix boolean program over predicate results.
// Token types: 0=REF(arg=predicate index), 1=AND, 2=OR, 3=NOT, 4=PAD.
// The full stack trace is constrained: init state, per-step transition
// (including stack under/overflow guards), final state sp==1.
// predResults MUST be boolean-constrained upstream (PredicateEval does this).
template PostfixEval(MAX_TOKENS, MAX_PREDICATES, STACK_DEPTH) {
    assert(STACK_DEPTH <= 15); // sp range-checked with Num2Bits(4)

    signal input tokType[MAX_TOKENS];
    signal input tokArg[MAX_TOKENS];
    signal input predResults[MAX_PREDICATES];
    signal output result;

    signal stack[MAX_TOKENS + 1][STACK_DEPTH];
    signal sp[MAX_TOKENS + 1];
    for (var d = 0; d < STACK_DEPTH; d++) {
        stack[0][d] <== 0;
    }
    sp[0] <== 0;

    component isRef[MAX_TOKENS];
    component isAnd[MAX_TOKENS];
    component isOr[MAX_TOKENS];
    component isNot[MAX_TOKENS];
    component isPad[MAX_TOKENS];
    component argEq[MAX_TOKENS][MAX_PREDICATES];
    signal argTerms[MAX_TOKENS][MAX_PREDICATES];
    signal refVal[MAX_TOKENS];
    component topEq[MAX_TOKENS][STACK_DEPTH];
    component secEq[MAX_TOKENS][STACK_DEPTH];
    signal topTerms[MAX_TOKENS][STACK_DEPTH];
    signal secTerms[MAX_TOKENS][STACK_DEPTH];
    signal top[MAX_TOKENS];
    signal second[MAX_TOKENS];
    signal vAnd[MAX_TOKENS];
    signal nRef[MAX_TOKENS];
    signal nAnd[MAX_TOKENS];
    signal nOr[MAX_TOKENS];
    signal nNot[MAX_TOKENS];
    signal newVal[MAX_TOKENS];
    signal waRef[MAX_TOKENS];
    signal waBin[MAX_TOKENS];
    signal waNot[MAX_TOKENS];
    signal writeAt[MAX_TOKENS];
    component wEq[MAX_TOKENS][STACK_DEPTH];
    signal wGated[MAX_TOKENS][STACK_DEPTH];
    component spBits[MAX_TOKENS];
    component refOk[MAX_TOKENS];
    component binOk[MAX_TOKENS];
    component notOk[MAX_TOKENS];

    for (var t = 0; t < MAX_TOKENS; t++) {
        // one-hot token type (also constrains tokType[t] to 0..4)
        isRef[t] = IsEqual();
        isRef[t].in[0] <== tokType[t];
        isRef[t].in[1] <== 0;
        isAnd[t] = IsEqual();
        isAnd[t].in[0] <== tokType[t];
        isAnd[t].in[1] <== 1;
        isOr[t] = IsEqual();
        isOr[t].in[0] <== tokType[t];
        isOr[t].in[1] <== 2;
        isNot[t] = IsEqual();
        isNot[t].in[0] <== tokType[t];
        isNot[t].in[1] <== 3;
        isPad[t] = IsEqual();
        isPad[t].in[0] <== tokType[t];
        isPad[t].in[1] <== 4;
        isRef[t].out + isAnd[t].out + isOr[t].out + isNot[t].out + isPad[t].out === 1;

        // refVal = predResults[tokArg] (also constrains tokArg to [0, MAX_PREDICATES))
        var argSum = 0;
        var refAcc = 0;
        for (var k = 0; k < MAX_PREDICATES; k++) {
            argEq[t][k] = IsEqual();
            argEq[t][k].in[0] <== tokArg[t];
            argEq[t][k].in[1] <== k;
            argTerms[t][k] <== argEq[t][k].out * predResults[k];
            argSum += argEq[t][k].out;
            refAcc += argTerms[t][k];
        }
        argSum === 1;
        refVal[t] <== refAcc;

        // dynamic stack reads: top = stack[sp-1], second = stack[sp-2]
        // (sp-1/sp-2 underflow to non-matching field values; guarded below)
        var topAcc = 0;
        var secAcc = 0;
        for (var d = 0; d < STACK_DEPTH; d++) {
            topEq[t][d] = IsEqual();
            topEq[t][d].in[0] <== sp[t] - 1;
            topEq[t][d].in[1] <== d;
            topTerms[t][d] <== topEq[t][d].out * stack[t][d];
            topAcc += topTerms[t][d];
            secEq[t][d] = IsEqual();
            secEq[t][d].in[0] <== sp[t] - 2;
            secEq[t][d].in[1] <== d;
            secTerms[t][d] <== secEq[t][d].out * stack[t][d];
            secAcc += secTerms[t][d];
        }
        top[t] <== topAcc;
        second[t] <== secAcc;

        // candidate results per op
        vAnd[t] <== second[t] * top[t];
        nRef[t] <== isRef[t].out * refVal[t];
        nAnd[t] <== isAnd[t].out * vAnd[t];
        nOr[t] <== isOr[t].out * (second[t] + top[t] - vAnd[t]);
        nNot[t] <== isNot[t].out * (1 - top[t]);
        newVal[t] <== nRef[t] + nAnd[t] + nOr[t] + nNot[t];
        newVal[t] * (newVal[t] - 1) === 0; // explicit booleanity (pitfall 8)

        // write position: REF -> sp, AND/OR -> sp-2, NOT -> sp-1, PAD -> none
        waRef[t] <== isRef[t].out * sp[t];
        waBin[t] <== (isAnd[t].out + isOr[t].out) * (sp[t] - 2);
        waNot[t] <== isNot[t].out * (sp[t] - 1);
        writeAt[t] <== waRef[t] + waBin[t] + waNot[t];

        for (var d = 0; d < STACK_DEPTH; d++) {
            wEq[t][d] = IsEqual();
            wEq[t][d].in[0] <== writeAt[t];
            wEq[t][d].in[1] <== d;
            wGated[t][d] <== wEq[t][d].out * (1 - isPad[t].out);
            stack[t + 1][d] <== stack[t][d] + wGated[t][d] * (newVal[t] - stack[t][d]);
        }

        // stack pointer transition + bounds guards
        sp[t + 1] <== sp[t] + isRef[t].out - isAnd[t].out - isOr[t].out;

        spBits[t] = Num2Bits(4);
        spBits[t].in <== sp[t];
        refOk[t] = LessThan(4);
        refOk[t].in[0] <== sp[t];
        refOk[t].in[1] <== STACK_DEPTH;
        isRef[t].out * (1 - refOk[t].out) === 0;
        binOk[t] = GreaterEqThan(4);
        binOk[t].in[0] <== sp[t];
        binOk[t].in[1] <== 2;
        (isAnd[t].out + isOr[t].out) * (1 - binOk[t].out) === 0;
        notOk[t] = GreaterEqThan(4);
        notOk[t].in[0] <== sp[t];
        notOk[t].in[1] <== 1;
        isNot[t].out * (1 - notOk[t].out) === 0;
    }

    sp[MAX_TOKENS] === 1;
    result <== stack[MAX_TOKENS][0];
}

// ACTA predicateProgramHash v1 (normative definition; see research doc 03 §3.6):
//   Poseidon14([VERSION, packedParams, predLeaf[0..3], tokenLeaf[0..7]])
//   predLeaf  = claimRef·2^72 + op·2^64 + compareValue
//   tokenLeaf = (type_{2j}·2^8 + arg_{2j})·2^16 + type_{2j+1}·2^8 + arg_{2j+1}
// Packing is injective because claimRef<2^3, op<3, compareValue<2^64,
// type<5, arg<MAX_PREDICATES — all constrained in PredicateEval/PostfixEval,
// which MUST be instantiated over the same signals.
template ProgramHash(MAX_PREDICATES, MAX_TOKENS) {
    assert(MAX_PREDICATES == 4);
    assert(MAX_TOKENS == 16);

    signal input predClaimRef[MAX_PREDICATES];
    signal input predOp[MAX_PREDICATES];
    signal input predValue[MAX_PREDICATES];
    signal input tokType[MAX_TOKENS];
    signal input tokArg[MAX_TOKENS];
    signal output hash;

    var P64 = 18446744073709551616; // 2^64
    var P72 = P64 * 256;            // 2^72
    // packParams(nClaims=8, maxPredicates=4, maxLogicTokens=16, valueBits=64)
    var PACKED_PARAMS = 8 * 281474976710656 + 4 * 4294967296 + 16 * 65536 + 64;

    signal predLeaf[MAX_PREDICATES];
    for (var i = 0; i < MAX_PREDICATES; i++) {
        predLeaf[i] <== predClaimRef[i] * P72 + predOp[i] * P64 + predValue[i];
    }
    signal tokenLeaf[MAX_TOKENS \ 2];
    for (var j = 0; j < MAX_TOKENS \ 2; j++) {
        tokenLeaf[j] <== (tokType[2 * j] * 256 + tokArg[2 * j]) * 65536
                       + tokType[2 * j + 1] * 256 + tokArg[2 * j + 1];
    }

    component h = Poseidon(14);
    h.inputs[0] <== 1; // VERSION
    h.inputs[1] <== PACKED_PARAMS;
    for (var i = 0; i < MAX_PREDICATES; i++) {
        h.inputs[2 + i] <== predLeaf[i];
    }
    for (var j = 0; j < MAX_TOKENS \ 2; j++) {
        h.inputs[6 + j] <== tokenLeaf[j];
    }
    hash <== h.out;
}
