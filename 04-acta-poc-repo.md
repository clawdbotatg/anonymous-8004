# 04 — The ACTA PoC Repo, As Documented

> **Scope note — read first.** This document surveys the author's proof-of-concept repo
> (`vendor-acta-poc`, commit `b75e597`) **as it documents itself**: its stated intent,
> architecture, and claims. It deliberately does **not** assess whether any of it works,
> compiles, or is sound — that is the job of the companion audit document, which records
> ground truth. Every statement below of the form "X does Y" should be read as
> "the docs claim X does Y." Section 8 collects the claims an audit should check.

## TLDR

The repo is a monorepo PoC of ACTA (Anonymous Credentials for Trustless Agents): a
four-layer protocol — `did:ethr` identity → W3C JWT-VC credentials (Credo.ts +
OID4VCI/OID4VP) → Circom/Groth16 ZK privacy → Solidity on-chain verification — that lets
an AI agent prove it satisfies a verifier's predicate policy (e.g. `auditScore ≥ 80 AND
jurisdiction ∉ sanctions`) while revealing only a context-scoped nullifier and six/seven
public signals. It ships npm workspaces for shared types, an issuer/holder/verifier trio
of Express services, Hardhat contracts, a draft `@acta/sdk`, and a fully-simulated React
demo app; plus two generations of circuits (V1 hard-coded predicates "production", V2
zkID generalized-predicates "draft"). The docs are unusually elaborate for a PoC: a
normative SPEC, an in-repo security audit with 20 findings and remediation claims, four
ADRs, a versioned roadmap (v0.2–v1.0), and a PM rule that all docs stay in sync. The
central caveat the repo itself admits: **no real trusted-setup ceremony has run** —
real proofs depend on an external `wallet-unit-poc` library or a stub that emits fake
proofs accepted only by a test verifier, and the V2 circuit is explicitly "not yet
expected to compile cleanly."

Everything of substance is dated 2026-05-27 (audit, v0.3, v0.4 all the same day), with
git history compressed into 9 commits — this is a rapid, likely heavily AI-assisted
build, which makes the intent-vs-reality split this corpus is doing especially important.

---

## 1. Monorepo Layout

Root `package.json`: `acta-poc` v0.1.0, npm workspaces (Node ≥20, npm ≥10). Workspaces:
`packages/{shared, issuer, holder, verifier, contracts, demo-app, sdk}`. Note
`openac-sdk/` is **not** a workspace member (see below).

| Path | Stated purpose |
|------|----------------|
| `packages/shared` (`@acta/shared` 0.1.0) | Shared types, constants (the canonical 16-slot attribute-index mapping), predicate hashing (`predicateHash.ts`, `predicateCircuit.ts`), Poseidon helpers, stealth-address derivation (`stealth.ts`), and the zkID GP IR under `src/gp/` (`types.ts`, `compiler.ts`, `encoder.ts`, `witness.ts`, `v1Compat.ts`). Tests under `test/` (`gp.test.ts`, `gp-witness.test.ts`, `gp-v1Compat.test.ts`, `stealth.test.ts`). |
| `packages/issuer` (`@acta/issuer`) | Credo.ts + OID4VCI issuance server (Express, port 3001): `agent.ts`, `credentialSchema.ts`, `didEthrSetup.ts`, `issuanceRoutes.ts`. |
| `packages/holder` (`@acta/holder`) | Credo.ts holder/agent wallet (Express, port 3002): `credentialStore.ts`, `openacAdapter.ts` (+ `openacAdapterV2.ts`), `presentationHandler.ts`, `presentationValidation.ts`, plus a second copy of stealth derivation referenced by ADR-0002 (`packages/holder/src/stealth.ts`). Bridges W3C credentials to the OpenAC `wallet-unit-poc` prover; falls back to `StubWalletUnit` when it isn't installed. |
| `packages/verifier` (`@acta/verifier`) | Credo.ts + OID4VP verifier (Express, port 3003) and the "Verifier SDK": `predicateBuilder.ts` (+ `predicateBuilderV2.ts`), `presentationRequest.ts`, `offchainVerifier.ts`, `onchainSubmitter.ts`, `policyRegistry.ts`, `verifierRoutes.ts`. |
| `packages/contracts` (`@acta/contracts`) | Hardhat + Solidity `^0.8.24` + OpenZeppelin 5.x. `contracts/{core, interfaces, verifiers, examples, mocks, lib}`; tests (`NullifierRegistry`, `AgentAccessGate`, `integration/FullFlow.test.ts`); scripts (`deploy.ts`, `setup-circuits.sh`, `setup-circuits-v2.sh`). |
| `packages/sdk` (`@acta/sdk` **0.3.0**) | Per ADR-0004, the intended single public integration surface. Currently a skeleton: `predicate.ts`, `stealth.ts`, `holder.ts`, `verifier.ts` (mostly re-exports of `@acta/shared`/service code). |
| `packages/demo-app` (`@acta/demo-app`) | React 18 + Vite + Tailwind interactive 10-step demo (port 5173), fully simulated, no backend/wallet/network. |
| `circuits/` | Circom 2.1.6 circuits: `presentation/` (V1 + V2), `anchor/`, `lib/` (shared templates). |
| `openac-sdk/` | A **separate, differently-architected SDK** ("OpenAC SDK" 0.1.0): TypeScript wrapper around zkID's **Spartan2 + Hyrax over secp256r1** proving system for SD-JWT credentials (age-over-18 + device binding via a Prepare/Show two-circuit protocol), with a Rust/WASM component (`wasm/`, `native-backend.ts`, witness calculator, e2e tests). Present since the initial commit but essentially undocumented in the main docs (only `docs/PM_AGENT_PROMPT.md` lists it, as "Prover API referenced in holder integration docs"). It is *not* the Groth16 stack the rest of the repo uses — its relationship to the ACTA flow is one of the murkier points to resolve. |
| `docs/` | `ARCHITECTURE.md`, `SPEC.md`, `FLOW.md`, `API_REFERENCE.md`, `ROADMAP.md`, `SECURITY_AUDIT.md`, `PM_GUIDE.md`, `PM_AGENT_PROMPT.md`, `adr/0001–0004`, `diagrams/*.mermaid` (6), `protocol-diagram.html`. |
| `.cursor/rules/documentation-sync.mdc` | Always-on "PM rule": every code change must update all affected docs/diagrams/demo copy in the same PR. Explains the unusual docs polish. |
| `docker-compose.yml`, `vercel.json`, `.env.example` | Full local stack; Vercel deploy scoped to the demo app. |

## 2. The Layered Architecture (as documented)

ARCHITECTURE.md and SPEC.md describe four "strictly separated" layers (a compromise at
one layer "MUST NOT propagate"):

1. **Layer 1 — DID identity**: `did:ethr` (ERC-1056) on Base Sepolia for all three roles
   (Issuer / Holder-Agent / Verifier); all keys secp256k1/ES256K; DID documents implicit;
   `agentId = uint256(uint160(holderAddress))` links DID to contracts.
2. **Layer 2 — W3C credential**: Credo.ts agents; `AgentCapabilityCredential` JWT-VC
   (auditScore, modelHash, operatorJurisdiction, capabilities bitmask, auditedBy,
   auditDate) issued via OID4VCI pre-authorized-code flow; presented via OID4VP with
   custom `x-openac-predicate` / `x-openac-policy-id` / `x-onchain-verifier` fields.
   Credential fields encode into a fixed 16-element `attributeValues[]` array (indices
   0–5 used, 6–15 MUST be zero) per `packages/shared/src/constants.ts`.
3. **Layer 3 — ZK privacy**: Groth16 over BN254, circomlib Poseidon. The circuit proves
   commitment knowledge, Merkle-root derivation, predicate satisfaction, and nullifier
   derivation `Poseidon(Poseidon(commitment, randomness), Poseidon(verifier, policyId,
   nonce))`. Proof generation is delegated to zkID's `wallet-unit-poc` as a black box
   via `OpenACAdapter`; without it, `StubWalletUnit` emits deterministic fake proofs
   accepted only by the test verifier (sentinel `OPENAC_TEST_PROOF_V1`).
4. **Layer 4 — on-chain execution**: `GeneralizedPredicateVerifier.verifyAndRegister()`
   runs a 10-step atomic check sequence, verifies the Groth16 proof, registers the
   nullifier, emits `PresentationAccepted`; consumer contracts gate on
   `isAcceptedForPolicy(nullifier, policyId)`.

On top of the four layers sit the **SDK** (ADR-0004; `@acta/sdk` as the sole intended
public surface, with a future `ActaClient.create({network, prover, unlinkability})`
facade, CLI, and conformance suite) and the **demo app** (a pure-simulation walkthrough
of the whole flow).

SPEC.md is written as a normative spec (RFC-2119 language, COSS governance header,
`status: raw`) including a trust model (T1 issuer honesty … T6 IPoseidonT4 correctness),
a linkability analysis, and known limitations L1–L5 (fixed predicate structure, static
16-slot schema, no device binding, revocation latency, trusted setup required).

## 3. The Circuits (claimed behavior)

All circuits are `pragma circom 2.1.6` and depend on circomlib Poseidon.

**`circuits/presentation/OpenACGPPresentation.circom` (V1, "production")** — the primary
circuit. Header + SPEC claim it proves: (1) `Poseidon(attributeValues[16], randomness)
== credentialCommitment`; (2) a 4-level Poseidon Merkle root over the attributes equals
`credentialMerkleRoot`; (3) three hard-coded predicate families, each disable-able by a
zero parameter — `auditScore ≥ min`, `capabilities & mask == mask` (8-bit), and
`jurisdiction ∉ sanctions[8]`; (4) nullifier derivation as above; (5) reserved slots
6–15 are zero; (6) an in-circuit `predicateProgramHash = Poseidon(min, capMask,
sanctions[8])` (added post-audit, ACTA-003). Public signals: **7 in the circuit header
and SECURITY_AUDIT v0.2 layout** (nullifier, contextHash, predicateProgramHash,
issuerPubKeyCommitment, credentialMerkleRoot, credentialCommitment, expiryBlock) — but
ARCHITECTURE.md and SPEC.md still document **6** (no credentialCommitment). The docs
also disagree internally on whether `contextHash` is Poseidon (spec body, checked
on-chain via `IPoseidonT4`) or keccak256 (V1 circuit header comment, SPEC glossary and
Implementation Notes test vectors). Both discrepancies are doc-drift flags for the audit.
Estimated ~50k constraints ("run `snarkjs r1cs info` after compilation" — i.e. never
measured).

**`circuits/presentation/OpenACGPPresentationV2.circom` (draft)** — the zkID
generalized-predicates circuit (ADR-0001). Replaces the three hard-coded families with:
a list of predicates `(claimIndex, op ∈ {≤, ≥, ==}, operand, isClaimRef)` evaluated by
`PredicateEval`, combined by a postfix expression over `{AND, OR, NOT, PRED(i)}`
evaluated by `PostfixEval`. 7 public signals matching the on-chain layout. Its own
header is explicit: **"v0.3 DRAFT — pending ZK-engineer review and trusted setup. …
not yet expected to compile cleanly against snarkjs/circom 2.1.6."** The file calls
itself "the specification of the V2 constraints" more than an implementation.

**`circuits/anchor/OpenACCredentialAnchor.circom`** — run by the holder at anchor time;
claims to prove knowledge of `attributeValues[]` + `randomness` behind the on-chain
`commitment`, well-formedness/range checks, and correct Merkle-root computation. Per
SECURITY_AUDIT ACTA-020 it is currently **unused** ("reserved for future
selective-disclosure / anchor proofs"); ADR-0003 would revive an anchor proof in v0.5.

**`circuits/lib/`:**
- `MerkleProof.circom` — Poseidon Merkle inclusion proof (leaf, pathElements,
  pathIndices → root); also flagged unused today (ACTA-020).
- `NullifierDerive.circom` — the two-stage Poseidon nullifier:
  `credentialSecret = Poseidon(commitment, randomness)`, `nullifier =
  Poseidon(credentialSecret, Poseidon(verifier, policyId, nonce))`; claims cross-context
  unlinkability + per-context determinism.
- `PredicateEval.circom` — evaluates one GP predicate: N-way claim selectors, operator
  dispatch (le=0/ge=1/eq=2), claim-ref operands, `isActive` masking for padding slots.
- `PostfixEval.circom` — stack-machine evaluator for the postfix boolean expression;
  prover supplies the full stack trace as witness and the circuit verifies transition
  consistency; final state must be depth 1 / value true. Own header: "v0.3 DRAFT …
  Do not deploy to mainnet until reviewed"; target ≤10k constraints for T=16, M=8
  (unverified).

## 4. Contracts (as documented)

`packages/contracts/contracts/`:

- **core/**
  - `OpenACCredentialAnchor.sol` — stores `(commitment, merkleRoot)` per
    `(agentId, credentialType)`; enforces `msg.sender == address(uint160(agentId))`;
    `anchorCredential()` reverts `ActiveAnchorExists` if a live anchor exists;
    `rotateCredential()` updates; `isMerkleRootCurrent()` / `getCommitment()` are read
    by the verifier.
  - `GeneralizedPredicateVerifier.sol` — the centerpiece. `registerPolicy(
    PolicyDescriptor)` → deterministic `policyId = keccak256(abi.encode(verifier,
    predicateProgramHash, credentialType, circuitId, expiryBlock, issuerCommitment))`;
    policies immutable, deactivatable by registrant. `verifyAndRegister(policyId,
    proof, pubSignals, agentId, nonce)` runs the 10-step atomic sequence: policy
    active/unexpired → signal count → predicate-hash match → expiry-block future →
    Merkle root current at anchor (plus post-audit Step 5b: `pubSignals` commitment ==
    anchored commitment) → issuer commitment match → **Step 7** context hash:
    `IPoseidonT4.hash(msg.sender, policyId, nonce) == pubSignals[1]` (front-running
    protection; reverts `ContextHasherNotConfigured` if unset outside chainid 31337) →
    Groth16 `verifyProof` → nullifier registration → `PresentationAccepted` event.
    `ReentrancyGuard` + `Pausable` + owner admin (`setContextHasher`,
    `registerCircuitVerifier`, `pause/unpause`). Exposes `isAccepted(nullifier)`
    (informational) vs `isAcceptedForPolicy(nullifier, policyId)` (REQUIRED for
    gating — the docs stress that using the policy-agnostic one is a security error).
  - `NullifierRegistry.sol` — context-scoped nullifier store: `register/isActive/
    revoke`; second `register` of the same nullifier reverts `NullifierAlreadyActive`;
    caller authorization locked to the GP verifier via `lockAuthorization()`.
  - `ZKReputationAccumulator.sol` — anonymous, policy-scoped reputation
    (`isAcceptedForPolicy` gated to prevent cross-policy inflation).
- **verifiers/** — `OpenACSnarkVerifier.sol` (production placeholder that **reverts
  `VerifierNotConfigured` / rejects all proofs** until replaced by the
  ceremony-generated `OpenACSnarkVerifier_generated.sol`) and
  `TestOpenACSnarkVerifier.sol` (accepts the `OPENAC_TEST_PROOF_V1` sentinel,
  local/Hardhat only — the split is the ACTA-001 remediation).
- **interfaces/** — `ICircuitVerifier`, `IGeneralizedPredicateVerifier`,
  `INullifierRegistry`, `IOpenACCredentialAnchor`, `IZKReputationAccumulator`.
- **lib/** — `PoseidonT4.sol` (the `IPoseidonT4` interface for the on-chain Poseidon(3)
  context hash; a real implementation must be deployed and must match circomlib
  constants — trust assumption T6, `test/PoseidonConsistency.test.ts` mentioned as the
  check).
- **examples/** — `AgentAccessGate.sol` (consumer pattern: `onlyVerifiedAgent(nullifier)`
  modifier, `grantAccess`/`revokeAccess`, permanent revocation via
  `_permanentlyRevoked`) and `AnonymousReputationPool.sol`.
- **mocks/** — `MockGPVerifier`, plus `MockERC8004Identity` / `MockERC8004Reputation` —
  notably, **the only ERC-8004 touchpoints in the whole repo**: minimal stubs, with a
  comment that "ERC-8004 integration is optional in the ACTA PoC." The proposal is a
  privacy layer *for* ERC-8004, but the PoC's actual coupling to ERC-8004 is two mocks.

README also publishes a gas-cost table (e.g. `verifyAndRegister` ~205k gas) and says
Base Sepolia deployment addresses populate in `deployments/base-sepolia.json` after
running the deploy script (i.e. none are committed).

## 5. The Four ADRs

All four are dated 2026-05-27, status Accepted.

- **ADR-0001 — Adopt zkID generalized-predicates as ACTA's predicate model.**
  Decision: replace the three hard-coded v0.2 predicate families with zkID's GP design
  as source of truth — 1:1 IR (claims; predicates `(claim_idx, op, operand,
  isClaimRef)`; postfix AND/OR/NOT), circuit ops limited to ≤/≥/== with derived ops
  composed off-circuit, `predicateProgramHash` = Poseidon over a canonical encoding
  (leaf 0 = encoder version). Rationale: v0.2 too narrow for real policies;
  `predicateProgramHash` becomes a cross-system identifier. Deliberately does **not**
  vendor `wallet-unit-poc` (too big a surface, version lock-step, audit bloat) —
  instead reimplements with byte-for-byte hashing parity, to be validated by a
  parity-vector test "when available" (upstream hadn't published its prover). Costs
  acknowledged: bigger circuit (est. 25k–40k constraints, unconfirmed), new ceremony,
  encoder↔circuit lockstep risk.
- **ADR-0002 — Stealth addresses per (verifier, policyId, sessionIndex).**
  Decision: fix ACTA-014 (the reused holder address makes all presentations publicly
  correlatable) by deriving a fresh keypair per presentation context via
  HKDF-SHA256(master, salt="acta-stealth/v1", info=verifier|policy|session) →
  secp256k1 key → address; the stealth key signs the VP JWT and is `msg.sender`.
  Claimed properties: determinism (recoverable), pseudo-randomness, domain separation,
  forward secrecy. Explicitly chosen **over a relayer** (user preference: no off-chain
  service dependency), accepting the gas-funding UX/correlation cost, with three funding
  strategies sketched but unenforced. Derivation + tests shipped (v0.3); actually
  *using* stealth in the presentation flow is open (v0.5).
- **ADR-0003 — Anchor credentials by holder-commitment, not raw agentId.**
  Decision: stealth addresses alone don't help if the anchor map still keys by master
  address (commitment matching re-links). Anchor V2 keys by `holderCommitment =
  Poseidon(holderMasterSecret, salt)`; anchor leaves `Poseidon(holderCommitment,
  credentialCommitment, credentialMerkleRoot)` go into a Merkle accumulator whose only
  public state is the root; presentation proves anchor-set membership in-circuit
  (~log₂N extra Poseidon hashes). Claimed to close ACTA-014 fully and enable
  Semaphore-style composition. **Entirely open (v0.5)** — no code shipped.
- **ADR-0004 — Ship `@acta/sdk` as the public integration surface.**
  Decision: consolidate the too-wide per-package surface into one npm package with an
  `ActaClient` facade (`acta.predicate/issuer/holder/verifier/ceremony`), three bundle
  flavours, peer-deps on ethers + snarkjs; internal packages become private
  implementations. v0.3 shipped only a skeleton (predicate + stealth re-exports);
  the real clients, CLI, and conformance suite are v0.6.

## 6. Roadmap and Version History

Git history (9 commits total): `a8e5c74` initial v0.1 → four demo-app/deploy tweaks →
`98b8ba9` security-audit fixes + PM rule (v0.2) → `e660388` **v0.3** (GP IR + stealth +
SDK skeleton + ADRs + roadmap) → `b75e597` **v0.4** (witness builder + V2
holder/verifier/SDK surfaces + ceremony script) — the audited commit. All of audit,
v0.3, and v0.4 carry the date 2026-05-27.

Version ladder (ROADMAP.md): v0.2 audit remediation (shipped) · v0.3 GP IR off-chain +
stealth derivation + ADRs + draft V2 circuit (shipped) · v0.4 full off-chain V2 stack
(shipped, per the docs) · v0.5 anchor-by-commitment + stealth end-to-end, `agentId`
removed from public surface (planned) · v0.6 SDK clients + `acta` CLI + conformance
suite + OpenAPI (planned) · v1.0 audited Solidity + audited Circom + zkID interop
(planned).

**Claimed done through v0.4** (all off-chain TypeScript): GP IR types, shunting-yard
infix→postfix compiler, canonical encoder + Poseidon program hash (power-of-2 leaf
padding "closes a JS↔Circom hash drift"), `buildCircuitWitness` + snarkjs input adapter,
`v1ToGP` translator, `PredicateBuilderV2`, `OpenACAdapterV2` + `StubWalletUnitV2`,
`verifyOffchainV2()`, `@acta/sdk` v0.4 surfaces, V2 ceremony *script*, stealth
derivation + tests. Headline claim: "**92 tests pass** across `@acta/shared`,
`@acta/verifier`, `@acta/holder`, `@acta/sdk`" — but note the v0.4 status line's fine
print: everything is "implemented and tested **under `StubWalletUnitV2`**".

**Explicitly NOT done, by the repo's own account**: compiling V2 (draft, "pending
ZK-engineer review"); any live Groth16 ceremony ("blocked on circom/snarkjs install" —
i.e. the author couldn't even install the toolchain locally); the generated Solidity
verifier; the zkID parity vector (blocked upstream); re-pointing the GP verifier at V2;
all of Phase 2 (anchor V2, stealth wiring, funding helper) and Phase 3 (SDK clients,
CLI, conformance, OpenAPI). SECURITY_AUDIT's production checklist is entirely unchecked.

The in-repo SECURITY_AUDIT.md (self-audit, same date) tabulates 20 findings — 3
Critical / 9 High / 5 Medium / 3 Low-Info — and claims all Critical/High/Medium "Fixed"
in code (e.g. ACTA-001 sentinel verifier split, ACTA-002 7th public signal + Step 5b,
ACTA-003 in-circuit predicate hash), with ACTA-013/014/017 accepted/mitigated pending
v0.5, and honest residuals (no ceremony, WUP unaudited, tests never exercise a real
SNARK — ACTA-019).

## 7. The Demo App

`packages/demo-app` is a self-contained React 18 + Vite + Tailwind SPA (port 5173,
deployed via Vercel) that **simulates** the complete flow in 10 steps for PMs and
non-engineers — no backend, wallet, or network. Layout: react-flow architecture diagram
(left, animated per step) · active step panel (center) · docs panel (right) · scrolling
event log (bottom); plus a Docs page, Spec page, and a Use Cases page with 7 protocol
scenario diagrams. The 10 steps: actors created → schema configured (editable values) →
credential issued (decoded JWT-VC tabs) → on-chain anchor → interactive predicate
editor → policy registered → presentation request → ZK proof ("privacy split-panel":
what the agent knows vs what the proof reveals) → 10-step verification checklist
animation → access granted + a replay-attack demo showing `NullifierAlreadyActive`.

The README is candid about fidelity: DIDs, JWT-VC structure, OID4VCI/OID4VP messages,
and keccak256 predicate hashing are "real format"; **ZK proof bytes are fake** and
contract calls simulated (`SimulationEngine.ts`, `mockContracts/Issuer/Holder.ts`) —
"designed to be indistinguishable from real outputs to a non-technical viewer, while
being clearly documented as simulated." A roadmap item to sync the demo to the GP IR is
open. For our purposes: the demo demonstrates the *pitch*, not the cryptography, and its
existence should not be counted as evidence the protocol runs.

## 8. Claims to Verify (handoff to the audit doc)

Functional/factual claims the docs make, roughly ordered from load-bearing to cosmetic:

**Circuits & crypto**
1. `OpenACGPPresentation.circom` (V1) compiles under circom 2.1.6 and its constraints
   actually enforce C1–C5 (commitment, Merkle root, three predicate families with the
   zero-disables-check pattern, nullifier, reserved-slot zeroing) — including that the
   "if enabled" gating can't be abused to satisfy a policy with predicates off
   (the exact ACTA-003 class of bug, claimed fixed by the in-circuit Poseidon(10)
   predicate hash — verify the fix binds what it claims).
2. Public-signal count/order consistency: circuit ↔ contract ↔ TS. Docs disagree (6 in
   ARCHITECTURE/SPEC vs 7 in circuit header, audit v0.2 layout, and V2) — which is real?
3. `contextHash`: Poseidon vs keccak256. SPEC body + interoperability section mandate
   Poseidon/`IPoseidonT4` and explicitly say keccak "will always produce
   ContextHashMismatch", yet the V1 circuit header comment, SPEC glossary, and SPEC
   Implementation-Notes test vectors all say keccak256. What does the code do, on both
   sides?
4. V2 circuit: does it compile at all (its own header says probably not)? Do
   `PredicateEval`/`PostfixEval` soundly constrain the prover-supplied stack trace?
5. Nullifier derivation matches the spec formula everywhere (circuit, stub, TS, docs)
   and is genuinely context-binding.
6. Claimed constraint counts (~50k V1; 25k–40k V2; ≤10k PostfixEval) — all self-labeled
   estimates, never measured.
7. Stealth derivation (`stealth.ts` — note it exists at *two* documented paths,
   `packages/shared/src/stealth.ts` and `packages/holder/src/stealth.ts`) implements the
   ADR-0002 HKDF construction with the claimed determinism/uniqueness properties, and
   its "IND-CCA against the master secret" audit item.
8. GP encoder canonical hash: leaf-0 version tag, power-of-2 padding "matches the V2
   circuit Merkle fold" (the claimed v0.4 drift fix), and encoder↔witness↔circuit
   parity.

**Contracts**
9. The 10-step `verifyAndRegister` sequence exists as documented, atomically, with the
   documented custom errors, including post-audit Step 5b (anchored-commitment check)
   and the `ContextHasherNotConfigured` guard off-Hardhat (ACTA-009).
10. `NullifierRegistry` replay protection + `lockAuthorization`; `AgentAccessGate`
    uses `isAcceptedForPolicy` (not `isAccepted`) and permanent revocation;
    `ZKReputationAccumulator` policy-scoping.
11. `OpenACSnarkVerifier` (production) really rejects everything; the sentinel path
    really is confined to `TestOpenACSnarkVerifier` + Hardhat (ACTA-001 as claimed).
12. Anchor contract enforces `msg.sender == address(uint160(agentId))`,
    `ActiveAnchorExists`, `rotateCredential` (README itself lists rotation testing as
    a should-fix).
13. `policyId` derivation matches the six-field `keccak256(abi.encode(...))` spec.
14. Gas table numbers (~65k anchor / ~205k verifyAndRegister) — measured or invented?
15. `PoseidonT4.sol`: is there an actual implementation or only an interface? Does
    `PoseidonConsistency.test.ts` exist and pass (SPEC leans on it for T6)?

**End-to-end & tests**
16. "All tests pass without the real library" / "92 tests pass" — run `npm test`;
    count; and confirm the audit's own caveat (ACTA-019) that **no test anywhere
    verifies a real SNARK** — the entire test suite rides on stub proofs + the test
    verifier.
17. `FullFlow.test.ts` integration: what does it actually exercise, and with which
    verifier?
18. Does the documented service flow (FLOW.md steps 0–8: OID4VCI issuance → anchor →
    policy → OID4VP request → proof → off-chain + on-chain verify) run at all with the
    stub? With `wallet-unit-poc` (does that dependency even resolve —
    `file:../../wallet-unit-poc`)? Do the three Express services + docker-compose start?
19. Demo app: does `npm run dev` work; is the simulation honest about being simulated
    in-product (not just in the README)?
20. `setup-circuits.sh` / `setup-circuits-v2.sh`: do they run given the toolchain, and
    does the V1 zkey/verifier pipeline produce something the contracts accept? (Author
    admits never executing the V2 one.)
21. All 12 audit "Fixed" remediations (ACTA-001…018): does the code at the cited paths
    match the claimed fix? A self-audit performed the same day as the fixes deserves
    spot-checking, not trust.

**Positioning / meta**
22. "Reference implementation … Production-grade Solidity" (README line 3) vs the same
    README's PoC security notice — characterize honestly.
23. ERC-8004 integration is only two mock stubs marked "optional" — verify nothing else
    touches ERC-8004, since the ethresear.ch framing is "privacy layer on ERC-8004."
24. `openac-sdk/`: determine what it actually is (Spartan2+Hyrax/secp256r1 SD-JWT
    age-proof SDK with Rust/WASM), whether any ACTA package imports it, whether its
    e2e tests pass, and why it ships in the repo while the main stack bets on
    Groth16/BN254 + `wallet-unit-poc`. Two incompatible proving stacks in one repo is
    either an evolution artifact or dead weight — the audit should say which.
25. SPEC claims a reference implementation at `github.com/privacy-ethereum/acta-poc`
    and JSON-LD contexts at `acta.ethereum.org` — check whether these exist or are
    aspirational.
26. Deployed Base Sepolia addresses: README implies deployment happened ("Gas Costs
    (Base Sepolia)") but commits no addresses — was anything ever deployed?
