# 08 — Demo ideas, ranked by effort

**TLDR:** Five demo concepts for ACTA, smallest first: **(A)** a CLI-only non-OFAC walkthrough with real Groth16 proofs verified on anvil (~2–4 days, the credibility baseline); **(C)** a policy-registry "over-asking auditor" dashboard (~3–5 days, the genuinely novel artifact — nobody has built this); **(B)** a three-panel Issuer/Agent/Verifier web demo where every click is a real proof or tx (~1.5–2 weeks, the conference-talk piece); **(D)** a zk-reputation loop feeding an accumulator and closing back into ERC-8004's Reputation Registry (~1–2 weeks on top of A/B); **(E)** full ERC-8004 integration on Base Sepolia (~2–3 weeks, the "this is real infrastructure" finale). Recommended pitch: open with B's unlinkability moment (or A's terminal version if B isn't built), then C as the surprise, then D/E as roadmap. The one non-negotiable across all five: **no sentinel proofs** — her own PoC's ZK layer bottoms out in `StubWalletUnit` emitting the `OPENAC_TEST_PROOF_V1` sentinel accepted by `TestOpenACSnarkVerifier` (see `vendor-acta-poc/docs/ARCHITECTURE.md` L177), and the demo's core job is to visibly *not* do that.

---

## Context: what she asked for, what she already has

zulu0echo's four focus points from the call:

1. **Credentialing** — e.g. prove non-OFAC status
2. **zk reputation** — anonymous feedback, provable aggregates
3. **Policy registry** — "are verifiers asking for too much?"
4. **Predicates** — "prove score ≥ X"

The [ACTA proposal](https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797) defines five components — **CredentialAnchor**, **PolicyRegistry**, **PredicateVerifier**, **NullifierRegistry**, **ZKReputationAccumulator** — a 10-step flow (issue → anchor → policy registration → proof → verify → nullifier registration → `PresentationAccepted`), and deliberately abstracts the proof system behind `ICircuitVerifier` ("SNARKs, STARKs, zkVMs … swappable per policy").

Her PoC (`vendor-acta-poc/`) already contains real assets we should reuse, not rewrite:

- **Circom circuits** that were written but never wired end-to-end with real proving in the demo path: `circuits/presentation/OpenACGPPresentation.circom` (+V2), `circuits/lib/{NullifierDerive,PredicateEval,PostfixEval,MerkleProof}.circom`, `circuits/anchor/OpenACCredentialAnchor.circom`.
- **Solidity** for four of the five components: `packages/contracts/contracts/core/{OpenACCredentialAnchor,GeneralizedPredicateVerifier,NullifierRegistry,ZKReputationAccumulator}.sol` (policy registration lives inside the predicate verifier).
- **Credo.ts issuer/holder/verifier nodes** (OID4VCI / OID4VP, `did:ethr`).
- A **fully simulated** React demo-app (`packages/demo-app/src/simulation/SimulationEngine.ts`, `mockIssuer.ts`) — pedagogically nice, cryptographically empty. This is the thing our demo must be the opposite of.

The "real ZK" lift is therefore not "write circuits" — it's **compile hers, run the Groth16 setup (`packages/contracts/scripts/setup-circuits.sh`), deploy the generated verifier instead of `TestOpenACSnarkVerifier`, and prove with real witnesses**. That reframing makes every estimate below smaller than it would be from scratch.

---

## The five demos, smallest first

### A. CLI-only non-OFAC walkthrough — *the smallest real thing*

**Story / audience.** A terminal session an ethresear.ch reader can reproduce in ten minutes: an issuer issues a credential (`jurisdiction`, `audit_score`) to an agent; the agent anchors a commitment on a local anvil chain; the agent proves *"my jurisdiction is not in the OFAC list AND my audit_score ≥ 80"* without revealing either value; the verifier contract accepts it, registers a nullifier, emits `PresentationAccepted`; replaying the same proof **reverts**. The audience is anyone who reads the proposal and thinks "sure, but does it actually work" — and, first among them, zulu0echo herself.

**Focus points:** 1 (credentialing / non-OFAC), 4 (predicates / score ≥ X). Touches 3 implicitly (a policy is registered as a predicate hash before proving).

**ACTA components exercised:** CredentialAnchor, PolicyRegistry (as embedded in the predicate verifier), PredicateVerifier, NullifierRegistry. Not the accumulator.

