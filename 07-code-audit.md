# 07 — Code Audit: `vendor-acta-poc` (zulu0echo's ACTA PoC, commit `b75e597`)

**Auditor:** independent forensic pass, run against the clone at
`/Users/clawd/clawd-harness/projects/anonymous-8004/vendor-acta-poc`
**Subject:** `b75e597 feat(v0.4): JS witness builder + V2 holder/verifier/SDK + ceremony script` (9 commits total)
**Purpose:** decide what, if anything, to carry into the fresh ACTA reference implementation.
The author's own guidance — *"build from the article, not my code"* — is, on the evidence below, correct and should be followed.

---

## TL;DR verdict

**Nothing nefarious. Nothing working. A specification wearing an implementation's clothes.**

- **Malice: none.** All 1,757 lockfile entries resolve to `registry.npmjs.org`; zero install/postinstall hooks; no `eval`, no obfuscated blobs, no key exfiltration, no unexpected network egress. The only `child_process` use is a legitimate local CLI wrapper in vendored third-party code.
- **It has never run, end to end, in any configuration.** I proved this by executing it. **The Solidity does not compile** — 8 hard `solc` errors including every core contract failing OpenZeppelin v5's `Ownable(initialOwner)` base-constructor requirement. Contracts that do not compile cannot have been tested, deployed, or gas-measured. **The holder package cannot even be `require`d** — a temporal-dead-zone `ReferenceError` at import time. **The circuits were never compiled** (no `circom`/`snarkjs`/`circomlibjs` anywhere in `package.json` *or* `package-lock.json`; no `circuits/build/`), and the V1 circuit contains constructs `circom` rejects. I found **13 independent breaks**, not four.
- **The ZK layer is a sentinel string.** Both "provers" emit `keccak256("OPENAC_TEST_PROOF_V1"/"_V2")` right-padded to 256 bytes. There is no witness computation against a compiled circuit, no proving key, no proof. Worse: **I deployed the test verifier in isolation and it rejects every sentinel the codebase produces** (`verifyProof -> false` for all three variants) — so even the fake path was never executed.
- **The presentation circuit does not bind the issuer's signature.** `issuerPubKeyCommitmentPrivate` is a *private input assigned straight to a public output*. The prover chooses it. Anyone can prove arbitrary statements about a credential no issuer ever signed. This is a total break of the protocol's core claim. **Confirmed.**
- **Two further breaks the prior audit did not name:** (i) `agentId` — the holder's raw Ethereum address — is a **cleartext calldata argument** to `verifyAndRegister()`, and `credentialCommitment`/`credentialMerkleRoot` are **static public signals**, so every "anonymous" presentation is trivially deanonymised and cross-linked; (ii) the nullifier is bound to a **verifier-supplied nonce**, so unlimited fresh nullifiers per credential — no sybil resistance, and the reputation pool is farmable by anyone who reads an event log.
- **What's worth keeping:** the generalized-predicate IR + encoder + witness builder (`packages/shared/src/gp/`) and the `PostfixEval` trace design are genuinely good and, unusually for this repo, *correctly constrained*. The contract decomposition and the 10-step verification sequence are a sound skeleton. Take the designs; take none of the code.

**Prior-audit hypotheses:** (a) confirmed. (b) confirmed and extended — not just circuits; the whole stack. (c) confirmed, with mechanism and exploit path documented below. (d) **contradicted as an undercount** — 13 breaks, several fatal at compile time. (e) confirmed.

---

## 0. Method — what I ran vs. what I read

Everything below is either a quoted source line with `file:line`, or captured output from a command I ran. Where tooling was missing I say so explicitly.

**Commands executed (all inside the clone or the scratchpad; nothing committed — `git status --porcelain` is empty, all artifacts are gitignored):**

| Command | Result |
|---|---|
| `npm ci --ignore-scripts --dry-run` | `added 1764 packages` — **lockfile is internally consistent** |
| `npm ci --ignore-scripts` | succeeded; `110 vulnerabilities (19 low, 55 moderate, 29 high, 7 critical)` |
| `npx hardhat compile` (in `packages/contracts`) | **fails** — see Break 1 |
| `npx hardhat compile` with `TS_NODE_COMPILER_OPTIONS` workaround | **fails with 8 solc errors** — Breaks 2–5 |
| `npm test` in `packages/shared` | **66 passing** |
| `npm test` in `packages/sdk` | 13 passing *(only after I manually built `@acta/shared`)* |
| `npm test` in `packages/verifier` | 18 passing *(same caveat)* |
| `npm test` in `packages/holder` | **fails: `ReferenceError: Cannot access 'StubWalletUnit' before initialization`** |
| `npm test` in `packages/issuer` | **fails: 4 TypeScript errors** |
| `npm run build` (root, documented) | **fails in 4 of 7 workspaces** |
| `npx tsc --noEmit` per package | holder/verifier/issuer all fail; sdk clean |
| Isolated Hardhat project: deploy `TestOpenACSnarkVerifier`, call `verifyProof()` with the exact bytes the repo's stubs and tests produce | **`false` for all three** — see Break 9 |

**Tooling absent on this machine:** `circom`, `snarkjs`, `tsc` (global). Circuit findings in §4 are therefore **static analysis of the `.circom` source**, and I flag the one finding that would need `circom` to confirm. Note this absence is *not* an excuse the repo can use — `circom`/`snarkjs`/`circomlibjs` appear in **neither** `package.json` **nor** `package-lock.json`, meaning no contributor ever had them wired into this project either.

---

## 1. Nefarious scan — clean, with evidence

**Verdict: no evidence of malicious intent or data exfiltration. I would not block on supply-chain grounds.**

| Vector | Finding | Evidence |
|---|---|---|
| Unexpected package hosts | **None.** Every resolved dependency comes from npm. | Parsed all `resolved` URLs in `package-lock.json`: `[('registry.npmjs.org', 1757), ('', 7)]` — the 7 blanks are the local workspace links |
| Install/lifecycle hooks | **None** in any first-party manifest. Only `"prepublishOnly": "npm run build:all"` in the vendored `openac-sdk/package.json` — benign, and only fires on publish | grepped all 9 `package.json` files for `preinstall\|postinstall\|prepare\|prepublish` |
| `eval` / `new Function` | **Zero occurrences** anywhere | repo-wide grep excluding `node_modules` |
| `child_process` | **One** occurrence: `openac-sdk/src/native-backend.ts:5` `import { execFile } from "child_process"` — wraps a *local* `ecdsa-spartan2` Rust binary for heavy proving. Path-resolved from disk (`:51`), never a URL. Legitimate pattern | `openac-sdk/src/native-backend.ts:5,51,67` |
| Network egress | `axios` in holder/verifier for OID4VCI/OID4VP flows against **configured** endpoints only. `fetch()` at `openac-sdk/src/wasm-bridge.ts:161` fetches proving keys from a **caller-supplied `baseUrl`**. `curl` in the two ceremony scripts downloads the well-known Hermez Powers-of-Tau from `hermez.s3-eu-west-1.amazonaws.com` (`setup-circuits.sh:38`, `setup-circuits-v2.sh:47`) — the standard ptau source | as cited |
| Private-key handling | Keys are read from env vars and used **in-process only**; never logged, never transmitted. `packages/issuer/src/didEthrSetup.ts:56` even warns when running with an ephemeral key | `packages/issuer/src/agent.ts:16,54-63,122`; `packages/holder/src/server.ts:20` |
| Obfuscated blobs | **None** — no base64/hex run ≥500 chars in any `.ts`/`.js`/`.json` outside `node_modules` | repo-wide regex scan |
| Suspicious deps | None. Standard set: ethers 6, Credo.ts 0.5, express, jose, hardhat, OZ 5.x | all `package.json` reviewed |

