# ACTA — research corpus for a reference implementation

**ACTA** ("Anonymous Credentials for Trustless Agents") is a research proposal by
**zulu0echo** (PSE/zkID, Ethereum Foundation): a **privacy layer on top of
ERC-8004**, the trustless-AI-agents standard.
Post: <https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797>

**New here? Read [`TLDR.md`](TLDR.md) first** — what this is, what works, and
the end-goal UX in four short paragraphs.

This repo is the staging ground for a **reference implementation**. Phase 1
(research corpus, complete): docs 01–08. Phase 2 (complete): the build plan,
`09-implementation-plan.md`. Phase 3 (in progress): build it.

## Status

- **Research corpus: complete** (docs 01–08 below, written 2026-07-28).
- The author's own PoC (`zulu0echo/acta-poc`) was cloned and forensically
  audited (doc 07). Verdict: **nothing nefarious, nothing functional** — the
  Solidity doesn't compile, the ZK layer is a sentinel-string stub whose fake
  path itself never ran, and the circuits have a confirmed critical soundness
  hole (issuer commitment is a free private input — anyone can "prove"
  statements about a credential no issuer signed). She herself said: **build
  from the article, not the code.** The audit confirms she's right.
- **Plan: written** (`09-implementation-plan.md`) — four milestones. **M1 and
  M2 are COMPLETE** (2026-07-28):
  - **M1**: `ActaPresentation.circom` compiles at **45,438 constraints**
    (budget <50k) — EdDSA-BJJ issuer signature in-circuit, LeanIMT anonymity
    set, SMT sanctions exclusion, in-circuit `predicateProgramHash` (defined
    here, absent upstream), postfix predicate VM, context-scoped nullifiers.
    11 witness tests incl. 8 negatives; SDK↔circuit parity pinned
    (`docs/parity-vectors.json`). Proving: **1.13s** end-to-end
    (`docs/latency.md`), gate was <15s.
  - **M2**: five contracts + generated Groth16 verifier; 11/11 Foundry tests
    against a **real proof** (~490k gas gate entry, `docs/gas-report.txt`);
    `make demo` runs the full CLI story on anvil: issue → anchor → policy →
    prove (~1.2s) → on-chain verify → **replay reverts
    `NullifierAlreadyUsed`** → tampered credential fails at witness →
    sanctioned jurisdiction unprovable → unlinkable dual-policy nullifiers.
  - **Next: M3** — over-asking auditor dashboard (demo C) + three-panel web
    demo (demo B) + Base Sepolia. Ask the wire-format question before/at M3.

## Her four focus points (from the 2026-07-28 call) → ACTA components

| Focus point | ACTA component(s) | Corpus coverage |
|---|---|---|
| 1. Credentialing (e.g. prove non-OFAC) | `CredentialAnchor` + SMT non-membership predicate | 02 §components, 03 §predicates, 06 §SMT, 08 demo A/B |
| 2. zk reputation | `ZKReputationAccumulator` → ERC-8004 Reputation Registry | 01 §reputation-registry, 02 §components, 08 demo D |
| 3. Policy registry ("are verifiers asking for too much?") | `PolicyRegistry` (on-chain predicate hashes) | 02 §components, 08 demo C — the *over-asking auditor*, the novel artifact |
| 4. Predicates ("prove score ≥ X") | `PredicateVerifier` + zkID generalized-predicates IR | 03 (the whole doc), 06 §comparators |

## File map (read in this order to go deep)

