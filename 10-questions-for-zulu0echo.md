# Questions for zulu0echo — ranked by importance

Agenda for the call where we show her the demo. Each item: what we ask, why it
matters, and what we did in the meantime (so she reacts to something concrete
instead of deciding in the abstract). Run `make demo` live, then work down
this list until time runs out — the ordering is the priority.

## TL;DR (if we only get five minutes)

We built the whole v1 loop she sketched: issue → anchor → policy → prove
(~1.2s) → on-chain verify → nullifier replay protection, on real cryptography
(no sentinels), with her four focus points each demoed. To do it we had to
close gaps her post deliberately left open, and **three of those choices only
she can bless or veto**: (1) the **credential wire format** — we used
EdDSA-BabyJubJub instead of OpenAC's ES256/SD-JWT, which is the fork in the
road for everything downstream; (2) the **normative `predicateProgramHash`**
— we defined it because upstream zkID never did; (3) the **nullifier
derivation** — we kept the session nonce *out* of it to kill the
pseudonym-farming hole in her PoC. If she nods at those three, the rest is
engineering.

---

## 1. Wire format: EdDSA-BJJ (ours) vs OpenAC ES256/SD-JWT — THE fork ⭐

**Ask:** How much do you care about W3C VC / SD-JWT / OID4VCI / EUDI
alignment for v1? Is "honest crypto, bespoke envelope" acceptable, or is
interop with real-world issuers the point?

**Why it matters:** This decides the proving stack. Real OpenAC (the paper,
eprint 2026/251) proves over ordinary **ES256-signed SD-JWTs** with
transparent Spartan+Hyrax — ~99ms phone proofs, no trusted setup — but v1 of
the paper has **no nullifiers, no revocation, no on-chain verifier** (exactly
the parts ACTA adds), and in-circuit ES256 in a Groth16-style system costs
1.5–2M constraints. We chose **EdDSA-BabyJubJub-Poseidon** (circomlib): the
issuer signature verifies in-circuit at a total of 45k constraints, proving
is 1.1s in Node — but an existing SD-JWT issuer can't sign our credentials
without new tooling.

**Positions she could take:** (a) EdDSA-BJJ fine for the reference impl,
note ES256 as an `ICircuitVerifier` swap later — we're done; (b) SD-JWT
alignment is core → v2 pivots the proving stack (Spartan/zkVM behind
`ICircuitVerifier`, which is exactly what the abstraction is for); (c) hybrid
— issuer signs SD-JWT *and* a BJJ companion signature. We'd argue (a)+(c).

## 2. `predicateProgramHash` — we wrote the normative definition; adopt it? ⭐

**Ask:** Her post and zkID's generalized-predicates both *reference* a
`predicateProgramHash` but neither defines its derivation. We defined it:
`Poseidon14([VERSION=1, packedParams, predLeaf[0..3], tokenLeaf[0..7]])`,
recomputed **in-circuit** so the proof is bound to the exact program the
policy registered (no "prove predicate A, claim it was B"). Encodings for
ops/tokens/string-packing are pinned in `packages/sdk/src/constants.js` and
cross-checked SDK↔circuit↔contract in `docs/parity-vectors.json`.

**Why it matters:** It's the one piece of *spec* (not just implementation) we
authored. If she blesses it, it should go into the ethresear.ch thread / an
ACTA spec doc as normative; if she wants a different shape (different hash,
different packing, room for >4 predicates), better to hear it before anyone
else builds against ours.

## 3. Nullifier derivation: session nonce out — confirm the fix ⭐