**Real vs mocked:**
- *Real:* Groth16 proof from the compiled `OpenACGPPresentation` circuit (snarkjs), real Poseidon commitment anchored in a real tx, real generated verifier contract on anvil, real nullifier storage, real revert on replay. OFAC non-membership as a real Merkle non-inclusion (or sorted-list range) proof against a published sanctions-list root.
- *Mocked:* the issuer is a script with a local key (no OID4VCI ceremony); the "OFAC list" is a small fixture list with a documented real-world ingestion path; single chain, single account.

**Effort:** ~2–4 focused days. Circuit compile + trusted-setup script + a ~300-line TS/foundry driver script + fixtures.

**Wow moment:** the last three lines of the terminal:
```
✓ proof verified on-chain      (gas: 2xx,xxx)  PresentationAccepted(policyId=…, nullifier=0x3f…)
✗ replay of same proof         REVERTED: NullifierAlreadyUsed()
✗ tampered credential (score 79) proof generation FAILED at constraint …
```
A demo that shows its own failure modes reads as engineering; one that only shows success reads as theater.

---

### C. Policy-registry "over-asking auditor" — *the novel artifact*

**Story / audience.** Her focus point 3 verbatim: *"are verifiers asking for too much?"* Because ACTA policies are **on-chain predicate hashes with registered descriptors**, the policy registry is — for the first time — an auditable public record of *what verifiers demand of agents*. Build a dashboard that enumerates registered policies and scores each one: number of constraints; how many attributes it touches; whether it requests disclosures vs predicates; and an **anonymity-set estimate** — given a modeled attribute distribution, how many credential holders could satisfy this policy? A policy demanding `jurisdiction = CH AND audit_score ≥ 95 AND capability ∈ {rare}` shrinks the satisfying set to a handful of agents, making "anonymous" presentation de-anonymizable in practice. The dashboard flags it: **"this policy over-asks — effective anonymity set ≈ 4."** Audience: EF/PSE colleagues and the ethresear.ch thread — this is a *research contribution shaped like a demo*, and it's the one nobody (including her PoC) has built.

**Focus points:** 3 (its whole reason to exist), with 4 as substrate (policies *are* predicates).

**ACTA components exercised:** PolicyRegistry deeply (enumeration, descriptor parsing, predicate-hash preimage registration); CredentialAnchor read-only (anchored population as the anonymity-set denominator).

