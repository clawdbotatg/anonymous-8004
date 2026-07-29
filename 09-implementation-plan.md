# 09 — Implementation plan for the ACTA reference implementation

**TLDR:** Build a fresh, small, *actually-running* ACTA stack in four milestones:
**M1** a sound Circom presentation circuit (EdDSA-BJJ issuer signature + LeanIMT
anonymity-set membership + SMT sanctions non-membership + GP predicates +
context-scoped nullifier, budget < 50k constraints), compiled and witness-tested
in CI from the first commit; **M2** four Solidity contracts + the generated
Groth16 verifier running end-to-end on anvil via a CLI walkthrough (= demo A —
the moment this project does what her repo never did); **M3** the over-asking
auditor dashboard (demo C) + the three-panel web demo (demo B) on Base Sepolia
with a decoy anchor set; **M4** the failure trilogy polished + optionally the
zk-reputation loop (demo D) + the writeup for her/ethresear.ch. Total ~2 weeks
focused. Every design choice below is grounded in the corpus (docs 01–08);
acceptance criteria = the 30-item pitfalls checklist in doc 07 §8.

**Build fresh, carry her designs.** Doc 08 floated "compile her circuits and
wire them"; the audit (doc 07) rules that out — her circuits are unsound even
if compiled (no issuer binding §4.1, V2 dropped range checks §4.2, static
public signals kill anonymity §4.4) and her Solidity doesn't compile (§2). What
we carry forward is her *design* work (doc 07 §6): the GP IR, the canonical
program encoding + hash scheme, the fail-fast witness builder, the PostfixEval
trace pattern, the contract decomposition, the 10-step verification sequence,
policy-scoped nullifier acceptance, the fail-closed verifier stub, ADR-0003
(anchor by holder commitment), and the stealth derivation (the one file worth
lifting nearly verbatim, with its SHA-256 placeholder swapped for Poseidon).

---

## 1. Stack (locked unless the wire-format answer changes it)

Per doc 06's recommendation:

| Layer | Choice | Notes |
|---|---|---|
| Circuit language | **circom 2.2.3**, circomlib pinned by commit | buses/tags welcome but optional |
| Proof system | **Groth16 (BN254)** via **snarkjs ≥ 0.7.6** | ~200–260k verify gas; ≥0.7.6 mandatory (CVE-2023-33252 class) |
| ptau | `powersOfTau28_hez_final_20.ptau` (2^20) | headroom over the <50k budget; dev phase-2 via `snarkjs zkey contribute` (labelled DEV CEREMONY everywhere) |
| Anonymity-set tree | **LeanIMT**: `@zk-kit/lean-imt` (JS) + `@zk-kit/lean-imt.sol` + `@zk-kit/binary-merkle-root.circom` | audited (Semaphore 4.0.0 audit) |
| Issuer signatures | **EdDSA-BJJ-Poseidon**: `@zk-kit/eddsa-poseidon` + `@zk-kit/baby-jubjub` (JS), circomlib `EdDSAPoseidonVerifier` (circuit) | BJJSignature2021-style W3C VC envelope; **no ES256 in-circuit in v1** |
| Sanctions tree | circomlib **`SMTVerifier(32)`**, exclusion mode (`fnc=1`), keys = truncated Poseidon of the sanctioned identifier | ≈ 9–10k constraints; watch `lean-imt-plus` as future replacement |
| Contracts | Foundry, Solidity 0.8.x, OZ pinned exact | verifier from `snarkjs zkey export solidityverifier` + independent `< r` public-signal check |
| Browser proving | vanilla snarkjs wasm (Web Workers) | artifacts CDN'd Semaphore-style |
| Chains | anvil locally → **Base Sepolia** | no public RPCs — Alchemy with `ALCHEMY_API_KEY` (ask Austin if missing) |

**Constraint budget: < 50k total** (doc 06 §6: sub-5s desktop proving, phones
viable). Rough ledger: EdDSA-Poseidon verify ~4–8k, LeanIMT membership
(depth ≤ 32) ~8k, SMT exclusion (32 levels) ~10k, predicates + postfix eval
~2–4k, nullifier + commitments ~1k → ~25–31k with headroom.

## 2. The credential

`AgentCapabilityCredential` — a W3C VC envelope whose core claim is a Poseidon
attribute commitment signed by the issuer's BJJ key (Privado ID
`BJJSignature2021` pattern):

- Attributes (field elements, fixed slots): `auditScore` (uint), `jurisdiction`
  (string→packed scalar per 1/OPENAC normalization), `capabilities` (bitmask
  uint), `validUntil` (uint timestamp, **in the signed payload** — pitfall 4),
  `holderCommitment = Poseidon(masterSecret)` (binds the credential to the
  holder — ADR-0003), plus reserved zero slots.
- Issuer signs `M = Poseidon(attrs…)`; the circuit re-derives M from the
  private attributes and verifies the signature — **the issuer key is bound
  in-circuit** (pitfall 1), with only `issuerPubKeyHash = Poseidon(Ax, Ay)`
  exposed, and checked by the contract against the policy's registered issuer.
