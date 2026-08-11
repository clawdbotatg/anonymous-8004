# ACTA critical product handoff

**Date:** 2026-08-10  
**Purpose:** Preserve the current product and technical assessment for the next
agent or a future maintainer. Read this after `TLDR.md` and `README.md`, and
before starting M4 or making additional public claims.

## Executive conclusion

This repository contains a real and unusually solid cryptographic prototype:
the circuit constrains issuer signatures, holder binding, predicates, expiry,
anonymity-set membership, sanctions-list exclusion, policy binding, and
context-scoped nullifiers; real Groth16 proofs verify on-chain; and negative
tests cover the principal soundness failures found in the original PoC.

It does **not yet demonstrate the article's complete privacy or authorization
story end to end**. The current web flow submits a proof from a visible wallet,
uses a public demo issuer secret, records acceptance without performing a
meaningful protected action, permits proof-copy/front-running denial of
service, and gives each credential only one presentation per policy forever.

The project should presently be described as:

> An executable research reference for private, policy-bound credential
> predicates for agents, including a concrete predicate encoding, nullifier
> construction, and policy privacy auditor.

It should **not yet** be described as a production credential network, an
end-to-end private agent execution system, an OFAC compliance product, an
interoperable OpenAC implementation, or a complete ERC-8004 privacy layer.

The recommended next milestone is not the reputation accumulator. It is an
honest private authorization flow that binds a proof to a useful action and
supports privacy-preserving submission.

## Sources and scope reviewed

The assessment covered:

- the ACTA research proposal as captured in `02-acta-proposal.md`;
- ERC-8004 background and privacy analysis in `01-erc-8004-background.md`;
- the original incomplete `zulu0echo/acta-poc` audit in `07-code-audit.md`;
- research and design documents `03` through `10`;
- the Circom circuit, SDK, CLI demo, policy auditor, Solidity contracts,
  Foundry tests, Scaffold-ETH app, Base deployment metadata, and repository
  history;
- the original ACTA post:
  <https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797>;
- ERC-8004: <https://eips.ethereum.org/EIPS/eip-8004>.

This review was read-only except for adding this handoff and linking it from
the README. It did not redeploy contracts or alter application behavior.

## What the research article is trying to achieve

ACTA is motivated by a problem larger than selective disclosure. ERC-8004's
public identities, feedback, validation, and wallet activity allow observers to
reconstruct which agents and protocols interact. For commercially sensitive
agent workflows, the interaction graph itself may reveal strategy.

The intended outcome is therefore:

1. An issuer privately gives an agent a credential.
2. A verifier publishes a policy describing the minimum facts it needs.
3. The agent proves the credential satisfies that policy without revealing the
   credential, holder identity, attributes, or cross-protocol history.
4. A context-scoped nullifier enforces the verifier's intended rate or replay
   rule without creating a global identifier.
5. A consumer uses that successful presentation to authorize something useful.
6. The submission mechanism does not simply recreate the identity link through
   the transaction sender.

The current implementation handles steps 1 through 4 cryptographically, but
the demo does not yet complete steps 5 and 6 as a product.

## Current implementation map

### Circuit and SDK

- Circuit: `packages/circuits/src/ActaPresentation.circom`.
- Browser/Node-compatible encoding and credential logic:
  `packages/sdk/src/` and the browser port at
  `app/packages/nextjs/utils/acta/actaSdk.ts`.
- Browser witness construction and proving:
  `app/packages/nextjs/utils/acta/prove.ts`.
- Measured size: 45,438 constraints.
- Measured Node proving time in the committed report: about 1.1 seconds.
- Public browser artifacts are approximately 6.2 MB WASM and 21 MB zkey.
- The checked-in browser artifacts use a **development ceremony**, not a
  production trusted setup.

The soundness core is materially better than the original PoC:

- The holder commitment is derived from the master secret.
- Claims are bound to an EdDSA-BabyJubJub issuer signature in-circuit.
- The issuer public-key hash is public and policy-bound.
- Predicate programs are hashed in-circuit.
- Comparator operands are range-checked.
- Credential expiry is checked in-circuit.
- LeanIMT membership hides which leaf belongs to the holder.
- A sparse Merkle non-membership witness enforces the demo denylist.
- Nullifiers are stable within a context and change across contexts.

### Contracts

The Scaffold-ETH app contains the canonical contract copies under
`app/packages/foundry/contracts/`:

- `CredentialAnchor.sol`: one append-only LeanIMT per issuer address.
- `PolicyRegistry.sol`: permissionless immutable policy registration, including
  the full compiled predicate program.
- `PredicateVerifier.sol`: checks policy bindings, time freshness, context,
  roots, field bounds, proof validity, and then consumes the nullifier.
- `NullifierRegistry.sol`: one-shot wiring to the predicate verifier and
  policy-scoped nullifier storage.
- `AgentAccessGate.sol`: example consumer that records that a nullifier entered.
- `Groth16CircuitVerifier.sol` plus the generated verifier.

The five core contracts are recorded as deployed to Base mainnet in
`app/packages/foundry/deployments/8453.json`. This deployment is best treated
as a public research artifact. It is not production-ready merely because the
contracts are verified and live.

### Web demo

The main demo is `app/packages/nextjs/app/demo/page.tsx`:

- A single connected wallet plays issuer, verifier organization, and agent.
- A fixed issuer secret in the client signs a configurable credential.
- The wallet anchors the holder commitment.
- The wallet registers a score-plus-jurisdiction policy.
- The browser rebuilds the issuer's tree from events and generates a real
  Groth16 proof locally.
- The connected wallet submits `verifyPresentation` on-chain.
- A failure lab demonstrates replay rejection, claim tampering failure, denylist
  exclusion, and different nullifiers for different policies.

The root homepage remains the default Scaffold-ETH welcome page. The ACTA demo
is discoverable through the header but is not presented as the product home.

### Policy auditor

`packages/demo-web/auditor.html` reads full predicate programs from
`PolicyRegistry`, evaluates them over a declared synthetic population, and
multiplies the estimated satisfaction rate by the issuer tree size. It ranks
policies by an estimated effective anonymity set.

This is arguably the repository's most novel research artifact. It makes the
proposal's "are verifiers over-asking?" question concrete and suggests a
privacy-linting norm for policy authors. Its current output is a modeled
estimate, not a measurement of real credential-holder anonymity.

## Verification performed on 2026-08-10

From the repository root, `npm test` passed:

- 11/11 circuit witness tests;
- 10/10 SDK tests.

From `app/`, the following passed:

- `yarn next:check-types`;
- `yarn foundry:test`, 11/11 tests.

The Foundry happy-path gate test consumed approximately 490,507 gas. The tests
use a real generated Groth16 proof, not a mock or sentinel.

What these tests establish:

- the implemented cryptographic statement is enforced;
- SDK, circuit, and contract signal layouts agree;
- invalid proofs/signals/policies fail in the tested ways;
- nullifier replay is rejected;
- real on-chain proof verification works.

What they do **not** establish:

- transaction-sender privacy;
- front-running resistance;
- authorization of a meaningful application action;
- safe issuer operations;
- revocation or denylist freshness;
- production trusted-setup security;
- interoperability with SD-JWT, OID4VCI/OID4VP, or OpenAC's ES256 format;
- real-world anonymity-set size.

## Critical findings

### P0 — Transaction metadata defeats the strongest privacy copy

The browser submits `verifyPresentation` using the connected wallet. Ethereum
transactions expose their sender even when the emitted event omits it. The UI
currently says the chain learned only that the policy holds, but the chain also
learns which account submitted the proof.