**Two things to note without alleging malice:**

1. `.env.example` ships `WALLET_KEY=insecure-dev-key-replace-in-production` (`:15`), `STRICT_ISSUANCE=false` (`:18`), `ALLOW_OPEN_CREDENTIAL_OFFER=true` (`:19`) — i.e. defaults that are the exact inverse of the repo's own production checklist (`docs/SECURITY_AUDIT.md:256-257`). Careless, not hostile.
2. `openac-sdk/` (30 files, ~top-level) is **an unattributed vendored copy of PSE's zkID `openac-sdk`**, not first-party ACTA code: `openac-sdk/package.json` declares `"repository": "https://github.com/privacy-scaling-explorations/zkID"`; `wasm/Cargo.toml` pins `spartan2` to a **personal fork** (`github.com/0xVikasRushi/Spartan2.git`, branch `openac-sdk`) and depends on `ecdsa-spartan2 = { path = "../../ecdsa-spartan2" }` — **a sibling directory that does not exist here**. No `LICENSE` file, no SPDX headers, no attribution notice, arrived in one squashed commit. It proves a *completely different statement* (SD-JWT age-over-18 over secp256r1/Spartan2), is not in the workspace list, and is imported by nothing. **For the fresh implementation: do not carry this directory. If you ever vendor upstream code, vendor it with its LICENSE and a `VENDOR.md` provenance note.**

---

## 2. Does it run? — No. Thirteen independent breaks.

Ordered by how early they kill you. Every one is reproduced from command output or quoted source.

### Break 1 — Hardhat cannot load its own config (build-time, environmental)
```
$ npx hardhat compile
An unexpected error occurred:
error TS5109: Option 'moduleResolution' must be set to 'NodeNext' (or left unspecified)
              when option 'module' is set to 'NodeNext'.
```
`packages/contracts/` ships **no `tsconfig.json`** (confirmed: `npx tsc --showConfig` → `error TS5081: Cannot find a tsconfig.json file`), and there is no ancestor tsconfig. With `typescript: "^5.4.5"` resolving to 5.9.3 today, `ts-node` cannot load `hardhat.config.ts`. *Fairness note: this specific break is version-drift; it may have worked in April 2024. Breaks 2–5 are not.*

### Break 2 — `Ownable` base constructor never called: **six contracts, fatal** (build-time)
```
TypeError: No arguments passed to the base constructor. Specify the arguments
           or mark "GeneralizedPredicateVerifier" as abstract.
  --> contracts/core/GeneralizedPredicateVerifier.sol:52:1
Note: Base constructor parameters:
  --> @openzeppelin/contracts/access/Ownable.sol:38:16
```
Identical error for `NullifierRegistry`, `OpenACCredentialAnchor`, `ZKReputationAccumulator`, `AgentAccessGate`, `AnonymousReputationPool`. Every constructor writes the OZ **v4** idiom:
- `GeneralizedPredicateVerifier.sol:81` — `) Ownable2Step() {` then `_transferOwnership(initialOwner);`
- `NullifierRegistry.sol:38`, `OpenACCredentialAnchor.sol:42`, `ZKReputationAccumulator.sol:38`, `AgentAccessGate.sol:48`, `AnonymousReputationPool.sol:39` — same.

OZ **v5.0.0 onwards** requires `Ownable(initialOwner)`. The manifest declares `"@openzeppelin/contracts": "^5.0.2"` (`packages/contracts/package.json`), installed 5.6.1. **This has never compiled against the dependency the repo itself pins — not today, not in 2024.** This single fact falsifies the entire contract-test, integration-test, deployment and gas-measurement story.

### Break 3 — `error` and `event` share a name (build-time, fatal)
```
DeclarationError: Identifier already declared.
  --> contracts/interfaces/IOpenACCredentialAnchor.sol:44:5
     error CredentialRevoked(uint256 agentId, bytes32 credentialType);
Note: The previous declaration is here:
  --> contracts/interfaces/IOpenACCredentialAnchor.sol:32:5
     event CredentialRevoked(
```
Cascades into two more errors where the event is used as a revert reason:
```
TypeError: Expression has to be an error.
  --> contracts/core/OpenACCredentialAnchor.sol:101:33  and  :122:33
     if (rec.revoked) revert CredentialRevoked(agentId, credentialType);
TypeError: Wrong argument count for function call: 2 arguments given but expected 3.
  --> contracts/core/OpenACCredentialAnchor.sol:101:33  and  :122:33
```

### Break 4 — duplicate event declaration (build-time, fatal)
```
DeclarationError: Event with same name and parameter types defined twice.
  --> contracts/core/GeneralizedPredicateVerifier.sol:75:5   event ContextHasherSet(address indexed hasher);
Note: Other declaration is here:
  --> contracts/interfaces/IGeneralizedPredicateVerifier.sol:35:5
```

### Break 5 — net effect: `Error HH600: Compilation failed`
8 distinct `solc` errors. No artifacts, no typechain types. Consequently `packages/contracts/test/*.ts` (which `import type { … } from '../../typechain-types'`, `FullFlow.test.ts:4-10`) has **never executed**.

### Break 6 — the holder package cannot be imported at all (runtime, fatal)
```
$ npm test    # packages/holder
Exception during run: ReferenceError: Cannot access 'StubWalletUnit' before initialization
    at Object.<anonymous> (packages/holder/src/openacAdapter.js:47:5)
```
Source (`packages/holder/src/openacAdapter.ts:56-66`):
```ts
let WalletUnit: new () => IWalletUnit
try {
  const mod = require('@privacy-ethereum/zkid-wallet-unit-poc')
  WalletUnit = mod.WalletUnit ?? mod.default
} catch {
  WalletUnit = StubWalletUnit as unknown as new () => IWalletUnit   // ← line 64
}
```
`class StubWalletUnit` is declared at **line 119** — a `class` binding is in the temporal dead zone at line 64. The `catch` branch is *always* taken (the wallet-unit-poc dependency is absent and not in any manifest), so **module load always throws**. `packages/verifier/src/offchainVerifier.ts:3` imports this module, so anything touching the real verification path dies too. This is also flagged statically: `tsc` → `src/openacAdapter.ts(64,16): error TS2449: Class 'StubWalletUnit' used before its declaration.`

**Implication:** `README.md:277` states *"All tests pass without the real library."* The holder test suite has never run.

### Break 7 — root `npm run build` fails in 4 of 7 workspaces
```
> @acta/shared@0.1.0 build   > tsc
error TS2688: Cannot find type definition file for 'minimatch'.
npm error code 2   (repeats for issuer, holder, verifier)
```
Version-drift in hoisted `@types`, so partly environmental — but it means the documented `npm install && npm test` (`README.md:110-120`) fails immediately for a fresh cloner.

### Break 8 — workspace packages depend on an artifact the build never produces
```
Error: Cannot find module '…/node_modules/@acta/shared/dist/index.js'.
Please verify that the package.json has a valid "main" entry
```
`packages/shared/package.json` sets `"main": "dist/index.js"`, `dist/` is gitignored, and Break 7 prevents building it. So `npm test` at the root fails for sdk/verifier/holder even before their own bugs bite. **I only got sdk (13) and verifier (18) tests green by manually running `npx tsc --types node` in `packages/shared` first** — a step no documentation mentions.

### Break 9 — the sentinel verifier rejects every sentinel the codebase produces (**empirically demonstrated**)
`TestOpenACSnarkVerifier.sol:20-21,35-40`:
```solidity
bytes32 private constant SENTINEL = keccak256(abi.encodePacked("OPENAC_TEST_PROOF_V1"));
...
if (proof.length != 256) return false;
return keccak256(proof) == SENTINEL;
```
It demands a **256-byte** proof whose keccak equals the keccak of a **20-byte string**. Collision-resistance says that never happens. I compiled the contract in isolation (the only way, given Breaks 2–5), deployed it, and called it with the exact byte strings the repo constructs:

