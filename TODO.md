# TODO

## Crawl ERC-8004 for credential-issuing use cases

**Goal:** find real, live demand for ACTA — concrete agents/protocols on
ERC-8004 where an anonymous credential would replace or improve what they're
doing publicly today — and turn the findings into a ranked shortlist we can
actually approach.

**Method — use the local node, not public RPCs** (repo ground rule #3):

1. Enumerate the ERC-8004 registries (Identity / Reputation / Validation,
   the `0x8004…` singletons) — start with Base + mainnet, expand if cheap.
2. Pull the event history: `Registered` / `URIUpdated` (who exists, what
   their registration files claim), `NewFeedback` (who actually has
   reputation — doc 01 measured only ~6% of agents do), `ValidationRequest`
   / `ValidationResponse` (who is already paying third parties to vouch for
   work — the closest thing to credential demand in the wild).
3. Fetch and parse the `agentURI` registration files for live agents:
   declared skills/endpoints/trust models. Tag patterns that map onto
   credential schemas (audit/security claims, KYC/compliance mentions,
   capability lists, jurisdiction mentions).
4. Score candidates: activity (recent feedback/validations), whether their
   trust signal is currently *public and linkable* (ACTA's pitch), and
   whether an obvious issuer exists (auditor, validator, registry operator).

**Output:** a doc with (a) hard numbers — registered agents, % with
feedback, % with validations, per chain; (b) a top-10 candidate list with
what credential we'd issue, who'd issue it, who'd verify; (c) the 2–3 best
outreach targets.

**Why:** supply is not the bottleneck for 8004 — demand is. This is the
systematic version of "find the app that rips on 8004" instead of guessing.
Feeds the use-case iteration loop and the M3.5 consumer choice (doc 11).
