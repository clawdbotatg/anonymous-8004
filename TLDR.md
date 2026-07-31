# TLDR

**What we're building:** A reference implementation of **ACTA** — a privacy
layer on top of [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) (the
on-chain AI-agent trust standard), from zulu0echo's research proposal:
<https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797>

**What it does:** Lets an AI agent prove things like *"a real auditor scored me
≥ 80 and I'm not OFAC-sanctioned"* with a ZK proof — without revealing its
score, jurisdiction, identity, or history. The chain only ever sees "policy
satisfied, once" plus an unlinkable nullifier that blocks replays.

**What we have so far** (2026-07-30):

- Research corpus (docs `01`–`08`) + build plan (doc `09`)
- A **working prototype** (milestones M1+M2 of 4):
  - the ZK circuit — 45,438 constraints, proves in **~1.1 s**
  - five Solidity contracts + generated Groth16 verifier — real proofs verify
    on-chain in tests (~490k gas per gate entry)
  - **`make demo`** — full CLI walkthrough on anvil, including the failure
    cases: replay reverts `NullifierAlreadyUsed`; a forged credential can't
    even build a proof; sanctioned jurisdiction is unprovable; two verifiers
    see unlinkable nullifiers
- Next: **M3** — Base mainnet deploy + the web demos. Then **M4** — the
  zk-reputation loop + ethresear.ch writeup.

**End-goal UX:** One screen, three panels — **Issuer / Agent / Verifier**.
~8 clicks: issuer signs a credential, agent anchors it among decoys, verifier
posts a policy, agent proves in-browser (real ~2 s progress bar), on-chain ✓
appears with a Basescan link. Then the kicker clicks: replay → red revert;
tampered score → proof won't build; same agent at two verifiers → two
nullifiers that can't be linked. Plus a side dashboard scoring registered
policies for **"over-asking"** (her pet question: are verifiers demanding so
much detail they de-anonymize agents?).

*Deep dives: `README.md` (index + status) → docs `01`–`09`.*