```
FullFlow.test.ts SENTINEL_PROOF   len(bytes)= 256  verifyProof -> false
StubWalletUnit(V1) proofBytes     len(bytes)= 256  verifyProof -> false
StubWalletUnitV2 proofBytes       len(bytes)= 256  verifyProof -> false
contract SENTINEL constant = 0x4b4a89256e6c833b183a2c74dedd36436220049f032f69b11072d233c0617ae4
keccak256(256-byte proof)  = 0x5ae2e50d7ac3d2a570b682605f805a12a8c5cb05aab2edf9cb1731891fc343b6
```
Sources of those bytes: `FullFlow.test.ts:34-35` (`zeroPadBytes(TEST_PROOF, 256)`), `openacAdapter.ts:165-166` and `openacAdapterV2.ts:178` (`SENTINEL.slice(2).padEnd(512,'0')`).

**Therefore `FullFlow.test.ts:182` — "verifyAndRegister completes all 10 steps and emits PresentationAccepted" — would revert `ProofInvalid()` at Step 8 (`GeneralizedPredicateVerifier.sol:258`) even in a world where the contracts compiled.** Two independent proofs that the flagship integration test never ran.

### Break 10 — V2 has no on-chain verifier at all
`StubWalletUnitV2` emits `OPENAC_TEST_PROOF_V2` (`openacAdapterV2.ts:99`). The only test verifier recognises `…_V1` and reports `circuitId() = keccak256("OpenACGPPresentation.v1")` (`TestOpenACSnarkVerifier.sol:12-13`). There is no `TestOpenACSnarkVerifierV2`. The v0.4 "shipped" V2 path has **no on-chain counterparty**, working or fake.

### Break 11 — contextHash algorithm disagreement
The circuit outputs `contextHash = Poseidon(verifierAddress, policyId, nonce)` (`OpenACGPPresentation.circom:203-207`; V2 `:274-278`) and the contract recomputes **Poseidon** via `IPoseidonT4` (`GeneralizedPredicateVerifier.sol:243-247`). But `FullFlow.test.ts:164-169` builds the expected value with `ethers.keccak256(solidityPacked(...))`. The mismatch is invisible only because Step 7 is *skipped entirely* on `block.chainid == 31337` (`GeneralizedPredicateVerifier.sol:238-241`). The stub does the same, and admits it: `openacAdapter.ts:19-21` — *"The StubWalletUnit approximates the contextHash with keccak256 … MUST NOT be used with a deployed IPoseidonT4 contract."* **Front-running protection is off in every configuration that has ever been exercised**, and no `IPoseidonT4` implementation exists in the repo — only the interface (`contracts/lib/PoseidonT4.sol` is an `interface`, `:26`).

### Break 12 — cross-package source imports make `tsc` structurally unbuildable
```
src/didEthrSetup.ts(4,57): error TS6059: File '…/packages/issuer/src/didEthrSetup.ts' is not under
   rootDir '…/packages/holder/src'. 'rootDir' is expected to contain all source files.
```
`packages/holder/src/didEthrSetup.ts:4`, `packages/verifier/src/agent.ts:7` and `packages/verifier/src/offchainVerifier.ts:2` all reach into `../../issuer/src/…`. Packages import each other's *source*, not their published surface. Plus `issuer` itself doesn't typecheck against Credo.ts 0.5:
```
src/agent.ts(47,14): error TS2339: Property 'addResolver' does not exist on type 'DidsApi'.
src/agent.ts(37,13): error TS2322: … OpenId4VciCredentialRequestToCredentialMapper … Expected 2 or more, but got 1.
src/agent.ts(148,73): error TS2304: Cannot find name 'CryptoKey'.
```
The issuer/holder/verifier services have never been built or started.

### Break 13 — `docker-compose up --build` cannot succeed
`docker-compose.yml` builds `issuer` (`:55-74`), `holder` (`:77-97`) and `verifier` (`:100-119`) from `packages/{issuer,holder,verifier}/Dockerfile` — **none of those three files exist**. Only `packages/contracts/Dockerfile` and `packages/demo-app/Dockerfile` are present. So `npm run docker:up` (advertised in `README.md:123`) fails on 3 of 5 services.

### Also true, and important
- **No CI.** There is no `.github/` directory. Nothing has ever been checked automatically.
- **No build artifacts of any kind.** `find` for `*.r1cs`, `*.zkey`, `*.wasm`, `*.ptau`, `*_generated.sol` → **nothing**. `circuits/build/` does not exist. `packages/contracts/deployments/` does not exist.
- **`circomlibjs` is in neither any manifest nor the lockfile** (0 hits). So `packages/shared/src/poseidon.ts:37-48` **always** takes the `catch` branch, and every commitment/root/nullifier/program-hash in this repo is computed by `poseidonFallback()` — which its own comment (`:30-31`) describes as *"NOT compatible with circomlib Poseidon"*. The 66 passing `@acta/shared` tests validate a keccak function against itself.

---

## 3. ZK reality check — the proof layer is a string constant

There is **no proving code** in this repository. Not "incomplete" — absent. Every `snarkjs` reference in the codebase is a comment about a future integration (`witness.ts:5,44,280`; `openacAdapterV2.ts:16,207`; `sdk/holder.ts:16`); `snarkjs` is not a dependency of anything.

**Smoking gun 1 — the V1 "prover"** (`packages/holder/src/openacAdapter.ts:147-178`):
```ts
async generateProof(params: {...}) {
    const cred = this.store.get(params.credentialId)!
    ...
    const SENTINEL = ethers.keccak256(ethers.toUtf8Bytes('OPENAC_TEST_PROOF_V1'))
    const proofBytes = Buffer.from(SENTINEL.slice(2).padEnd(512, '0'), 'hex')
    return { proofBytes, nullifier, contextHash, predicateProgramHash, ... }
}
```
The "proof" is a constant. The public signals are computed directly in TypeScript from the private data — there is no soundness relationship between them and the proof bytes whatsoever.

**Smoking gun 2 — the V1 "verifier"** (`openacAdapter.ts:180-184`):
```ts
async verifyProof(_params: { proofBytes: Buffer; publicSignals: bigint[] }): Promise<boolean> {
    const sentinelBytes = Buffer.from(SENTINEL.slice(2).padEnd(512, '0'), 'hex')
    return _params.proofBytes.equals(sentinelBytes)
}
```
Verification is a string comparison that **ignores `publicSignals` entirely**. Any set of public signals is accepted with the fixed constant.

**Smoking gun 3 — V2 is the same, one field better** (`openacAdapterV2.ts:194-197`):
```ts
async verifyProof(p: {...}): Promise<boolean> {
    return p.proofBytes.equals(sentinelBytes) && p.publicSignals.length === 7
}
```
Checks the *length* of the signal array.

**Smoking gun 4 — the off-chain verifier's V2 path** (`packages/verifier/src/offchainVerifier.ts:113`):
```ts
// V2 verification: binds proof to expectedPredicateHash + checks sentinel.
```
The only real check in `verifyOffchainV2` is a string equality on `predicateProgramHash` (`:281-286` in the adapter) — an off-chain agreement between two pieces of the same process, with no cryptographic content.

**Smoking gun 5 — the production verifier is a revert stub** (`OpenACSnarkVerifier.sol:31-36`):
```solidity
function verifyProof(bytes calldata, uint256[] calldata) external pure override returns (bool) {
    revert VerifierNotConfigured();
}
```
This one is *good practice* — deliberately fail-closed so a sentinel can't reach mainnet. Credit where due.

