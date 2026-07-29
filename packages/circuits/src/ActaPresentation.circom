pragma circom 2.1.5;

include "poseidon.circom";
include "eddsaposeidon.circom";
include "comparators.circom";
include "bitify.circom";
include "smt/smtverifier.circom";
include "binary-merkle-root.circom";
include "lib/gp.circom";

// ---------------------------------------------------------------------------
// ActaPresentation v1 — the ACTA anonymous credential presentation proof.
//
// Statement: "I hold a credential whose claims were EdDSA-signed by an issuer
// (key exposed only as Poseidon(Ax,Ay)); my holder commitment is anchored in
// the issuer's LeanIMT (anonymity set); my jurisdiction claim is NOT in the
// sanctions SMT; my claims satisfy the policy's predicate program (bound via
// predicateProgramHash, recomputed in-circuit); the credential has not
// expired; and my nullifier for this context is Poseidon(secret, context)."
//
// Public signals (Groth16 order: outputs, then public inputs):
//   [nullifier, issuerKeyHash,
//    anchorRoot, sanctionsRoot, predicateHash, contextHash, currentTime,
//    sessionNonce]
//
// Cryptographic layout matches @acta/sdk exactly (docs/parity-vectors.json):
//   holderCommitment = Poseidon1([masterSecret])
//   M                = Poseidon9([holderCommitment, claims[0..7]])
//   issuerKeyHash    = Poseidon2([Ax, Ay])
//   nullifier        = Poseidon2([masterSecret, contextHash])
//
// Schema v1 fixed slots: 0=auditScore, 1=jurisdiction, 2=capabilities,
// 3=validUntil, 4..7=reserved. The sanctions non-membership check is always
// over slot 1; a policy that doesn't care uses the empty-tree root (0).
// ---------------------------------------------------------------------------
template ActaPresentation(N_CLAIMS, MAX_PREDICATES, MAX_TOKENS, ANCHOR_DEPTH, SMT_DEPTH, VALUE_BITS) {
    assert(N_CLAIMS == 8);

    // ---- private inputs ----
    signal input masterSecret;
    signal input claims[N_CLAIMS];
    // issuer pubkey + EdDSA-Poseidon signature over M
    signal input Ax;
    signal input Ay;
    signal input R8x;
    signal input R8y;
    signal input S;
    // anchor (LeanIMT) membership proof for holderCommitment
    signal input anchorDepth;
    signal input anchorIndex;
    signal input anchorSiblings[ANCHOR_DEPTH];
    // sanctions SMT exclusion proof for claims[1]
    signal input smtSiblings[SMT_DEPTH];
    signal input smtOldKey;
    signal input smtOldValue;
    signal input smtIsOld0;
    // compiled predicate program (hash-bound; private to keep pubSignals small)
    signal input predClaimRef[MAX_PREDICATES];
    signal input predOp[MAX_PREDICATES];
    signal input predValue[MAX_PREDICATES];
    signal input tokType[MAX_TOKENS];
    signal input tokArg[MAX_TOKENS];

    // ---- public inputs ----
    signal input anchorRoot;
    signal input sanctionsRoot;
    signal input predicateHash;
    signal input contextHash;
    signal input currentTime;
    signal input sessionNonce;

    // ---- outputs ----
    signal output nullifier;
    signal output issuerKeyHash;

    // 1. Claims are 64-bit (schema guarantee, enforced in-circuit)
    component claimBits[N_CLAIMS];
    for (var i = 0; i < N_CLAIMS; i++) {
        claimBits[i] = Num2Bits(VALUE_BITS);
        claimBits[i].in <== claims[i];
    }

    // 2. Holder commitment + signed message
    component hc = Poseidon(1);
    hc.inputs[0] <== masterSecret;

    component msg = Poseidon(9);
    msg.inputs[0] <== hc.out;
    for (var i = 0; i < N_CLAIMS; i++) {
        msg.inputs[1 + i] <== claims[i];
    }

    // 3. Issuer signature verified in-circuit over M (the non-negotiable core)
    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1;
    sig.Ax <== Ax;
    sig.Ay <== Ay;
    sig.R8x <== R8x;
    sig.R8y <== R8y;
    sig.S <== S;
    sig.M <== msg.out;

    component ikh = Poseidon(2);
    ikh.inputs[0] <== Ax;
    ikh.inputs[1] <== Ay;
    issuerKeyHash <== ikh.out;

    // 4. Anchor membership: holderCommitment ∈ LeanIMT(anchorRoot).
    // BinaryMerkleRoot returns 0 when depth > MAX_DEPTH, so bound depth here.
    component depthBits = Num2Bits(5);
    depthBits.in <== anchorDepth;
    component depthOk = LessEqThan(5);
    depthOk.in[0] <== anchorDepth;
    depthOk.in[1] <== ANCHOR_DEPTH;
    depthOk.out === 1;

    component imt = BinaryMerkleRoot(ANCHOR_DEPTH);
    imt.leaf <== hc.out;
    imt.depth <== anchorDepth;
    imt.index <== anchorIndex;
    for (var i = 0; i < ANCHOR_DEPTH; i++) {
        imt.siblings[i] <== anchorSiblings[i];
    }
    imt.out === anchorRoot;

    // 5. Sanctions exclusion: claims[1] (jurisdiction) ∉ SMT(sanctionsRoot)
    component smt = SMTVerifier(SMT_DEPTH);
    smt.enabled <== 1;
    smt.root <== sanctionsRoot;
    for (var i = 0; i < SMT_DEPTH; i++) {
        smt.siblings[i] <== smtSiblings[i];
    }
    smt.oldKey <== smtOldKey;
    smt.oldValue <== smtOldValue;
    smt.isOld0 <== smtIsOld0;
    smt.key <== claims[1];
    smt.value <== 0;
    smt.fnc <== 1; // exclusion proof

    // 6. Predicate program: recompute the hash (binds the private program to
    // the policy) and verify evaluation over the claims.
    component ph = ProgramHash(MAX_PREDICATES, MAX_TOKENS);
    component preds[MAX_PREDICATES];
    for (var i = 0; i < MAX_PREDICATES; i++) {
        ph.predClaimRef[i] <== predClaimRef[i];
        ph.predOp[i] <== predOp[i];
        ph.predValue[i] <== predValue[i];
        preds[i] = PredicateEval(N_CLAIMS, VALUE_BITS);
        preds[i].claimRef <== predClaimRef[i];
        preds[i].op <== predOp[i];
        preds[i].compareValue <== predValue[i];
        for (var j = 0; j < N_CLAIMS; j++) {
            preds[i].claims[j] <== claims[j];
        }
    }
    for (var t = 0; t < MAX_TOKENS; t++) {
        ph.tokType[t] <== tokType[t];
        ph.tokArg[t] <== tokArg[t];
    }
    ph.hash === predicateHash;

    component eval = PostfixEval(MAX_TOKENS, MAX_PREDICATES, 8);
    for (var t = 0; t < MAX_TOKENS; t++) {
        eval.tokType[t] <== tokType[t];
        eval.tokArg[t] <== tokArg[t];
    }
    for (var i = 0; i < MAX_PREDICATES; i++) {
        eval.predResults[i] <== preds[i].result;
    }
    eval.result === 1;

    // 7. Expiry: currentTime <= validUntil (slot 3), in-circuit
    component timeBits = Num2Bits(VALUE_BITS);
    timeBits.in <== currentTime;
    component notExpired = LessEqThan(VALUE_BITS);
    notExpired.in[0] <== currentTime;
    notExpired.in[1] <== claims[3];
    notExpired.out === 1;

    // 8. Context-scoped nullifier (sessionNonce deliberately NOT an input —
    // one nullifier per (secret, context), pitfall 6)
    component nul = Poseidon(2);
    nul.inputs[0] <== masterSecret;
    nul.inputs[1] <== contextHash;
    nullifier <== nul.out;

    // 9. Groth16 malleability guard for the otherwise-unconstrained public
    // input (Semaphore's dummy-square pattern)
    signal nonceSquare <== sessionNonce * sessionNonce;
}

component main { public [anchorRoot, sanctionsRoot, predicateHash, contextHash, currentTime, sessionNonce] } =
    ActaPresentation(8, 4, 16, 16, 32, 64);
