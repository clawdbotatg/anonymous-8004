# 05 — ivc-checkpoints: Nova+CycleFold folded checkpoints (the author's other repo)

Corpus doc for the ACTA reference-implementation project. Subject:
`vendor-ivc-checkpoints/` — a clone of
[zulu0echo/ivc-checkpoints](https://github.com/zulu0echo/ivc-checkpoints), the ACTA author's
IVC/folding prototype. All paths below are relative to
`./vendor-ivc-checkpoints/` unless absolute.

## TLDR

ivc-checkpoints is a **working, measured prototype** — not a paper design — of a
validity-proven checkpoint for an off-chain balance ledger: an arkworks step circuit folded
with **Nova+CycleFold via sonobe**, compressed by a `DeciderEth` proof, and verified on-chain
by a generated `NovaDecider.sol` at a **constant ~0.8M gas per epoch** regardless of how many
operations the epoch contained. The headline number is real: `results/forge_gas.json` records
`verify_nova_proof_tx_gas: 799731`, and **we reproduced it byte-for-byte on this machine** by
re-running the committed Foundry suite (14/14 tests pass, including verification of the
committed real proof). The repo is honest about its own status: dev-mode trusted setup,
unaudited stack, `light-test` prover figures, a known key↔position soundness gap, and a
sonobe upstream that is mid-rewrite (`docs/BUILD_PLAN_A0_A1.md`). **For ACTA it is context,
not critical path**: the ethresear.ch post never mentions IVC/folding, and a first ACTA
reference implementation needs single-shot membership/predicate proofs, not folding. Where it
*will* matter is later: batched zk-reputation accumulator updates, recursive delegation
chains (open question #2), and as the best measured datapoint the author owns for the
zkVM-vs-circuit threshold question (open question #6).

---

## 1. What the project actually is

An **operator** keeps a ledger of account balances off-chain in a depth-22 Poseidon Merkle
tree and settles once per epoch by posting a checkpoint on-chain. Normally that checkpoint is
*evidence* (you trust the operator's arithmetic). This repo attaches a **validity proof**: a
single folded zero-knowledge proof per epoch that the entire ledger transition was applied
correctly — no negative balances (96-bit solvency), no replays (per-account nonces), value
conservation, and settled payee nets exactly matching the proven operations (`README.md`,
`docs/REPORT.md`).

The mechanics, in plain terms (`docs/REPORT.md` §2b):

- You can't put "apply 40k ledger ops to a Merkle tree" in one circuit — the prover would
  need absurd memory. **IVC via folding** fixes this: a small step circuit `F` applies a
  batch of 16 ops; the prover runs `z_{i+1} = F(z_i, w_i)` repeatedly, and Nova (with the
  CycleFold compiler, over the BN254/Grumpkin cycle) *accumulates* each step into a running
  claim with a few elliptic-curve ops — **constant memory per step**, streamed during the
  epoch.
- At epoch end, one **decider** proof (`DeciderEth`, Groth16+KZG) compresses the whole
  accumulated computation into a single 1,028-byte proof.
- **sonobe** (PSE/0xPARC's Rust folding library) provides all of this *and* emits the
  Solidity verifier (`contracts/generated/NovaDecider.sol` — 838 lines, carrying sonobe's
  generator header), whose gas is fixed and independent of the number of steps folded.

The IVC state is three field elements — `z = [stateRoot, opsAcc, netsAcc]`
(`crates/ledger-circuit/src/lib.rs`, `STATE_LEN = 3`): the ledger's Merkle root, an
accumulator over every op, and an accumulator over payee payouts. The on-chain contract
(`contracts/src/ProvenCheckpoint.sol`) supplies `z0`/`zi` itself from its own stored state
(so history can't be forged from calldata), recomputes the payout accumulator on-chain with a
Poseidon **generated from arkworks' own constants** (`contracts/src/PoseidonT5.sol`, via
`crates/prover/src/poseidon_codegen.rs`) so circuit and chain hash bit-identically, calls the
generated verifier, and only then credits payouts.

Layout: a 3-member Rust workspace (`Cargo.toml`: `crates/ledger-circuit`, `crates/prover`,
`bench`) + a Foundry project (`contracts/`) + a comparison script
(`script/compare_to_model.py`) + heavily-commented vendored arkworks under `vendor/` (more on
that in §4). Notably the F-circuit is written **directly against sonobe's arkworks `FCircuit`
trait — no Circom/Noir frontend**.

## 2. The measured results — verified against the checked-in artifacts

The repo's central claim is provenance discipline: turning analytical `[A]` cost-model
figures into measured `[M]` ones. The claims check out against the result files:

| Metric | README/REPORT claim | `results/forge_gas.json` / `results/measured.json` | Verified here |
| --- | ---: | ---: | --- |
| `verifyNovaProof` tx gas | 799,731 (constant per epoch) | **799,731** | ✅ reproduced exactly (see below) |
| vs analytical model | 784,428, Δ +1.95% | model in `measured.json.analytical_model_reference` | ✅ consistent |
| Calldata / proof size | 1,028 bytes | **1,028** | ✅ (`contracts/generated/proof.json` `calldataBytes`) |
| `NovaDecider` deploy gas | 3,221,311 (README) | **3,221,483** | ⚠️ trivial doc drift (~170 gas) |
| `settleEpochProven` tx gas | 3,613,984 (README) | **3,616,175** | ⚠️ same kind of drift |
| Fold time / step (B=16) | ~1.7 s | avg **1,838 ms**, per-step array 1,208–2,174 ms | ✅ `[M, light-test, small]` |
| Decider prove | ~27.8 s (README) | **29,111 ms** | ✅ (reduced circuit — **not** production) |
| Peak RSS | — | 7,545,520,128 B (~7.0 GB, macOS, 24 GB machine) | `[M, light-test]` |
| Constraints | 31,404/op, 502,464/step, 12,050,881 decider | README table | as documented (from `crates/ledger-circuit/tests/constraints.rs`) |

**Independent reproduction performed for this doc:** with forge 1.7.1 (the repo pins 1.5.1),
`forge test` in `contracts/` passes **14/14** — including `test_valid_proof_accepted`
(the committed real proof verifies), `test_mutated_proof_rejected`, negative tests, the
Poseidon circuit-fixture cross-checks, governance, and escape-hatch tests — and
`GasTest.test_meter_and_write_gas` **rewrote `results/forge_gas.json` byte-identical to the
committed copy** (empty `git diff`). The ~800k-constant-gas claim is real, deterministic, and
survives a Foundry version bump. Foundry runs in `isolate` mode (`contracts/foundry.toml`)
so these are tx-level numbers, not warm-state call gas.

**The amortization story** (`docs/REPORT.md` §4a/§4e): per-op on-chain verification costs
~200k gas and scales linearly; the folded proof is flat ~0.8M, so break-even is at **4
operations** and at "large daily" volume (~42,705 ops/day) the amortized cost is **~18
gas/op** — ~10,000× cheaper. The proof-verification bill depends only on settlement cadence,
never on volume. The report is equally upfront about the cost that *does* scale: the
prototype's naive Solidity Poseidon costs ~856k gas/hash, so the O(payees) on-chain nets
recomputation dominates settlement at scale (~36.7M gas at 42 payees) — flagged as an
implementation artifact with named fixes (Poseidon precompile, or per-payee claims against a
proven `netsRoot`).

**The essential caveats, stated by the repo itself** (`README.md` §Hardware, §Results): the
committed artifacts were produced under the `light-test` feature, which shrinks the decider
(~9M Pedersen-check constraints skipped) so the pipeline runs on a 24 GB laptop.
`light-test` verifiers are **unsound**; the claim defended is that the *verifier gas* is
structurally representative (public-input layout unchanged) while prover time/RAM are not —
the real ~12M-constraint decider needs **≥64 GB and minutes per epoch**, still unmeasured.

## 3. Trust model and the user-sovereignty mechanisms

`docs/TRUST_MODEL.md` is unusually rigorous for a prototype — every claim labelled
*proven-by-code* / *arranged-in-the-synthetic-workload* / *deferred*. The one-line framing:
**the validity proof changes the threat surface, not the privacy surface.** The operator
remains custodian and authorizer; the proof removes trust in the operator's *arithmetic*
only. New surfaces folding introduces: trusted-setup subversion (dev-mode Groth16 here),
the unaudited sonobe stack, circuit-version confusion (mitigated by `ppHash` pinning), and
a known **key↔position binding gap** — the tree uses dense slots plus an off-circuit
key→slot map, so a malicious prover could place one key at two positions; masked only because
the operator is the trusted prover, and named production requirement #1 (§4.2, §6). Privacy:
public inputs are exactly `(i, z_0, z_n)`; the one new leak is epoch op-count via step count
`i`, closed by constant-`i` padding (soundness proven by the `inactive_batch_is_noop` test).

The two most recent code commits (`7379d95` "Add user-sovereignty escape hatch, verifier
freeze, branch challenge"; documented in `docs/DECENTRALIZATION.md`) push toward
"a service you can leave" rather than a custodian:

- **Escape hatch (`exit`)** — a user unilaterally withdraws their proven balance by opening
  their leaf against `lastProvenRoot` with an on-chain Poseidon Merkle path
  (`ProvenCheckpoint.exit`, depth-22 siblings), owner-bound via
  `key = _fieldKey(msg.sender, tokenId)`, double-exit blocked by a per-`(tokenId, key)`
  nullifier. Funds cannot be trapped by a rogue or vanished operator. Tested (accept /
  double-exit / tampered balance / wrong caller) in
  `contracts/test/ProvenCheckpoint.t.sol:EscapeHatchTest`, with the on-chain `hash2` pinned
  to the circuit by fixture. The exit witness ships in `contracts/generated/proof.json`
  (`.exit.*`) so the tests exercise a *real* branch from the real proven tree.
- **Verifier freeze + timelock** — upgrades go `proposeDeciderUpgrade` → 2-day
  `DECIDER_TIMELOCK` → `executeDeciderUpgrade`; `freezeVerifier()` renounces upgradability
  entirely, deleting the governance-capture vector (`GovernanceTimelockTest`).
- **Branch challenge (`requestExitData`)** — exit needs *your* Merkle branch; this creates an
  on-chain, timestamped, attributable record of a branch request, with `exitDataOverdue`
  after `EXIT_DATA_WINDOW`. Deliberately non-blocking; binding it to freezes/slashing is a
  deployment policy choice.

The honestly-stated boundary (`docs/DECENTRALIZATION.md` §"stated honestly"): today's set
reaches **"non-custodial funds with an operator trusted only for liveness"** — the operator
still *can* move a balance in an arithmetically-valid transition before you exit, until
in-circuit user-signed debits (A1) and the key-indexed tree (A0) land. Those are specified,
deferred, and the subject of the build plan (§6 below). The doc also names the trilemma
plainly: full censorship-resistance needs public DA, which costs the amount-privacy this
design keeps — so it deliberately stops short of being a rollup.

## 4. Maturity assessment — does it actually build and run?

**What we could verify directly on this machine (no Rust toolchain installed here, so the
Solidity side is the executable evidence):**

- `forge test` in `contracts/`: **14/14 pass**, first run downloading solc 0.8.30, in
  seconds. This exercises the *committed real proof* against the *committed generated
  verifier* — the strongest possible artifact-authenticity check short of re-proving.
- The gas-metering test **regenerated `results/forge_gas.json` identical to the committed
  file** — the published numbers are machine-generated outputs, not typed-in claims.

**Structural evidence the Rust side is real (not rebuilt here, assessed from artifacts):**

- `Cargo.toml` is a coherent 3-member workspace with a committed `Cargo.lock` (3,189 lines)
  and `rust-toolchain.toml` (1.97.1, with a documented reason for diverging from sonobe's
  1.88 pin). The `[patch]`/`vendor/` section is the tell of someone who actually fought the
  build: sonobe repoints arkworks at unpinned git HEADs, `[patch]` only works from the root
  workspace, and `ark-groth16` + the flyingnobita forks pull arkworks via their own git deps
  — so `vendor/` contains algebra/snark/std/groth16/crypto-primitives/r1cs-std with git deps
  rewritten to crates.io requirements, unifying the graph to one crate per package. Nobody
  writes that machinery (or the comments explaining it) without having run the build.
- `results/prover.json` looks like a real run, not fabrication: a 12-element per-step fold
  array with realistic jitter (1,208–2,174 ms), `platform: "macos"`, ~7.0 GB peak RSS on the
  documented 24 GB machine, and an honest `light_test: true` flag; `bench/src/main.rs`
  matches the schema field-for-field and asserts `Nova z_n == native z_n` before writing.
- `contracts/generated/` holds the full prover output: sonobe-templated `NovaDecider.sol`,
  `proof.json` with a real exit-branch witness, `calldata_explicit.hex`, and the arkworks
  Poseidon fixture.

**Honest contrast with the docs' framing:** the docs *undersell* nothing and oversell
little — the repo says "working prototype + measurement harness" and that is exactly what it
is. The gaps are the ones it lists itself: `light-test` prover figures (production decider
never run — needs ≥64 GB), dev-mode Groth16 setup, unaudited everything, the key↔position
gap, synthetic workload arrangements (pre-registered accounts, one withdraw per payee in
payee order is *why* `netsAcc == withdrawalsAcc` holds exactly), single-address governance.
Minor real discrepancies found: README's deploy/settle gas (3,221,311 / 3,613,984) lag the
result files (3,221,483 / 3,616,175) by a rounding-error margin — stale prose, not stale
data. Social proof is nil and recent: **5 commits, 0 stars/forks, single author, first
commit through 2026-07-22** — a fresh one-person research artifact, which matters for how
much external review the code has had (none), not for whether it runs (it does).

## 5. Relevance to ACTA — and why it is NOT on the critical path

First, the ground truth: the ACTA post
(https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797) **contains no
mention of IVC, folding, Nova, or batched reputation updates** (confirmed by fetch,
2026-07-28). ACTA deliberately specifies *no proof system*; everything flows through the
`ICircuitVerifier` abstraction. So ivc-checkpoints connects to ACTA through the author and
through three forward-looking seams, not through the spec:

1. **Open question #6 — zkVM-vs-circuit thresholds.** ACTA asks at what proof-size /
   verification-gas / prover-latency thresholds zkVM-based `ICircuitVerifier` backends beat
   hand-written circuits. This repo is the author's best *measured* datapoint for the
   circuit+folding end of that trade: **1,028-byte proofs, ~800k constant verification gas,
   ~1.8 s/fold-step — but a decider whose fixed overhead alone is ~10.5M of 12M constraints,
   needing ≥64 GB RAM and minutes per epoch**. That prover profile is a *server* job. It puts
   a hard number on why folding backends sit far above any client-side proving threshold
   today: an agent proving on its own hardware (the ACTA-relevant regime) cannot run this
   decider, while a phone can run a Semaphore-class membership proof. The repo's own
   decomposition ("optimizing the step logic barely moves the total; the overhead is the
   folding machinery", `docs/REPORT.md` §4c) is exactly the kind of input question #6 needs.
2. **Batched zk-reputation accumulator updates.** ACTA's reputation layer will accumulate
   many small updates (feedback events, task completions) into a commitment agents later
   prove against. That is *structurally* this repo's problem: `z = [stateRoot, opsAcc,
   netsAcc]` maps directly onto `[reputationRoot, eventsAcc, …]`, and the epoch-checkpoint
   pattern — fold N updates off-chain, post one constant-gas proof — is how a reputation
   registry avoids per-update on-chain writes at scale. The measured amortization curve
   (break-even at 4 ops, ~18 gas/op at volume) tells you *when* that machinery earns its
   complexity: only once update volume is high. An early ACTA deployment won't be there.
3. **Open question #2 — recursive delegation chains.** ACTA asks for the minimum predicate
   expressiveness to verify an agent→sub-agent delegation chain without a trusted
   intermediary. IVC is the natural asymptotic answer — each fold step verifies one
   delegation hop, the verifier cost stays constant in chain depth — and this repo proves the
   author can drive that machinery end-to-end. But for the chain depths a first
   implementation will see (2–3 hops), a fixed-depth circuit or sequential verification is
   simpler and auditable.

**Why it is not on the critical path for a first reference implementation:**

- **Wrong primitive for v1.** ACTA v1 needs single-shot proofs — set membership, predicate
  satisfaction, nullifiers — verified per-action. Folding pays for itself only when
  amortizing *many* homogeneous steps into one verification; a credential presentation is
  one step.
- **The backend is quicksand right now.** Per this repo's own `README.md` §"The sonobe pin
  is `main`, not `staging`" and `docs/BUILD_PLAN_A0_A1.md`: sonobe's audited line lacks the
  EVM decider, the decider PR is a draft, and the `FCircuit` trait is changing. Building
  ACTA's reference implementation on that would couple its schedule to an upstream rewrite.
- **Unaudited + dev-setup + 64 GB prover** — all three disqualify it from a *reference*
  implementation whose purpose is to be studied and re-run by others on normal hardware.
- **ACTA's own abstraction says don't.** `ICircuitVerifier` exists precisely so backends can
  be swapped later. The right move is to ship v1 on a boring, audited single-shot system and
  keep folding as a drop-in *batch* backend behind the same interface once reputation-update
  volume justifies it — with ivc-checkpoints as the measured feasibility evidence.

## 6. BUILD_PLAN_A0_A1 — what it says about sonobe upstream

`docs/BUILD_PLAN_A0_A1.md` (latest commit, `616e2d4`, 2026-07-22) is a migration plan from
the "classic" sonobe line to the "new" line, and doubles as the best snapshot in the corpus
of **sonobe's upstream state**:

- **The audit/feature split:** sonobe's audits target the `staging` branch, but `staging` is
  a ground-up rewrite (official arkworks 0.6, gr1cs, `sonobe-primitives`/`fs`/`ivc`) with
  **no `DeciderEth`, no `solidity-verifiers`, no `NovaDecider.sol` generation, and a
  different `FCircuit` trait**. The complete Nova+CycleFold+EVM pipeline this prototype needs
  lives only on `main`/`dev` — hence the awkward pin `main @ 63f2930d` with a standing
  "MUST re-validate when the decider lands on the audited line" note (`README.md`).
- **The new line's EVM decider is a draft PR:** sonobe **PR #259** (LegoGroth16 decider,
  branch `revamp/decider`). The plan's Phase 0 spike *measured it working end-to-end* — fold
  → LegoGroth16 decider → render `DeciderVerifier.sol` → verify in revm — at
  **~669,362 gas** (trivial circuit, z_len 1) vs the classic line's 799,731 (z_len 3), i.e.
  the next line looks **~16% cheaper**; the decider proved in ~5 min within 24 GB for the
  trivial circuit. Phase 4 (the on-chain path) is explicitly **gated on PR #259 merging to
  `staging`** — "don't build the on-chain path on a moving branch."
- **Ecosystem convergence:** PSE's **plasma-blind** already lives on the new line and ships
  the two primitives the sovereignty roadmap needs — `sparsemt` (key-indexed sparse Merkle
  tree → closes the key↔position gap, A0) and `schnorr` (in-circuit user-signed debits over
  Grumpkin, A1) — with a rev-reconciliation caveat (plasma-blind pins `dmpierre/sonobe@
  8269ea4`, the decider sits on `privacy-ethereum/revamp-decider`). Design decision carried
  in: keep ECDSA for ownership/exit, add a delegated Poseidon-friendly Schnorr spend key
  bound to the ECDSA owner. The new line also changes cryptographic defaults (Griffin
  transcript, different Poseidon configs), so the on-chain hash match must be re-derived.
- **Status: Phase 0 (spike) complete and measured; Phases 1–5 pending.** The classic
  prototype stays as the reference until parity.

The takeaway for ACTA planning: even the person most invested in this stack judges the
folding backend to be **one merged draft PR, one trusted-setup ceremony, and several audit
cycles away** from something you could specify against — which independently corroborates
§5's conclusion. What the plan demonstrates *positively* is the author's working style
(measure before migrating, phase gates with go/no-go criteria, honest "what this still does
not buy" sections) — a good sign for the ACTA reference implementation itself.

---

*Verification notes for this doc: forge suite re-run 2026-07-28 on forge 1.7.1 (repo pins
1.5.1) — 14/14 pass, regenerated `forge_gas.json` byte-identical, working tree restored.
Rust workspace not rebuilt (no local toolchain); assessed from `Cargo.toml`/`Cargo.lock`,
vendoring structure, and committed artifacts. GitHub state at fetch time: 5 commits,
0 stars/forks/issues, single author (zulu0echo), latest commit 2026-07-22.*