**Smoking gun 6 — the deploy script undermines exactly that** (`packages/contracts/scripts/deploy.ts:41-68`):
```ts
// ── 3. TestOpenACSnarkVerifier (local dev only) ───
const TestOpenACSnarkVerifier = await ethers.getContractFactory('TestOpenACSnarkVerifier')
const snarkVerifier = await TestOpenACSnarkVerifier.deploy()
...
const regTx = await gpVerifier.registerCircuitVerifier(circuitId, snarkVerifierAddr)
```
There is **no network branch**. `npm run deploy:base-sepolia` runs this same script and would install the sentinel verifier on a public testnet — and then write it into the deployments file under the key `OpenACSnarkVerifier` (`:105-106`), mislabelling it. (Mitigated in practice only because the contracts don't compile.)

**What *is* real:** the witness *builder* (`packages/shared/src/gp/witness.ts`) genuinely constructs a complete, correctly-shaped circuit input map including the postfix stack trace, refuses to build for an unsatisfied program (`:221-225`), and cross-checks itself against an independent evaluator (`:228-231`). It is real engineering pointed at a circuit that was never compiled.

---

## 4. Circuit soundness — line-by-line

Five `.circom` files, ~800 lines. **None has ever been compiled.** Findings are static.

### 4.1 CRITICAL — the issuer's signature is not verified in-circuit, and nothing else compensates

`circuits/presentation/OpenACGPPresentation.circom:60,73,79`:
```circom
signal input issuerPubKeyCommitmentPrivate;   // :60  (private)
signal output issuerPubKeyCommitment;         // :73  (public)
issuerPubKeyCommitment <== issuerPubKeyCommitmentPrivate;   // :79
```
Identical in V2 (`OpenACGPPresentationV2.circom:51,74,79`). `grep -rniE "eddsa|ecdsa|signature" circuits/` returns **nothing**. There is no signature — EdDSA, ECDSA, or otherwise — anywhere in any circuit.

**What this means concretely.** The circuit proves: *"I know attribute values and randomness whose Poseidon hash equals this commitment, and they satisfy this predicate."* It says **nothing** about who issued those attributes. `issuerPubKeyCommitment` is a value the prover types in.

**The full attack, end to end** (every link verified):
1. Attacker invents `attributeValues[]` — `auditScore = 100`, jurisdiction `US`, all capabilities set — and random `randomness`.
2. Computes `commitment = Poseidon(attrs, randomness)` and the Merkle root. No issuer involved.
3. Anchors it: `OpenACCredentialAnchor.anchorCredential(agentId, type, commitment, root)`. The only gate is `msg.sender == address(uint160(agentId))` (`OpenACCredentialAnchor.sol:61`) — **the attacker is anchoring under their own agentId, which is exactly what the contract wants.**
4. Proves the predicate over their invented attributes and sets `issuerPubKeyCommitmentPrivate` to the honest issuer's commitment (a public value, derivable from the issuer's DID via `pubKeyToFieldCommitment`, `openacAdapter.ts:471-475`).
5. On-chain: Step 5 root ✓ (they anchored it), Step 5b commitment ✓, **Step 6 `issuerCommitment != policy.issuerCommitment` ✓ — because they supplied it**, Step 8 Groth16 ✓ (a real proof of a true-but-worthless statement). `PresentationAccepted` emitted.

The only issuer check in the entire system is the ES256K JWT-VC verification at `openacAdapter.ts:251-256` — which runs **inside the attacker's own holder process**. It is a UX check, not a security boundary.

The repo does disclose this, at Medium severity, in `docs/SECURITY_AUDIT.md:212-217` ("ACTA-017 … Full cryptographic binding via in-circuit signature verification remains out of scope for this PoC"). But `docs/ARCHITECTURE.md:216` simultaneously sells it as mitigated: *"Issuer substitution | `issuerCommitment` checked in Step 6"*. **Rating it Medium is wrong. This is the protocol's entire trust root; without it ACTA proves nothing.**

### 4.2 CRITICAL — comparator inputs are range-checked on neither side (V2)

`circuits/lib/PredicateEval.circom:75-85`:
```circom
component leCmp = LessEqThan(COMPARE_BITS);   // COMPARE_BITS = 64
leCmp.in[0] <== lhs;   leCmp.in[1] <== rhs;
component geCmp = GreaterEqThan(COMPARE_BITS);
geCmp.in[0] <== lhs;   geCmp.in[1] <== rhs;
```
There is **no `Num2Bits` on `lhs` or `rhs`**. circomlib's `LessThan(n)` computes `Num2Bits(n+1)` over `in[0] + 2^n - in[1]`; it is **sound only if both inputs are already known to be < 2^n**. With BN254 field elements as inputs, an adversarial value can wrap mod p into a valid `n+1`-bit range and flip the comparison result. This is the single most common ZK vulnerability class, and it is present in the operator every predicate depends on.

`lhs` comes from a claim selector (`:44-54`) over `attributeValues[]` — private inputs constrained *only* by the commitment. `rhs` comes from `operand` (`:72`), likewise unconstrained. **Both sides are attacker-controlled and neither is bounded.**

The V1 circuit *did* have one range check (`OpenACGPPresentation.circom:123-126`, `auditScore ≤ 100`) with an excellent comment explaining exactly this hazard. **V2 — the "shipped v0.4" path — dropped it and added no replacement.** A regression away from the safer design.

Additional under-constraints in the same file:
- `claimIdx` is never constrained to `[0, N)`. If out of range, the selector loop (`:47-52`) matches nothing and `lhs` silently becomes **0**.
- `operand` under `isClaimRef = 1` is never constrained to `[0, N)`; same silent-zero (`:60-67`).
- Silent-zero + unbounded comparator means an out-of-range predicate evaluates `0 ≥ 0 → true`. Exploitability is limited *today* because the verifier pins the program via `predicateProgramHash` — but that is a policy accident, not a circuit guarantee.

### 4.3 CRITICAL — expiry is a free variable, and credential expiry doesn't exist

`OpenACGPPresentationV2.circom:55,77,80`:
```circom
signal input expiryBlockPrivate;   // private, no constraints anywhere
signal output expiryBlock;
expiryBlock <== expiryBlockPrivate;
```
No range check, no comparison, no binding to anything. The prover picks it; the only check is on-chain `expiryBlock <= block.number` (`GeneralizedPredicateVerifier.sol:212`), so a prover simply picks a large number.

Worse: **the credential has no expiry attribute at all.** `ATTRIBUTE_INDEX` (`packages/shared/src/constants.ts:19-26`) is `AUDIT_SCORE, MODEL_HASH, OPERATOR_JURISDICTION, CAPABILITIES_BITMASK, AUDITED_BY_HASH, AUDIT_DATE_UNIX` — indices 6–15 are forced to zero (`circuit :283-285`). `CREDENTIAL_VALIDITY_DAYS = 90` (`constants.ts:63`) exists only as an off-chain constant. **There is no in-circuit notion of credential validity, and no possible way to constrain one with this schema.** Revocation is on-chain only (`OpenACCredentialAnchor.revokeCredential`), checked at Step 5 via `isMerkleRootCurrent`.

### 4.4 CRITICAL (novel; not in the prior audit) — the anonymity set is one

Two independent deanonymisation channels, both in the shipped design:

**(a) `agentId` is cleartext calldata.** `GeneralizedPredicateVerifier.verifyAndRegister(bytes32 policyId, bytes proof, uint256[] pubSignals, uint256 agentId, uint256 nonce)` (`:178-184`). `agentId == uint256(uint160(holderAddress))` (`OpenACCredentialAnchor.sol:14-16`; constructed at `onchainSubmitter.ts:60-64`). Every verification transaction publishes the holder's Ethereum address in the clear, forever. `AnonymousReputationPool`'s comment — *"At no point is the agent's real identity revealed"* (`:18-19`) — is false as built.

