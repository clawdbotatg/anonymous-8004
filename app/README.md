# ACTA web app

The web frontend + Foundry deployment package for **ACTA** (Anonymous
Credentials for Trustless Agents) — a ZK privacy layer for
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004). Built on
[Scaffold-ETH 2](https://scaffoldeth.io) (foundry flavor).

**What this repo is, why, and the research behind it: see the
[root README](../README.md) and [TLDR](../TLDR.md).**

- `packages/nextjs` — the app. `/` is the landing page, `/demo` is the
  three-panel Issuer / Verifier / Agent demo with **in-browser Groth16
  proving** (the master secret and claims never leave the tab). The proving
  artifacts (`public/circuits/`) are built from the repo-root circuit via
  `make webdemo-assets`.
- `packages/foundry` — the five ACTA contracts and deploy scripts. Deployed
  and verified on **Base mainnet** (chain 8453) — addresses in
  `packages/foundry/deployments/8453.json`.

## Run it

```bash
yarn install
yarn start          # frontend at http://localhost:3000, talking to Base mainnet
```

Local chain instead: set `targetNetworks: [chains.foundry]` in
`packages/nextjs/scaffold.config.ts`, then `yarn chain`, `yarn deploy`,
`yarn start` (three terminals).

Deploy frontend: `yarn vercel:yolo --prod` (or push, if Vercel is wired to
this repo). Set `NEXT_PUBLIC_ALCHEMY_API_KEY` (and optionally
`NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID`) in the hosting environment.

> ⚠️ Research demo: the circuit's proving key comes from a single-party dev
> ceremony, not a production trusted setup. Full trust assumptions are listed
> on the `/demo` page itself.