If that account is funded from a known account, registered as an ERC-8004
agent, reused elsewhere, or otherwise correlated, the interaction graph is not
hidden. This is a direct mismatch with the article's motivating privacy goal.

Required response:

- weaken the copy immediately;
- add a relayer, paymaster-sponsored unlinkable account, stealth submission
  flow, private delegation mechanism, or another explicit submission design;
- document what network metadata the chosen mechanism still reveals.

### P0 — No protected action is bound to the proof

The web demo calls `PredicateVerifier` directly and does not use
`AgentAccessGate`. The gate itself records an entry timestamp but does not
execute a protected action, authorize a caller, or mint a capability that is
subsequently usable without revealing identity.

The system currently proves that someone possessing a qualifying secret caused
a nullifier to be accepted. It does not demonstrate that a qualifying private
agent safely performed a useful action.

A reference consumer should atomically verify and execute an action. Do not
verify in one transaction and later trust a naked nullifier supplied by a
caller.

### P0 — Proof-copy and front-running denial of service

The proof is not bound to an action hash, action arguments, an intended
consumer, a verifier-issued task identifier, an intended relayer, or another
non-copyable authorization context. Anyone who obtains the calldata can submit
it first and consume the nullifier.

The public `sessionNonce` does not fix this. The current contract neither
issues nor records the nonce; the prover chooses a random value, and the circuit
merely binds it into the proof.

The next design should bind at least:

```text
domain
consumer/verifier identity
policy ID
action hash or task ID
epoch/rate-limit scope
verifier-issued challenge, where appropriate
```

Then test copied proofs, changed arguments, wrong consumers, wrong tasks, replay
within an epoch, and valid use in a later epoch.

### P0 — Public demo issuer secret permits arbitrary valid credentials

`DEMO_ISSUER_KEY = "acta-web-demo-issuer-key-v1"` is compiled into the browser
bundle. Any user can recover it and sign any claims. The proof remains
cryptographically valid, but "a real auditor scored me" is false for this
issuer.

This is acceptable only when prominently labeled as a toy issuer. The public
demo should either:

- use a tiny server-side demo issuer with explicit issuance rules;
- use an external allowlisted issuer service; or
- keep the browser key but place an unavoidable "toy issuer—anyone can mint"
  warning next to every trust claim.

Do not confuse proof soundness with issuer trustworthiness.

### P1 — Nullifier scope allows one presentation per policy forever

The context is currently `H(domain, PredicateVerifier address, policyId)`, and
the nullifier is `H(masterSecret, context)`. A credential can therefore satisfy
one policy only once, ever.

This is reasonable for one-person-one-vote or one-time redemption. It is not
reasonable for recurring compliance checks, agent jobs, trades, API sessions,
or periodic feedback.

The product must define rate semantics explicitly. A likely construction is:

```text
context = H(domain, consumer, policyId, actionClass, verifierControlledEpoch)
nullifier = H(masterSecret, context)
```

The verifier or application must control the epoch/task scope. The holder must
not be able to select arbitrary contexts to farm unlimited pseudonyms.

### P1 — The unlinkability demo shows different policies, not two verifiers

The failure lab computes nullifiers for two policy IDs under the same
`PredicateVerifier`. This demonstrates context separation mathematically, but
the product copy describes two verifiers. One wallet also plays every role.

An honest demonstration should use:

- separate verifier/consumer contracts or explicit verifier identifiers;
- separate accounts for issuer, agent, and verifier organizations;
- two actual proof submissions;
- an explanation of what observers can and cannot correlate.

### P1 — Anonymity-set size can be cosmetically inflated

The anchor tree accepts arbitrary leaves from its issuer account. The demo's
"add a decoy" button inserts a random value and increases the displayed tree
size. This shows how membership hiding works, but a random leaf is not evidence
of a valid independently held credential.

Tree size must not be presented as equivalent to a real anonymity set. At
minimum distinguish:

- total tree leaves;
- issuer-attested credentials;
- active/unrevoked credentials, once revocation exists;
- estimated holders satisfying a particular policy;
- model assumptions and confidence.

### P1 — Issuer address, issuer key, schema, and tree authority are only joined
by convention

Policies store both an issuer tree owner address and issuer public-key hash, but
the anchor contract itself does not establish their relationship. Any address
can create a tree, and any policy registrant can claim that tree corresponds to
any issuer key.

Permissionless policy registration is not necessarily wrong; a verifier is
allowed to choose its trust roots. But the reference architecture should define
how an issuer registry or signed metadata binds:

- issuer identity/address;
- credential verification key;
- schema;
- anchor tree;
- denylist/root authority;
- key rotation and retirement.

### P1 — Static jurisdiction denylist is not OFAC compliance

The demo excludes `IR`, `KP`, `SY`, and `CU` using a fixed SMT. Real sanctions
screening is not equivalent to a four-country denylist. It is entity-, program-,
authority-, jurisdiction-, and time-dependent.

Use "toy jurisdiction denylist" in user-facing copy. A credible root design
needs a named publisher, version, effective timestamp, update/migration rules,
and stale-root behavior. Immutable policies mean policy migration may be the
cleanest v1 update mechanism.

### P1 — Old anchor roots remain valid indefinitely

Every historical nonzero root is accepted forever. This is compatible with the
article's decision to leave revocation out of scope and helps proofs survive
tree growth. It also means removing or revoking a member is impossible. Claim
expiry limits some exposure but does not replace revocation.

Keep this explicit in all security claims. Before production, choose a root
validity window, revocation accumulator, epoch-based tree, or another
well-specified mechanism.

### P1 — Policy auditor has an XSS path

The registry is permissionless and `Policy.uri` is untrusted. The auditor
interpolates `p.uri` and other policy-derived descriptions into an HTML string
assigned to `innerHTML`. A malicious policy can inject markup/script into the
auditor page.

Fix before hosting the auditor publicly:

- render with DOM `textContent` or React escaping;
- validate addresses and policy structure;
- never interpolate permissionless chain data into raw HTML.

### P2 — Auditor estimates are useful but easy to misinterpret

The auditor samples a fresh random synthetic population on every run and uses
the issuer tree size as the base population. When anchor data is unavailable,
it silently falls back to a modeled population of 10,000.

Improve it by:

- making models deterministic and versioned;
- exposing every input and fallback prominently;
- reporting a range/confidence interval, not only a point estimate;
- separating modeled population from measured leaves;
- validating predicate programs before evaluating them;
- adding sensitivity analysis;
- flagging exact matches, rare conjunctions, small issuer trees, stale roots,
  and repeated linkable policies;
- suggesting less identifying alternatives.

### P2 — Mainnet deployment can imply unjustified maturity

The Base deployment proves that the contracts can be deployed and inspected. It
does not make the system production-ready. The browser uses a development zkey,
issuer operations are a toy, revocation is absent, transaction-sender privacy is
absent, and there is no meaningful protected application.

Label the deployment as a permanent research artifact. Do not encourage assets,
access rights, compliance decisions, or reputation value to depend on it.

### P2 — Documentation is inconsistent

`README.md` says M3 and Base deployment are complete, while `TLDR.md` still says
M3 is next. More importantly, the documentation blurs:

- cryptographically real;
- operationally mocked;
- deployed;
- production-safe;
- interoperable;
- complete relative to the article.

Update all status documents from a shared capability matrix.

## Claims matrix

Use this matrix when writing UI or documentation.