**(b) The public signals are static per credential.** `credentialMerkleRoot` (pubSignals[4]) and `credentialCommitment` (pubSignals[5]) are fixed for the life of a credential. Every presentation, to every verifier, carries the same two values — and the same values appear in the public `CredentialAnchored` event, signed by the holder's address. **All presentations of one credential are trivially linkable to each other and to a real Ethereum identity, with or without the nullifier.**

The stealth-address work (ADR-0002, `packages/shared/src/stealth.ts`) addresses only *who sends the transaction*. It cannot fix (a) — `agentId` is an explicit argument that must match the anchor — nor (b). The anchor-by-holder-commitment redesign (ADR-0003) is the right fix and is marked *planned (v0.5)*.

### 4.5 HIGH — nullifier derivation gives no sybil resistance

`circuits/lib/NullifierDerive.circom:41-50`:
```circom
nullifier = Poseidon(credentialSecret, Poseidon(verifierAddress, policyId, nonce))
```
with `credentialSecret = Poseidon(credentialCommitment, randomness)` (`V2 :262-264`).

Two problems:

1. **The nonce is in the nullifier.** The nonce is per-session and verifier-supplied (`presentationRequest`), so *one credential yields unlimited distinct nullifiers*. The repo states this explicitly as a feature — `NullifierRegistry.sol:77-79`: *"A legitimate re-presentation always uses a fresh nonce → different nullifier."* That is fine for replay protection of a single request and **useless as a per-identity limit**. Combined with `ZKReputationAccumulator` keying reputation on `(policyId, nullifier)` (`:35`), an agent can mint a fresh pseudonym per session and farm reputation indefinitely. A nullifier should be scoped to `(credential, verifier, policy [, epoch])` — *not* to a nonce — if it is meant to bound identity.
2. **No holder master secret.** `credentialSecret` is derived purely from the credential commitment and its blinding factor. Any party who learns `(attributes, randomness)` — e.g. the issuer, who chose the attributes, or anyone who ever imported the credential — can recompute every nullifier the holder will ever produce, for every context. There is no secret only the holder knows. The `holderMasterSecret` concept exists in `stealth.ts` but is **not wired into the circuit at all**.

### 4.6 MEDIUM — the Merkle "tree" is decorative

Both circuits compute `credentialMerkleRoot` as a fixed 4-level Poseidon fold over all 16 attributes (`V1 :93-117`, `V2 :92-116`) — no leaf selection, no path, no membership proof. It is a second hash of the same data already committed by `commitHasher`. `circuits/lib/MerkleProof.circom` implements a *correct* inclusion proof (and looks fine: proper `MultiMux1` ordering, `root === knownRoot` at `:75`) — **but nothing imports it.** The V1 presentation circuit `include`s it (`:7`) and never instantiates it. Two hashes, one purpose, extra constraints, zero added security.

### 4.7 Under-constrained signals — the good news

I checked specifically for `<--` (assignment without constraint), the classic under-constraint footgun: **there are zero occurrences in any circuit.** Every assignment is `<==` or `===`. Credit where due.

And `PostfixEval.circom` — the piece most likely to be under-constrained — **is actually sound.** The prover supplies the whole stack trace as witness, but:
- `dpTrace[0] === 0` and `stackTrace[0][d] === 0` pin the initial state (`:55-58`);
- `typeSum[k] === 1` forces exactly one token type (`:109-110`);
- `dpTrace[k+1] === dpTrace[k] + isPred - isAND - isOR` (`:141-142`) makes the depth sequence **fully determined** by the (hash-bound) token types;
- `stackTrace[k+1][d] === keep + writeVal` (`:186`) makes every cell fully determined by the previous state;
- `dpTrace[T] === 1` (`:191`) and `postfix.finalValue === 1` (`V2 :150`) pin the result.

Given the token program (bound by `predicateProgramHash`) and the predicate results, the entire trace is uniquely determined — a prover has no freedom. **This is the best-engineered part of the repository and is worth carrying forward.** Two nits: stack cells are never explicitly constrained boolean (harmless given determinism from a boolean-valued `pushVal`, but a `b*(1-b)===0` per written cell would be cheap defence-in-depth), and `NOT`/`AND` at insufficient depth silently no-op rather than failing (`writePosEqUnary` at `dp=0` matches nothing) — the depth arithmetic makes this unreachable for valid programs, but it should be an explicit constraint, not an emergent property.

### 4.8 Likely compile failure (static; **unverified — no `circom` on this machine**)

`OpenACGPPresentation.circom` declares signals and components **inside `for` loop bodies**:
- `:157` `signal capGate;` inside `for (var i = 0; i < 8; i++)`
- `:167` `component isNotSanctioned = IsEqual();` inside `for (var j = ...)`
- `:173` `signal jGate;` inside the same loop

circom 2.x requires signal and component declarations at template scope (components inside loops must be declared as arrays outside them, exactly as this same file correctly does at `:93,:100,:107`). I expect `circom` to reject this file outright. Notably, the V2 circuit does *not* make this mistake — consistent with V2 being written later and neither ever being compiled. **Confidence high; flagged as unverified because I could not run `circom`.**

**Also unverified for the same reason:** whether `foldPoseidonHash()` in `encoder.ts:218-236` actually agrees with the circuit's 128-leaf fold (`V2 :201-259`). The layouts *read* as identical (75 leaves → zero-pad to 128 → 7 levels of `Poseidon(2)`), which is careful work — but the TypeScript side has only ever run against the keccak fallback, so the parity is asserted, never demonstrated. `docs/ROADMAP.md:56` lists the parity-vector test as Open, and the file it names does not exist.

---

## 5. Contracts

The architecture is better than the implementation. Findings, severity-ordered.

### 5.1 CRITICAL — owner-swappable circuit verifier, no timelock, no immutability
```solidity
function registerCircuitVerifier(bytes32 circuitId, ICircuitVerifier verifier) external onlyOwner {
    _circuitVerifiers[circuitId] = verifier;      // GeneralizedPredicateVerifier.sol:106-111
}
```
The owner can, at any time and with immediate effect, point any `circuitId` at a contract whose `verifyProof` returns `true` unconditionally — silently invalidating every policy and every past and future acceptance. No two-step, no timelock, no event, no per-policy pinning. **Answering the question directly: yes, the verifier is owner-swappable, and this is the single largest centralisation risk in the contract set.** `setContextHasher` (`:92-95`) has the same shape: the owner can set it to `address(0)` and disable Step 7 front-running protection on a live chain.

### 5.2 CRITICAL — Step 7 silently disabled on any chain in test mode
```solidity
if (address(contextHasher) == address(0)) {
    if (block.chainid != 31337) { revert ContextHasherNotConfigured(); }   // :238-241
} else { ... }
```
The fail-closed guard for non-31337 is good. But *every test and every simulation this project has ever run* is on 31337, so the contextHash binding — the thing that ties a proof to `(msg.sender, policyId, nonce)` and stops front-running — has never been exercised, and the Poseidon implementation it needs does not exist in the repo (only `interface IPoseidonT4`, `lib/PoseidonT4.sol:26`).