| File | What's in it |
|---|---|
| `01-erc-8004-background.md` | The base standard: three registries (Identity/ERC-721, Reputation, Validation), verbatim interfaces, trust models, the five privacy holes ACTA targets, and mid-2026 ecosystem reality (live on 30+ chains at `0x8004…`, but only ~6% of agents have feedback — anonymity sets are empirically tiny). |
| `02-acta-proposal.md` | The full proposal: five interface components + `ICircuitVerifier` abstraction, 10-step protocol flow, six use cases, seven open research questions, the thread replies, and everything the post deliberately does *not* specify (8 implementer degrees of freedom; it contains zero Solidity). |
| `03-predicates-and-openac.md` | The proof machinery: zkID generalized-predicates (postfix boolean programs over `(claimRef, op, value)` triples; `predicateProgramHash` is **not defined upstream** — it's our work) and the real OpenAC paper (transparent Spartan+Hyrax over ES256 SD-JWTs, ~99 ms phone proofs, but v1 excludes nullifiers/revocation/on-chain verification — exactly what ACTA adds). Composition diagram + wire-format landscape (SD-JWT, BBS+, OID4VP, EUDI). |
| `04-acta-poc-repo.md` | Survey of her PoC **as documented** — intent, four ADRs, roadmap, the surprise second proving stack (`openac-sdk/`, Spartan2+Hyrax/secp256r1), and a 26-item claims-to-verify list. Written blind to correctness; doc 07 is ground truth. |
| `05-ivc-checkpoints.md` | Her *other* repo: Nova+CycleFold folding (sonobe), ~800k constant verifier gas — **independently reproduced here** (14/14 Foundry tests pass, byte-identical gas results). Genuine work; not on the v1 critical path, but the datapoint for open question #6 and a future batched-reputation backend. |
| `06-building-blocks.md` | The toolbox: Semaphore v4 (fork skeleton), circomlib (EdDSA + comparators + SMT, with footguns), zk-kit, circom/snarkjs/Groth16 vs Noir, browser-proving latency benchmarks (<50k constraints → single-digit seconds), issuance tooling, ERC-8004 deployments. Ends with a default-stack recommendation. |
| `07-code-audit.md` | **The audit** of `acta-poc` @ `b75e597`: clean nefarious scan (evidence given), 13 independent breaks (5 compile-fatal, proven by execution), the sentinel-proof ZK theater (even the fake verifier rejects its own fake proofs), the confirmed issuer-binding soundness hole with full exploit path, four additional holes (cleartext `agentId`, farmable nullifier pseudonyms, missing range checks — a V1→V2 regression, owner-swappable verifier), what's genuinely reusable, reality-vs-claims scorecard, and the pitfalls checklist for our build. |
| `08-demo-ideas.md` | Five demo concepts ranked by effort (CLI non-OFAC walkthrough → three-panel web demo → over-asking auditor → zk-reputation loop → full Base Sepolia), each mapped to her focus points, with pitch ordering and a "convincing vs vaporware" section. |

## Vendored source (gitignored — re-clone to reproduce)

```sh
git clone https://github.com/zulu0echo/acta-poc vendor-acta-poc
git -C vendor-acta-poc checkout b75e597   # commit the audit (doc 07) ran against
git clone https://github.com/zulu0echo/ivc-checkpoints vendor-ivc-checkpoints
git -C vendor-ivc-checkpoints checkout 616e2d4
```

## Ground rules for the build phase

1. **Build fresh from the article + this corpus**; use `vendor-acta-poc/` only
   to understand intent and avoid its mistakes. The pitfalls checklist is
   doc 07 §pitfalls — headline items: bind the issuer signature in-circuit,
   no cleartext `agentId` or static per-credential public signals, range-check
   both comparator sides, constrain expiry in-circuit, keep the session nonce
   out of nullifier *derivation* freedom (no unlimited pseudonyms), no
   owner-swappable verifier without timelock, rate-limit reputation writes.
2. Target chain for the shareable demo: **Base Sepolia** (anvil locally).
3. No public RPCs; scan for leaked secrets before any commit.

## The one question only she can answer

How much does she care about **W3C/SD-JWT/OID4VCI/EUDI wire-format
alignment**? Doc 03 sharpened this: real OpenAC proves over ordinary
ES256-signed SD-JWTs with transparent proofs (no trusted setup) — but has no
nullifiers or on-chain verifier, and in-circuit ES256 costs 1.5–2M constraints
(research-grade). The pragmatic EdDSA-BabyJubJub/Circom route (doc 06) is
honest cryptography but not the OpenAC wire format. **Ask before building past
the first milestone.**

## Key external links

- ACTA post: <https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797>
- ERC-8004: <https://eips.ethereum.org/EIPS/eip-8004>
- OpenAC paper: <https://eprint.iacr.org/2026/251>
- PSE zkID: <https://github.com/privacy-ethereum/zkID>
- Her repos: <https://github.com/zulu0echo/acta-poc> · <https://github.com/zulu0echo/ivc-checkpoints>
- Build libs: circomlib · zk-kit · snarkjs · Semaphore v4 (design reference)