| Claim | Current status | Safe wording |
|---|---|---|
| Real ZK proof | Demonstrated | Real Groth16 proof generated locally and verified on-chain |
| Issuer signature bound | Demonstrated | Proof verifies a BJJ signature from the policy-pinned demo key |
| Claims hidden in proof | Demonstrated | Score and jurisdiction are not public signals |
| Holder leaf hidden | Demonstrated cryptographically | Proof does not reveal which leaf is used |
| Sender identity hidden | Not demonstrated | Presentation transaction currently reveals its submitting wallet |
| Real auditor attestation | Not demonstrated | Toy browser issuer; public key material allows anyone to mint |
| OFAC compliance | Not demonstrated | Toy four-jurisdiction denylist |
| Two-verifier unlinkability | Partially demonstrated | Different policy contexts yield different nullifiers |
| Useful anonymous access | Not demonstrated | Acceptance is recorded; no meaningful protected action yet |
| Front-running resistance | Not demonstrated | Public proof calldata can be copied and consumed first |
| Revocation | Not implemented | Credential expiry only; historical roots remain valid |
| Production setup | Not implemented | Development Groth16 ceremony |
| OpenAC interoperability | Not implemented | Bespoke EdDSA-BJJ field-element credential profile |
| ERC-8004 integration | Not implemented end to end | ACTA sidecar contracts are deployed; no live registry loop |
| Policy privacy score | Research prototype | Modeled estimate based on declared synthetic distributions |

## Recommended next milestone: M3.5 — honest private authorization

### Goal

Demonstrate one useful action whose authorization depends atomically on an ACTA
proof, while avoiding direct agent-wallet disclosure and resisting copied-proof
front-running.

### Suggested application

Use a deliberately small consumer, for example:

- a private agent job queue that accepts one response per qualified agent per
  task;
- a mock vault operation available to agents satisfying a policy;
- a rate-limited capability token minted to an unlinkable ephemeral account.

The job queue is likely clearest because task IDs naturally define replay
scope, no real assets are at risk, and the output can visibly demonstrate an
authorized action.

### Proposed proof/action binding

Define and document a new context version, for example:

```text
actionHash = H(functionSelector, canonicalActionArguments)
contextHash = H(
  ACTA_CONTEXT_V2,
  chainId,
  consumerAddress,
  policyId,
  taskIdOrEpoch,
  actionHash
)
nullifier = H(masterSecret, contextHash)
```

Exact encoding, hashing, chain/domain separation, and argument canonicalization
must be specified and parity-tested across SDK, circuit, and Solidity.

The consumer should perform proof verification, nullifier consumption, and the
protected action in one transaction. The action must not depend on an
unverified caller-supplied nullifier later.

### Submission privacy

For the demo, a relayer is probably the clearest design:

1. Agent receives a verifier-controlled task/challenge.
2. Browser builds the action-bound proof locally.
3. Browser sends proof and action to a relayer.
4. Relayer submits the atomic consumer call.
5. Contract verifies that the proof binds exactly to the action being executed.

Document residual privacy limitations:

- the relayer may see IP/timing metadata;
- the verifier may know which off-chain session requested the task;
- timing and action uniqueness may still shrink anonymity;
- collusion between issuer, verifier, and relayer changes the threat model.

### Required tests

- honest relayed action succeeds;
- direct and relayed calls have identical authorization semantics;
- copied proof with changed arguments fails;
- proof for consumer A fails at consumer B;
- proof for task A fails at task B;
- first submission wins and exact replay fails;
- the same holder succeeds in a verifier-controlled later epoch/task;
- holder-selected arbitrary epoch/task cannot bypass the intended rate limit;
- stale challenge fails if challenges expire;
- transaction sender is the relayer, not the agent wallet;
- the protected action is executed atomically with nullifier consumption.

### Demo actor separation

Use distinct identities:

- issuer service/account;
- agent browser with credential and master secret;
- verifier organization A and consumer A;
- verifier organization B and consumer B;
- relayer account.

Then present twice and show both chain records. Explain what is unlinkable and
what metadata remains visible.

### Exit criteria