### 5.3 HIGH — no rate limit and no authorisation on reputation writes
`AnonymousReputationPool.sol:51-63`:
```solidity
function contributeAction(bytes32 nullifier, bytes calldata actionData) external returns (bool) {
    if (!gpVerifier.isAcceptedForPolicy(nullifier, policyId)) revert NullifierNotAccepted(nullifier);
    _actionCount[nullifier]++;
    reputationAccumulator.increment(policyId, nullifier, REPUTATION_PER_ACTION);
```
**Anyone can call this with anyone's nullifier.** Nullifiers are public — they are emitted in `PresentationAccepted` (`GeneralizedPredicateVerifier.sol:266`) and indexed. There is no proof that the caller controls the nullifier, no per-block/per-caller limit, and no cap on total accumulation. An observer can scrape nullifiers from logs and either farm reputation for themselves or grief a competitor by inflating theirs into an implausible range. `ZKReputationAccumulator.increment` (`:68-87`) caps only `delta` per call (`maxDeltaPerOp`) — a per-*call* bound is not a rate limit when calls are unlimited. Combined with §4.5 (unlimited nullifiers per credential), anonymous reputation here is meaningless.

Also `success = actionData.length >= 0;` (`:62`) — a `uint256` is always `>= 0`; the function unconditionally returns true. Same pattern, less harmful, at `AgentAccessGate.sol:125`.

### 5.4 MEDIUM — no plaintext credentials in structs (good), but the commitment is as good as an identifier
Answering the checklist item directly: **no**, `PolicyDescriptor` (`IGeneralizedPredicateVerifier`) and the public signal array contain no plaintext attributes. Everything on-chain is a hash or commitment. **However**, as covered in §4.4, `credentialCommitment` + `credentialMerkleRoot` + `agentId` together function as a stable, publicly-linkable identifier — so the privacy benefit of not storing plaintext is forfeited anyway.

### 5.5 Nullifier checks — present and, at the contract layer, correct
`NullifierRegistry.register` (`:64-98`) rejects zero nullifiers, rejects already-expired expiry, and — the good part — refuses re-registration **even for expired or revoked** nullifiers (`:85-87`), with a clearly-reasoned comment (`:74-84`). `verifyAndRegister` records both `_acceptedNullifiers` and `_policyAcceptances` (`:262-263`), and consumers are steered to the policy-scoped check (`isAcceptedForPolicy`, `:283-285`), which `AgentAccessGate:77`, `ZKReputationAccumulator:74` and `AnonymousReputationPool:56` all correctly use. `lockAuthorization` (`:52-55`) is a reasonable pattern. **The replay/cross-policy story at the contract layer is genuinely well done — it is upstream, in the circuit, that the nullifier stops meaning anything.**

### 5.6 Other observations
- `OpenACCredentialAnchor` correctly enforces self-sovereign anchoring (`:61`), forces `rotateCredential()` for updates so the audit trail is preserved (`:66-73`), and tracks `_usedCommitments` globally. Clean.
- `AgentAccessGate._permanentlyRevoked` (`:33,75,95`) correctly closes the re-grant-after-revoke hole. Good.
- `GeneralizedPredicateVerifier` is `ReentrancyGuard` + `Pausable` (`:52`) — the pause is owner-only and covers `verifyAndRegister` and `registerPolicy`, another centralisation lever to note.
- `registerPolicy` (`:120-158`) has no expiry validation (`desc.expiryBlock` may be in the past; `0` means never-expires) and lets anyone register any policy — reasonable for a permissionless registry, worth being deliberate about.

---

## 6. What's reusable vs. what to discard

### Take these designs (re-implement; do not copy files)

| Asset | Where | Why it's good |
|---|---|---|
| **Generalized-predicate IR** | `packages/shared/src/gp/types.ts` | Clean, minimal, honest about its provenance (zkID). `(claimIndex, op ∈ {le,ge,eq}, operand: const \| claimRef)` + postfix `{PRED, AND, OR, NOT, PAD}` is exactly the right factoring: one circuit, arbitrary policies, hash-bound program. This is the single best idea in the repo |
| **Canonical program encoding + hash** | `gp/encoder.ts:176-248` | Fixed-shape padding to circuit bounds, versioned leaf vector, zero-pad to a power of two, Poseidon(2) binary fold. Explicitly documents that changing the layout requires a version bump and re-derivation of every policy hash (`:11-19`, `:172-175`). Carry the *scheme* verbatim |
| **Witness builder with fail-fast semantics** | `gp/witness.ts:110-263` | Builds the full stack trace, **refuses to build for an unsatisfied program** (`:221-225`) rather than producing a witness that fails obscurely in `snarkjs`, and cross-checks against an independent evaluator (`:228-231`). Excellent developer ergonomics |
| **`PostfixEval` trace-verification pattern** | `circuits/lib/PostfixEval.circom` | Prover supplies the trace; circuit checks initial state, per-step transition, final state. Fully determined ⇒ sound (see §4.7). Reusable as-is conceptually; add explicit booleanity per cell |
| **Contract decomposition** | `contracts/core/*`, `interfaces/*` | Anchor / NullifierRegistry / policy-and-verification / reputation, with an `ICircuitVerifier` seam so the Groth16 verifier is swappable. Right shape |
| **The 10-step verification sequence** | `GeneralizedPredicateVerifier.sol:185-267` | Policy → signal count → predicate hash → expiry → merkle root → commitment → issuer → context → proof → nullifier → event. A genuinely good checklist; keep the ordering and the named custom errors |
| **Policy-scoped acceptance** | `isAcceptedForPolicy` (`:283-285`) + all three consumers | Prevents a weak-policy nullifier from unlocking a strict gate. Subtle, correct, well-commented |
| **Nullifier re-registration ban incl. expired/revoked** | `NullifierRegistry.sol:74-87` | Good reasoning, well documented |
| **Fail-closed production verifier stub** | `OpenACSnarkVerifier.sol:31-36` | Reverting rather than returning false, so a misconfiguration can't be mistaken for a rejection. Keep this pattern |
| **Stealth-address derivation** | `packages/shared/src/stealth.ts` | Textbook HKDF-SHA256 → `SHA256(seed) mod (n-1) + 1` → secp256k1, correct domain separation (`acta-stealth/v1`, `:41`), canonicalised info string (`:111-120`), input validation (`:150-166`), delegates pubkey/address to ethers (`:172-175`). 24 passing tests including 256-distinct-address uniqueness. **The one file I'd consider lifting nearly verbatim** — after replacing `holderCommitment`'s SHA-256 placeholder (`:202-206`) with Poseidon |
| **ADR-0003 (anchor by holder commitment)** | `docs/adr/0003-*.md` | The correct fix for §4.4(a). Implement it from day one, not as "v0.5" |
| **The docs themselves** | `docs/SPEC.md`, `ARCHITECTURE.md`, `FLOW.md` | As *specification*, these are decent and worth mining for the fresh spec — with every number re-derived |

### Discard

| Asset | Why |
|---|---|
| **All Solidity, as code** | Doesn't compile against the OZ version it pins. Reuse the architecture; retype the code |
| **`openacAdapter.ts` / `openacAdapterV2.ts`** | Sentinel provers; the V1 file also can't be imported. Nothing to salvage beyond `credentialSubjectToAttributes` mapping conventions |
| **`packages/shared/src/poseidon.ts`** | The keccak fallback is a trap: it makes every hash *look* like it works while guaranteeing it can never match a circuit. Depend on `circomlibjs` (or a Rust/WASM Poseidon) hard, and fail loudly if absent — never fall back |
| **`openac-sdk/`** | Unattributed vendored third-party code, broken sibling paths, orphan, proves an unrelated statement. Delete |
| **`packages/demo-app/`** | 20+ files of simulation. `mockHolder.ts:31` literally emits the string `'0x[256-byte-groth16-proof]'`. Honestly labelled in the README, but it is the largest chunk of the repo and the most likely thing to be mistaken for working software. Build the demo on real output or not at all |
| **`circuits/anchor/OpenACCredentialAnchor.circom`** | Proves only that a hash was computed correctly, with no signature and no secret. Superseded by the ADR-0003 design |
| **`circuits/lib/MerkleProof.circom`** | Correct but unused. Either use a real Merkle inclusion proof for selective disclosure, or drop the "Merkle" concept entirely and keep one commitment |
| **All gas figures, constraint counts, and timings in the docs** | Unmeasurable in this repo (§7). Re-derive from real runs or delete |

