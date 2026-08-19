# Exploration handoff — demo language, custody landscape, story bank

**Date:** 2026-08-18. **What this is:** the written-down version of a deep
exploration session, so the next agent (or future me) starts from conclusions
instead of re-deriving them. Three threads: (1) how the upstream PoC's demo
*teaches* ACTA and what of that we should adopt, (2) the credential-custody
landscape and where our `/wallet` (doc 13) sits in it, (3) a bank of
use-case stories to tell. Companion pieces: **doc 14 is the operational
half** (state of everything, invariants, verification ledger — read it
first for the build itself); `TODO.md` (the 8004 crawl); doc 13 (wallet
v1); doc 11 (M3.5 before M4 — still the standing decision).

---

## 1. The upstream demo's language, decoded

Source: the demo app vendored at `vendor-acta-poc/packages/demo-app`
(deployed by the author; the deployed build matches the vendored source at
b75e597 — verified by the "simulated ~0.13s" string, so everything below can
be checked locally). The *cryptography* in that PoC is what doc 07 audited
("nothing nefarious, nothing working"). The *pedagogy* is a different story:
it is genuinely good, and better than ours in specific ways.

### The 10-step frame

One linear flow, one actor highlighted per step on a live architecture
diagram (React Flow — issuer / agent / anchor / protocol / verifier /
nullifiers / access gate as nodes, edges light up as the flow reaches them):

1. **Actors** — issuer, agent, verifier each get a `did:ethr` identity
2. **Schema** — the credential type as a W3C VC / JSON-LD schema
3. **Issuance** — OID4VCI flow, JWT-VC signed ES256K
4. **Anchor** — commitment goes on-chain
5. **Predicate builder** — the verifier composes requirements in a form
6. **Policy registration** — requirements locked on-chain
7. **Presentation request** — OID4VP challenge to the agent
8. **Proof** — agent generates the ZK proof (simulated, 1800 ms delay)
9. **Two-phase verify** — off-chain pre-flight, then an on-chain
   **10-item checklist** rendered as ✓ rows (policy loaded → signals
   decoded → predicate hash matches → … → nullifier recorded)
10. **Access** — `AgentAccessGate.grantAccess()`, then a **replay attempt
    that visibly reverts** (`NullifierAlreadyActive`)

### The pedagogy pattern (steal this)

Every step pairs the technical panel with two devices:

- A one-sentence **"Plain language:"** analogy. The actual bank, verbatim —
  these are good and we should reuse the *genre* even where we rewrite:
  - Anchor: "The agent registers a **sealed envelope** on-chain. The
    contents are invisible — only the envelope's fingerprint is public."
  - Issuance: "Like a **PDF diploma**, but cryptographically verifiable."
  - Schema: "This is the **form the certifier fills out** about the AI
    agent — like an audit report."
  - Proof: "proving you're **old enough to enter a venue without showing
    your ID**."
  - Predicate: "like **setting hiring criteria** — you're not asking for a
    résumé, you're asking for a yes/no answer."
  - Policy: "The protocol **locks its requirements on-chain** … agents can
    trust the rules won't shift after they generate a proof."
  - Presentation request: "like a **customs officer** saying 'prove you
    have the right paperwork' — but the agent proves it privately."
  - Access: "each access is **one-time** and the agent's real identity is
    never revealed."