- one meaningful protected action exists;
- verification and action execution are atomic;
- context scope is verifier-controlled and supports explicit reuse semantics;
- copied proofs cannot authorize modified actions;
- relayed submission is demonstrated;
- two distinct verifier contexts are demonstrated with real proofs;
- no issuer signing secret is shipped to the browser;
- UI and documentation disclose every mock and privacy limitation;
- policy auditor no longer renders untrusted chain data via `innerHTML`;
- all existing soundness/parity tests remain green.

## Product and documentation work to do immediately

Before implementing M3.5, make the current demo honest:

1. Add a persistent "research demo" banner.
2. Replace "real auditor" with "toy demo issuer."
3. Replace "OFAC" with "toy jurisdiction denylist."
4. Replace "the chain learned only" with a precise public-signal statement and
   disclose that the submitting wallet is visible.
5. Label the zkey as a development ceremony next to the proof action.
6. Explain that tree size includes arbitrary demo decoys and is not a measured
   anonymity set.
7. Explain that a nullifier currently permits one presentation per policy ever.
8. Add Basescan links for contracts and successful transactions.
9. Replace the Scaffold-ETH homepage with an ACTA landing page or redirect it to
   `/demo`.
10. Synchronize `TLDR.md`, `README.md`, and milestone status.

## Why M4 reputation should wait

The reputation accumulator compounds every unresolved semantic question:

- who is entitled to submit feedback;
- how a completed interaction creates that entitlement;
- what scope prevents duplicate feedback while permitting future interactions;
- which agent receives a private aggregate without revealing an ERC-8004 link;
- who can update roots;
- how blinded values are range-constrained;
- how ACTA roots are written into ERC-8004 without recreating the interaction
  graph;
- how revocation, issuer trust, and Sybil resistance work;
- whether the credential/proving stack will remain EdDSA-BJJ or pivot toward
  SD-JWT/OpenAC interoperability.

Building M4 first would create more code on top of undefined application
semantics. Resolve M3.5 and the author questions in `10-questions-for-zulu0echo.md`
before committing to the accumulator circuit.

## Decisions that require zulu0echo or project-owner input

The existing ranked agenda remains valid. The most important decisions are:

1. Is EdDSA-BJJ acceptable for the reference implementation, or is
   SD-JWT/ES256/OpenAC interoperability central?
2. Should this repository's `predicateProgramHash` become a proposed normative
   ACTA encoding?
3. What rate semantics should nullifier context express: once per policy,
   session, task, epoch, action class, or something else?
4. Does policy transparency justify storing the full program on-chain?
5. What threat model applies to issuer/verifier/relayer collusion?
6. Should anonymity-set size be surfaced, warned on, or enforced?
7. Who should operate the public demo issuer?
8. Is the next research priority private authorization, reputation, or wire
   format interoperability?

Do not let these questions block honest incremental work. M3.5 can use a
versioned context and toy issuer service while clearly labeling both.

## Policy auditor roadmap

Treat the auditor as a first-class product, not a side HTML file.

Recommended evolution:

1. Move it into the Next.js app and use escaped component rendering.
2. Validate policy shape and predicate hash before scoring.
3. Define versioned population models with reproducible seeds.
4. Show real tree size separately from modeled credential distribution.
5. Report satisfying-set ranges and sensitivity to model assumptions.
6. Add a policy lint report:
   - number of attributes touched;
   - exact-match predicates;
   - rare conjunctions;
   - repeated or redundant checks;
   - stale denylist roots;
   - tiny issuer trees;
   - unusually identifying validity windows;
   - cross-policy intersection risk.
7. Suggest minimally sufficient alternative policies.
8. Export a machine-readable privacy score and methodology version.

The deeper research question is not merely "how many agents satisfy this
policy?" It is "how much does observing satisfaction update an adversary's
belief about which agent acted, especially after multiple policy observations?"
That suggests Bayesian or intersection-attack analysis as a later research
direction.

## Security and privacy threat model to write next

The repository currently has implementation rules but needs one consolidated
threat model. It should enumerate:

