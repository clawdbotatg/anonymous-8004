# The ACTA Proposal — Anonymous Credentials for Trustless Agents

**Primary source:** [Anonymous Credentials for Trustless Agents (ACTA) — A Privacy Layer for the On-Chain Agent Economy](https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797), ethresear.ch topic 24797. Posted **2026-05-05** by **zulu0echo** (display name "zoey", PSE / zkID team, Ethereum Foundation; contact via [x.com/0xZoey](https://x.com/0xZoey)). Acknowledgments in the post: [Davide (Crapis)](https://x.com/DavideCrapis), Nam, [Marco (de Rossi)](https://x.com/marco_derossi), Thore, and [Vivian (Plasencia)](https://x.com/ViviPlasenciaC) for feedback and reviews. Raw content retrieved via `https://ethresear.ch/t/24797.json` (3 posts: the proposal + 2 replies, documented in §9).

This document is intended as a **complete substitute for reading the post**: every component, flow step, use case, open question, and reference in the source is captured here. Where the post is silent, §10 says so explicitly.

> **Note on fidelity:** the post contains **no Solidity code blocks, no diagrams, and no tables** — the five interfaces and `ICircuitVerifier` are named and described entirely in prose (inline code identifiers only). All identifier names, event names, error names, and predicate examples below are reproduced verbatim from the post; there is no fuller interface text to quote. Deriving concrete Solidity signatures is implementer work (see §10).

---

## 1. TL;DR

ERC-8004 ("Trustless Agents") gives AI agents on-chain identity, reputation, and validation registries — but every feedback signal, credential check, and delegation is permanently public, producing an interaction graph that is itself sensitive data (for a DeFi protocol routing execution through agents, "that interaction graph *is* the alpha"). **ACTA** proposes a composable privacy layer that sits **above ERC-8004 without modifying it**, built from anonymous credentials, zero-knowledge predicate proofs, and context-scoped nullifiers. Agents prove claims — personhood, audit score, model provenance, reputation thresholds, jurisdiction — without revealing underlying data, and can prove a **verified human principal** stands behind them (personhood credentials, Adler et al. 2024) without disclosing who. Five on-chain components (`IOpenACCredentialAnchor`, `IPolicyRegistry`, `IPredicateVerifier`, `INullifierRegistry`, `IZKReputationAccumulator`) compose around a single proof-system-agnostic abstraction, **`ICircuitVerifier`**, so SNARKs, STARKs, zkVMs, and future post-quantum systems are swappable per policy without changing any ACTA contract. The post is a **draft / request for collaboration**, not a finished spec: it walks through use cases "deployable today", lists seven open research questions, and invites the ERC-8004 authors and protocol builders to engage. (The post's own TL;DR says "seven concrete on-chain use cases"; the body enumerates six headed use cases — see §6.)

---

## 2. Motivation

### 2.1 Framing scenario (verbatim in substance)

Consider a DeFi protocol that routes execution through specialised AI agents — a liquidity routing agent, a risk assessment agent, a liquidation agent — each registered on-chain via ERC-8004 and building reputation through verifiable feedback as trades settle. The routing agent calls the risk agent fifty times a day; the liquidation agent receives quality scores every block. Every interaction is permanently public: calling address, agent identifier, feedback score, task endpoint tag. Anyone running an event indexer can reconstruct exactly which protocol is using which execution layer, how often, with what quality outcomes, and which agent vendors are winning the market. For a protocol whose edge is its execution strategy, **the interaction graph *is* the alpha** — publishing it by default is "not just a privacy concern, it is an immediate economic attack surface."

This is not confined to DeFi: "*any onchain interaction where participants are routing resolution queries through AI agents will expose their workflows.*" The properties that make on-chain agent trust valuable — verifiable reputation, auditable credential claims, composable feedback — are the same properties that make the current ERC-8004 design incomplete for many real on-chain use cases.

The cryptographic ingredients ACTA assembles: ZK proofs let an agent prove it satisfies a score threshold, holds an approved model hash, and is outside a sanctions list — privately; anonymous credential schemes let reputation feedback be submitted without linking to the submitter's address; nullifier mechanisms prevent double-use without identity disclosure.

### 2.2 ERC-8004 background as the post states it

ERC-8004 addresses how agents and clients establish trust across organisational boundaries without pre-existing relationships, via three registries:

- **Identity Registry** — a portable **ERC-721-based** identifier per agent.
- **Reputation Registry** — a standard interface for posting/reading feedback signals, composable with any scoring system.
- **Validation Registry** — agents request and record independent verification of their outputs.

The post calls this "the right foundation" and positions ACTA as "an extension of that foundation" — a **complement, not a competitor**.

### 2.3 The five privacy gaps ("The Privacy Gap")

ERC-8004's current design creates **five specific, exploitable vulnerabilities** for any deployment where the interaction graph carries personal, economic, or regulatory sensitivity:

1. **Permanent public interaction graph.** The `NewFeedback` event emits `clientAddress`, `agentId`, `value`, and task tags in plaintext, immutably on-chain. *Attack scenario given:* a competing DeFi protocol indexes these events to identify which execution agents a rival uses, how frequently, and with what quality ratings — reconstructing its AI execution strategy in real time.
2. **No unlinkability across sessions.** `readAllFeedback()` enumerates every interaction for any given client address and agent. Multiple interactions by the same client are trivially linkable, enabling statistical inference about trading patterns or analytical workflows.
3. **No selective disclosure of credentials.** An agent's `agentURI` registration file exposes all capabilities, endpoints, DID, ENS name, and wallet address simultaneously. A counterparty asking "is this agent compliant for my jurisdiction?" receives the agent's full operational profile, including potentially commercially sensitive details.
4. **Sybil resistance requires reviewer identification.** ERC-8004 itself acknowledges that `getSummary()` requires a non-empty `clientAddresses[]` filter because unfiltered results are vulnerable to Sybil spam — so the intended mitigation forces reviewers to be identifiable on-chain.
5. **Cross-registry fingerprinting.** The combination of `agentId` (ERC-721 token), `agentWallet` (explicitly linked on-chain), and the optional `DID` field in the registration file forms a unique three-dimensional fingerprint that collapses separated identity contexts into a single traceable profile across on-chain and off-chain systems.

### 2.4 The core idea

Real-world analogy: with anonymous credentials you present a proof saying only "this person's birthdate, attested by a government issuer, satisfies the predicate `age ≥ 18`". Scaled to on-chain agents: a DeFi risk-management contract needs to verify that an execution agent has a sufficient audit score, an approved model version, and an operator not on an OFAC list. With anonymous credentials:

- The agent generates **one proof** that its credential satisfies all three predicates simultaneously.
- The protocol verifies the proof **on-chain**.
- **One event** is emitted: an unlinkable nullifier and the policy ID that was satisfied.

The agent's actual audit score, model hash, and jurisdiction are never published anywhere.

---

## 3. The five components ("ACTA: Possible Components")

The post's heading — "**Possible** Components" — signals draft status. Each component is described in prose only; everything the post says about each is captured below.

### 3.1 Credential Anchoring — `IOpenACCredentialAnchor`

The **prerequisite that all downstream proof flows depend on**. Before an agent can make anonymous presentation proofs, it registers a cryptographic **commitment to its credential** on-chain: a **blinded hash of the agent's master secret combined with its credential attributes**. This proves the credential exists and was validly issued without revealing any attribute value. The anchor contract:

- verifies a **zero-knowledge proof of correct commitment formation** — using **whichever `ICircuitVerifier` the operator selects**;
- then stores only: the **commitment hash**, the **issuer key commitment**, the **credential schema identifier**, and an **expiry timestamp**.

No credential details appear on-chain. (The name reflects the OpenAC anonymous-credential scheme — see §8 references — and in the protocol flow the concrete contract is called `OpenACCredentialAnchor`.)

### 3.2 Policy Registry — `IPolicyRegistry`

A **verifier** (a DeFi protocol, a DAO, an on-chain compliance oracle) registers a **policy** as a **boolean predicate program**, e.g. verbatim:

```
audit_score >= 80 AND operator_jurisdiction_not_in(OFAC_LIST)
```

The policy lives on-chain **as a hash**. The `PolicyDescriptor` includes:

- the **predicate program hash**,
- the **credential schema**,
- the **issuer commitment**,
- a **validity window**, and
- **critically, the address of the `ICircuitVerifier` implementation** to use for proof verification.

**Policies are immutable once registered.** Registration happens via `IPolicyRegistry.registerPolicy()`, which locks these fields in under a `policyId` (per the protocol flow, §4 step 6).

### 3.3 Predicate Verification — `IPredicateVerifier`

Handles **per-call verification** when an agent presents a proof that its credential satisfies a registered policy. It:

1. reads from `IPolicyRegistry`;
2. **delegates verification to the registered `ICircuitVerifier`**;
3. registers the resulting nullifier;
4. emits a **`PresentationAccepted`** event containing **only the policy ID, the nullifier, and an expiry timestamp**.

No agent identity, no attribute values, no wallet address are revealed. Entry point named in the flow: `IPredicateVerifier.verifyPresentation()`.

### 3.4 Nullifier Registry — `INullifierRegistry`

Nullifiers are **context-scoped**: each is derived from the **agent's master secret combined with a context hash that includes the verifier's address and a session nonce**. Consequences:

- The same agent's nullifier for verifier A is **computationally unrelated** to its nullifier for verifier B (cross-verifier unlinkability).
- Within a single session context, **double-use is detected and rejected** — per-session Sybil resistance **without global identity disclosure**.

### 3.5 ZK Reputation Accumulator — `IZKReputationAccumulator`

Private feedback that stays composable with ERC-8004:

- Clients submit reputation feedback as a **zero-knowledge proof** demonstrating (a) they hold a **valid interaction credential** and (b) they have **not already submitted feedback in this context**.
- Feedback values are stored as **blinded Merkle tree leaves** — committing to the nullifier and value while **hiding the value from the event log**.
- The accumulator **writes its Merkle root back into ERC-8004's existing Reputation Registry** using the **standard `giveFeedback()` interface with a reserved tag**, maintaining composability with any ERC-8004-aware reputation aggregator.
- An agent can later **prove its aggregate anonymous score exceeds a threshold** without revealing any individual feedback entry.

### 3.6 The proof-system abstraction — `ICircuitVerifier`

Not one of the five storage/registry components but the load-bearing abstraction beneath them. From the post's TL;DR: it "**intentionally decouples ACTA from any specific proof system: SNARKs, STARKs, zkVMs, and future post-quantum constructions are all first-class backends, swappable per policy without changing the ACTA contract.**" Each policy pins its verifier address at registration (§3.2); `IPredicateVerifier` delegates entirely to it (§3.3); the credential anchor uses whichever one the operator selects (§3.1).

The author's reply in the thread (verbatim, post 60035): *"We propose ACTA to specify no proof system or DID method. The `ICircuitVerifier` interface is the single normative abstraction through which all proof verification flows. The internal structure of the proof is entirely implementation-defined. A policy registered today using a classical SNARK verifier coexists with a policy registered tomorrow using a STARK verifier, and a policy next year using a zkVM proof. In none of these cases does any ACTA contract change. What is important is that the proof is generated client-side or through private delegation. This abstraction matters because the proof system landscape is moving fast."*

---

## 4. The protocol flow ("Example: Protocol Flow") — 10 steps

Reproduced with every detail the post gives per step:

1. **Actors Created.** Issuer, Agent, and Verifier each get a **`did:ethr`** identity anchored to an Ethereum address.
2. **Schema Configured.** The Issuer defines what an **`AgentCapabilityCredential`** contains — fields like `auditScore`, `operatorJurisdiction`, and `capabilities`.
3. **Credential Issued.** The Issuer issues the agent wallet a **signed JWT-VC**; **the credential stays off-chain**.
4. **On-Chain Anchor.** The agent computes a **commitment and Merkle root over its credential** and writes them to **`OpenACCredentialAnchor`**, **specifying the `ICircuitVerifier` implementation it will use for proofs**.
5. **Predicate Built.** The Verifier defines its compliance rules as a structured predicate (post's example: `auditScore ≥ 80 AND caps ⊇ 'evm-execution'`), **compiles it using the OpenAC `generalized-predicates` package** *[the post literally carries the placeholder "GP-PACKAGE-API: substitute actual compiler call"]*, and derives a **deterministic `predicateProgramHash`** *[again marked "GP-PACKAGE-API: substitute actual hash computation method"]*.
6. **Policy Registered.** The Verifier calls **`IPolicyRegistry.registerPolicy()`** on-chain, locking in the predicate hash, trusted issuer commitment, and the address of the chosen `ICircuitVerifier` under a **`policyId`**.
7. **Presentation Request.** The Verifier sends the agent the `policyId`, a **fresh `sessionNonce`**, and **its address** — scoping the proof to this interaction only.
8. **Proof Generation.** The agent's **OpenAC wallet** compiles the predicate via the `generalized-predicates` package *[GP-PACKAGE-API placeholder again]* and generates a **ZK proof client-side**, with **public outputs `nullifier`, `contextHash`, and `predicateHash`** — but **no credential values**.
9. **Verified.** The Verifier submits the proof to **`IPredicateVerifier.verifyPresentation()`**. The contract **delegates entirely to the registered `ICircuitVerifier`**, registers the nullifier, and emits **`PresentationAccepted(policyId, nullifier, expiryTimestamp)`**.
10. **Access Granted.** The agent presents its nullifier to **`AgentAccessGate`** — **granted on first use, reverted with `NullifierAlreadyActive` on replay**.

Footnote in the post, verbatim in substance: "**Revocation is considered out of scope for this post.** PSE has extensive research on revocation design strategies" — linking to [privacy-ethereum/zkID/revocation](https://github.com/privacy-ethereum/zkID/tree/main/revocation).

Implementation-plan signals worth flagging: the `[GP-PACKAGE-API]` placeholders in steps 5 and 8 show the post was written **before the `generalized-predicates` compiler API was pinned down** — the exact compile call and `predicateProgramHash` derivation must be sourced from the zkID/OpenAC codebase. `AgentAccessGate` (step 10) is a sixth contract appearing only in the flow, an example consumer/gate, not listed among the five components.

---

## 5. Use cases ("Use Cases: On-Chain Applications")

Six headed use cases (the TL;DR says "seven"; six appear — likely counting the intro's risk-management example or an editing artifact).

### 5.1 DeFi Protocol Agent Delegation
As protocols route execution through specialised AI agents, how should a protocol's contracts trust those agents? Under ERC-8004, every delegation check and quality rating a protocol posts is permanently public. Under ACTA: the protocol registers a capability policy in `IPolicyRegistry`; the agent presents an anonymous predicate proof against it via `IPredicateVerifier`. The protocol **chooses its ZK backend when it registers the policy**, and the contract calling `verifyPresentation` is **indifferent to which backend was chosen** — it reads the same `policyId` and receives the same `PresentationAccepted` either way.

### 5.2 Censorship-Resistant Agent Reputation
Prediction markets, lending protocols, and any system relying on agent quality signals: under ERC-8004, meaningful reputation can only be submitted by identified reviewers (because `getSummary()` requires a non-empty `clientAddresses[]` filter against Sybil attacks), so anonymous sources cannot contribute. Any actor — a dominant protocol, a well-resourced competitor — who can identify and pressure a reviewer can suppress their feedback entirely. The participants best placed to identify misconduct are silenced because speaking up is economically self-destructive: a prediction-market participant flagging a biased resolution agent permanently links their address, and therefore their open positions. ACTA's ZK reputation accumulator resolves this: any credential holder submits feedback without their address on-chain; the nullifier mechanism prevents double-voting; the accumulator root is anchored back into ERC-8004's Reputation Registry as a composable signal.

### 5.3 Private Credential Verification for Agent-to-Agent and Agent-to-Protocol Interactions (compliance / FATF)
As agents execute swaps, loans, transfers, and contract calls on behalf of human principals, regulated protocols must verify the agent's **operator** has passed credential checks, operates in a permissible jurisdiction, and is not on a sanctions list — **without** the agent broadcasting its operator's identity to the whole chain per transaction. ERC-8004 has no mechanism for this: the agent's public registration links its `agentId` to its operator's wallet directly. Under ACTA, the agent anchors a credential from a compliant identity provider, a policy is registered requiring (verbatim) `operator_jurisdiction_not_in(sanctionsList) AND credential_tier >= required_tier`, and the agent presents anonymous predicate proofs to regulated protocols. The post says this "maps directly to how [FATF's Travel Rule](https://www.fatf-gafi.org/content/dam/fatf-gafi/recommendations/Best-Practices-Travel-Rule-Supervision.pdf) is expected to apply to autonomous agents under emerging guidance."

### 5.4 Self-Sovereign Agent Identity Across Protocols
A credential-verified agent on Uniswap's agent delegation framework should carry its reputation and compliance proofs to Aave — to any ERC-8004-compatible protocol — without reconstructing its interaction history per protocol. ERC-8004's portability exists but exposes the agent's full cross-protocol interaction history to anyone correlating `agentId` across registries: operational history, vendor relationships, and credential profile become permanently legible. Under ACTA the agent presents **fresh anonymous predicate proofs to each protocol, scoped by context-specific nullifiers**: each protocol gets its required verification; **no cross-protocol interaction graph is constructible from chain data**. "An agent's identity is something its principal has the final say over and, more importantly, portable without being linkable."

### 5.5 Permissionless Agent Reputation Bootstrapping
A new agent faces a cold-start problem: no reputation, no history, no social proof. The current fix — accumulate public feedback — forces the agent to expose its entire early interaction history to permanent indexing before it has any market position to protect. Under ACTA an agent bootstraps reputation through the ZK accumulator **from its first interaction**, accumulating anonymous but verifiable signals without a permanent public graph. When it later proves to a prospective protocol that its aggregate score exceeds a trust threshold, **that proof is valid regardless of whether the underlying feedback was submitted under ERC-8004's public model or ACTA's anonymous model** — because the accumulator's Merkle root is anchored into ERC-8004's Reputation Registry as a standard feedback signal.

### 5.6 Personhood Credentials and the Human-Behind-the-Agent Problem
The other use cases concern the **agent's** credentials; this one concerns the **principal layer**: how does a DeFi protocol, prediction market, or DAO governance contract know an agent acts on behalf of a **real human** rather than a fully autonomous bot with no accountable principal? Adler, Hitzig, Jain et al. (2024) define this as the **personhood credential (PHC)** problem: a PHC certifies its holder is a real person without revealing further identifying information, using the same unlinkable pseudonymity and ZK properties ACTA applies to capability claims. That paper identifies **verified delegation to AI agents as one of the three primary PHC use cases**:

- a principal links their personhood credential to an agent they control;
- the agent proves to services that **a real human is accountable for its actions without disclosing who that human is**.

Acute today for governance: a DAO wanting to restrict voting or proposal rights to human-backed agents "currently has no privacy-preserving mechanism to enforce this."

---

## 6. Open questions for the community (all seven, verbatim in substance)

1. **Anonymity set sizing.** The anonymity guarantee of a predicate proof is bounded by the number of other agents whose credentials satisfy the same predicate; each additional attribute constraint in a policy compounds the problem, potentially deanonymising an agent even when each individual constraint seems benign. What minimum threshold is appropriate for different risk contexts? One promising direction named: a **VOPRF network** (Verifiable Oblivious Pseudorandom Function).
2. **Privacy-preserving on-behalf-of (OBO) delegation.** The OpenID Foundation's 2025 whitepaper on agentic AI identity identifies the move from agent impersonation to explicit delegated authority as the most urgent unsolved problem in the space. A proper OBO flow requires a credential encoding two identities — delegating human principal and acting agent — but publishing both on a public chain permanently creates a delegation graph that is itself sensitive data. ACTA's **`principal_vc_satisfies()` predicate** offers a ZK path: an agent proves its delegating principal holds a valid credential satisfying a policy without revealing who that principal is. Open subquestions: how should this interact with existing **OAuth 2.0 Token Exchange** flows off-chain? For **recursive delegation** (agent → sub-agent), what is the minimum predicate expressiveness needed to verify the entire chain without a trusted intermediary?
3. **Issuer bootstrapping and centralisation risk.** Who issues `AgentCapabilityVC`s in practice? Audit firms and TEE attestation services are the obvious candidates, but a small number of trusted issuers becomes a trust bottleneck, and centralised issuers can **de-anonymise credential holders by logging issuance**. Is there a credible path to decentralised issuer registries for agent capability credentials that remain Sybil-resistant without reintroducing a trusted party at the registry layer? What are potential approaches for decentralised credential issuance?
4. **Threshold decryption as a standard extension.** ACTA is fully anonymous by default — a nullifier on-chain cannot be linked to its agent without the agent's master secret. Right default, but it leaves an abuse gap: a malicious anonymous agent has no accountability mechanism. Should ACTA define a standard extension for **threshold-committee de-anonymisation** — a multi-sig or threshold signature scheme among nominated trustees that can, upon on-chain proof of demonstrated abuse, reveal the agent behind a specific nullifier? What governance mechanism selects and rotates the committee without recreating centralisation?
5. **Cross-chain credential portability with unlinkability.** Bridging credential Merkle roots across chains naively re-creates a linkability vector — the same root appearing on multiple chains can be correlated with the original anchoring transaction. Is there a sound design for cross-chain portability that preserves unlinkability?
6. **Client-side proving.** What are the practical thresholds — in **proof size, on-chain verification gas, and prover latency** — at which **zkVM-based `ICircuitVerifier` implementations** become preferable to **circuit-based** ones for the ACTA use cases?
7. **Private trust graphs for agent-to-agent interactions.** ACTA's current credential model is agent-centric: an `AgentCapabilityVC` attests to what a single agent *is*. In a multi-agent economy, trust increasingly depends on what two agents *are to each other* — prior verified interaction, delegated relationship, shared principal. Open question: can a network of such private credentials form a trust graph that is **locally verifiable** (each agent proves only its immediate relationships) while remaining **unlinkable globally**, so an observer cannot reconstruct the broader network topology? How should these credentials be issued, by whom, and under what revocation model?

---

## 7. Call to action (draft status and audience)

- **To the ERC-8004 authors:** ACTA is a complement, not a competitor; design-compatibility concerns are best surfaced now.
- **To DeFi protocol developers, prediction market teams, infrastructure builders:** "the six use cases in this post are our best guess of where the demand might be" — feedback on deployment blockers is more valuable at draft stage than at final review. (Note the post here says *six*, contradicting its own TL;DR's *seven*.)
- **PSE's Private Proving team is soliciting protocol-design proposals and submissions** — reach out via [x.com/0xZoey](https://x.com/0xZoey) or comment on the thread.

---

## 8. All references cited in the post

From "Further Reading" plus inline links:

- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) — the base standard.
- [OpenAC: Open Design for Transparent and Lightweight Anonymous Credentials — IACR ePrint 2026/251](https://eprint.iacr.org/2026/251) — the anonymous-credential scheme ACTA's anchor/wallet/`generalized-predicates` machinery is named after.
- [PSE/zkID GitHub — privacy-ethereum/zkID](https://github.com/privacy-ethereum/zkID) — home of the zkID generalized-predicates work.
- [AI Agents with Decentralized Identifiers and Verifiable Credentials (arXiv 2511.02841)](https://arxiv.org/pdf/2511.02841).
- [Personhood credentials: Artificial intelligence and the value of privacy-preserving tools to distinguish who is real online (arXiv 2408.07892)](https://arxiv.org/pdf/2408.07892) — Adler, Hitzig, Jain et al. 2024, basis of §5.6.
- [zk API Usage Credits: LLMs and Beyond (ethresear.ch t/24104)](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104).
- [privacy-ethereum/zkID — revocation research](https://github.com/privacy-ethereum/zkID/tree/main/revocation) — cited for the out-of-scope revocation footnote.
- Inline: [FATF Travel Rule best-practices PDF](https://www.fatf-gafi.org/content/dam/fatf-gafi/recommendations/Best-Practices-Travel-Rule-Supervision.pdf) (§5.3); the OpenID Foundation 2025 agentic-AI-identity whitepaper is referenced in open question 2 but **not hyperlinked** in the post.

---

## 9. Discussion thread (as of 2026-07-28: two replies)

**Reply 1 — kalikho (Roshan Singh), 2026-05-15** (verbatim): "Does ACTA plan to use OpenAC for the condition predicate implementations? There can be scenarios where some protocols need to support complex predicate logic or dynamic predicates. Circuit-based approaches for such scenarios would be difficult from an implementation perspective."

**Reply 2 — zulu0echo (zoey), 2026-05-20** (verbatim, and load-bearing for implementers): "We propose ACTA to specify no proof system or DID method. The `ICircuitVerifier` interface is the single normative abstraction through which all proof verification flows. The internal structure of the proof is entirely implementation-defined. A policy registered today using a classical SNARK verifier coexists with a policy registered tomorrow using a STARK verifier, and a policy next year using a zkVM proof. In none of these cases does any ACTA contract change. What is important is that the proof is generated client-side or through private delegation. This abstraction matters because the proof system landscape is moving fast."

Takeaways: (a) the one community critique on record is about **expressiveness of circuit-based predicates for complex/dynamic policy logic** — the implied answer is that a zkVM backend behind `ICircuitVerifier` covers those cases; (b) the author confirms **neither the proof system nor the DID method is normative**, and (c) states a normative-sounding constraint absent from the original post: proofs must be generated **client-side or through private delegation** (never by handing raw credentials to the verifier).

---

## 10. What the proposal does NOT specify — degrees of freedom for an implementer

The post is a draft sketch, and the author explicitly declines to pin down several layers. An implementation plan must choose:

1. **Proof system.** Explicitly unspecified (reply 2: "no proof system"). Anything behind `ICircuitVerifier` — Groth16/Plonk-class SNARKs, STARKs, zkVM proofs (Risc0/SP1-class), future post-quantum systems — is conformant, chosen **per policy** at registration. The only stated constraint: proving happens client-side or via private delegation. Open question 6 (gas/proof-size/latency crossover between circuit and zkVM backends) is left as research.
2. **DID method.** Explicitly unspecified (reply 2: "no DID method"). The protocol flow *uses* `did:ethr` for all three actors, but that is an example, not normative.
3. **Interface signatures.** No Solidity is given anywhere. Only names and behaviors are fixed: the five interfaces, `ICircuitVerifier`, `registerPolicy()`, `verifyPresentation()`, `giveFeedback()` (ERC-8004's, with a reserved tag), the `PolicyDescriptor` field list, the `PresentationAccepted(policyId, nullifier, expiryTimestamp)` event, the `NullifierAlreadyActive` revert, and the `AgentAccessGate` example consumer. Parameter types, return values, access control, and storage layout are all implementer's choice.
4. **Credential wire format & issuance mechanism.** The flow shows a **signed JWT-VC** kept off-chain, issued after an issuer-defined schema (`AgentCapabilityCredential` with `auditScore`, `operatorJurisdiction`, `capabilities`) — but no issuance protocol (OIDC4VCI, DIDComm, bespoke), no schema registry mechanism, and no attribute encoding are specified. Who issues at all is open question 3.
5. **Predicate compilation toolchain.** Steps 5 and 8 defer to the OpenAC/zkID **`generalized-predicates` package** with literal `[GP-PACKAGE-API: substitute actual …]` placeholders — the concrete compiler call and the `predicateProgramHash` derivation must be taken from the zkID codebase (or re-specified).
6. **Revocation.** Explicitly **out of scope** for the post, with a pointer to [PSE's revocation research](https://github.com/privacy-ethereum/zkID/tree/main/revocation). Note the anchor and policy both carry expiry/validity windows, so time-bounding exists even without revocation.
7. **Cryptographic constructions.** Commitment scheme, hash functions, master-secret handling, exact nullifier derivation (only its inputs — master secret + context hash of verifier address + session nonce — are stated), Merkle tree parameters for both the credential (step 4) and the reputation accumulator, and the blinding scheme for feedback leaves are all unspecified.
8. **Deployment specifics.** No chain(s), no gas targets, no upgrade/governance model for the registries (only that *policies* are immutable), no anonymity-set minimums (open question 1), no cross-chain design (open question 5), no threshold de-anonymisation extension (open question 4), and no OBO/`principal_vc_satisfies()` spec (open question 2 — the predicate is named but never defined).

In short: ACTA fixes the **component topology, event/nullifier semantics, and the ERC-8004 composition points** (anchor → policy → predicate proof → nullifier → accumulator root via `giveFeedback()`), and deliberately leaves the **cryptographic backend, identity method, wire formats, and issuance ecosystem** open. That is the design space the implementation plan must close.