**Ask:** Her post says nullifier inputs are "master secret + context hash of
verifier address + session nonce". Her PoC let the *holder* choose the
session nonce inside the derivation → unlimited pseudonyms per context,
which guts sybil-resistance (doc 07, hole #3). We derive
`nullifier = Poseidon2(masterSecret, contextHash)` where
`contextHash = H(domain, verifierAddr, policyId)` — the nonce is bound in
the proof (replay-freshness) but does **not** vary the nullifier. One agent
= one nullifier per (verifier, policy). Is that the intended semantics?

**Why it matters:** It's a soundness question about *her* design, and the
answer defines what "one action per agent per context" means for every
consumer (rate-limiting, one-vote, feedback dedup).

## 4. Policy registry semantics: immutable + full predicate mirror on-chain

**Ask:** We made policies immutable structs that store the **entire
predicate program** (ops, values, logic tokens) on-chain, not just its hash
— that's what makes the over-asking auditor (her focus point 3) possible
with zero off-chain infrastructure: anyone can read every policy and compute
how much of the population each one excludes. Cost: ~10 extra storage slots
per policy. Right trade, or did she imagine hash-only + off-chain descriptor
(URI) as the norm?

**Why it matters:** Focus point 3 was "are verifiers asking for too much?" —
the auditor demo is the novel artifact of this repo, and it only works if
programs are readable. If she prefers hash-only policies, the auditor needs
an indexer/IPFS story.

## 5. Anonymity-set reality check (her open question 1)

**Ask:** ERC-8004 mid-2026 reality: ~6% of registered agents have any
feedback; realistic anonymity sets are tiny. Our anchor tree is per-issuer
(LeanIMT, depth 16 ≈ 65k credentials). Does she want v1 to *surface* the
anonymity set size (e.g. the auditor already estimates "N of population
passes"), enforce minimums per policy, or leave it as documentation? And is
the per-issuer tree the right scoping, or should anchors merge across
issuers to grow the set?

**Why it matters:** It's her own #1 open question, and we now have a live
tool (the auditor) that measures exactly the compounding-constraints effect
she described. Cheap to turn into a headline feature of the writeup.

## 6. M4 scope: which reputation loop is worth building?

**Ask:** For `ZKReputationAccumulator` (focus point 2), which minimal demo
convinces: (a) blinded feedback leaves + "prove aggregate score ≥ X across
≥ k interactions" via one more Groth16 circuit; or (b) the Nova/IVC folding
route from her `ivc-checkpoints` repo (we reproduced it: 14/14 tests,
~800k constant verifier gas) for unbounded-length histories? (a) is a week,
(b) is a research project. Also: should the accumulator root land in
ERC-8004's `giveFeedback()` with the reserved tag as the post sketches?

**Why it matters:** It's the last unbuilt component and the biggest effort
fork. Her answer scopes M4.

## 7. Issuer story for the public demo (her open question 3)

**Ask:** For a Base-mainnet public demo, who plays issuer? Options: we run
a demo issuer key with a "toy issuer" banner; a small allowlisted set of
issuer keys anchored in `CredentialAnchor` (already per-issuer); or she
wants a decentralized-registry sketch even in v1. Also: does PSE/zkID want
the demo issuer to live under their umbrella (it's *their* zkID predicates
lineage), or fully independent?

**Why it matters:** Centralized issuers can deanonymize by logging issuance —
her open question 3. For a demo it's fine, but the banner text and the
writeup framing depend on how she wants that caveat told.

## 8. Publishing: co-author the ethresear.ch follow-up?

**Ask:** The plan ends with a writeup ("here's a working reference
implementation of ACTA: numbers, gas, latency, what we had to pin down").
Does she want it as a reply in her thread, a joint new post, or ours with
her review? And is she comfortable with the doc-07 audit framing ("build
from the article, not the code" — her own words) being public, or should
the PoC comparison stay private?

**Why it matters:** It's her proposal and her thread; the reference impl is
worth the most if she's holding it. Also the audit is candid — publishing
it without her sign-off would be a dick move.

## 9. Grab-bag (only if time)

- **Threshold de-anonymization (open q4):** does she want the *hook* in v1
  (an optional encrypted-identity field per presentation) or is that scope
  creep?
- **Schema slots:** SCHEMA_V1 = [auditScore, jurisdiction, capabilities,
  validUntil, 4 reserved]. Enough reserved room? Any claim she knows is
  coming?
- **Trusted setup:** dev ceremony is labelled non-production. If this gets
  real usage, does PSE want to run a small real ceremony, or is "swap to a
  transparent backend via ICircuitVerifier" the answer?
- **`principal_vc_satisfies()` (open q2, OBO):** we didn't build it. Is a
  second credential type + one extra circuit input the v2 she'd want next,
  ahead of reputation?