---

## 7. Reality-vs-claims scorecard

| # | Documented claim | file:line | Ground truth | Verdict |
|---|---|---|---|---|
| 1 | "Reference implementation … **Production-grade Solidity contracts**" | `README.md:3` | 8 solc errors; never compiled | ❌ **False** |
| 2 | "The architecture and protocol design are production-grade." | `docs/PM_GUIDE.md:134` | Architecture is decent; implementation is non-functional | ⚠️ Misleading framing |
| 3 | "Compile Solidity contracts … `npm test`" (setup instructions) | `README.md:116-120` | `npm run build` fails in 4/7 workspaces; `hardhat compile` fails | ❌ **False** |
| 4 | "**All tests pass without the real library.**" | `README.md:277` | Holder tests throw at import; issuer tests fail typecheck; contract tests can't compile | ❌ **False** |
| 5 | "92 unit tests pass across shared/verifier/holder/sdk" | `SECURITY_AUDIT.md:270`, `ROADMAP.md:154` | I measured 66 + 18 + 13 = **97 passing, and only after an undocumented manual build step**; holder = 0 | ❌ Not reproducible as written |
| 6 | Gas table: `verifyAndRegister() (with Poseidon + Groth16) ~205,000 gas` | `README.md:203`; echoed `adr/0002:56`, `PM_GUIDE.md:93` (as ~200,000) | **Impossible to have measured**: contracts don't compile, no Groth16 verifier exists, no Poseidon implementation exists, `REPORT_GAS=false` (`.env.example:37`), no gas snapshot in repo. Stated without an "estimated" qualifier, and self-inconsistent across docs | ❌ **Fabricated-by-estimation** |
| 7 | "`// valid: true, timingMs: ~50`" | `docs/FLOW.md:206` | No benchmark artifact exists | ❌ Unsupported |
| 8 | "Constraints: ~50,000 (estimated; run `snarkjs r1cs info` after compilation)" | `ARCHITECTURE.md:144` | Honestly hedged; no `.r1cs` exists | ✅ Honest |
| 9 | "25k–40k constraints … To be confirmed by snarkjs once the V2 circuit compiles" | `adr/0001:53` | Honestly hedged | ✅ Honest |
| 10 | "Proving system: Groth16 (BN254)" | `ARCHITECTURE.md:142`, `SPEC.md:220` | Aspirational. No proving code, no keys, no `snarkjs` dependency | ⚠️ Spec-mode, easily misread as descriptive |
| 11 | "**Public signals (6)**" | `SPEC.md:29,31,240-249,693`; `ARCHITECTURE.md:156-164` | Code has **7** (`OpenACGPPresentation.circom:70-76`; `EXPECTED_PUBLIC_SIGNAL_COUNT = 7`). The spec is normatively wrong and stale vs. the repo's own audit doc | ❌ **False** |
| 12 | "Issuer substitution \| `issuerCommitment` checked in Step 6 \| mitigated" | `ARCHITECTURE.md:216` | The prover supplies that value (§4.1). Not a mitigation | ❌ **False** |
| 13 | "ACTA-017 Issuer commitment not in-circuit (**Medium**) … Mitigated (off-chain checks)" | `SECURITY_AUDIT.md:212-217` | Disclosure is honest; **severity is wrong** — this is critical, and the "off-chain checks" run on the attacker's own machine | ⚠️ Correct fact, wrong rating |
| 14 | Audit scorecard: "Critical 3/3 fixed, High 9/9 fixed, **Medium 5/5 fixed, Open 0**" | `SECURITY_AUDIT.md:13-15` | ACTA-013, -014, -017 are Medium and explicitly **not** fixed in their own finding bodies. The table contradicts the document | ❌ **Internally inconsistent** |
| 15 | "`OpenACSnarkVerifier` rejects all proofs until replaced" | `README.md:290` | True (`OpenACSnarkVerifier.sol:35`) | ✅ **True** |
| 16 | "Local tests use `TestOpenACSnarkVerifier` only" | `README.md:290`, `SECURITY_AUDIT.md:235` | True — and that verifier **rejects every sentinel the repo produces** (Break 9), which the docs don't know | ✅ True / ⚠️ incomplete |
| 17 | "Deployed Addresses (Base Sepolia) — populated after running the deploy script" | `README.md:181-183` | No addresses claimed anywhere; `deployments/` doesn't exist. **The doc set's strongest honesty point** | ✅ **Honest** |
| 18 | "V2 circuit: **draft** — pending ZK-engineer review + ceremony"; "Live ceremony: blocked on circom/snarkjs install" | `README.md:326-327`, `ROADMAP.md:55` | Accurate | ✅ **Honest** |
| 19 | "Run `test/PoseidonConsistency.test.ts`" | `README.md:300`, `SPEC.md:607` | File does not exist | ❌ False reference |
| 20 | "`packages/shared/test/gp/`", "`packages/holder/test/stealth.test.ts`", "`packages/holder/src/stealth.ts`" | `ROADMAP.md:45,84,85`; `SECURITY_AUDIT.md:188` | All mislocated — real paths are `packages/shared/test/gp*.test.ts` and `packages/shared/{src,test}/stealth.ts` | ❌ Stale references |
| 21 | "`docker-compose up --build` — Full local stack" | `README.md:35,123` | 3 of 5 Dockerfiles missing | ❌ **False** |
| 22 | "Predicate hashing ✅ Real keccak256 computation" (demo) | `README.md:95` | True, and correctly caveated: "ZK proof bytes ⚡ Fake bytes" (`:91`) | ✅ **Honest** |
| 23 | "ACTA does **not** vendor zkID's `wallet-unit-poc`" | `adr/0001:36-40` | Literally true; but a 30-file unattributed copy of zkID's `openac-sdk` sits in the repo root | ⚠️ True-but-misleading |
| 24 | "`hashPredicateProgram()` now uses matching Poseidon hash" (ACTA-003 fixed) | `SECURITY_AUDIT.md:69` | `circomlibjs` is in no manifest and not in the lockfile ⇒ the keccak fallback always runs ⇒ parity is untested and, as shipped, false | ❌ **False** |

**Pattern.** The docs are consistently honest about *ceremony status* and *deployment*, and consistently dishonest — mostly by omission and by stating estimates as measurements — about *whether anything runs*. The failure mode is a well-documented specification that was never once executed, with prose written in the present tense.

---

## 8. Pitfalls checklist for the fresh implementation

Derived directly from every hole above. Treat as acceptance criteria.