### Actors

- credential holder/agent;
- issuer;
- verifier/policy author;
- consumer contract;
- relayer/paymaster;
- denylist/root publisher;
- chain observer and mempool observer;
- colluding subsets of the above.

### Protected information

- credential attribute values;
- master secret;
- which anchor leaf belongs to the holder;
- cross-verifier linkability;
- agent wallet and operator identity;
- interaction graph;
- protected action details, if those are intended to be private.

### Explicit non-goals for the current prototype

- hiding transaction timing;
- hiding public action calldata;
- hiding the issuer or policy selected;
- issuer-blind issuance;
- resistance to issuer/verifier collusion;
- revocation;
- coercion resistance;
- compromised-browser protection;
- production ceremony security.

### Attacks requiring tests or documentation

- forged issuer signature;
- modified claims;
- wrong policy/program;
- wrong issuer/root;
- malformed public signals and field aliases;
- copied proof/front-running;
- action substitution;
- consumer substitution;
- nullifier farming;
- epoch manipulation;
- malicious verifier programs;
- malicious policy metadata/XSS;
- stale or malicious denylist roots;
- tiny anonymity sets and intersection attacks;
- issuer timing correlation;
- relayer network-metadata correlation;
- local-storage secret theft.

## Operational cautions

- `app/packages/nextjs/utils/acta/actaSdk.ts` is a browser port of the SDK.
  Encoding changes must be made deliberately in both implementations and
  reflected in parity vectors.
- Circuit public-signal order is a contract. Any change requires coordinated
  circuit, SDK, browser, fixture, Solidity wrapper, tests, and deployed-verifier
  updates.
- Changing circuit inputs requires a new zkey and generated Solidity verifier.
- Never describe the existing dev ceremony as production-safe.
- Existing Base contracts are immutable artifacts. Version new contracts; do
  not imply that an app update changes deployed semantics.
- The repository may have user changes. Check `git status` before editing and
  avoid rewriting unrelated work.
- The canonical Scaffold-ETH contract copies live under `app/`; the root
  `packages/` contain circuit, SDK, CLI, and auditor pieces.

## Suggested implementation order

1. Correct public copy and documentation.
2. Fix auditor XSS and make estimates deterministic.
3. Write the consolidated threat model.
4. Specify `ACTA_CONTEXT_V2` and action hashing in a short normative document.
5. Add SDK parity vectors for context/action binding.
6. Update the circuit and verifier contracts.
7. Build the atomic consumer contract.
8. Add adversarial Foundry and circuit tests.
9. Add the relayer and separate demo actors.
10. Update the web demo to show two real verifier contexts.
11. Re-run latency, gas, build, and end-to-end browser tests.
12. Review with zulu0echo/project owner.
13. Decide whether to proceed to reputation or interoperability work.

## Restart checklist for the next agent

When resuming work:

1. Read `TLDR.md`, `README.md`, this file, `10-questions-for-zulu0echo.md`, and
   `app/AGENTS.md`.
2. Check `git status --short` and recent commits.
3. Run `npm test` from the root.
4. Run `yarn next:check-types` and `yarn foundry:test` from `app/`.
5. Confirm whether the user wants diagnosis/design only or implementation.
6. If implementing, start with current-copy corrections and auditor XSS unless
   priorities have changed.
7. Do not start M4 solely because the old milestone plan says it is next.
8. Preserve the distinction between cryptographic correctness and end-to-end
   privacy.

## Final assessment

The project made the correct first technical decision: discard the incomplete
original PoC and build a sound proof path from the article. That work is real
and valuable.

The next decision is more important than adding another circuit. The project
must choose whether it is demonstrating private mathematics or private agent
behavior. ACTA's motivation requires the latter. Closing the transaction,
front-running, context, and action-binding gaps will turn this from a strong ZK
component demo into a credible reference architecture for the proposal.