- Claim normalization follows the 1/OPENAC encoding verbatim (doc 03 §3.4):
  op codes LE=0/GE=1/EQ=2, format tags, `valueBits = 64`, mandatory rejections.

## 3. The circuit — `ActaPresentation.circom`

One fixed-shape circuit, parameterized `(nClaims=8, maxPredicates=4,
maxLogicTokens=16, valueBits=64, imtDepth=32, smtDepth=32)`.

**Private inputs:** `masterSecret`; `attrs[nClaims]`; issuer pubkey `(Ax, Ay)`;
signature `(R8x, R8y, S)`; LeanIMT siblings + index for `holderCommitment`
membership in the issuer's anchor root; SMT exclusion siblings for
`jurisdiction` against the sanctions root; predicate witness trace (PostfixEval
pattern — prover supplies the trace, circuit checks init/transition/final).

**Public inputs:** `anchorRoot` (issuer-level — shared by all holders, never a
per-credential value; pitfall 5); `sanctionsRoot`; `predicateHash`;
`contextHash = Poseidon(verifierAddr, policyId, epoch)`; `currentTime`;
`sessionNonce` (bound via the Semaphore `dummySquare` trick — **not** in the
nullifier; pitfall 6); predicate program arrays (predicates + logic tokens,
fixed-width — they're the preimage of `predicateHash`).

**Public outputs:** `nullifier = Poseidon(masterSecret, contextHash)`;
`issuerPubKeyHash`.

**Constraints (the soundness core, mapped to doc 07 §8):**
1. `holderCommitment === Poseidon(masterSecret)`; LeanIMT membership of
   `holderCommitment` under `anchorRoot`.
2. `M === Poseidon(attrs…)`; `EdDSAPoseidonVerifier(enabled=1)` over
   `(Ax, Ay, S, R8, M)`; `issuerPubKeyHash === Poseidon(Ax, Ay)`.
3. Every comparator input range-checked **both sides**: `Num2Bits(valueBits)`
   on each active `attrs[i]` and each `compareValue` (pitfall 2); every
   `claimRef`/operand index constrained in-range (pitfall 3).
4. `predicateHash === Poseidon-fold(version ‖ circuitParams ‖ predicates[] ‖
   logicTokens[])` — the doc 03 §3.6 option (a) binding: recomputed in-circuit
   so a proof is unusable for any other policy. This *is* ACTA's
   `predicateProgramHash` definition (nothing upstream defines one).
5. PostfixEval over the predicate results with explicit booleanity per cell
   (pitfall 8); final result `=== 1`.
6. SMT exclusion of `Poseidon(jurisdiction)|truncated` under `sanctionsRoot`
   (`fnc=1`).
7. `currentTime <= attrs[validUntil]` (range-checked; pitfall 4).
8. `nullifier === Poseidon(masterSecret, contextHash)`; `sessionNonce²`
   non-malleability square.
9. Review rules: no `<--` without `===` + justification (pitfall 7); no
   compile-time `assert` doing a constraint's job.

**Negative tests written with the circuit, not after** (pitfall 14's parity
vectors + doc 07's exploit paths as regression tests): forged-issuer witness
fails; near-field-modulus comparator input fails; expired credential fails;
sanctioned jurisdiction fails; wrong-policy proof fails; replayed nullifier
caught at contract layer.

## 4. Contracts (Foundry)

| Contract | Role | Key rules (doc 07 §8) |
|---|---|---|
| `CredentialAnchor.sol` | issuer-level LeanIMT of holder commitments; issuers append; emits roots | anchor by holder commitment only — **no agentId anywhere in the ABI** (pitfall 18); recent-roots window à la Semaphore |
| `PolicyRegistry.sol` | **standalone** (unlike her PoC — doc 08 §cross-cutting): `registerPolicy(PolicyDescriptor)` | descriptor = `{predicateHash, predicates[], logicTokens[], issuerPubKeyHash, sanctionsRoot, validityWindow, circuitVerifier}` — verifier address **in the immutable descriptor** (pitfall 19); enumerable (demo C needs it) |
| `PredicateVerifier.sol` | `verifyPresentation(policyId, proof, pubSignals)`: load policy → check pubSignal layout/count → check `predicateHash`, `issuerPubKeyHash`, roots, `currentTime` freshness, all signals `< r` → delegate to `ICircuitVerifier` → register nullifier → emit `PresentationAccepted(policyId, nullifier, expiry)` | her 10-step sequence kept, named custom errors kept; fail-closed stub pattern for unset verifiers (pitfall 23) |
| `NullifierRegistry.sol` | policy-scoped nullifier store; `isAcceptedForPolicy(policyId, nullifier)` | re-registration banned incl. expired (her design, kept); rejects values ≥ r as defense-in-depth |
| `AgentAccessGate.sol` | demo consumer: grants on first accepted nullifier, `NullifierAlreadyActive` on replay | the demo finale |

Deploy scripts refuse `Test*` contracts on non-local networks (pitfall 22); no
`chainid`-conditional logic anywhere (pitfall 20). `ZKReputationAccumulator` is
deferred to M4 (demo D) — it needs the one genuinely new circuit (aggregate ≥
threshold over blinded leaves) and nothing in M1–M3 depends on it.

## 5. SDK (TypeScript, one package)

`@acta/sdk`: credential issue/sign (`@zk-kit/eddsa-poseidon`), GP compiler
(DSL → triples + postfix, her encoder scheme re-implemented + the Poseidon
program hash), fail-fast witness builder (her design: refuse to build for
unsatisfied programs, cross-check against an independent evaluator), prover
(snarkjs, node + browser), and contract clients (viem). Hard rules: **no
sentinel proofs — unimplemented paths `throw`** (pitfall 11); **no silent
crypto fallbacks** — Poseidon comes from circomlibjs pinned in `dependencies`,
hard-fail if absent (pitfalls 12–13); cross-implementation parity vectors
(`(program, claims) → predicateHash, commitment, nullifier` identical in TS and
circuit witness) committed **before** the circuit lands (pitfall 14).

## 6. Milestones

**M1 — circuit spike (days 1–4).** Scaffold monorepo + CI (compile circuit,
`snarkjs r1cs info`, witness tests, Foundry tests on every push — pitfalls 10,
17). Write parity vectors, then `ActaPresentation.circom` + gadget unit tests +
the negative-test suite. Measure: constraint count (target < 50k), browser
proving latency (go/no-go: < 15s desktop; expect 2–6s). Dev phase-2 ceremony
script. *Exit: `r1cs-info.txt` + browser latency number committed.*

**M2 — e2e on anvil = demo A (days 5–8).** Contracts + generated verifier +
`< r` checks; CLI walkthrough script: issue → anchor → register policy → prove
("jurisdiction ∉ OFAC ∧ auditScore ≥ 80") → verify on-chain →
`PresentationAccepted` → replay reverts → tampered credential fails at witness.
Gas report + proof size committed (measured, or labelled estimated — pitfall
26). *Exit: `make demo` runs the full terminal story from clean clone.*

**M3 — demos C + B on Base Sepolia (days 9–14).** Extract policy enumeration →
over-asking auditor dashboard (constraint count, attributes touched, modeled
anonymity-set estimate with the model openly declared — doc 08 C). Three-panel
web demo with in-browser proving and the failure trilogy (tamper / replay /
unlinkable dual-verifier nullifiers). Seed a **decoy anchor set** (the live
ERC-8004 reality of tiny anonymity sets — doc 01 — makes this mandatory for an
honest unlinkability demo). Deploy to Base Sepolia via Alchemy. *Exit:
shareable URL + explorer links.*

**M4 — polish + optional reputation loop (week 3+, if wanted).** Demo D
(accumulator + aggregate circuit + write-back through ERC-8004 `giveFeedback()`
reserved tag, rate-limited + authorized per pitfall 21), the pitch per doc 08's
ordering, and the writeup/reply for the ethresear.ch thread.

## 7. Gates and non-goals

**Gate — the wire-format question (ask her at/before M2 exit):** does she want
OpenAC/SD-JWT/ES256 alignment (transparent Spartan+Hyrax, no on-chain verifier
today, in-circuit ES256 ≈ 1.5–2M constraints) or this pragmatic
EdDSA-BJJ/Circom route? M1–M2 are useful either way (contracts + GP encoding +
nullifier design survive a proving-layer swap behind `ICircuitVerifier`); M3+
UX investment is what the answer steers. Demo A in hand makes that a better
conversation than an abstract question.

**Non-goals (v1):** ES256/JWT-VC in-circuit; revocation (explicitly out of
scope in the post; LeanIMT+ noted as the future path); IVC/folding (doc 05:
off the critical path); real OID4VCI/OID4VP transport (panels hand off
directly, declared); production trusted-setup ceremony (dev ceremony, labelled);
threshold de-anonymization, cross-chain portability, OBO delegation (open
research questions, not implementation targets).

**Acceptance criteria:** doc 07 §8, all 30 items, treated as a checklist at
each milestone exit. Headline invariants: issuer signature verified in-circuit;
no cleartext `agentId` or per-credential public signals; both-sides range
checks; expiry in-circuit; nonce out of the nullifier; immutable per-policy
verifier; no sentinel proofs; CI from commit #1; every number measured or
labelled estimated.

## 8. Repo layout

```
packages/
  circuits/        ActaPresentation.circom + lib gadgets, tests, ceremony scripts
  contracts/       Foundry: 5 contracts + generated verifier + tests
  sdk/             @acta/sdk (TS): credential, GP compiler, witness, prover, clients
  demo-cli/        demo A driver (make demo)
  demo-web/        demos B + C (Vite)
docs/              measured artifacts: r1cs-info.txt, gas-report.txt, latency.md
```
