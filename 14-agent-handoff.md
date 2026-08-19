# Agent handoff — the state of everything (2026-08-18)

You are an agent (or a future session) taking over this repo. This doc is the
entry point: what exists, what is proven, what is not, where the traps are,
and what to do next. Everything here is either verifiable in this repo or
verified on the production deployment.

**Read order for a cold start:** `TLDR.md` → this doc → then, when a task
touches the relevant area: doc 11 (product/threat-model), doc 12 (`/demo` +
deploy pipeline + live-demo runbook), doc 13 (wallet spec).

## 1. What this project is

A working **reference implementation of ACTA** — zulu0echo's
anonymous-credentials privacy layer for ERC-8004 agents (ethresear.ch
proposal; her own PoC was audited in doc 07 and is non-functional by her own
account — everything here was built from the article, not her code).

The pitch in one line: an agent proves *"a trusted auditor certified me and I
meet your policy"* on-chain without revealing the credential, the scores, or
which credential-holder it is.

## 2. What exists and is live

- **Circuit** (`packages/circuits`): `ActaPresentation.circom`, 45,438
  constraints, proves in ~1.1s. EdDSA-BabyJubJub issuer signature in-circuit,
  LeanIMT anonymity-set membership, SMT sanctions **non**-membership, postfix
  predicate VM with in-circuit `predicateProgramHash`, context-scoped
  nullifiers. 11 witness tests incl. 8 negatives.
- **SDK** (`packages/sdk`): issuance, witness building, Poseidon commitments.
  Parity with the circuit is pinned in `docs/parity-vectors.json`.
- **Contracts** (`app/packages/foundry`): five contracts + generated Groth16
  verifier, deployed AND verified on **Base mainnet (8453)**, immutable and
  ownerless. 11/11 Foundry tests against a real proof (~490k gas).
- **Web app** (`app/packages/nextjs`), live at
  **https://anonymous-8004.vercel.app**:
  - `/` — landing page.
  - `/demo` — three-panel guided demo (issuer / verifier org / agent), real
    in-browser Groth16 proof (~1.5s), on-chain `verifyPresentation`, failure
    lab (replay, forged score, sanctioned jurisdiction, unlinkability).
    Journey pointer = exactly one primary button at any time (doc 12).
  - `/wallet` — **credential wallet v1** (doc 13), shipped 2026-08-18:
    sign-one-message unlock (HKDF(signature) → AES-GCM vault in
    localStorage), W3C VC envelope, `#import=`/`#request=` URL-fragment
    hand-offs emitted by `/demo`, plain-words policy consent read back from
    the chain, in-wallet prove + present with Basescan receipt.
- **CLI demos**: `make demo` (full loop on anvil), `make auditor` (demo C).

## 3. The map (where code lives)

```
packages/circuits/          circom source + witness tests
packages/sdk/               canonical JS SDK (Node)
app/packages/foundry/       contracts + tests + deploy scripts
app/packages/nextjs/        the deployed web app (Scaffold-ETH 2)
  app/demo/page.tsx           three-panel demo + journey step machine
  app/wallet/page.tsx         wallet v1 (~640 lines)
  utils/acta/actaSdk.ts       browser mirror of packages/sdk — see §4
  utils/acta/vault.ts         key derivation + encrypted vault
  utils/acta/vc.ts            W3C VC envelope encode/decode + fragments
  utils/acta/context.ts       contextHashFor — single source, see §4
  utils/acta/policyWords.ts   policy program → plain English
  utils/acta/prove.ts         in-browser Groth16
  public/circuits/            wasm + zkey — COMMITTED ON PURPOSE, see §5
probes/                     headless production probes — see §6
docs/                       parity vectors, gas report, latency, r1cs info
vendor-acta-poc/            her PoC, frozen, audit subject only (doc 07)
```

Docs 01–08 are the research corpus; 09 the build plan; 10 open questions for
the author; 11–13 handoffs/specs. `TODO.md` holds the ERC-8004 demand-crawl
task.

## 4. Invariants that must not drift

1. **SDK parity.** `utils/acta/actaSdk.ts` is a hand-maintained browser
   mirror of `packages/sdk`. Any change to commitments, claim normalization,
   message hashing, or program encoding must land in **both**, and
   `docs/parity-vectors.json` re-checked. The circuit and the on-chain
   verifier are immutable — the code must conform to them, never vice versa.
2. **One contextHash implementation.** `utils/acta/context.ts` is the single
   source of `contextHashFor(verifier, policyId)`; `/demo` and `/wallet`
   both import it. Never re-inline it — a drift means wallet-made proofs
   silently stop verifying for demo-made policies.