**Real vs mocked:**
- *Real:* reads real registered policies from a real chain (anvil seeded, or Base Sepolia if E lands); real predicate parsing (reuse `packages/shared`'s predicate hashing / zkID GP IR); the scoring math is real and documented.
- *Mocked:* the attribute distribution used for anonymity-set estimates is a modeled population (declared openly — it's a privacy *estimate*, like a k-anonymity calculator); the seeded policies are written by us to span the good→abusive spectrum.

**Effort:** ~3–5 days given A's contracts are deployed. No proving required at all — it's chain-reading + analysis + a small web UI. Cheapest per unit of novelty on this list.

**Wow moment:** a sorted leaderboard of verifier policies with a red **"anonymity set: 4 — over-asking"** badge next to a plausible-looking DeFi policy, and a green "anonymity set: 12,000" next to a minimal one. It turns an abstract governance worry into a number on a screen — and suggests a norm ("policy privacy score") the ecosystem could actually adopt.

---

### B. Three-panel web demo — *the story in eight clicks*

**Story / audience.** One screen, three panels: **Issuer**, **Agent (holder)**, **Verifier**. A conference-talk / live-call demo telling the whole 10-step flow in ~8 clicks — and **every click is a real proof or a real tx** (this is the explicit anti-thesis of her demo-app, which is beautiful but 100% `SimulationEngine`). Click 1: issuer signs credential. Click 2: agent anchors commitment (tx hash appears, links to explorer/anvil). Click 3: verifier registers policy. Click 4: agent generates proof *in-browser* (snarkjs WASM, a real progress bar for the ~seconds of proving — the wait itself is evidence). Click 5: verify on-chain → `PresentationAccepted`. Clicks 6–8 are the failure trilogy:
- **Tampered credential** (flip audit_score 85→79) → witness generation fails locally, proof never even exists;
- **Replay** the old proof → on-chain revert `NullifierAlreadyUsed`, shown as the actual revert;
- **Same agent, two verifiers** → two `PresentationAccepted` events side by side with visibly unrelated nullifiers, plus a "try to link them" panel that can't.

**Focus points:** 1, 4 directly; 3 (the verifier panel registers a policy — and can embed C's over-asking score right there); 2 optionally via D as a fourth act.

**ACTA components exercised:** CredentialAnchor, PolicyRegistry, PredicateVerifier, NullifierRegistry — the full presentation path. (Accumulator only if D is folded in.)

**Real vs mocked:**
- *Real:* every proof (browser-side Groth16 over her circuits), every tx (anvil or Base Sepolia), the nullifier unlinkability (real `NullifierDerive` with verifier-address + nonce in the derivation), all three failure modes.
- *Mocked:* the three "organizations" are three panels of one page with local keys; OID4VCI/OID4VP transport is skipped (direct hand-off between panels) — declared as out of scope, since the crypto, not the transport, is the claim under test.

**Effort:** ~1.5–2 weeks given A exists (A *is* B's backend; B adds the UI, browser proving, and the choreography). Reuse her demo-app's layout/steps as visual scaffolding but rip out `SimulationEngine` — the diff itself ("same UI, now real") is a nice talking point.

**Wow moment:** the two-verifiers panel — one agent, two `PresentationAccepted` events, two nullifiers that share no bytes — followed immediately by the replay revert. Unlinkability *and* Sybil-resistance in the same 20 seconds, both on-chain.

---

### D. zk-reputation loop — *closing the circle into ERC-8004*

**Story / audience.** Focus point 2 end-to-end: clients who interacted with an agent submit **anonymous feedback** — each submission a ZK proof of (a) holding a valid interaction credential and (b) not having already submitted (nullifier per feedback epoch) — into the **ZKReputationAccumulator** (blinded leaves in a Merkle tree). Then the flow reverses: the *agent* proves **"my aggregate feedback ≥ X over ≥ N submissions"** against the accumulator root, and that proof lands in ERC-8004's **Reputation Registry** — reputation earned anonymously, spent publicly, with no individual reviewer ever exposed. Audience: the ERC-8004 authors and ethresear.ch — this answers the proposal's "censorship-resistant reputation" and "permissionless reputation bootstrapping" use cases with running code.

**Focus points:** 2 (entirely), 4 (the aggregate ≥ X predicate), 1 (feedback requires a credential).

**ACTA components exercised:** ZKReputationAccumulator (the one component A–C never touch), NullifierRegistry (double-feedback prevention), PredicateVerifier (aggregate threshold), plus the ERC-8004 Reputation Registry interface on the way out.

**Real vs mocked:**
- *Real:* the accumulator contract (hers exists: `core/ZKReputationAccumulator.sol`), real feedback proofs, real double-submission revert, real aggregate proof. This needs **one new circuit** (aggregate-over-blinded-leaves ≥ threshold) — the only from-scratch circuit work in the whole plan; the rest reuse her `MerkleProof`/`NullifierDerive` gadgets.
- *Mocked:* the "interaction credentials" entitling clients to leave feedback are issued by our demo issuer (in reality they'd attest a completed task); the ERC-8004 Reputation Registry can be a minimal local deployment if E hasn't landed.

**Effort:** ~1–2 weeks on top of A/B, dominated by the aggregation circuit and its tests.

**Wow moment:** five anonymous feedback proofs go in (the sixth from a repeat reviewer **reverts**); the agent comes out with one proof: *"aggregate ≥ 4.0 across ≥ 5 reviews"* — posted to a reputation registry that never learns who said what, or even the exact average.

---

### E. End-to-end ERC-8004 integration on Base Sepolia — *the "it's infrastructure" finale*

**Story / audience.** A real agent registered in a real **ERC-8004 Identity Registry** on Base Sepolia, with the full ACTA stack deployed beside it as the privacy sidecar the proposal describes ("complements, not replaces"). A gating consumer contract (mock DeFi vault) checks `PresentationAccepted` before accepting the agent's delegation. Everything from A/B/D, but with block-explorer links instead of localhost — every claim in the demo is independently checkable by anyone, forever. Audience: the ethresear.ch thread and the ERC-8004 working group; this is the demo that upgrades ACTA from "proposal with a PoC" to "deployed reference implementation," and the natural substrate for the eventual writeup.

**Focus points:** all four (it's the union of A–D on a public testnet).

**ACTA components exercised:** all five, plus ERC-8004 Identity + Reputation registries, plus a consumer contract.

**Real vs mocked:**
- *Real:* everything on public testnet — deployments, proofs, nullifiers, the ERC-8004 registration (her PoC already targets `did:ethr` on Base Sepolia, so the chain choice is continuous with her work). The demo README links every tx.
- *Mocked:* testnet ETH obviously; the DeFi vault is a minimal mock consumer; issuer remains demo-keyed (a real issuer federation is roadmap, and should be *said* to be roadmap).

**Effort:** ~2–3 weeks total assuming A/B/D exist (deployment hardening, gas realities — proof verification cost becomes a measured number worth reporting — faucet/ops friction, docs). Do not start here: it's the same code as A–D with higher ambient friction.

**Wow moment:** pasting a Base Sepolia explorer link into the call chat: *"that's the `PresentationAccepted` event — click it."* Nothing beats the audience verifying the demo themselves on infrastructure we don't control.

---

## Recommended pitch ordering (hook first)

For a call/meeting with her, don't present in effort order — present in *story* order:

1. **Hook — the unlinkability + replay double-punch.** Open with B's two-verifiers/replay sequence (or A's terminal finale if only A is built). 60 seconds, zero slides, ends on a revert. Establishes immediately that the ZK layer is real — the exact axis on which her own PoC is soft, so it's the first question she'll silently be asking.
2. **The surprise — C, the over-asking auditor.** She named focus point 3 as a question ("are verifiers asking for too much?"); C answers it with an artifact she hasn't seen anywhere, built on *her* registry design. This is the moment the demo stops being "you implemented my spec" and becomes "your spec enables something new."
3. **The full story — B start to finish**, eight clicks, narrating the 10-step flow.
4. **The circle — D**, reputation in anonymously, out provably, into ERC-8004.
5. **The roadmap — E** as "and all of this is one deploy script away from Base Sepolia" (or, if E is done, close by pasting the explorer link).

If only one thing can be built before the call: **A**, then live-code the pitch around the terminal. If two: **A + C** — smallest combined effort, covers three of her four points, and includes the novel one.

## What makes a demo convincing vs vaporware

The difference is checkable, not aesthetic:

- **Real proofs.** Groth16 over compiled circuits with a real (dev-ceremony, and say so) setup. Proving takes visible seconds — *show the wait*. Print proof size, constraint count, verification gas. **No sentinel strings:** her PoC's `StubWalletUnit` → `OPENAC_TEST_PROOF_V1` → `TestOpenACSnarkVerifier` path must be provably absent — deploy only the generated verifier, and make `grep -r OPENAC_TEST_PROOF demo/` returning nothing part of the README.
- **Real txs.** Every on-chain claim has a hash; on testnet, a public explorer link. On anvil, show the cast/foundry receipt, not a UI toast.
- **Visible failure modes.** A demo that can't fail proves nothing. Every concept above ships its negatives: tampered credential → constraint failure, replay → revert, double feedback → revert, over-asking policy → red badge. Rehearse the failures as carefully as the successes.
- **Reproducible.** `git clone && make demo` in a README a stranger can run. The ethresear.ch audience doesn't watch demos — it re-runs them.
- **Honest seams.** Label every mock out loud (demo issuer keys, modeled anonymity distributions, skipped OID4VP transport). Confessing the mocked 20% is what makes the real 80% believable — the failure of the simulated demo-app isn't that it mocked things, it's that the mocking was silent.

## Cross-cutting notes

- **Build order = effort order** (A → C → B → D → E): each reuses the last's artifacts, and there's a credible stopping point after every stage.
- **Reuse her code visibly.** Building on `vendor-acta-poc`'s circuits and contracts (fixing/wiring rather than replacing) is both faster and better politics: the demo validates her design instead of competing with it. Where we must diverge (e.g. deploying the real verifier), note it as "PoC gap closed," referencing her own `SECURITY_AUDIT.md` remediation item.
- **A standalone PolicyRegistry contract** may be worth extracting (her PoC folds policy registration into `GeneralizedPredicateVerifier`; the proposal names `IPolicyRegistry` as its own component) — C benefits from clean enumeration, and it tightens spec-to-code correspondence.
