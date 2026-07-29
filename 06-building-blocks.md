# 06 — Building Blocks: The Toolbox Survey

*Research corpus for the ACTA reference implementation ([Anonymous Credentials for Trustless Agents](https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797), a privacy layer on ERC-8004). This doc surveys the off-the-shelf components available for the likely build shape: a Circom circuit combining Semaphore-style Merkle anonymity-set membership + EdDSA-BabyJubJub issuer-signature verification + Poseidon nullifiers + comparison predicates; Solidity verifier contracts; browser-side proving. All versions and maintenance claims verified against live sources as of **late July 2026**.*

---

## TL;DR

Every piece of the target design exists as maintained, mostly-audited, off-the-shelf code — the build is composition, not invention. **Semaphore v4** (v4.14.3, July 2026, actively maintained under the reorganized PSE) supplies the exact identity/membership/nullifier pattern, audited, deployed at the same address on 16 chains — but its circuit proves only *membership*; ACTA must fork/extend it with issuer-signature verification and predicates. **circomlib** supplies those extensions (`EdDSAPoseidonVerifier`, `Poseidon`, comparators, `SMTVerifier` for sanctions non-membership) — de-facto standard but frozen on npm since 2022 and carrying well-documented footguns (unconstrained `LessThan` inputs, `Num2Bits` aliasing) that the implementation plan must handle explicitly. **zk-kit** (now its own GitHub org, very active) provides the LeanIMT tree in JS/Solidity/Circom plus `@zk-kit/eddsa-poseidon` for issuer-side signing — all releases within weeks of this writing, core packages audited. The **circom 2.2.3 + snarkjs 0.7.6 + Groth16** toolchain is alive and remains the right default: ~200–260k verify gas and the fastest browser prover, at the cost of a per-circuit phase-2 ceremony (Hermez ptau files verified live; PSE's p0tion ceremony tooling works but is maintenance-only). Browser proving is comfortable for this circuit's likely size (≲100k constraints → single-digit seconds on desktop); mobile *browsers* fail above ~150–200k constraints on memory, so circuit size is a real design constraint. **Noir/UltraHonk** is the credible alternative — dramatically better ergonomics and proving speed, no per-circuit ceremony, but a ~2.4M-gas EVM verifier (~7× Groth16) and a younger gadget ecosystem (EdDSA demoted from stdlib; Semaphore exists only as third-party ports). For credentials, sign natively with **EdDSA-BabyJubJub-Poseidon** (Privado ID's `BJJSignature2021` is direct precedent); verifying real-world ES256 JWT-VCs in-circuit costs 1.5–2M constraints and remains research-grade (Crescent, longfellow-zk) — defer it behind ACTA's pluggable `ICircuitVerifier`. **ERC-8004** contracts are live on mainnet (Jan 2026, 30+ chains, vanity `0x8004…` addresses, audited) with SDKs and explorers to integrate against.

*Local context: this repo vendors an earlier ACTA PoC (`vendor-acta-poc/`) whose draft circuits (Circom 2.1.6) already use circomlib Poseidon/comparators, a context-scoped Poseidon nullifier (`NullifierDerive.circom`), and a postfix predicate evaluator — useful as a starting sketch, but marked "pending ZK-engineer review" and predating everything surveyed here.*

---

## 1. Semaphore v4 — the membership + nullifier skeleton

**What it gives us.** Anonymous group-membership signaling: prove you belong to a Merkle-tree group and emit a message bound to a scope, with a nullifier preventing double-signaling. Reference stack: Circom + Groth16 + snarkjs. Spec: [zkspecs #3](https://github.com/privacy-ethereum/zkspecs/blob/main/specs/3/README.md); site: [semaphore.pse.dev](https://semaphore.pse.dev); docs: [docs.semaphore.pse.dev](https://docs.semaphore.pse.dev).

**Identity scheme (exact).** An EdDSA keypair over Baby Jubjub ([EIP-2494](https://eips.ethereum.org/EIPS/eip-2494)) with Poseidon as the signature hash; the secret scalar is derived with **Blake1** (a deliberate deviation from RFC 8032's SHA-512, for circuit efficiency and circomlibjs compatibility). The **identity commitment = `Poseidon(2)([Ax, Ay])`** — Poseidon of the two public-key coordinates. In the circuit ([`packages/circuits/src/semaphore.circom`](https://github.com/semaphore-protocol/semaphore/blob/main/packages/circuits/src/semaphore.circom), `pragma circom 2.1.5`), the private input is the secret scalar itself; the pubkey is derived in-circuit via circomlib's `BabyPbk()`, and the secret is range-checked with `LessThan(251)` against the Baby Jubjub subgroup order — a constraint added after the March 2024 audit (see below).

**Nullifier (exact).** `nullifier <== Poseidon(2)([scope, secret])` — order is (scope, secret). Public outputs: `merkleRoot`, `nullifier`; public inputs: `message`, `scope`. The message is bound only via `dummySquare <== message * message` (the standard Groth16-malleability guard). ACTA's context-scoped nullifier (`Poseidon(masterSecret, contextHash)` per the ethresear.ch draft) is this exact pattern with `scope = contextHash`.

**LeanIMT.** Semaphore v4's tree is the LeanIMT: a binary incremental Merkle tree where a node with two children is `Poseidon(left, right)`, **a node with only a left child equals that child** (no zero-hash padding at all), and **depth is dynamic** — `ceil(log2(n))`, growing with insertions. Merkle proofs skip sibling-less levels, so proof length is itself a circuit input (`merkleProofLength`). Versus a classic fixed-depth IMT (Tornado-style, zero-hash-padded): fewer hashes per insert and no zero-value footgun — the creator-controlled zero value was the source of a v3-era hidden-membership bug ([Veridise, "Breaking the Tree"](https://medium.com/veridise/breaking-the-tree-violating-invariants-in-semaphore-4be73be3858d)). LeanIMT reference + paper: [zk-kit lean-imt](https://github.com/zk-kit/zk-kit/tree/main/packages/lean-imt).

**Proof system & artifacts.** Groth16 via snarkjs, one compiled circuit per `MAX_DEPTH` for depths 1–32. A **multi-party phase-2 ceremony completed 13 July 2024 with 400+ participants** produced per-depth zkeys, distributed via PSE's [snark-artifacts CDN](https://github.com/privacy-scaling-explorations/snark-artifacts) and auto-fetched by `@semaphore-protocol/proof` ([circuits docs](https://docs.semaphore.pse.dev/technical-reference/circuits)). Constraint counts aren't officially published — the [benchmarks page](https://docs.semaphore.pse.dev/benchmarks) gives timings only — but the cost structure (~240-constraint `Poseidon(2)` per level + one fixed-base Baby Jubjub scalar-mul + 2 Poseidons + a 251-bit comparison) puts depth-20 in the low thousands of constraints; run `snarkjs r1cs info` for exact numbers.

**Contract architecture** ([contracts docs](https://docs.semaphore.pse.dev/technical-reference/contracts)):
- `SemaphoreGroups.sol` (abstract) — on-chain group CRUD via zk-kit's `LeanIMT.sol` + `PoseidonT3`, per-group admin (EOA or contract).
- `SemaphoreVerifier.sol` — an extended snarkjs Groth16 verifier holding **verification keys for all 32 depths**.
- `Semaphore.sol` — `verifyProof` (view; accepts recent-old roots) and `validateProof` (nullifier-unseen check → store nullifier → emit event).
- **Same addresses on 16 networks** (Ethereum, Arbitrum, Optimism, Base, Polygon, Linea, Gnosis + testnets): Semaphore `0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D`, SemaphoreVerifier `0x4DeC9E3784EcC1eE002001BfE91deEf4A48931f8`, PoseidonT3 `0xB43122Ecb241DD50062641f089876679fd06599a` ([deployed contracts](https://docs.semaphore.pse.dev/deployed-contracts)).

**Maturity/maintenance.** Latest release **v4.14.3, 2026-07-08** (`core`/`identity`/`proof` in lockstep with zk-kit's lean-imt 2.2.5 the same week); steady cadence through 2025–26 ([releases](https://github.com/semaphore-protocol/semaphore/releases)). PSE reorganized in Sept 2025 into **Privacy Stewards of Ethereum**, and the EF's Oct 2025 privacy cluster explicitly consolidated Semaphore (and MACI) under its umbrella — Semaphore survived the reorg and is actively maintained ([pse.dev/about](https://pse.dev/about), [CoinDesk](https://www.coindesk.com/tech/2025/10/09/ethereum-foundation-expands-privacy-push-with-dedicated-research-cluster)).

**Audits.** The [Semaphore 4.0.0 audit (March 2024, PSE internal audit team)](https://semaphore.pse.dev/Semaphore_4.0.0_Audit.pdf) covered contracts, circuits, and TypeScript, *plus* zk-kit's `InternalLeanIMT.sol` and `binary-merkle-root.circom`. 14 findings — 3 critical (missing `onlyGroupAdmin` on `_addMember()`; **unconstrained Baby Jubjub secret scalar**; out-of-range private key), 3 high — all fixed pre-4.0.0. v3-era on-chain tree bugs (out-of-field leaf in `update()`; the zero-value hidden-membership issue) are catalogued in the [0xPARC zk-bug-tracker](https://github.com/0xPARC/zk-bug-tracker).

**What to borrow vs where ACTA differs.** Borrow: the identity scheme (EdDSA-BJJ keypair → Poseidon commitment), LeanIMT everywhere (JS + Solidity + circuit template), the `Poseidon(scope, secret)` nullifier, the `Semaphore.sol` verify/validate/nullifier-store contract pattern, and the ceremony/artifact-distribution playbook. **ACTA cannot use the Semaphore circuit as-is**: Semaphore proves *"I am in the set"*; ACTA must prove *"I am in the set AND an issuer signed my attributes AND those attributes satisfy predicate P"*. That means a forked circuit adding `EdDSAPoseidonVerifier` over an attribute commitment, comparator-based predicates, and (for sanctions) an SMT exclusion sub-proof — which in turn means **ACTA runs its own trusted-setup ceremony** (Semaphore's zkeys are per-circuit and don't transfer). The fixed one-nullifier-per-scope shape also needs care if a policy session requires multiple nullifiers.

---

## 2. circomlib — the gadget box (and its footguns)

**What it gives us.** The canonical Circom template library ([iden3/circomlib](https://github.com/iden3/circomlib), LGPL-3.0). Templates confirmed present and relevant (read from master):

- **`EdDSAPoseidonVerifier`** ([`eddsaposeidon.circom`](https://github.com/iden3/circomlib/blob/master/circuits/eddsaposeidon.circom)) — inputs `enabled, Ax, Ay, S, R8x, R8y, M`; verifies `S·B8 = R8 + h·8·A` with `h = Poseidon(5)(R8x, R8y, Ax, Ay, M)`; forces `S` below the subgroup order via `CompConstant`. This is the issuer-signature gadget: the issuer signs `M = Poseidon(attribute commitment)` and the circuit verifies it in a few thousand constraints.
- **`Poseidon(nInputs)`** — the ecosystem-standard BN254 Poseidon (2-input hash ≈ 240 R1CS constraints). Used identically by Semaphore, zk-kit, and Privado ID, which is what makes the whole stack compose.
- **Comparators** ([`comparators.circom`](https://github.com/iden3/circomlib/blob/master/circuits/comparators.circom)) — `IsZero`, `IsEqual`, `LessThan(n)`, `LessEqThan`, `GreaterThan`, `GreaterEqThan` (all thin wrappers over `LessThan`). `LessThan(n)` computes `Num2Bits(n+1)` of `in[0] + (1<<n) − in[1]`; it carries **`assert(n <= 252)`** — a *compile-time* assert, not a constraint.
- **`Num2Bits(n)` / `Num2Bits_strict`** ([`bitify.circom`](https://github.com/iden3/circomlib/blob/master/circuits/bitify.circom)) — bit decomposition. At n=254 plain `Num2Bits` **aliases** (two representations exist for values near the field modulus); `Num2Bits_strict` adds an `AliasCheck` forcing the canonical one.
- **`SMTVerifier(nLevels)`** ([`smt/smtverifier.circom`](https://github.com/iden3/circomlib/blob/master/circuits/smt/smtverifier.circom)) — sparse-Merkle-tree inclusion/**exclusion** proofs (§7).

**The classic footguns (must be named in the implementation plan):**
1. **`LessThan` on unconstrained inputs is unsound.** Both inputs must already be constrained to n bits (via `Num2Bits` or provenance) — a field element larger than 2ⁿ wraps and flips the comparison. This is the Dark Forest v0.3 bug in the [0xPARC zk-bug-tracker](https://github.com/0xPARC/zk-bug-tracker), and it lands squarely on ACTA's predicate gadget: every attribute fed to a comparator (audit score, timestamps) must be range-checked at the point it enters the circuit (or bounded by the issuer's schema and constrained once).
2. **Aliasing:** any ≥254-bit decomposition must use `Num2Bits_strict`; `assert()` in circom is not a constraint.
3. **Historical "assigned-not-constrained" bugs** (circomlib MiMC used `=` instead of `<==`, leaving the hash output attacker-controllable — long fixed; same family recurs in circom-ecdsa's `BigMod`). Formal-verification sweeps (Veridise/Coda, [zksecurity's circom pitfalls](https://blog.zksecurity.xyz/posts/circom-pitfalls-1/), [zkbugs corpus](https://github.com/zksecurity/zkbugs)) found remaining under-constrained issues concentrated in circomlib's *rarely-used* templates — the ones ACTA needs (Poseidon, EdDSA, comparators, bitify) are the most-exercised in the ecosystem.

**Maturity/maintenance.** **npm `circomlib` is frozen at 2.0.5 (June 2022)** and there are no GitHub releases — but the repo is not dead: commits through 2025 (notably switching blake-hash to audited noble-hashes), PR/issue activity into 2026, `pushed_at` 2026-07-14. In practice everyone vendors/includes the `.circom` files by commit, not npm version. **circomlibjs** (the JS witness-gen companion) is similarly frozen on npm at **0.1.7 (July 2022)** with sporadic repo activity — see §8 for the modern replacements.

**Trade-off.** De-facto standard, what Semaphore itself builds on, maximally reviewed — but effectively unversioned, and its sharp edges are the integrator's problem. The plan should pin a circomlib commit and include a comparator-hygiene checklist (there is **no** `safe-comparators` zk-kit package, contrary to some older references — verified absent from both the repo and npm).

---

## 3. zk-kit — LeanIMT (JS/Solidity/Circom) + modern crypto libs

**What it gives us.** PSE-lineage monorepos of audited, tree-shakeable primitives. **Note: the project moved out of the `privacy-scaling-explorations` GitHub org into its own [`zk-kit`](https://github.com/zk-kit/zk-kit) org** (old URLs 301-redirect). Current structure, all active mid-2026: `zk-kit/zk-kit` (JS/TS, pushed 2026-07-21), [`zk-kit/zk-kit.circom`](https://github.com/zk-kit/zk-kit.circom) (pushed 2026-07-20), [`zk-kit/zk-kit.solidity`](https://github.com/zk-kit/zk-kit.solidity) (pushed 2026-07-21), plus `.rust` and `.noir` repos.

Key packages (npm-verified):

| Package | Latest | Published | Audited |
|---|---|---|---|
| `@zk-kit/lean-imt` (JS) | 2.2.5 | 2026-07-08 | Yes (Semaphore 4.0.0 audit) |
| `@zk-kit/lean-imt.sol` (`InternalLeanIMT`/`LeanIMT`) | 2.0.1 | 2025-03-31 | Yes (same audit) |
| `@zk-kit/binary-merkle-root.circom` | 2.0.0 | 2025-06-30 | Yes (same audit) |
| `@zk-kit/eddsa-poseidon` | 1.1.0 | 2024-10-22 | Yes |
| `@zk-kit/baby-jubjub` | — | stable | Yes |
| `@zk-kit/smt` | 1.0.2 | 2024-12-02 | No |
| `@zk-kit/poseidon-cipher` | 0.3.2 | 2024-09-13 | No |
| `@zk-kit/lean-imt-plus` (JS/Sol/Circom) | 0.1.x | 2026-07-16..21 | No (new) |

The audit badges all point at the same [Semaphore 4.0.0 audit PDF](https://semaphore.pse.dev/Semaphore_4.0.0_Audit.pdf) — i.e., the March-2024 audit *is* the LeanIMT audit, scoped to `InternalLeanIMT.sol` and `binary-merkle-root.circom`.

**Maturity/maintenance.** Very much alive post-reorg — lean-imt 2.2.5 shipped the same week as Semaphore 4.14.3 (which consumes it); the new `lean-imt-plus` family (non-membership, §7) landed days before this survey. The crypto primitives (`eddsa-poseidon`, `baby-jubjub`) are stable/slow-moving rather than abandoned.

**Trade-off.** This is the least-contested pick in the survey: ACTA's anonymity-set tree should be LeanIMT via these exact three packages (JS for the holder/indexer, `.sol` for the on-chain accumulator, `binary-merkle-root.circom` in-circuit) — identical to what Semaphore deploys, sharing its audit. `@zk-kit/eddsa-poseidon` replaces stale circomlibjs for issuer-side signing (§8).

---

## 4. circom + snarkjs toolchain: Groth16 vs PLONK vs fflonk, ptau, ceremonies

**Compiler.** [circom](https://github.com/iden3/circom) latest **v2.2.3 (Oct 2025)**; the 2.2 line added **buses** and strengthened **tags** (a poor-man's type system — useful discipline for a credential circuit's structured witnesses). Note v2.2.0 changed default constraint simplification from `--O2` to `--O1`. Maintenance: alive but slow-moving (~1–2 releases/year; repo pushed June 2026).

**Prover.** [snarkjs](https://github.com/iden3/snarkjs) latest **v0.7.6 (npm, Jan 2026)**, repo pushed July 2026. v0.7.6 matters: it **added public-input checks to the Groth16/PLONK/fflonk Solidity verifier templates** (issue #358) and moved hashing to audited noble-hashes.

**Proof-system choice** (all three implemented in snarkjs; fflonk still labeled beta):

| | Groth16 | PLONK | fflonk (beta) |
|---|---|---|---|
| Setup | ptau + **per-circuit phase-2 ceremony** | universal — ptau only, no ceremony | universal, no ceremony |
| EVM verify gas | **~230k typical** (~207k + ~7.2k/public input) | ~290k | ~200k + ~0.9k/input |
| Proof size | 2 G1 + 1 G2 (~6 field elems) | ~16 field elems | PLONK-class |
| Prover speed | fastest | slower | slowest |

Sources: [iden3's PLONK announcement](https://blog.iden3.io/circom-snarkjs-plonk.html) (290k vs 230k), [Orbiter's fflonk gas study](https://hackmd.io/@Orbiter-Research/S1nat__m0). One measured anchor: Base's Sept 2025 benchmark saw a snarkjs Groth16 verifier at **347,665 gas** with a large public-input set ([blog.base.dev](https://blog.base.dev/benchmarking-zkp-systems)); a Semaphore-style circuit with ~6 public signals budgets **~200–260k**. **Read:** Groth16 is the default — fastest browser prover, cheapest verify, smallest proof; the price is the ceremony. fflonk would eliminate the ceremony for a slower prover on a beta toolpath; PLONK buys nothing here.

**Powers of tau.** The Hermez/Polygon bn254 ptau files remain live and HTTP-verified (2026-07-28): [`powersOfTau28_hez_final_18.ptau`](https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_18.ptau) 302 MB (2^18 = 262k constraints), `_19` 604 MB, `_20` 1.21 GB (2^20 = 1.05M). For a 50k–500k design take **2^20** for headroom (2^19's 524k ceiling is uncomfortably tight). The [Perpetual Powers of Tau](https://github.com/privacy-ethereum/perpetualpowersoftau) ceremony continues (86 contributions; files now on PSE's S3 — the old Azure links are dead).

**Phase-2 ceremony tooling.** `snarkjs zkey contribute/beacon/verify` remains the minimal path. PSE's hosted suite (**p0tion + DefinitelySetup**, ceremony.pse.dev) is **maintenance-only** — "not actively developed anymore," critical fixes only ([PSE retrospective](https://mirror.xyz/privacy-scaling-explorations.eth/Cf9nYvSlATGks8IcFaHQe3H5mgZ_Va767Zk5I8jPYXk)) — but it still works and ran real ceremonies (Semaphore v4: 400+ participants; Anon Aadhaar v2: 105; [RISC Zero](https://risczero.com/blog/verifying-risc-zeros-trusted-setup-ceremony); 0xbow Privacy Pools, Feb 2025). Plan to self-host p0tion or run manual `snarkjs zkey contribute` round-robins; don't count on PSE running ACTA's ceremony.

**Verifier generation.** `snarkjs zkey export solidityverifier` emits standalone contracts, `pragma solidity >=0.7.0 <0.9.0` (0.8.x-compatible). **The known hole is CVE-2023-33252**: pre-0.7.0 verifiers didn't check public signals `< r`, enabling input aliasing — the same proof verifies with `input` and `input + r`, which for a Poseidon-**nullifier** design is a direct double-spend vector ([Snyk](https://security.snyk.io/vuln/SNYK-JS-SNARKJS-5595568)). Fixed in 0.7.0, further hardened in 0.7.6. **Rule: generate with snarkjs ≥ 0.7.6, never copy a tutorial-era verifier.sol, and have the nullifier registry independently reject values ≥ r as defense in depth.**

---

## 5. Noir + Barretenberg — the alternative stack

**What it gives us.** A Rust-like circuit language ([Noir](https://noir-lang.org)) compiled to Aztec's Barretenberg backend (**UltraHonk**: PLONKish, KZG commitments, smaller proofs and much faster proving than UltraPlonk, which is now "legacy"; [barretenberg docs](https://barretenberg.aztec.network/docs/)). **No per-circuit ceremony ever** — UltraHonk uses a universal KZG SRS (same trust model as PLONK). Solidity verifier generation is first-class (`bb write_vk --oracle_hash keccak` → `bb write_solidity_verifier`; [how-to](https://barretenberg.aztec.network/docs/how_to_guides/how-to-solidity-verifier/)). Browser proving via [`@aztec/bb.js`](https://www.npmjs.com/package/@aztec/bb.js) (wasm, requires SharedArrayBuffer → COOP/COEP cross-origin isolation for threading).

**Maturity mid-2026.** Noir is **still 1.0-beta**: v1.0.0-beta.25 (2026-07-22), very high release cadence, Aztec publicly running the ["1.0 pre-release"](https://aztec.network/blog/the-future-of-zk-development-is-here-announcing-the-noir-1-0-pre-release) campaign; bb.js **5.1.0 (2026-07-22)** ships in lockstep. Aztec's own protocol circuits are [rebuilt in Noir](https://aztec.network/blog/aztecs-core-cryptography-now-in-noir) — the language is load-bearing for their L2. Aztec's Ignition chain launched on mainnet Nov 2025 (consensus-only, execution layer phased; a critical proving-system vulnerability was disclosed March 2026 — the stack is young). Production Noir users: zkEmail, **ZKPassport** (acquired by Aztec Labs; circuits audited by Consensys Diligence + TU Vienna, ran production sanctions screening), zkLogin. Notably, **ZKProofport already sells Noir-circuit KYC/country/OIDC proofs to ERC-8004 agents** ([awesome-erc8004](https://github.com/sudeepb02/awesome-erc8004)).

**The numbers that decide it** ([Base's benchmark](https://blog.base.dev/benchmarking-zkp-systems), ~2M-constraint P-256 circuit):
- **Proving:** Noir/UltraHonk **0.6–2.1 s** native vs 15–50 s for Groth16 stacks (5–50× faster); wasm ~3.5–4× slower than native.
- **Verify gas:** Noir/UltraHonk **2,396,575 gas** vs 347,665 (snarkjs Groth16) — **~7×**. Proofs are ~456 field elements (~14.6 KB; [zkverify docs](https://docs.zkverify.io/architecture/verification_pallets/ultrahonk)) vs Groth16's 3 group elements. [HashCloak's UltraHonk-verifier writeup](https://hashcloak.com/blog/understanding-the-ultrahonk-verifier) (Mar 2026) calls it their most challenging verifier yet.

**Gadget ecosystem for this build.** P-256/secp256k1 ECDSA are **built-in black-box functions** (relevant for a future real-JWT-VC path, §8). But **EdDSA was demoted from the stdlib** to a v0.1.0 external library ([noir-lang/eddsa](https://github.com/noir-lang/eddsa), placeholder docs) — far less battle-tested than circomlib's. Poseidon(2) lives in `noir-lang/poseidon`; Merkle (non-)membership in [`zk-kit.noir`](https://github.com/privacy-scaling-explorations/zk-kit.noir). Semaphore exists only as third-party ports ([hashcloak/semaphore-noir](https://github.com/hashcloak/semaphore-noir), ModoriLabs' semaphore.nr) — official PSE Semaphore remains Circom/Groth16.

**Trade-off.** Pro: ergonomics (real language, real tooling), no ceremony ops, dramatically faster proving, native recursion/ClientIVC (future reputation-accumulator folding), stronger path to in-circuit P-256. Con: ~7× verify gas (decisive on L1, tolerable on L2s), 14.6 KB proofs, beta churn, and the exact gadgets ACTA needs most (EdDSA-BJJ, Semaphore pattern) are the *least* mature parts of the Noir ecosystem while being the *most* mature parts of Circom's. ACTA's `ICircuitVerifier` abstraction keeps this door open without betting on it now.

---

## 6. Browser proving latency — what to actually expect

**Hard anchors (snarkjs wasm, Groth16):**
- **Semaphore-class (thousands of constraints):** ~1 s prove on an iPhone 16 Pro (snarkjs; 143 ms rapidsnark native) — [Mopro benchmarks](https://zkmopro.org/docs/performance/); "a few seconds" in-browser per [Semaphore docs](https://docs.semaphore.pse.dev/benchmarks).
- **Anon Aadhaar (1.115M constraints):** **~40 s** in-browser on a mid laptop, **9.6 GB peak memory**, 307 MB artifact download; the web app was **disabled on mobile browsers** outright ([Nova Aadhaar paper, IIT Bombay 2025](https://www.ee.iitb.ac.in/~sarva/zk/aadhaar-age-proof.pdf)). Same circuit on Android in-app: snarkjs 51.5 s vs rapidsnark 3.4 s.
- **zk-email Proof of Twitter (1.39M constraints):** **~20 s** on a fast desktop using **chunked/streamed zkeys** (a snarkjs fork; [zk.email blog](https://zk.email/blog/twitter)).
- **Base P-256 (~2M constraints):** 40–50 s on 8 vCPU; snarkjs and rapidsnark both **OOM'd at 4 GB and 8 GB** ([blog.base.dev](https://blog.base.dev/benchmarking-zkp-systems)).

**Extrapolated ranges for a 50k–500k-constraint ACTA circuit** (rule of thumb: snarkjs wasm ≈ 25–40k constraints/sec on a decent desktop browser; phones 3–15× slower):

| Circuit size | Desktop browser | Mobile browser | zkey download |
|---|---|---|---|
| ~50k | **1–4 s** | 5–20 s | ~30–60 MB |
| ~100k | **2–8 s** | 10–40 s (shaky on older devices) | ~60–120 MB |
| ~500k | **10–30 s** | **expect failures** (memory, not CPU) | ~300–500 MB |

**Memory is the binding constraint:** snarkjs runs wasm32 (hard 4 GB linear-memory cap; Memory64 has landed in browsers but snarkjs hasn't adopted it), and the zkey is additionally held in JS heap. Treat **>~150–200k constraints as unreliable in mobile browsers**.

**Accelerations.** snarkjs multithreads via plain Web Workers (message-passing — it does **not** require COOP/COEP; bb.js and other emscripten-pthread provers do). **rapidsnark** ([iden3](https://github.com/iden3/rapidsnark), pushed July 2026) is 4–15× faster but **native-only — no maintained wasm port exists**; the ecosystem's answer to mobile is native proving via [Mopro](https://zkmopro.org) (active, iOS/Android bindings for rapidsnark/witnesscalc), not faster wasm. Witness generation: [circom-witnesscalc](https://github.com/iden3/circom-witnesscalc) (Rust, iden3-adopted) is 2–5× faster than the wasm calculator and drops the wasm runtime overhead. Delegated/server proving (zk-email precedent: ~60 s on cloud GPU; [ICICLE-Snark](https://www.ingonyama.com/post/icicle-snark-the-fastest-groth16-implementation-in-the-world) for GPU) is the escape hatch if the circuit grows.

**Design consequence:** keep the ACTA presentation circuit small. Semaphore membership (+~5k) + EdDSA-Poseidon verify (+~4–8k) + a handful of predicates (+~1k) + an SMT exclusion at truncated depth (+~10k) lands the whole thing **well under 50k constraints → sub-5 s desktop, usable on phones**. The 500k ceiling only threatens if predicates balloon (deep SMTs, many attributes, hash-heavy encodings) — that's a budget to enforce in the plan, not a hazard of the base design.

---

## 7. Sanctions / set non-membership

**Baseline: circomlib `SMTVerifier(nLevels)`** ([source](https://github.com/iden3/circomlib/blob/master/circuits/smt/smtverifier.circom)). Key/value sparse Merkle tree over a 2^254 keyspace; leaf hash `Poseidon(3)(key, value, 1)` (domain-separated), node hash `Poseidon(2)(L,R)`, empty subtrees = 0. **`fnc=1` selects an exclusion proof**: the path for `key` terminates at an empty slot (`isOld0=1`) or at a *different* leaf `(oldKey, oldValue)` sharing the key's prefix; both `key` and `oldKey` go through `Num2Bits_strict` (aliasing handled correctly here). **Cost ≈ 250 constraints/level** plus fixed overhead — full 254-level depth ≈ 64k constraints (too much), **truncated 32-level keyspace ≈ 9–10k** (fine; key the tree by a truncated Poseidon of the sanctioned identifier). No headline CVE against SMTVerifier, but the SMT family is among circomlib's least-exercised code, and **`SMTProcessor` (in-circuit insert/update/delete) should be avoided** — do tree updates off-circuit (the sanctions list is maintained by a publisher anyway) and only *verify* in-circuit. JS side: `@zk-kit/smt` 1.0.2 (circomlib-compatible, unaudited) or circomlibjs's SMT; iden3's production SMTs live in go/js-merkletree (Privado ID runs them in anger).

**Alternative A — Indexed Merkle Tree (Aztec-style)** ([docs](https://docs.aztec.network/developers/docs/foundational-topics/advanced/storage/indexed_merkle_tree)): sorted linked-list leaves `{value, nextIndex, nextValue}`; non-membership of `v` = one *membership* proof of the "low leaf" with `value < v < nextValue` + two range checks — height ~32 instead of 254 (~8× fewer hashes). Cost: insertion needs predecessor lookup / off-chain indexing — fine for an admin-maintained sanctions list.

**Alternative B — LeanIMT+ (new, directly on point):** [`@zk-kit/lean-imt-plus`](https://github.com/zk-kit/zk-kit/tree/main/packages/lean-imt-plus) (JS 0.1.2 + `.sol` + `.circom`, all published 2026-07-16..21) — **LeanIMT with non-membership proofs**, using the indexed-tree low-leaf trick on the dynamic-depth, zero-hash-free LeanIMT. Architecturally the perfect fit (same tree family, hash, and org as the rest of the stack) — but **weeks old, 0.1.x, unaudited**. Its own README says: membership-only → plain lean-imt.

**Read:** circomlib SMTVerifier (truncated keys) is the conservative pick today; LeanIMT+ is the one to watch and likely the eventual answer; a hand-rolled indexed tree is only worth it at Aztec-scale batch-insertion volumes.

---

## 8. Issuance tooling: EdDSA-BabyJubJub in JS, and the JWT-VC gap

**Signing libraries.** circomlibjs (`buildEddsa` → EdDSA-Poseidon over Baby Jubjub) works but is **frozen on npm at 0.1.7 since July 2022**. The modern replacement is **[`@zk-kit/eddsa-poseidon`](https://www.npmjs.com/package/@zk-kit/eddsa-poseidon) 1.1.0** (audited-lineage, no-WASM TypeScript, drop-in compatible with circomlib's `EdDSAPoseidonVerifier`) + `@zk-kit/baby-jubjub` — this pair is the recommended issuer-side signer. circomlibjs remains a fallback for SMT witness compatibility.

**Prior art for BJJ-signed W3C VCs.** iden3/Privado ID's credentials carry a **`BJJSignature2021`** Data-Integrity proof — the issuer signs the credential's core claim with a Baby Jubjub EdDSA key, explicitly designed for ZK presentation ([suite spec](http://iden3-communication.io/BJJSignature2021/), [Privado ID V3 circuit](https://docs.privado.id/docs/verifier/v3-circuit/)). "W3C VC envelope + BabyJubJub signature + circom verification" is a proven pattern ACTA can copy for AgentCapabilityVCs.

**Why real-world JWT-VC (ES256) in-circuit is much harder.** A standard JWT-VC means ECDSA **P-256** + **SHA-256** over a base64url-encoded JSON payload. In circom, P-256 verification alone is **~1.5–2M constraints** via non-native bigint emulation ([ethresear.ch "Efficient ECDSA"](https://ethresear.ch/t/efficient-ecdsa-signature-verification-using-circom/13629); PSE's [circom-ecdsa-p256](https://github.com/privacy-ethereum/circom-ecdsa-p256) needed **~56 GB RAM to build**; Base measured ~2M constraints and 15–50 s native proving). Add SHA-256 over kilobytes of JSON plus in-circuit base64url/JSON parsing (the [zkemail/noir-jwt](https://github.com/zkemail/noir-jwt) approach, RS256-only today) — versus **a few thousand constraints total** for EdDSA-Poseidon over field elements. Three orders of magnitude.

**The "prove existing credentials" research frontier (maturity check, mid-2026):**
- **[Microsoft Crescent](https://github.com/microsoft/crescent-credentials)** — JWT (RS256) + ISO mDL (ECDSA) possession proofs with unlinkability; Groth16 + arkworks + Spartan-T256, clever Prepare(slow)/Show(fast) split ([paper](https://eprint.iacr.org/2024/2013.pdf)). Explicitly **"not been carefully audited… should not be used in a production environment."**
- **[Google longfellow-zk / libZK](https://github.com/google/longfellow-zk)** — C++ proofs over legacy mdoc/JWT/W3C-VC, no trusted setup; being standardized at IETF CFRG ([draft-google-cfrg-libzk](https://datatracker.ietf.org/doc/draft-google-cfrg-libzk/), presented IETF 125, Mar 2026); ISRG Rust re-implementation underway; EUDI implementers evaluating. Promising, pre-production.
- **EUDI/eIDAS 2** ([ARF Topic G](https://eudi.dev/latest/discussion-topics/g-zero-knowledge-proof/)) — ZKP *encouraged* not mandated for the wallets Member States must ship by end-2026; candidates include ECDSA-based anonymous credentials, Crescent, Mopro-style mobile provers. PSE's wallet-unit-poc work feeds this track.
- **[Self / OpenPassport](https://blog.zksecurity.xyz/posts/self-audit/)** — RSA/ECDSA passport sigs in Circom, audited (zkSecurity), live on Celo — but needed **TEE proof-delegation** (AWS Nitro) because client-side proving of document signatures is that heavy.

**Takeaway:** ACTA **cannot** pragmatically accept real-world ES256 JWT-VCs in-circuit today — every working system either uses zk-native signatures (Privado ID), delegates to TEEs (Self), or is an unaudited research stack (Crescent, libZK). **Issue ACTA credentials with native EdDSA-BJJ-Poseidon signatures inside a W3C VC envelope** (BJJSignature2021-style), and treat "verify standard JWT-VCs" as a later pluggable-verifier upgrade — exactly what the ACTA draft's proof-system-agnostic `ICircuitVerifier` anticipates. (If that upgrade ever comes, Noir's built-in P-256 makes it the stronger stack for that specific path.)

---

## 9. ERC-8004 — what we're integrating with

**Spec status.** [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) ("Trustless Agents", authors from MetaMask/EF/Google/Coinbase) is formally **still Draft** — but the curated contracts went **live on Ethereum mainnet 2026-01-29** with >20k agents registered within weeks ([Forbes](https://www.forbes.com/sites/digital-assets/2026/02/05/ai-agents-gain-trust-via-ethereum-erc-8004-on-mainnet/)). Because the EIP page trails the deployed reality, **pin ACTA against `ERC8004SPEC.md` in the [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) repo**, not the EIP text.

**The three registries (current spec).** **Identity** = ERC-721 + URIStorage — each agent is an NFT (`agentId`) whose `agentURI` resolves to a registration file (endpoints: A2A, MCP, ENS, DID…); note this replaced the earlier "agent domain + address" model. **Reputation** = `giveFeedback(agentId, value int128, valueDecimals, tag1, tag2, endpointURI, fileHash)` with revocation, responses, tag-filterable reads. **Validation** = `validationRequest()` → `validationResponse()` with score 0–100 + evidence URI.

**Deployments & tooling.** Contracts deployed on **30+ chains at vanity addresses** — e.g., Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on Ethereum (testnets: `0x8004A818…`); **audited by Cyfrin, Nethermind, and the EF security team** ([awesome-erc8004](https://github.com/sudeepb02/awesome-erc8004)). SDKs: **Agent0 SDK** (TS + Python + subgraphs), `create-8004-agent` CLI, ChaosChain SDK (the older `ChaosChain/trustless-agents-erc-ri` reference lineage is superseded by the erc-8004 org), Azeth SDK (smart accounts + x402). Explorers: 8004scan.io, agentscan.info. EF involvement via the dAI team (8004.org/build); positioned as the trust layer complementing Google's A2A.

**Where ACTA hooks in.** Per the [ACTA draft](https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797), the layer sits *above* ERC-8004 unmodified: agent identity commitments (not raw `agentId` owners) form the LeanIMT anonymity set; `IPolicyRegistry` predicates attest over AgentCapabilityVC fields and over Validation Registry scores/feedback values; `INullifierRegistry` provides context-scoped Sybil resistance; and `IZKReputationAccumulator` **writes its Merkle root back through the standard `giveFeedback()` using a reserved tag** — the `tag1/tag2` + file-hash fields are the natural anchoring slot. Precedent that ZK credentials × ERC-8004 composes in practice already exists (ZKProofport's Noir KYC proofs sold to 8004 agents over x402).

---

## Default stack recommendation + alternatives

**Default stack (recommendation only — the plan comes later):**

- **Language/prover:** circom **2.2.3** + snarkjs **≥ 0.7.6**, **Groth16**, BN254. Ptau: `powersOfTau28_hez_final_20.ptau` (2^20); phase-2 via self-hosted p0tion or manual `snarkjs zkey contribute` round-robin.
- **Circuit composition:** fork the Semaphore v4 circuit shape — zk-kit `binary-merkle-root.circom` (LeanIMT) membership + `Poseidon(scope, secret)`-family context-scoped nullifier — extended with circomlib `EdDSAPoseidonVerifier` over the issuer-signed attribute commitment, circomlib comparators for predicates (**with explicit range-check hygiene: every comparator input pre-constrained via Num2Bits; `Num2Bits_strict` for any ≥254-bit decomposition**), and circomlib `SMTVerifier` (`fnc=1`, truncated ~32-level keys) for sanctions non-membership. Pin circomlib by commit. Budget the whole circuit **< 50k constraints** to keep browser proving in single-digit seconds and phones viable.
- **Trees:** LeanIMT everywhere — `@zk-kit/lean-imt` (JS), `@zk-kit/lean-imt.sol` (on-chain accumulator), audited as part of Semaphore 4.0.0. Watch `lean-imt-plus` as the future sanctions-tree replacement once it has an audit story.
- **Issuance:** EdDSA-BabyJubJub-Poseidon signatures via `@zk-kit/eddsa-poseidon` + `@zk-kit/baby-jubjub`, wrapped in a W3C VC envelope à la Privado ID's `BJJSignature2021`. Do **not** attempt in-circuit ES256 JWT-VC verification in v1.
- **Contracts:** Semaphore's `Semaphore.sol` pattern (verify → nullifier-store → event) adapted to ACTA's `IPredicateVerifier`/`INullifierRegistry`; verifier from `snarkjs zkey export solidityverifier` (0.8.x), with an independent `< r` public-signal check as defense in depth (CVE-2023-33252 class). Integrate against the `0x8004…` registries per `ERC8004SPEC.md`.
- **Browser proving:** vanilla snarkjs wasm (Web Workers, no COOP/COEP needed); artifacts on a CDN following Semaphore's snark-artifacts pattern.

**Alternatives, and what would trigger them:**

1. **Noir + UltraHonk (bb.js)** — switch (or add as a second `ICircuitVerifier` backend) if: verification moves wholly to cheap L2s (neutralizing the ~7× gas gap), the ceremony burden proves unacceptable, real-JWT-VC (P-256) verification gets pulled into scope, or recursion/folding of the reputation accumulator becomes a v2 goal. Re-benchmark UltraHonk verifier gas on current bb 5.x first (the 2.4M figure is from 2025), and check hashcloak/semaphore-noir's benchmark report.
2. **fflonk (snarkjs)** — same circuits, no ceremony, ~Groth16 gas, slower prover on a beta toolpath. A cheap experiment worth one afternoon; not the default until it sheds the beta label.
3. **Native mobile proving (Mopro + rapidsnark/circom-witnesscalc)** — if agent-holder UX must include phones and the circuit outgrows ~150k constraints; ~15× the wasm speed at the cost of shipping native apps.
4. **Delegated proving (GPU server / TEE à la Self)** — the escape hatch if predicate scope balloons the circuit past browser viability; a privacy/architecture trade-off that needs its own analysis before adoption.
5. **LeanIMT+ for the sanctions tree** — adopt over SMTVerifier once it matures past 0.1.x and gets audited; it unifies the whole stack on one tree family.

---

## Sources

Semaphore: [zkspecs #3](https://github.com/privacy-ethereum/zkspecs/blob/main/specs/3/README.md) · [releases](https://github.com/semaphore-protocol/semaphore/releases) · [contracts](https://docs.semaphore.pse.dev/technical-reference/contracts) / [circuits](https://docs.semaphore.pse.dev/technical-reference/circuits) / [deployed](https://docs.semaphore.pse.dev/deployed-contracts) / [benchmarks](https://docs.semaphore.pse.dev/benchmarks) · [4.0.0 audit PDF](https://semaphore.pse.dev/Semaphore_4.0.0_Audit.pdf) · [Veridise "Breaking the Tree"](https://medium.com/veridise/breaking-the-tree-violating-invariants-in-semaphore-4be73be3858d) · [snark-artifacts](https://github.com/privacy-scaling-explorations/snark-artifacts).
circomlib/circom/snarkjs: [circomlib](https://github.com/iden3/circomlib) ([comparators](https://github.com/iden3/circomlib/blob/master/circuits/comparators.circom), [bitify](https://github.com/iden3/circomlib/blob/master/circuits/bitify.circom), [eddsaposeidon](https://github.com/iden3/circomlib/blob/master/circuits/eddsaposeidon.circom), [smtverifier](https://github.com/iden3/circomlib/blob/master/circuits/smt/smtverifier.circom)) · [circomlibjs](https://github.com/iden3/circomlibjs) · [0xPARC zk-bug-tracker](https://github.com/0xPARC/zk-bug-tracker) · [zksecurity circom pitfalls](https://blog.zksecurity.xyz/posts/circom-pitfalls-1/) · [zkbugs](https://github.com/zksecurity/zkbugs) · [circom releases](https://github.com/iden3/circom/releases) · [snarkjs](https://github.com/iden3/snarkjs) · [iden3 PLONK post](https://blog.iden3.io/circom-snarkjs-plonk.html) · [Orbiter fflonk gas study](https://hackmd.io/@Orbiter-Research/S1nat__m0) · [CVE-2023-33252 (Snyk)](https://security.snyk.io/vuln/SNYK-JS-SNARKJS-5595568) · [perpetualpowersoftau](https://github.com/privacy-ethereum/perpetualpowersoftau) · [p0tion retrospective](https://mirror.xyz/privacy-scaling-explorations.eth/Cf9nYvSlATGks8IcFaHQe3H5mgZ_Va767Zk5I8jPYXk).
zk-kit: [zk-kit](https://github.com/zk-kit/zk-kit) · [zk-kit.circom](https://github.com/zk-kit/zk-kit.circom) · [zk-kit.solidity](https://github.com/zk-kit/zk-kit.solidity) · [lean-imt-plus](https://github.com/zk-kit/zk-kit/tree/main/packages/lean-imt-plus) · [Aztec indexed Merkle tree](https://docs.aztec.network/developers/docs/foundational-topics/advanced/storage/indexed_merkle_tree).
Noir/Barretenberg: [noir releases](https://github.com/noir-lang/noir/releases) · [Noir 1.0 pre-release](https://aztec.network/blog/the-future-of-zk-development-is-here-announcing-the-noir-1-0-pre-release) · [barretenberg docs](https://barretenberg.aztec.network/docs/) · [solidity verifier how-to](https://barretenberg.aztec.network/docs/how_to_guides/how-to-solidity-verifier/) · [Base ZKP benchmark](https://blog.base.dev/benchmarking-zkp-systems) · [zkverify UltraHonk](https://docs.zkverify.io/architecture/verification_pallets/ultrahonk) · [HashCloak UltraHonk verifier](https://hashcloak.com/blog/understanding-the-ultrahonk-verifier) · [semaphore-noir](https://github.com/hashcloak/semaphore-noir) · [noir-lang/eddsa](https://github.com/noir-lang/eddsa) · [awesome-noir](https://github.com/noir-lang/awesome-noir).
Browser proving: [Nova Aadhaar paper](https://www.ee.iitb.ac.in/~sarva/zk/aadhaar-age-proof.pdf) · [zk.email Twitter post](https://zk.email/blog/twitter) · [Mopro performance](https://zkmopro.org/docs/performance/) · [Mopro prover comparison](https://zkmopro.org/blog/circom-comparison/) · [rapidsnark](https://github.com/iden3/rapidsnark) · [circom-witnesscalc](https://github.com/iden3/circom-witnesscalc) · [ffjavascript threadman](https://github.com/iden3/ffjavascript/blob/master/src/threadman.js) · [ICICLE-Snark](https://www.ingonyama.com/post/icicle-snark-the-fastest-groth16-implementation-in-the-world) · [FIAT paper](https://arxiv.org/pdf/2209.11451).
Credentials/VC: [@zk-kit/eddsa-poseidon](https://www.npmjs.com/package/@zk-kit/eddsa-poseidon) · [BJJSignature2021](http://iden3-communication.io/BJJSignature2021/) · [Privado ID V3 circuit](https://docs.privado.id/docs/verifier/v3-circuit/) · [efficient-ecdsa thread](https://ethresear.ch/t/efficient-ecdsa-signature-verification-using-circom/13629) · [circom-ecdsa-p256](https://github.com/privacy-ethereum/circom-ecdsa-p256) · [noir-jwt](https://github.com/zkemail/noir-jwt) · [Crescent](https://github.com/microsoft/crescent-credentials) ([paper](https://eprint.iacr.org/2024/2013.pdf)) · [longfellow-zk](https://github.com/google/longfellow-zk) ([IETF draft](https://datatracker.ietf.org/doc/draft-google-cfrg-libzk/)) · [EUDI ARF Topic G](https://eudi.dev/latest/discussion-topics/g-zero-knowledge-proof/) · [Self audit (zkSecurity)](https://blog.zksecurity.xyz/posts/self-audit/).
ERC-8004: [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) · [erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) · [awesome-erc8004](https://github.com/sudeepb02/awesome-erc8004) · [Forbes mainnet coverage](https://www.forbes.com/sites/digital-assets/2026/02/05/ai-agents-gain-trust-via-ethereum-erc-8004-on-mainnet/) · [QuickNode ERC-8004 guide](https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/) · [ACTA draft (ethresear.ch)](https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797).
PSE status: [pse.dev/about](https://pse.dev/about) · [CoinDesk EF privacy cluster](https://www.coindesk.com/tech/2025/10/09/ethereum-foundation-expands-privacy-push-with-dedicated-research-cluster) · [PSE roadmap thread](https://ethereum-magicians.org/t/pse-roadmap-2025-and-beyond/25423).

*Open flags for the plan authors: (a) the 2.4M UltraHonk gas figure is from Base's 2025 benchmark — re-measure on current bb 5.x before relying on it; (b) exact Semaphore v4 constraint counts are unpublished — run `snarkjs r1cs info` on the ceremony artifacts; (c) `noir-lang/eddsa` at v0.1.0 is the concrete maturity asymmetry justifying the Circom default; (d) ERC-8004 is formally Draft — pin to the contracts repo's `ERC8004SPEC.md`.*