3. **The VC envelope is packaging, not crypto.** `vc.ts` round-trips the
   exact bytes the circuit consumes (`vcToCredential` rebuilds claims via
   `claimsToVector` and re-verifies the EdDSA signature). Changing the
   envelope must keep that round-trip byte-identical.
4. **`scaffold.config.ts` targetNetworks stays `[chains.base]`** — putting
   foundry first makes prod try localhost (bit once).
5. **Nullifiers are one presentation per agent per policy, forever**
   (replay → `NullifierAlreadyUsed`, `0xcad2ae02`). Every live demo needs a
   **freshly registered policy**; ≥2 policies also unlocks the unlinkability
   lab. Any previously demoed policy is spent.

## 5. Deploy pipeline

- **Push to main = production deploy.** Vercel is wired to this repo; env
  vars (`NEXT_PUBLIC_ALCHEMY_API_KEY`, WalletConnect id) are set in Vercel,
  not in the repo. This repo is an exception to "only commit when asked" —
  shipping *is* committing.
- **`app/packages/nextjs/public/circuits/` is committed on purpose.** It was
  once gitignored; prod 404'd the wasm/zkey while every local test passed.
  The on-chain verifier is pinned to that exact zkey. Never re-ignore it.
- **This Next.js build runs the React Compiler**: manual `useMemo`/
  `useCallback` that the compiler can't preserve is a **build-failing lint
  error**. The fix is deleting the manual memoization, not restructuring it.
- Before committing: scan the diff for secrets (a gitleaks hook also runs)
  and keep private/off-repo coordination content out of this public repo.

## 6. Verification discipline

**Rule (learned the hard way): nothing is "tested" until exercised on the
production URL.** Local dev servers, local builds, and local headless runs
have all produced false greens (the gitignored-wasm incident).

- `probes/` contains the headless production probes and a README with the
  gotchas (never `networkidle` on these pages; headless has no wallet so
  *Connect* is the correct CTA). Run after any deploy touching `/demo` or
  `/wallet`:
  ```sh
  node probes/walletprobe.mjs  https://anonymous-8004.vercel.app
  node probes/handoffprobe.mjs https://anonymous-8004.vercel.app
  ```
- For binary assets, `curl | xxd` the magic bytes (wasm = `00 61 73 6d`);
  for client-conditional UI, grep the deployed JS chunks.

### Wallet v1 verification ledger (as of 2026-08-18)

Verified headless **on production** (both probes exit 0): locked state,
import consent card with live EdDSA verification, claims rendering,
tampered-VC rejection, garbage-fragment survival, and the real
`/demo` → Issue → hand-off link → `/wallet` consent path.

**Still unverified — needs a human with a browser wallet (EOA):**
1. Unlock: connect on `/wallet`, sign the fixed message → vault opens.
2. Accept & store a credential arriving via `#import=`.
3. Present: `/wallet#request=<policy>` → plain-words consent → approve →
   in-wallet proof → on-chain receipt. Use a **fresh policy** (§4.5).

Until those three are confirmed by hand, treat them as unshipped.

### Known v1 wallet limits (disclosed on the page)

- **EOA-only**: unlock relies on deterministic ECDSA (RFC 6979); smart
  accounts re-signing differently shows up as "wrong key" on second unlock.
- **Master secret is still plaintext-mirrored** in `acta-master-secret`
  localStorage so `/demo` keeps working. The vault becomes its only home
  when the demo panels split into pages that talk to the wallet (v2).

## 7. Open work, ranked

1. **Human wallet verification** of the three flows above (blocks calling
   wallet v1 done).
2. **M3.5 "honest private authorization" before M4** (doc 11): action-bound
   contexts (ACTA_CONTEXT_V2), relayer submission, atomic consumer —
   closes the submitting-wallet-visible / proof-front-running gaps.
3. **ERC-8004 demand crawl** (`TODO.md`): find real credential demand on
   live registries via the local node; output a ranked outreach list.
4. Wallet v2 seams (doc 13 "out of scope"): split `/demo` into separate
   issuer/verifier pages emitting the links (three-window demo),
   E2E-encrypted sync, OpenAC/standard-suite proving lane over the same
   stored VC.
5. Audit leftovers (doc 07/12): `auditor.html` innerHTML XSS from untrusted
   `Policy.uri` (that page is undeployed — fix before deploying), mobile
   wallet deep-linking.
6. Doc 10 questions Q2 (`predicateProgramHash` semantics) and Q3 (nullifier
   scoping) remain open with the author.

## 8. How to not break the demo story

The product story is three actors — issuer, agent, verifier — and the repo's
UX work exists to make that legible. `/demo` is the guided single-player
version (one wallet, three hats, journey pointer). `/wallet` is the first
real actor-separation: the credential now has a *place*, moves by URL
fragment (provably serverless), and consent happens where custody lives.
Changes should sharpen that separation, not blur it back into one page's
localStorage.