- A four-tab doc panel per step: **What is this / How it works / For your
  product / In the code.** The "For your product" tab is the tell about
  audience: the demo is written for a *verifier-side integrator* deciding
  whether to adopt — not for a cryptographer. Ours (doc 12's `/demo`)
  leans role-play ("you are the auditor"); the upstream leans
  adoption-pitch. Both are valid; a public-facing ACTA site probably wants
  the upstream's framing with our *working* backend.
- A **Use Cases page**: 7 tabs, each rendered as a side-by-side of the
  "plain ERC-8004 path" vs the "ACTA path" for the same scenario. The
  side-by-side format is the single most persuasive artifact in the app —
  it makes the privacy delta concrete instead of asserted.

### Adopt the language, NOT the semantics

Two places where the upstream demo's *narration* teaches the exact holes
docs 07/11 flagged and our build fixed. If we import copy, rewrite these:

1. **It anchors/narrates a cleartext `agentId`** alongside the commitment —
   the linkability hole. Ours anchors only the commitment.
2. **The session nonce participates in its context hash** — which would let
   a verifier grind linkage across presentations. Our nullifier is
   deliberately `Poseidon(masterSecret, contextHash)` with the nonce
   *outside* the derivation (doc 09 §nullifier).

Also remember the proof step is *simulated* there (fixed 1800 ms timeout,
hardcoded "~0.13s" label). Ours proves for real in ~1.1–1.5 s. When we
borrow the 10-step frame, step 8/9 become a genuine differentiator: same
story, real proof, real revert.

### Concrete adoption list for our `/demo`+`/wallet`

- Add "Plain language:" one-liners per stage (we have none).
- Add the on-chain-verify **checklist rendering** (our verify is one
  button + a receipt; the 10 ✓ rows make the contract's work legible).
- Add a **replay-reverts** beat as a first-class step — we discovered the
  "demo-again trap" (doc 12) the hard way; upstream turned the same
  property into the finale. Reframe ours likewise.
- Consider a use-cases page in the side-by-side format (see §3 bank).

---

## 2. Credential custody — the landscape

Question explored: where should an agent *hold* an ACTA credential, and
what prior art exists? Five reference points, ordered by relevance:

- **CryptKeeper (PSE — discontinued 2024).** Browser-extension "ZK identity
  wallet": pages request `connect → approve → prove`, the extension holds
  identity secrets and returns proofs, never secrets. Dead as a product,
  but its **inject → connect → approve → prove** flow is the interaction
  blueprint our `/wallet` consent card follows. Worth citing as prior art;
  not worth resurrecting the extension form factor for v1.
- **Zupass / POD + GPC (0xPARC/PSE — alive).** "Provable object data" +
  general-purpose composable proofs; battle-tested at Devcon scale. The
  lesson: credentials as small signed objects with a generic prover over
  them — structurally the same shape as our VC envelope + one circuit.
- **ZKPassport (Aztec — very alive, ~17k users).** Passport-derived creds,
  **scoped nullifiers** and **cached base proofs** (prove the expensive
  passport statement once, reuse it cheaply per-verifier). The cached-base-
  proof idea maps directly onto a future "prove credential validity once,
  derive per-policy presentations cheaply" optimization (relevant to the
  M3.5/M4 boundary and doc 05's IVC work).
- **EUDI wallet / Bhutan NDI.** The institutional lane: OID4VCI for
  issuance, OID4VP for presentation — the same grammar the upstream demo
  narrates in steps 3 and 7. Whatever wire format ACTA standardizes,
  speaking this grammar at the edges is what makes institutional issuers
  reachable. (NDI is migrating to Ethereum — a live example of a national
  credential system arriving on our turf.)
- **Privado ID → "Billions".** Pivoted explicitly to *AI-agent
  verification*. Read as both validation of the ACTA thesis and the
  incumbent to differentiate from: their stack is proprietary-ish and
  issuer-centric; ACTA's pitch is credibly-neutral public-goods rails on
  ERC-8004.

**Where our wallet v1 sits:** doc 13's `/wallet` is the "separate-origin
web wallet" recommendation implemented as an in-repo route — signMessage →
HKDF → AES-GCM vault, fragment hand-offs, consent-based proving. The
landscape says v2 pressure will come from (a) ZKPassport-style proof
caching, (b) OID4VCI/OID4VP-shaped edges for real issuers, (c) genuine
origin separation if the three-places story needs to be literally true.

---

## 3. Use-case story bank

Stories to tell, each one sentence of setup + who issues / who verifies.
The `TODO.md` crawl exists to find *real* counterparts to these on 8004.

**External:**

1. **KYC-gated participation** — an agent proves "my operator cleared KYC
   with issuer X" to enter a gated sale/pool, revealing nothing else.
   Issuer: a KYC provider. Verifier: the sale contract (M3.5's atomic
   consumer is exactly this shape).
2. **Audited-agent gate** — "audit score ≥ N by a recognized auditor"
   before an agent may act on funds. Issuer: audit firm. Verifier: any
   protocol's access gate. (This is the credential our live demo already
   issues — auditScore/jurisdiction/capabilities.)
3. **Jurisdiction / sanctions screening** — non-membership in a denylist
   without disclosing which jurisdiction you *are* in. The SMT
   non-membership branch of the circuit, already built.
4. **Capability tiers** — marketplaces gating jobs on proved capability
   bits rather than self-asserted README claims.
5. **Reputation thresholds without history disclosure** — "≥ k positive
   validations" without linking the validations to each other (M4 / the
   accumulator; blocked on M3.5 per doc 11).
6. **One-per-actor actions** — airdrops, votes, rate limits: the
   nullifier's one-presentation-per-context property used as the feature
   (sybil resistance) instead of the limitation.

**Internal (dogfooding on our own fleet):** a harness of coding agents is
itself a multi-agent economy. Candidate: agents proving to each other
"operated by the same org" / "passed the repo's shipcheck-class gate" /
"authorized for repo X" without exposing which account or machine —
i.e., use ACTA as the trust layer between our own agents, and demo *that*.
Nobody else can demo agent-to-agent anonymous credentials with real agents
doing real work; we can.

**Story-telling formats, ranked by observed persuasiveness:**
side-by-side (8004-path vs ACTA-path) > loop-closing receipt with a real
tx link (our doc 12 aha-moment) > linear step walk-through > prose.

---

## 4. Footnotes + where this fits in the ranked work

Standing state, the code map, and the ranked open-work list live in
**doc 14** — don't duplicate them here. What this exploration adds to that
list: the §1 adoption list (plain-language lines, verify checklist
rendering, replay-revert finale, side-by-side use-cases page) as `/demo`
work, and the §3 story bank as the qualitative input to the `TODO.md`
crawl (the crawl turns stories into named targets).

One footnote not recorded elsewhere: `docs/gas-report.txt` is a stale
*failing* run (512,467 vs the 500k assert); the verified passing number is
~490,507 (doc 11). Regenerate the report next time gas is touched.
