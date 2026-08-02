# demo-web

**auditor.html** — the over-asking policy auditor (research doc 08, demo C).
Reads every registered ACTA policy straight from `PolicyRegistry`, decodes its
on-chain predicate program, and estimates the effective anonymity set (declared
population model × real anchored population). Red badge = a policy so demanding
that "anonymous" presentation is de-anonymizing in practice.

Run locally: `make auditor` (seeds anvil with 6 spectrum policies + 64 anchored
holders, then serves the page). Point it at any chain by entering an RPC URL +
registry address — for Base, use your own RPC endpoint (no key is embedded).
