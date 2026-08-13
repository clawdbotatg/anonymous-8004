# Demo-polish session handoff (2026-08-12)

**Date:** 2026-08-12
**Purpose:** Hand off everything learned while walking Austin through `/demo`
live in his browser and fixing what broke. Read `11-critical-product-handoff.md`
first for the product/crypto assessment; this doc covers the demo UX layer, the
production deploy pipeline, and the operational knowledge for driving the next
live demo. Written by the agent that shipped commits `7412b25` → `0fa78b9`.

## Executive summary

The `/demo` page is now a guided single-path walkthrough: three panels named by
role in plain words, exactly one solid primary button on screen at any time
(the next step), and a post-presentation "receipt card" that closes the loop
with verifiable facts. Along the way we hit — and fixed — a production-only
failure: **the circuit artifacts were gitignored, so proving worked locally and
404'd on Vercel.** That failure and its lesson are the most important thing in
this doc.

Everything below is deployed. Production is https://anonymous-8004.vercel.app,
Base mainnet (8453), five immutable contracts. **Push to `main` = deploy**
(Vercel auto-deploys; Austin has standing-authorized commit-and-push for this
repo).

## The one lesson that must not be lost

> **`WebAssembly.compile(): expected magic word 00 61 73 6d, found 3c 21 44 4f`**
> = the browser received an HTML 404 page where the wasm should be.

Root cause chain, in full, because each link is a trap on its own:

1. `.gitignore` excluded `app/packages/nextjs/public/circuits/*.wasm` and
   `*.zkey` (a reflex — "build artifacts don't get committed").
2. **Vercel deploys only what is in git.** The files existed locally, so every
   local test — dev server, `yarn build`, headless probe — passed.
3. Prior QA verified "pages render, buttons are gated" but never ran an actual
   prove **against production**. The demo shipped with a dead centerpiece and
   Austin found it live ("haven't you tested this?!?!").
4. The artifacts are not even reproducible build outputs: **the deployed
   `Groth16CircuitVerifier` on Base is pinned to the exact dev-ceremony zkey.**
   Re-running `make setup` yields a different zkey whose proofs the on-chain
   verifier rejects. Until a new verifier is deployed, the committed bytes are
   canonical. So committing them is *correct*, not a workaround.

Fix (commit `d62433c`): committed `ActaPresentation.wasm` (6.5 MB) and
`acta_dev.zkey` (21.5 MB), removed the ignore lines, and left the rationale in
two places — a comment block at the bottom of the root `.gitignore` and
`app/packages/nextjs/public/circuits/README.md`. **Do not re-ignore these
files.** Regenerate them only alongside deploying a matching new verifier.

**QA rule going forward:** a feature is not verified until exercised on the
production URL. For the prover specifically:

```sh
# wasm must start with the WebAssembly magic bytes, not '<!DO'
curl -s https://anonymous-8004.vercel.app/circuits/ActaPresentation.wasm | head -c 4 | xxd
# expect: 00 61 73 6d
curl -sI https://anonymous-8004.vercel.app/circuits/acta_dev.zkey | head -1   # expect 200
```

## What shipped this session (all on `main`, all deployed)

| Commit | What |
| --- | --- |
| `7412b25` | Panel titles name the roles in plain words: `1 · Issuer (the auditor)`, `2 · Verifier org (the client)`, `3 · Agent (the AI proving itself)` |
| `4487097` | Journey pointer — one solid CTA per state — plus the panel-whitespace fix |
| `d62433c` | Circuit artifacts committed (the prod 404 fix above) |
| `0fa78b9` | Post-presentation receipt card — the "aha" moment |

## How the demo page works now (`app/packages/nextjs/app/demo/page.tsx`)

### The story to tell (Austin asked for it in exactly these terms)

You are **one person playing three roles** with one wallet:

1. **The auditor** (panel 1) examines an AI agent and signs a credential:
   "score 85, jurisdiction CH." Then anchors a *commitment* to it on-chain —
   a hash, revealing nothing.
2. **The client** (panel 2) publishes a policy on-chain: "I only hire agents
   with score ≥ 60, from an auditor I trust."
3. **The agent** (panel 3) proves in the browser — score never leaves the tab —
   that it holds a valid credential satisfying the policy, and presents that
   proof on-chain. The chain learns *policy satisfied*, nothing else.

### Journey pointer (the CTA state machine)

Around line 474. One derived `step` value; every button's class comes from
`cta(name)` which renders `btn-primary` only for the current step, `btn-outline`
otherwise. **Invariant: exactly one solid button on the page = the thing to
click next.** If you add a button, wire it into this.

```tsx
const step = !cred ? "issue"
  : !isAnchored ? "anchor"
  : myPolicyIds.length === 0 ? "register"
  : !call ? "prove"
  : !presented ? "present"
  : "lab";
```

The lab's replay button is the `"lab"` step (solid red `btn-error` once the
loop closes, outlined before).

### The cross-user trap `myPolicyIds` exists to avoid

Policies are **global** on-chain, but a policy pins **its registrant's issuer
tree**. Proving against another wallet's policy fails, because your anchors
live in *your* tree. So the page filters `PolicyRegistered` events by
`registrant === connectedAddress` (line ~197) and auto-selects the connected
wallet's own newest policy. Never "helpfully" auto-select the globally newest
policy — that regresses a subtle multi-user failure.

