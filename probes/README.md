# Headless production probes

These scripts verify the deployed app **on the production URL** — the repo's
QA rule (docs 12/13) is that nothing counts as tested until it has been
exercised there. They are how wallet v1 was verified without a human wallet.

## Setup

The scripts use `playwright-core` (browser driver only, no bundled browser).
Point two env vars at any working install:

```sh
export PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs  # optional if resolvable
export CHROME_BIN=/path/to/chrome-headless-shell                        # optional if playwright's own browser is installed
```

If `playwright-core` is resolvable from the CWD and its matching browser is
installed (`npx playwright install chromium`), no env vars are needed.

## Scripts

- **`make-vc.mjs`** — builds a sample W3C VC exactly as `/demo`'s
  "hand this credential to your wallet" link encodes one (test-only identity,
  demo issuer key), printing the base64url payload. Regenerates `vc.b64`:
  `node probes/make-vc.mjs > probes/vc.b64`
- **`walletprobe.mjs <baseURL>`** — 10 assertions on `/wallet`: locked card,
  correct CTA without a wallet, import consent card with live signature
  verification, claims rendered, the "never touched a server" line, store
  gated on unlock, **tampered VC rejected**, garbage fragment survived.
- **`handoffprobe.mjs <baseURL>`** — the real path: loads `/demo`, clicks
  Issue, asserts the hand-off link appears, follows its `#import=` fragment
  to `/wallet`, asserts the consent card + signature verification + claims.

```sh
node probes/walletprobe.mjs https://anonymous-8004.vercel.app
node probes/handoffprobe.mjs https://anonymous-8004.vercel.app
```

Both exit 0 on full pass and print a JSON checklist either way.

## Hard-won gotchas (do not rediscover these)

1. **Never wait for `networkidle` on the production pages** — they poll RPC
   continuously, so `networkidle` never fires and the probe times out looking
   like an app bug. Use `waitUntil: "domcontentloaded"` + a fixed
   `waitForTimeout`.
2. **No wallet exists in headless Chromium**, so the correct `/wallet` CTA is
   *Connect*, not *Unlock* — a probe asserting only "Unlock" fails against a
   correctly working page.
3. What these probes **cannot** verify: anything behind a real signature —
   unlock (sign → vault), accept & store, approve → prove → present. Those
   need a human with a browser wallet (see doc 14).
