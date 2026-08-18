# The credential wallet — spec (v1)

**Status:** spec, not yet built. **Motivation:** doc 11's two biggest demo
gaps — actor separation (one wallet currently plays all three roles) and
credential custody (the credential silently lives in the demo page's
localStorage; "where does the agent *hold* it?" has no answer). This mini-app
is the answer to both, and it turns the abstract three-party story into three
actual places.

## What it is

A small **credential-wallet app**: the place an agent keeps its credentials
and the place proofs get generated. Think password manager, not MetaMask —
MetaMask holds keys and signs transactions; this holds *credentials* and
generates *ZK proofs about them*.

## Where it lives

**A `/wallet` route in the existing Next.js app (`app/packages/nextjs`)** —
its own layout, its own visual identity, no shared nav with `/demo`. Not a
separate deployment.

Why in-repo: it reuses the in-browser Groth16 prover, the circuit assets
(`public/circuits/` — committed on purpose, see doc 12), the SDK, and the
scaffold-eth contract hooks; one push still deploys everything. Why its own
look: the narrative requires the wallet to read as a *different place* than
the issuer's page and the verifier's page. Peel it out to its own domain
later if the story demands it — nothing below prevents that.

## v1 scope

### 1. Sign in with your wallet key (no accounts, no passwords)

- Connect wallet → sign one **fixed, versioned message** (e.g.
  `ACTA Wallet v1 — unlock`) → HKDF the signature into a symmetric key
  (AES-GCM).
- Same wallet + same message = same key, deterministically, on any device.
- Nothing is stored server-side. Locking = forgetting the derived key.
- Trap to respect: signatures over the same message are deterministic for
  ECDSA in practice via RFC 6979, but **some wallets/AA accounts don't
  guarantee it** — v1 targets EOAs and states so.

### 2. Encrypted local store

- Credentials stored in `localStorage` (or IndexedDB), encrypted under the
  derived key, keyed by wallet address.
- Plaintext exists only in memory while unlocked.
- v1 is single-device by design. (v2: optional sync through a dumb KV store
  that only ever sees ciphertext.)

### 3. Credential format: W3C VC envelope

- The stored object is a **W3C Verifiable Credential** wrapper around the
  existing ACTA credential: `issuer`, `credentialSubject` (score,
  jurisdiction, the holder commitment), `proof` = the existing
  EdDSA-BabyJubJub signature (as a custom proof type).
- Same bytes into the circuit as today — the envelope is packaging, not a
  crypto change. It makes the credential legible to anyone who knows the VC
  data model, and leaves a clean seam for a future OpenAC/standard-suite
  proving lane over the same stored object.

### 4. Receive flow (issuer → wallet)

- The issuer page stops writing to its own localStorage. After signing, it
  produces a **hand-off link / QR**: `/wallet#import=<base64url(VC)>`.
- URL **fragments never reach a server** — the credential moves
  browser-to-browser with no intermediary.
- The wallet shows a consent card — issuer, claims, signature-verified badge
  — and only stores on **Accept**.

### 5. Present flow (verifier → wallet → chain)

The demo's "generate proof" step moves *into the wallet*:

- The verifier page produces a **proof request** link:
  `/wallet#request=<base64url({policyId, callbackHint})>`.
- The wallet resolves the policy on-chain and renders the request in plain
  words: *"Policy #N asks you to prove: score ≥ 60, jurisdiction not
  sanctioned. It will NOT learn your score, your jurisdiction, or which
  credential you used."* — the policy-legibility promise, made concrete at
  the exact moment of consent.
- On approve: pick the matching credential, generate the Groth16 proof
  in-wallet (~1s), present on-chain from the wallet's connected account (v1;
  a relayer is doc 11's M3.5 and out of scope here).
- Show the receipt (reuse `/demo`'s receipt-card pattern — see doc 12).

### 6. Wallet home

- Card per credential: issuer, claims, anchored-or-not (live check against
  `CredentialAnchor`), issued date.
- Per-credential actions: present (against a chosen policy), export
  (download the VC JSON), delete.
- Empty state teaches the model in one sentence and links to the issuer demo.

## What v1 unlocks

- **The three-window demo:** issuer page in one browser profile, wallet in a
  second, verifier in a third — three roles, three keys, no shared
  localStorage. This replaces `/demo`'s one-wallet-three-hats compromise for
  live presentations (keep `/demo` as the guided single-player version).
- A concrete answer to custody: signed off-chain, held by the agent,
  revealed to no one — only the commitment ever touches the chain.

## Explicitly out of scope for v1

- Cross-device sync (v2: E2E-encrypted KV; server sees ciphertext only).
- OpenAC / standard-suite proving lane (the VC envelope is the seam for it).
- Multi-issuer aggregation and MPC/decentralized issuance.
- Relayer submission (M3.5) and account-abstraction wallets.
- Mobile-native anything; v1 is a web page that works on a phone browser.

## Build notes

- Most of the work already exists: prover invocation, SDK witness building,
  contract hooks, receipt card. New work = key-derivation + encrypt/decrypt
  wrapper, the two `#fragment` hand-off flows, and the card UI.
- Order: store + import first (visible progress fast), then the present flow,
  then split `/demo`'s panels into issuer/verifier pages that emit the links.
- QA per doc 12: it isn't done until the flows run on the production URL.