(`PolicyRegistered(uint256 indexed policyId, address indexed registrant, …)`,
registrant = `msg.sender`, emitted at `PolicyRegistry.sol:54`.)

### The receipt card (the "aha" moment)

Renders when `presented && call`, inserted just above the failure lab
(~line 695): **"✓ Loop closed. Here is the receipt."** Contents are concrete
facts only — Austin's brief was "WITH NO SLOP!", keep it that way:

- Two columns: **THE CHAIN NOW KNOWS** (policy #N satisfied; the nullifier,
  marked *spent — replays revert*; the submitting wallet) vs **THE CHAIN CAN
  NEVER LEARN** (score 85, jurisdiction CH, which of the N anchored
  commitments is yours, the master secret).
- A live **Basescan link to the actual presentation tx** (`presentTxHash`,
  captured from `writeContractAsync`'s return value), inviting the reader to
  decode the `PresentationAccepted` log themselves: exactly three values —
  policyId, nullifier, expiry. The score isn't encrypted in there; it was
  never sent.
- An **honest footnote**: in this demo the submitting wallet is visible
  (one wallet plays all three roles); production submits through a relayer.
  This is doc 11's wallet-linkability gap, disclosed rather than hidden.
- A pointer to the failure lab ("now try to break it").

State plumbing: `presented` + `presentTxHash` are reset in both `issue()` and
`proveHonest()` so a stale receipt never shows for a new credential/proof.

### Demoing twice: the nullifier is a one-way door

Nullifier = f(masterSecret, contextHash(policyId)). **One presentation per
agent per policy, forever** — a second present against the same policy reverts
`NullifierAlreadyUsed` (`0xcad2ae02`; the failure lab's replay button
demonstrates this deliberately). Consequence for live demos: to run the loop
again (e.g. to show the receipt card to someone new, or because a feature
shipped after the last present), **register a fresh policy** — new policyId →
new context → fresh nullifier. Bonus: with ≥2 policies the lab's "Show
unlinkability across policies" unlocks, showing two unlinkable nullifiers from
one secret. As of this writing Austin has presented against policy #0 (spent)
and was instructed to register policy #2 to see the receipt.

### Two DaisyUI/SE-2 gotchas fixed here

- **Panel whitespace:** DaisyUI's `.card-body` applies `flex-grow: 1` to `<p>`
  children, so a short panel's subtitle silently inflated to fill the column.
  Fix: `grow-0` on the subtitle `<p>`s (and on the receipt card's paragraphs).
  Remember this whenever a card shows mystery vertical gap.
- **Tx hash for explorer links:** `writeContractAsync` returns the hash;
  `getBlockExplorerTxLink(chainId, hash)` from `~~/utils/scaffold-eth`
  (defined in `utils/scaffold-eth/networks.ts:98`) builds the Basescan URL.

## Verifying a deploy (methods that actually work)

- `git push` → Vercel builds; typically live in ~2 min.
- **Client-conditional UI is invisible to `curl` of the page HTML.** The
  receipt card only renders after `presented && call`, so grepping `/demo`
  SSR output for "Loop closed" *times out even when the deploy succeeded*.
  Grep the built JS instead: fetch `/demo`, extract the
  `/_next/static/chunks/*.js` script URLs, grep those for the marker string.
- For the prover assets, the `curl | xxd` magic-byte check above.
- Local probes (dev server, screenshots) prove the code, not the deploy.

## Driving Austin's browser (clawd-browser bridge) — operational notes

- Bridge at `http://127.0.0.1:8765` (POST `/cmd`, tab_id routing). The
  extension's MV3 service worker suspends periodically → websocket blips.
- **"No tab with given id" usually means the owning browser is mid-blip, not
  gone.** Retry for ~60 s, re-poll the tab list for ~2 min before concluding
  anything. This session the id Austin pasted (1692543364) went stale and the
  demo tab came back as 1478759013 — tab ids churn; never cache them across
  sessions.
- A page can be running a *stale build* for hours: Austin's tab once showed
  anonymity-set 0 with Anchor stuck spinning because an old wallet confirm was
  never signed and the tab had never reloaded. First debugging step for any
  "the site is broken" report during a demo: **hard refresh, then re-check.**
  (Re-issuing is safe — the credential is deterministic from the persisted
  master secret, so the same commitment comes back.)

## Open items (in priority order)

1. **Walk Austin through the second-policy flow** so he actually sees the
   receipt card and the unlinkability lab (instructions were delivered; not
   yet confirmed done).
2. Doc 11's M3.5 — honest private authorization (ACTA_CONTEXT_V2, relayer,
   atomic consumer) **before** M4 (reputation accumulator).
3. `packages/demo-web/auditor.html` innerHTML XSS from untrusted `Policy.uri`
   — must be fixed before that page is ever hosted (currently local-only).
4. Mobile wallet deep-linking on `/demo` (untested on phone wallets).
5. Demo-copy honesty pass items from doc 11 that predate this session.

## Style/process conventions observed this session

- Austin steers demos in short bursts ("tldr", "try again", "no slop") — the
  right response is compression and concrete nouns, not more framing.
- Commits: imperative summary + one-line why; end with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- This repo is the exception to "only commit when asked": push **is** the
  deploy, standing-authorized.
- Prettier reorders imports on save here; accept it, don't fight it.
