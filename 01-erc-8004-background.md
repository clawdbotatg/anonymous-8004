# ERC-8004 ("Trustless Agents") — Background for the ACTA Reference Implementation

> Document 01 of the ACTA research corpus. Audience: engineers writing the ACTA
> implementation plan. ACTA (Anonymous Credentials for Trustless Agents,
> [ethresear.ch/24797](https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797))
> is a privacy layer *on top of* ERC-8004; this document establishes exactly what
> ERC-8004 is, what its on-chain surface looks like, and — critically — which parts
> of that surface leak the information ACTA is designed to protect.

---

## TL;DR

- **ERC-8004 "Trustless Agents"** is a Draft Standards-Track ERC (created 2025-08-13) by
  authors from MetaMask, the Ethereum Foundation, Google, and Coinbase. It fills the
  discovery-and-trust gap left by agent communication protocols (A2A, MCP) with **three
  per-chain singleton registries**: an ERC-721-based **Identity Registry**, a
  **Reputation Registry** (client feedback), and a **Validation Registry**
  (independent verification of agent work).
- It supports three pluggable trust models: **reputation**, **crypto-economic
  validation** (stake-secured re-execution), and **TEE attestation**.
- The registries went live on **Ethereum mainnet on 2026-01-29** at vanity addresses
  (`0x8004A169…` Identity, `0x8004BAa1…` Reputation) and are deployed across 15+
  EVM chains; ~10,000+ agents registered in the first months, though usage is
  "registration-heavy but operationally shallow."
- **Everything in ERC-8004 is public and linkable by design.** Feedback is emitted in
  plaintext events keyed by the reviewer's address; client sets per agent are
  enumerable via `getClients()`; the `agentURI` registration file discloses the
  agent's full profile (endpoints, wallet, DIDs, capabilities) in one blob; Sybil
  resistance in `getSummary()` works by *identifying reviewers*; and the
  `agentId + agentWallet + DID` triple forms a cross-registry fingerprint.
  These are the **five privacy gaps ACTA targets**, documented in §5 with the exact
  spec mechanism that causes each.

---

## 1. What ERC-8004 is

### 1.1 Identity card

| Field | Value |
|---|---|
| Title | ERC-8004: Trustless Agents |
| Status | **Draft** (Standards Track: ERC) — still Draft as of mid-2026, despite mainnet deployments |
| Created | 2025-08-13 |
| Authors | Marco De Rossi (MetaMask), Davide Crapis (Ethereum Foundation), Jordan Ellis (Google), Erik Reppel (Coinbase) |
| Requires | EIP-155, EIP-712, EIP-721, EIP-1271 |
| Spec | https://eips.ethereum.org/EIPS/eip-8004 |
| Discussion | https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098 |
| Reference contracts | https://github.com/erc-8004/erc-8004-contracts |

The author list is itself notable: a cross-company collaboration (wallet vendor,
L1 foundation, the company behind the A2A protocol, and a major exchange) —
coordinated by De Rossi (MetaMask) and Crapis (EF).

### 1.2 Motivation — the A2A / agent-economy context

Agent communication protocols already exist: **MCP** (Model Context Protocol,
Anthropic) standardizes how agents call tools, and **A2A** (Agent2Agent, Google)
standardizes how agents talk to each other, authenticate, and orchestrate tasks.
Neither covers two things needed for an *open* agent economy:

1. **Discovery** — how a client (human or agent) finds an agent it has no prior
   relationship with, across organizational boundaries.
2. **Trust establishment** — why the client should believe the agent will do the
   job, without a pre-existing contract or a shared platform vouching for it.

ERC-8004's answer is a set of **three lightweight on-chain registries**, deployable
as per-chain singletons on mainnet or any L2, that give agents portable,
censorship-resistant identifiers and standard interfaces for reputation and
validation signals. The abstract frames the goal as letting participants
"discover, choose, and interact with agents across organizational boundaries"
with **pluggable, tiered trust models** whose security scales with value at risk —
"from low-stakes tasks (pizza ordering) to high-stakes work (medical diagnosis)."
Available trust mechanisms named in the spec: reputation systems, stake-secured
re-execution (crypto-economic) validation, zkML proofs, and TEE oracles.