### Circuit / cryptography
1. **Verify the issuer's signature inside the circuit.** EdDSA-Poseidon (`circomlib/eddsaposeidon`) over a BabyJubJub issuer key is the standard choice; verify the signature over a message that *is* the attribute commitment, and expose only the issuer key commitment. If you must keep secp256k1/ES256K issuers, budget for in-circuit ECDSA or restructure so an issuer-signed Poseidon commitment is the credential. **No shortcut here: without this, ACTA proves nothing.** (§4.1)
2. **Range-check every comparator input on both sides.** `Num2Bits(n)` on `lhs` *and* `rhs` before any `LessThan`/`LessEqThan`/`GreaterEqThan`. Write a negative test that feeds a field element near `p` and asserts the witness fails. (§4.2)
3. **Constrain every index.** `claimIdx < N`, `operand < N` when `isClaimRef == 1`. Never let an out-of-range selector silently yield 0. (§4.2)
4. **Put expiry in the credential and constrain it in-circuit.** Add a `validUntil` attribute, signed by the issuer, and constrain `currentBlockOrTime <= validUntil` against a public input. Presentation-level expiry is a separate, additional check. (§4.3)
5. **Never expose a stable per-credential value as a public signal.** No `credentialCommitment`, no `credentialMerkleRoot` in `pubSignals`. Prove membership in an *issuer-level* Merkle/accumulator root instead, so the public signal is shared by all holders of that issuer. (§4.4b)
6. **Bind the nullifier to a holder master secret, and keep the session nonce out of it.** `nullifier = Poseidon(masterSecret, verifier, policyId [, epoch])`. Use a separate, non-nullifying binding for per-request replay. Decide explicitly whether you want one-presentation-per-credential-per-verifier or per-epoch rotation — and write the test that proves it. (§4.5)
7. **Ban `<--` in review.** This repo got that right; keep it right. Any `<--` needs an accompanying `===` and a comment justifying it.
8. **Constrain booleanity explicitly** wherever a signal is semantically boolean, even when determinism seems to imply it. Cheap; removes a class of review burden. (§4.7)
9. **One commitment, one purpose.** Don't ship both a Poseidon commitment and a redundant fold over the same data. If you need selective disclosure, use a real Merkle inclusion proof (with path + indices); otherwise drop the tree. (§4.6)
10. **Compile the circuit in CI from commit #1.** `circom --r1cs --wasm`, `snarkjs r1cs info`, and a witness-generation test on a known-good input, on every push. A circuit that has never been compiled is a design document — label it as one. (§2)

### Off-chain / SDK
11. **No sentinel proofs. Ever.** If a real prover isn't ready, the prover interface should `throw new NotImplementedError()`. A fake that "looks real" (`README.md:96` explicitly aims for *"indistinguishable from real outputs"*) is how a repo ends up claiming gas costs for a code path that reverts. (§3)
12. **No silent cryptographic fallbacks.** `poseidon.ts` must hard-fail when the real implementation is unavailable — in *all* environments, not just `NODE_ENV=production`. A keccak stand-in that satisfies every test while matching no circuit is worse than a crash. (§2, claim 24)
13. **Pin the crypto dependency for real.** `circomlibjs` (or equivalent) belongs in `dependencies` and in the lockfile. Verify with `grep circomlibjs package-lock.json` in CI.
14. **Write a cross-implementation parity test before writing the circuit.** Fixed vectors: `(program, claims) → predicateProgramHash, commitment, nullifier`, asserted identical between TypeScript and the compiled circuit's witness. This repo has the *design* for parity (`encoder.ts:158-175`) and never tested it. (§4.8)
15. **Packages consume packages' public APIs, never their `src/`.** No `import '../../issuer/src/…'`. Enforce with `rootDir` + project references, and let CI catch it. (Break 12)
16. **Never reference a class in module-level initialization before its declaration.** Prefer a factory function or a lazy getter for optional-dependency fallbacks — and *test the fallback path*, which here was the only path. (Break 6)
17. **CI from commit #1**: `npm ci` → build all → test all → `hardhat compile` → `circom` compile → lint. This repo has no `.github/`; every break in §2 would have been caught on the first push.

### Contracts
18. **Never accept a raw agent identifier as a public argument.** Anchor by a holder commitment (ADR-0003) and let the proof demonstrate control. Grep the final ABI for anything address-shaped that isn't `msg.sender`. (§4.4a)
19. **Make the verifier address immutable per policy.** Store the `ICircuitVerifier` (or its codehash) *in the `PolicyDescriptor` at registration*, so an owner cannot retroactively change what a policy means. If upgradeability is required, put it behind a timelock and emit an event. (§5.1)
20. **No `chainid`-conditional security.** `if (block.chainid != 31337)` means production semantics are never exercised. Deploy a real Poseidon in the test fixture and run the same code path everywhere. (§5.2, Break 11)
21. **Authorise and rate-limit every reputation write.** Require proof of nullifier control (a signature from the presentation's stealth key, or a fresh presentation), plus per-nullifier caps and per-epoch limits. Assume every nullifier is public the moment it's emitted. (§5.3)
22. **The deploy script must refuse to install test contracts on non-local networks.** A `require(network.name === 'hardhat' || network.name === 'localhost')` guard around any `Test*` deployment, and never write a test address under a production key name. (§3, smoking gun 6)
23. **Keep the fail-closed verifier stub pattern.** Revert, don't return false. (§3, smoking gun 5)
24. **Match your OpenZeppelin major version.** Pin exactly (`5.6.1`, not `^5.0.2`) and compile in CI. Six contracts here use the v4 `Ownable` idiom against a v5 dependency. (Break 2)
25. **Never name an `error` the same as an `event`.** (Break 3)

### Documentation discipline
26. **Every number is either measured or labelled `(estimated)`.** Gas figures come from a committed `gas-report.txt`; constraint counts from committed `r1cs-info.txt`; timings from a committed benchmark. No exceptions — this is where this repo lost the most credibility.
27. **A status table that says "shipped" must mean "runs in CI".** Distinguish *written* / *compiles* / *tested* / *ceremony-complete* / *deployed*, and never collapse them.
28. **Severity ratings must survive an adversary's reading.** "Issuer binding is prover-chosen" is not Medium. If a finding voids the protocol's core claim, it is Critical, regardless of whether it's "out of scope for the PoC".
29. **Keep the scorecard arithmetic consistent with the finding bodies.** (§7, claim 14)
30. **Vendored code carries its LICENSE and a provenance note**, and appears in a `VENDOR.md`. Or it doesn't ship. (§1)

---

## Appendix — prior-audit hypotheses, adjudicated

| Hypothesis | Verdict | Evidence |
|---|---|---|
| (a) ZK layer is a sentinel-string stub, not real proving | **Confirmed** | `openacAdapter.ts:165-166,181-183`; `openacAdapterV2.ts:99,178,194-197`; no `snarkjs`/`circom` in any manifest or the lockfile |
| (b) Circuits never compiled; stack never ran end to end | **Confirmed and extended.** Not just the circuits — the Solidity doesn't compile, the holder can't be imported, the build fails in 4/7 workspaces, there's no CI, and 3 of 5 Dockerfiles are missing | §2, Breaks 1–13 |
| (c) Presentation circuit does not bind the issuer signature | **Confirmed**, with mechanism and a complete exploit path | §4.1; `OpenACGPPresentation.circom:60,73,79`; V2 `:51,74,79`; zero signature primitives in `circuits/` |
| (d) ~four independent breaks in the e2e stack | **Contradicted — undercount.** I found **13**, of which 5 are compile-time fatal and 2 (Breaks 6, 9) are individually sufficient to prove the flow never ran | §2 |
| (e) Nothing nefarious | **Confirmed.** All deps from npm, no lifecycle hooks, no `eval`, no obfuscation, no key exfiltration. The one third-party vendored directory is sloppy (no license, no attribution), not hostile | §1 |

**New findings not in the prior audit:** the cleartext `agentId` and static public signals that defeat anonymity outright (§4.4); the nonce-in-nullifier design that eliminates sybil resistance (§4.5); the empirically-demonstrated fact that the sentinel verifier rejects the sentinel (Break 9); the missing comparator range checks — a *regression* from V1 to V2 (§4.2); the owner-swappable circuit verifier (§5.1); and the unauthenticated, unlimited reputation writes (§5.3).

**Closing note.** The failure here is not incompetence — the GP IR, the postfix trace design, the stealth derivation, the 10-step sequence and the ADRs are the work of someone who understands the problem. The failure is that nothing was ever executed, and the prose was written as though it had been. For the fresh implementation, invert that: run everything in CI from the first commit, and let the documentation lag the code rather than lead it.
