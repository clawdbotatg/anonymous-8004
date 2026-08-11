# Circuit artifacts (committed on purpose)

The `/demo` page proves in-browser and fetches two artifacts from here:

- `ActaPresentation.wasm` — witness calculator (~6.5 MB)
- `acta_dev.zkey` — Groth16 proving key, DEV ceremony, not production (~21.5 MB)

They are committed, not gitignored, for two reasons:

1. **The zkey is pinned by the chain.** The `Groth16CircuitVerifier` deployed
   on Base mainnet was exported from this exact zkey. Re-running the dev
   ceremony (`make setup`) produces a different proving key whose proofs the
   on-chain verifier rejects. Until a new verifier is deployed, these bytes
   are canonical.
2. **Vercel deploys only what is in git.** Gitignoring them shipped a demo
   whose "Generate ZK proof" button 404'd in production
   (`WebAssembly.compile(): expected magic word … found 3c 21 44 4f` — that's
   an HTML 404 page where the wasm should be).

To regenerate (only alongside deploying a matching new verifier):

```sh
make setup            # compile circuit + dev ceremony
make webdemo-assets   # cp into this directory
```