A deliberate design choice: identity rides on **ERC-721**, so the entire existing
NFT tooling stack (wallets, indexers, marketplaces, transfer semantics) doubles as
agent-identity tooling for free.

---

## 2. The three registries — interfaces verbatim

> All signatures and events below are extracted from the ERC-8004 spec
> (https://eips.ethereum.org/EIPS/eip-8004). These are the surfaces an ACTA
> implementation must interoperate with (and, in the privacy analysis, the
> surfaces that leak).

### 2.1 Identity Registry (ERC-721 based)

Each agent is an ERC-721 token (with the URIStorage extension). The **global agent
identifier** is the pair:

- `agentRegistry` = `{namespace}:{chainId}:{identityRegistry}` (CAIP-style; e.g.
  `eip155:1:0x8004A169…`) — namespace `eip155` for EVM chains;
- `agentId` = the ERC-721 `tokenId`, assigned incrementally.

Incremental token ids mean agents are **trivially enumerable** — anyone can walk
`agentId = 1..N` and resolve every registered agent.

**Functions:**

```solidity
struct MetadataEntry {
  string metadataKey;
  bytes metadataValue;
}

function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId);
function register(string agentURI) external returns (uint256 agentId);
function register() external returns (uint256 agentId);

function setAgentURI(uint256 agentId, string calldata newURI) external;

function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
function getAgentWallet(uint256 agentId) external view returns (address);
function unsetAgentWallet(uint256 agentId) external;

function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;
function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
```

**Events:**

```solidity
event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
```

**`agentWallet` semantics** (relevant to gap #5): the reserved metadata key
`agentWallet` is the agent's payment/operational wallet. It initializes to the
owner's address, cannot be set via generic `setMetadata()`, requires an EIP-712
signature (EOA) or ERC-1271 (contract wallet) from the new wallet to change, and
is automatically cleared when the agent NFT is transferred. It is **publicly
readable** via `getAgentWallet()` and its changes are publicly evented.

**The registration file (`agentURI`).** The `agentURI` (schemes: `ipfs://`,
`https://`, base64 `data:`) MUST resolve to a JSON registration file:

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "myAgentName",
  "description": "Natural language description of the Agent",
  "image": "https://example.com/agentimage.png",
  "services": [
    { "name": "web",   "endpoint": "https://web.agentxyz.com/" },
    { "name": "A2A",   "endpoint": "https://agent.example/.well-known/agent-card.json", "version": "0.3.0" },
    { "name": "MCP",   "endpoint": "https://mcp.agent.eth/", "version": "2025-06-18" },
    { "name": "OASF",  "endpoint": "ipfs://{cid}", "version": "0.8", "skills": [], "domains": [] },
    { "name": "ENS",   "endpoint": "vitalik.eth", "version": "v1" },
    { "name": "DID",   "endpoint": "did:method:foobar", "version": "v1" },
    { "name": "email", "endpoint": "mail@myagent.com" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    { "agentId": 22, "agentRegistry": "{namespace}:{chainId}:{identityRegistry}" }
  ],
  "supportedTrust": [ "reputation", "crypto-economic", "tee-attestation" ]
}
```

Agents MAY additionally prove domain ownership by serving
`https://{endpoint-domain}/.well-known/agent-registration.json`.

Note what a single fetch of this file yields: human-readable name/description,
**every service endpoint** (web, A2A card, MCP server, email), **ENS name**,
**DID**, all cross-chain registrations, and the supported trust models. There is
no notion of partial or audience-scoped disclosure.

### 2.2 Reputation Registry

Standard interface for posting, fetching, and aggregating feedback about agents.
Bound to an Identity Registry via:

```solidity
function getIdentityRegistry() external view returns (address identityRegistry);
```

**Submitting feedback:**

```solidity
function giveFeedback(
  uint256 agentId,
  int128 value,
  uint8 valueDecimals,
  string calldata tag1,
  string calldata tag2,
  string calldata endpoint,
  string calldata feedbackURI,
  bytes32 feedbackHash
) external;
```

Constraints: `agentId` must be registered; `valueDecimals` in 0–18; the submitter
**must not** be the agent's owner or operator (self-review guard); `tag1`, `tag2`,
`endpoint`, `feedbackURI`, `feedbackHash` are optional; `feedbackHash` is the
KECCAK-256 of the `feedbackURI` content (optional / `bytes32(0)` for
content-addressed URIs). The **client address is `msg.sender`** — feedback is
inherently attributed to the caller's address. Clients do not need to be
registered themselves; the spec suggests EIP-7702 gas sponsorship for frictionless
feedback.

**The central event:**

```solidity
event NewFeedback(
  uint256 indexed agentId,
  address indexed clientAddress,
  uint64 feedbackIndex,
  int128 value,
  uint8 valueDecimals,
  string indexed indexedTag1,
  string tag1,
  string tag2,
  string endpoint,
  string feedbackURI,
  bytes32 feedbackHash
);
```

Storage split: `value`, `valueDecimals`, `tag1`, `tag2`, `isRevoked`,
`feedbackIndex` are stored **on-chain** (for composability); `endpoint`,
`feedbackURI`, `feedbackHash` are event-only. `feedbackIndex` is a **1-indexed
counter per (clientAddress, agentId) pair** — i.e., the schema itself keys
feedback by the client-agent relationship and counts its interactions.

Spec-suggested `tag1` vocabulary (illustrating how semantically rich the public
values are): `starred` (0–100 quality), `reachable`, `ownerVerified`, `uptime`,
`successRate`, `responseTime`, `blocktimeFreshness`, `revenues` (cumulative USD),
`tradingYield` (with `tag2` = day/week/month/year).

**Off-chain feedback file** (pointed to by `feedbackURI`) — MUST fields are
`agentRegistry`, `agentId`, `clientAddress`, `createdAt`, `value`,
`valueDecimals`; optional fields include the exact `endpoint` called, MCP tool
name, A2A `skills`/`contextId`/`taskId`, OASF skills/domains, and a
`proofOfPayment` object (`fromAddress`, `toAddress`, `chainId`, `txHash`) that
links the review to a **payment transaction**:

```json
{
  "agentRegistry": "eip155:1:{identityRegistry}",
  "agentId": 22,
  "clientAddress": "eip155:1:{clientAddress}",
  "createdAt": "2025-09-23T12:00:00Z",
  "value": 100,
  "valueDecimals": 0,
  "tag1": "foo",
  "tag2": "bar",
  "endpoint": "https://agent.example.com/GetPrice",
  "mcp": { "tool": "ToolName" },
  "a2a": { "skills": ["as-defined-by-A2A"], "contextId": "...", "taskId": "..." },
  "oasf": { "skills": ["..."], "domains": ["..."] },
  "proofOfPayment": { "fromAddress": "0x00...", "toAddress": "0x00...", "chainId": "1", "txHash": "0x00..." }
}
```

**Revocation and responses:**

```solidity
function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

function appendResponse(
  uint256 agentId,
  address clientAddress,
  uint64 feedbackIndex,
  string calldata responseURI,
  bytes32 responseHash
) external;
event ResponseAppended(
  uint256 indexed agentId,
  address indexed clientAddress,
  uint64 feedbackIndex,
  address indexed responder,
  string responseURI,
  bytes32 responseHash
);
```

`appendResponse` is open to anyone (agents rebutting, spam-taggers, etc.).
Revocation flips `isRevoked` but — per the spec's audit-trail guarantee — the
original event and on-chain record are never deleted.

**Read functions:**

```solidity
function getSummary(
  uint256 agentId,
  address[] calldata clientAddresses,
  string tag1,
  string tag2
) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
```

`agentId` **and** `clientAddresses` are mandatory, and `clientAddresses` **must be
non-empty** — the spec's explicit Sybil-resistance mechanism: an aggregate is only
meaningful relative to a caller-chosen set of *identified, trusted reviewers*.

```solidity
function readFeedback(
  uint256 agentId,
  address clientAddress,
  uint64 feedbackIndex
) external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked);

function readAllFeedback(
  uint256 agentId,
  address[] calldata clientAddresses,
  string tag1,
  string tag2,
  bool includeRevoked
) external view returns (
  address[] memory clients,
  uint64[] memory feedbackIndexes,
  int128[] memory values,
  uint8[] memory valueDecimals,
  string[] memory tag1s,
  string[] memory tag2s,
  bool[] memory revokedStatuses
);

function getResponseCount(
  uint256 agentId,
  address clientAddress,
  uint64 feedbackIndex,
  address[] responders
) external view returns (uint64 count);

function getClients(uint256 agentId) external view returns (address[] memory);

function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
```

In `readAllFeedback` only `agentId` is mandatory; with the other filters empty it
returns **every client address and every score** for an agent in one call.
`getClients()` returns the complete reviewer set for an agent, and
`getLastIndex()` returns exactly how many times a given client has reviewed a
given agent. The spec expects "more complex reputation aggregation" to happen
off-chain over this fully public substrate (subgraph indexers are explicitly
anticipated).

### 2.3 Validation Registry

Hooks for requesting and recording independent checks on agent work. Also bound
to an Identity Registry via `getIdentityRegistry()`.

**Request** (must be called by the agent's owner/operator; all fields mandatory):

```solidity
function validationRequest(
  address validatorAddress,
  uint256 agentId,
  string requestURI,
  bytes32 requestHash
) external;

event ValidationRequest(
  address indexed validatorAddress,
  uint256 indexed agentId,
  string requestURI,
  bytes32 indexed requestHash
);
```

`requestURI` points to off-chain data with the inputs, outputs, and information
needed to verify the work; `requestHash` is a KECCAK-256 commitment to it.

**Response** (must be called by the designated `validatorAddress`; may be called
multiple times for progressive validation):

```solidity
function validationResponse(
  bytes32 requestHash,
  uint8 response,       // 0-100: binary (0 fail / 100 pass) or spectrum
  string responseURI,
  bytes32 responseHash,
  string tag
) external;

event ValidationResponse(
  address indexed validatorAddress,
  uint256 indexed agentId,
  bytes32 indexed requestHash,
  uint8 response,
  string responseURI,
  bytes32 responseHash,
  string tag
);
```

On-chain storage per request: `requestHash`, `validatorAddress`, `agentId`,
`response`, `responseHash`, `lastUpdate`, `tag`.

**Reads:**

```solidity
function getValidationStatus(bytes32 requestHash) external view returns (
  address validatorAddress,
  uint256 agentId,
  uint8 response,
  bytes32 responseHash,
  string tag,
  uint256 lastUpdate
);

function getSummary(
  uint256 agentId,
  address[] calldata validatorAddresses,
  string tag
) external view returns (uint64 count, uint8 averageResponse);

function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);
function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes);
```

Validator incentives/slashing are explicitly out of scope — delegated to the
specific validation protocol (e.g., an EigenLayer-style restaking AVS).

---

## 3. Trust models

The spec defines three pluggable trust models, advertised per-agent in the
registration file's `supportedTrust` array
(`["reputation", "crypto-economic", "tee-attestation"]`):

1. **Reputation** — client feedback via the Reputation Registry. On-chain values
   and tags give smart-contract composability and basic filtering (by reviewer
   set, by tag); sophisticated aggregation (weighting, decay, graph analysis) is
   expected off-chain. Sybil resistance = public attribution + reviewer-set
   filtering (see gap #4).
2. **Crypto-economic validation** — stake-secured re-execution: independent
   validators re-run or check the agent's work and post a 0–100 `response` via
   the Validation Registry; economic security (staking, slashing) comes from the
   validation protocol layered on top (EigenLayer is the canonical reference).
   zkML proofs also fall under this registry's request/response shape.
3. **TEE attestation** — trusted-execution-environment oracles attest that the
   agent's computation ran in a genuine enclave; the attestation flows through
   the same Validation Registry interface (ecosystem implementations: Automata
   Network's DCAP/TDX/SEV-SNP verification, Phala's dstack).

The "tiered" framing matters for ACTA: the spec already assumes trust mechanisms
are swappable per use-case. ACTA effectively proposes a fourth, privacy-preserving
way to *consume* these signals (ZK proofs over them) without changing how they are
*produced*.

---

## 4. Security & privacy posture of the spec itself

The spec's own Security Considerations acknowledge the following (all relevant to
ACTA's motivation):

- **Sybil attacks**: reputation can be inflated via fake clients. The chosen
  mitigation is *radical publicity* — "making signals public, enabling third
  parties to build reviewer reputation systems," plus native filtering by trusted
  reviewer lists. Privacy is traded away *as the Sybil defense*.
- **Immutable audit trail**: on-chain pointers and hashes cannot be deleted —
  a feature for accountability, but it makes every leak permanent.
- **Capability verification**: registration proves the file corresponds to the
  on-chain agent, not that capabilities are real/benign — that's what the trust
  models are for.
- **Indexing**: the design *intends* for subgraph indexers to join on-chain
  feedback with off-chain files for UX — i.e., mass correlation is an expected,
  encouraged usage pattern, not an attack.

There is **no privacy section**: no confidential feedback path, no anonymous
reviewer mechanism, no selective disclosure of the registration file, no
unlinkability between an agent's identities across contexts.

---

## 5. The five privacy gaps ACTA targets

Each gap below is stated with the **exact ERC-8004 mechanism** that causes it.
These correspond one-to-one to the gaps identified in the ACTA ethresear.ch post
(zulu0echo, 2026-05-05).

### Gap 1 — Permanent public interaction graph (plaintext feedback events)

**Mechanism:** `event NewFeedback(uint256 indexed agentId, address indexed
clientAddress, …, int128 value, …, string tag1, string tag2, string endpoint,
string feedbackURI, …)` — plus on-chain storage of `value/valueDecimals/tags` and
the immutable-audit-trail guarantee.

Every feedback submission permanently publishes *(who reviewed, which agent, what
score, what kind of task, which endpoint)* with both `agentId` and
`clientAddress` as **indexed topics** — the cheapest possible query key for any
log indexer. The optional off-chain feedback file makes it worse: it can carry the
exact MCP tool used, A2A `taskId`/`contextId`, and a `proofOfPayment` tx hash
linking the review to a payment flow. A competitor can reconstruct a client's
vendor list, task mix, usage cadence, and even execution strategy (e.g.
`tradingYield` tags) from public logs, forever. Revocation (`revokeFeedback`)
only flips a flag; the emitted data is permanent.

### Gap 2 — Enumerable client-agent pairs / linkable sessions

**Mechanism:** `getClients(uint256 agentId) returns (address[])`,
`readAllFeedback(agentId, [], "", "", …)` (only `agentId` mandatory),
`getLastIndex(agentId, clientAddress)`, and the per-(client, agent) 1-indexed
`feedbackIndex` counter.

The registry doesn't merely leak individual events — it provides **first-class
view functions to enumerate the whole relationship graph**: the complete reviewer
set of any agent in one call, all of their feedback in another, and an exact
interaction count per pair via `getLastIndex`/`feedbackIndex`. Repeated
interactions by the same client are trivially correlated (same `clientAddress`,
monotonically increasing index), enabling statistical inference (frequency,
timing, score trajectories) about e.g. a fund's trading-agent usage. There is no
concept of a per-session or unlinkable identity for the client.

### Gap 3 — All-or-nothing profile disclosure (`agentURI`)

**Mechanism:** the `agentURI` registration file structure (§2.1) required by
`register(string agentURI)` / `setAgentURI`, resolved by anyone.

The registration file is a single public JSON blob carrying the agent's name,
description, **all** service endpoints (web, A2A agent card, MCP server, email),
ENS name, DID, all cross-chain `registrations`, and supported trust models.
There is no mechanism for selective disclosure — an agent cannot prove "I support
MCP version X and have the `tee-attestation` trust model" to one counterparty
without simultaneously revealing its email, its ENS name, its other-chain
registrations, and every other attribute to the entire world. `MetadataSet`
events broadcast on-chain metadata in plaintext too.

### Gap 4 — Sybil resistance via reviewer identification

**Mechanism:** `getSummary(uint256 agentId, address[] calldata clientAddresses,
…)` with the spec constraint that `clientAddresses` **must be non-empty**; plus
`giveFeedback` attribution to `msg.sender` and the Security Considerations'
public-signals Sybil mitigation.

The spec's *only* Sybil defense is that feedback is attributable: aggregates are
computed over caller-supplied lists of identified reviewers, and third parties
are expected to build *reviewer* reputation systems on the public data. This
structurally forbids anonymous feedback — a review carries weight *only if* its
author is publicly identified and separately reputable. Reviewers who would face
retaliation (e.g., a small client honestly reviewing a dominant agent, or an
agent reviewing its own platform) must either identify themselves or be excluded
from every meaningful aggregate. ACTA's core challenge is here: replace
"identified reviewer set" with "anonymous-but-provably-distinct,
provably-qualified reviewer" (context-scoped nullifiers + credential predicates).

### Gap 5 — Cross-registry fingerprinting (`agentId` + `agentWallet` + DID)

**Mechanism:** the ERC-721 `agentId` (incremental, enumerable, transfer history
public), the reserved `agentWallet` metadata key exposed via
`getAgentWallet()` and evented on change, and the optional `DID` / `ENS` service
entries in the registration file — all bound to the same token, plus the
`registrations[]` array explicitly listing the same agent's ids on other chains.

Each identifier alone is pseudonymous; the standard **binds them together
publicly**: token → owner address (ERC-721), token → payment wallet
(`agentWallet`), token → DID/ENS/endpoints (`agentURI`), token → same-agent-ids
on other chains (`registrations`). This three-plus-dimensional fingerprint
collapses contexts that decentralized-identity practice deliberately separates:
the payment wallet links on-chain money flows to the identity; the DID links to
off-chain verifiable-credential ecosystems; the endpoints link to DNS/TLS and
hosting infrastructure; cross-chain registrations defeat per-chain
compartmentalization. Any observer can pivot from any one identifier to all the
others — and to both registries' event streams (Reputation *and* Validation
share the same `agentId` key, so validation activity and feedback activity
cross-correlate too).

**Summary table:**

| # | Gap | Causal spec mechanism |
|---|-----|----------------------|
| 1 | Permanent public interaction graph | `NewFeedback` event (indexed `agentId`, `clientAddress`, plaintext value/tags/endpoint/URI); immutable audit trail |
| 2 | Enumerable, linkable client-agent pairs | `getClients()`, `readAllFeedback()` (only `agentId` mandatory), `getLastIndex()`, per-pair `feedbackIndex` counter |
| 3 | Full profile disclosure | `agentURI` registration file (all endpoints, ENS, DID, email, cross-chain registrations in one public JSON); `MetadataSet` |
| 4 | Sybil resistance requires reviewer identification | `getSummary()` mandatory non-empty `clientAddresses[]`; feedback attributed to `msg.sender`; "public signals" as the spec's Sybil answer |
| 5 | Cross-registry fingerprinting | `agentId` (ERC-721) + `getAgentWallet()` + DID/ENS in `agentURI` + `registrations[]` cross-chain list, all publicly bound to one token |

**ACTA's response (for orientation; detailed in later corpus docs):** a modular
zero-knowledge credential layer anchored to ERC-8004 — blinded credential
commitments (no on-chain attribute revelation), **context-scoped nullifiers**
(distinctness without identification, addressing gap 4 and the linkability of
gaps 1–2), predicate proofs over credentials via swappable `ICircuitVerifier`
backends (selective disclosure, gap 3; proof-system agnostic: SNARKs, STARKs,
zkVMs, post-quantum), and ZK reputation accumulators whose Merkle roots anchor
back into ERC-8004 (private consumption of the public reputation substrate).

---

## 6. Ecosystem status (as of mid-2026)

### 6.1 Deployments

- **Mainnet launch: 2026-01-29** — the core registries (curated by the 8004 team,
  repo: [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts))
  went live on Ethereum mainnet, after ~3 months on testnet during which 10,000+
  agents and 20,000+ feedback entries were logged.
- **Vanity singleton addresses**, identical across chains:
  - Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (mainnets;
    `0x8004A818…` on testnets)
  - Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
  - Deployed across: Ethereum, Base, Arbitrum, Optimism, Polygon, Linea, Scroll,
    Avalanche, BNB Chain, Celo, Gnosis, Monad, Abstract, Mantle, Soneium, Taiko.
    (Authoritative address list: the contracts repo.)
- Non-EVM ports exist: Hedera (Hashgraph Online universal registry), TRON
  (M2M TRC-8004 Registry), and Tenzro Network (ERC-8004 as native precompiles).
- The ERC itself remains **Draft** — mainnet deployment preceded EIP finalization.

### 6.2 Measured usage (empirical studies, June 2026)

Two academic studies analyzed the live ecosystem:

- *"From Agent Identity to Agent Economy: Measuring the Operational Readiness of
  ERC-8004 AI Agents"* (Mafrur & Khusumanegara, arXiv:2606.12128, June 2026) —
  first 10,000 mainnet agents (2026-01-29 → 2026-04-09):
  - Only **67 of 10,000** agents expose service records; **628 (6.28%)** have any
    reputation feedback; **19** combine metadata + services + feedback +
    cross-chain registration.
  - Heavy concentration: 394 owner wallets control all 10,000 agents; top 10
    wallets hold 51.4%; ownership Gini 0.863. One client submitted **65.8% of all
    feedback**; top 5 clients: 92.4%. Most service endpoints cluster around
    `marketplace.olas.network`.
  - Verdict: "registration-heavy but operationally shallow."
- *"Can Trustless Agents Be Trusted? An Empirical Study of the ERC-8004
  Decentralized AI Agent Ecosystem"* (arXiv:2606.26028) — companion empirical
  study of the same ecosystem.

**Implication for ACTA:** the reputation graph is currently small and dominated by
a handful of feedback clients — which makes it *more* fingerprint-able, not less
(small anonymity sets). An ACTA design must account for tiny initial anonymity
sets on the live registries.

### 6.3 Who's building on it

The community-curated [awesome-erc8004](https://github.com/sudeepb02/awesome-erc8004)
list tracks 100+ projects. Representative sample by category:

- **SDKs**: Agent0 SDK (JS/TS + Python, [sdk.ag0.xyz](https://sdk.ag0.xyz/)),
  `create-8004-agent`, `@azeth/sdk`, `erc-8004-js` / `erc-8004-py` (tetratorus),
  ChaosChain SDK (PyPI `chaoschain-sdk`), Praxis SDKs (Python/Go), `agentwallet-sdk`.
- **Explorers / indexers**: [8004scan.io](https://8004scan.io) (primary explorer,
  mobile apps), agentscan.info, 8004agents.ai, trust8004.xyz, agenteconomy.to,
  RNWY Explorer (150K+ agents indexed across chains), Agent Arena (22K+ agents,
  16 chains), Agent0 subgraph; QuickNode ships an "ERC-8004 stack" (blog +
  tooling).
- **Trust/validation infrastructure**: Automata Network (TEE attestation
  verification: DCAP, TDX, SEV-SNP), Phala Network dstack (TEE deployment),
  ChaosChain (crypto-economic validation), Assay Protocol (stake-backed
  accountability), Verity, ORIGIN Protocol, Helixa, Chitin, Ensemble, ISEK.
- **Payments**: x402 ecosystem integration (`x402Support` field in the
  registration file) — Primev, PayAI, AsterPay facilitators; Coinbase's x402
  connection reflects author overlap.
- **Privacy-adjacent** (closest neighbors to ACTA): ZKProofport AI (ZK proof
  generation), Agent Veil Protocol / agentveil SDK (off-chain EigenTrust layer).
  Nothing in the ecosystem yet provides anonymous credentials over the
  registries — the niche ACTA targets is open.
- **Community**: [8004.org](http://8004.org), the
  [ERC-8004 Telegram](http://t.me/ERC8004), the
  [Ethereum Magicians thread](https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098),
  a "Trustless Agents" co-learning course, and mainstream coverage (Forbes,
  CCN, Bitcoin.com) following the mainnet launch.

### 6.4 What this means for the ACTA implementation plan

1. **Interfaces are stable enough to target**: singleton vanity addresses on 15+
   chains, a curated reference-contracts repo, and heavy SDK/indexer investment
   mean the surfaces in §2 are the de-facto ABI even while the ERC is Draft —
   but Draft status means the plan should isolate ERC-8004 bindings behind an
   adapter in case of late interface churn.
2. **ACTA composes, not forks**: all five gaps are *inherent to the spec's data
   model* (public attribution as the Sybil defense, public JSON as the identity
   document). ACTA cannot patch them in-place; it must anchor commitments/roots
   *into* the existing registries (e.g., via `setMetadata`, feedback/validation
   URIs, or a sidecar contract referencing `agentId`) while moving sensitive
   material behind ZK proofs.
3. **Adversary model is cheap**: every leak in §5 is exploitable with a stock log
   indexer or a single `eth_call` — no sophisticated adversary required — and the
   spec *encourages* building such indexers.

---

## Sources

**Primary spec & official:**
- ERC-8004: Trustless Agents (spec) — https://eips.ethereum.org/EIPS/eip-8004
- Ethereum Magicians discussion — https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098
- Reference contracts (8004 team) — https://github.com/erc-8004/erc-8004-contracts
- Best-practices repo — https://github.com/erc-8004/best-practices
- Official site — http://8004.org
- A2A Protocol specification — https://a2a-protocol.org/latest/specification/

**ACTA:**
- Anonymous Credentials for Trustless Agents (ACTA), ethresear.ch, zulu0echo, 2026-05-05 — https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797

**Ecosystem & authorship:**
- awesome-erc8004 (curated resource list, deployment addresses, projects) — https://github.com/sudeepb02/awesome-erc8004
- Marco De Rossi, "The Story Behind ERC-8004 & Next Steps" (author affiliations, history) — https://medium.com/survival-tech/the-story-behind-erc-8004-next-steps-ec46c18d1879
- QuickNode, "ERC-8004: A Developer's Guide to Trustless AI Agent Identity" — https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/
- QuickNode, "The QuickNode ERC-8004 Stack" — https://blog.quicknode.com/the-quicknode-erc-8004-stack-a-public-window-into-onchain-agents/
- Forbes, "AI Agents Gain Trust Via Ethereum: ERC-8004 On Mainnet" (2026-02-05) — https://www.forbes.com/sites/digital-assets/2026/02/05/ai-agents-gain-trust-via-ethereum-erc-8004-on-mainnet/
- OneKey, "Everything You Need to Know About ERC-8004" (2026-02-10) — https://onekey.so/blog/ecosystem/everything-you-need-to-know-about-erc-8004-20260210113200/
- CCN, "What Is ERC-8004?" — https://www.ccn.com/education/crypto/erc-8004-ai-agents-on-chain-ethereum-how-works-risks-explained/
- Eco support docs on ERC-8004 — https://eco.com/support/en/articles/13221214-what-is-erc-8004-the-ethereum-standard-enabling-trustless-ai-agents and https://eco.com/support/en/articles/14730445-erc-8004-trustless-agent-identity
- Bitcoin.com News, "What Is ERC-8004? Ethereum's New Agent Standard…" — https://news.bitcoin.com/what-is-erc-8004-ethereums-new-agent-standard-powers-thousands-of-onchain-ai-identities/
- Pinata, "What is ERC-8004?" — https://pinata.cloud/blog/what-is-erc-8004/
- Yehia Tarek, "ERC-8004: A Trustless Extension of Google's A2A Protocol" — https://medium.com/coinmonks/erc-8004-a-trustless-extension-of-googles-a2a-protocol-for-on-chain-agents-b474cc422c9a

**Empirical studies:**
- Mafrur & Khusumanegara, "From Agent Identity to Agent Economy: Measuring the Operational Readiness of ERC-8004 AI Agents," arXiv:2606.12128 (June 2026) — https://arxiv.org/html/2606.12128v1
- "Can Trustless Agents Be Trusted? An Empirical Study of the ERC-8004 Decentralized AI Agent Ecosystem," arXiv:2606.26028 — https://arxiv.org/pdf/2606.26028
