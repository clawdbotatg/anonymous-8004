// Deploys the ACTA reference stack to BASE MAINNET and runs one real
// presentation through it, so every claim in the repo has a Basescan link.
//
//   env: BASE_RPC_URL (Alchemy), DEPLOYER_PK (never logged, never stored)
//   out: docs/deployments/base.json + docs/BASE-DEPLOYMENT.md
//
// The demo credential's master secret is committed in this file ON PURPOSE:
// this is a public demo identity anyone can replay against new policies —
// labelled as such. Real agents keep their secret client-side.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, http, decodeEventLog, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import * as snarkjs from 'snarkjs';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import {
  SCHEMA_V1, compileDsl, predicateProgramHash, issueCredential, normalizeClaim, FORMAT,
} from '@acta/sdk';

const require = createRequire(import.meta.url);
const { newMemEmptyTrie } = require('circomlibjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'packages', 'contracts', 'out');
const BUILD = join(ROOT, 'packages', 'circuits', 'build');

// Config comes from env or the gitignored .env.deploy (see .env.deploy.example).
// No RPC urls, keystore names, or keychain identifiers are hardcoded here.
const envFile = join(ROOT, '.env.deploy');
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env.deploy — rely on the environment */ }

const RPC = process.env.BASE_RPC_URL;
if (!RPC) throw new Error('BASE_RPC_URL missing (env or .env.deploy)');

// Signer: DEPLOYER_PK, or a foundry keystore decrypted ENTIRELY IN-PROCESS
// (password from the macOS keychain; the key never appears in shell env,
// argv, logs, or on disk).
let PK = process.env.DEPLOYER_PK;
if (!PK) {
  const { ACTA_KEYSTORE_PATH, ACTA_KEYCHAIN_SERVICE, ACTA_KEYCHAIN_ACCOUNT } = process.env;
  if (!ACTA_KEYSTORE_PATH || !ACTA_KEYCHAIN_SERVICE || !ACTA_KEYCHAIN_ACCOUNT) {
    throw new Error('set DEPLOYER_PK or ACTA_KEYSTORE_PATH + ACTA_KEYCHAIN_SERVICE + ACTA_KEYCHAIN_ACCOUNT');
  }
  const { execFileSync } = await import('node:child_process');
  const { Wallet } = await import('ethers');
  const password = execFileSync(
    'security',
    ['find-generic-password', '-s', ACTA_KEYCHAIN_SERVICE, '-a', ACTA_KEYCHAIN_ACCOUNT, '-w'],
    { encoding: 'utf8' }
  ).trim();
  const keystoreJson = readFileSync(
    ACTA_KEYSTORE_PATH.replace(/^~/, process.env.HOME),
    'utf8'
  );
  PK = Wallet.fromEncryptedJsonSync(keystoreJson, password).privateKey;
}

const account = privateKeyToAccount(PK);
const pub = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });

const art = (n) => {
  const j = JSON.parse(readFileSync(join(OUT, `${n}.sol`, `${n}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
};
const log = (s) => console.log(s);

let totalGas = 0n;
const track = async (hash) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`tx failed: ${hash}`);
  totalGas += r.gasUsed;
  return r;
};
const deploy = async (name, args = [], libs = {}) => {
  let { abi, bytecode } = art(name);
  for (const addr of Object.values(libs)) {
    bytecode = bytecode.replace(/__\$[0-9a-f]{34}\$__/g, addr.slice(2).toLowerCase());
  }
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const r = await track(hash);
  log(`  ${name} → ${r.contractAddress}  (gas ${r.gasUsed})`);
  return { address: r.contractAddress, abi, txHash: hash };
};
const write = async (c, functionName, args) => {
  const hash = await wallet.writeContract({ address: c.address, abi: c.abi, functionName, args });
  return track(hash);
};

const bal0 = await pub.getBalance({ address: account.address });
log(`deployer ${account.address} — ${formatEther(bal0)} ETH on Base mainnet\n`);

log('[1/6] deploying the ACTA stack');
const poseidonT3 = await deploy('PoseidonT3');
const anchor = await deploy('CredentialAnchor', [], { PoseidonT3: poseidonT3.address });
const policies = await deploy('PolicyRegistry');
const nullifiers = await deploy('NullifierRegistry');
const g16 = await deploy('Groth16CircuitVerifier');
const verifier = await deploy('PredicateVerifier', [policies.address, anchor.address, nullifiers.address]);
await write(nullifiers, 'setVerifier', [verifier.address]);

log('\n[2/6] issuing the public demo credential (EdDSA-BJJ, off-chain)');
const masterSecret = 8004202607300001n; // PUBLIC demo secret, by design
const claims = { auditScore: 85, jurisdiction: 'CH', capabilities: 5, validUntil: 1893456000 };
const cred = issueCredential('acta-base-demo-issuer-v1', masterSecret, claims);
log(`  holderCommitment ${cred.holderCommitment}`);

log('\n[3/6] anchoring the anonymity set (3 decoys + demo holder)');
const imt = new LeanIMT((a, b) => poseidon2([a, b]));
const leaves = [8881n, 8882n, cred.holderCommitment, 8883n];
const anchorTxs = [];
for (const l of leaves) {
  imt.insert(l);
  const r = await write(anchor, 'anchor', [l]);
  anchorTxs.push(r.transactionHash);
}
const chainRoot = await pub.readContract({ address: anchor.address, abi: anchor.abi, functionName: 'currentRoot', args: [account.address] });
if (chainRoot !== imt.root) throw new Error('root mismatch');
log(`  on-chain LeanIMT root matches local: ${chainRoot}`);

log('\n[4/6] registering policy #0: auditScore >= 80 AND jurisdiction ∉ OFAC');
const smtTree = await newMemEmptyTrie();
const F = smtTree.F;
for (const cc of ['IR', 'KP', 'SY', 'CU']) await smtTree.insert(normalizeClaim(cc, FORMAT.STRING), 1n);
const sanctionsRoot = F.toObject(smtTree.root);
const dsl = { all: [{ claim: 'auditScore', op: '>=', value: 80 }, { not: { claim: 'jurisdiction', op: '==', value: 'IR' } }] };
const program = compileDsl(dsl, SCHEMA_V1);
const predHash = predicateProgramHash(program);
const policyStruct = {
  predicateHash: predHash,
  issuerKeyHash: cred.issuerPubKeyHash,
  issuer: account.address,
  sanctionsRoot,
  circuitVerifier: g16.address,
  validFrom: 0n,
  validUntil: 0n,
  predClaimRef: program.predicates.map((p) => p.claimRef),
  predOp: program.predicates.map((p) => p.op),
  predValue: program.predicates.map((p) => p.compareValue),
  tokType: program.tokens.map((t) => t.type),
  tokArg: program.tokens.map((t) => t.arg),
  registrant: '0x0000000000000000000000000000000000000000',
  uri: 'ACTA demo policy: auditScore>=80 AND jurisdiction not-in OFAC(IR,KP,SY,CU)',
};
const polR = await write(policies, 'registerPolicy', [policyStruct]);
const gate = await deploy('AgentAccessGate', [verifier.address, 0n]);

log('\n[5/6] proving locally + presenting ON BASE MAINNET');
const contextHash = await pub.readContract({ address: verifier.address, abi: verifier.abi, functionName: 'contextHash', args: [0n] });
const mProof = imt.generateProof(2);
const anchorSiblings = [...mProof.siblings];
while (anchorSiblings.length < 16) anchorSiblings.push(0n);
const ex = await smtTree.find(cred.claims[1]);
const smtSiblings = ex.siblings.map((s) => F.toObject(s));
while (smtSiblings.length < 32) smtSiblings.push(0n);
const block = await pub.getBlock();
const input = {
  masterSecret, claims: cred.claims,
  Ax: cred.issuerPublicKey.Ax, Ay: cred.issuerPublicKey.Ay,
  R8x: cred.signature.R8x, R8y: cred.signature.R8y, S: cred.signature.S,
  anchorDepth: BigInt(mProof.siblings.length), anchorIndex: BigInt(mProof.index), anchorSiblings,
  smtSiblings,
  smtOldKey: ex.isOld0 ? 0n : F.toObject(ex.notFoundKey),
  smtOldValue: ex.isOld0 ? 0n : F.toObject(ex.notFoundValue),
  smtIsOld0: ex.isOld0 ? 1n : 0n,
  predClaimRef: program.predicates.map((p) => p.claimRef),
  predOp: program.predicates.map((p) => p.op),
  predValue: program.predicates.map((p) => p.compareValue),
  tokType: program.tokens.map((t) => t.type),
  tokArg: program.tokens.map((t) => t.arg),
  anchorRoot: imt.root, sanctionsRoot, predicateHash: predHash,
  contextHash, currentTime: block.timestamp, sessionNonce: BigInt(block.number),
};
const toJson = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const wtns = { type: 'mem' };
const t0 = performance.now();
await snarkjs.wtns.calculate(toJson(input), join(BUILD, 'ActaPresentation_js', 'ActaPresentation.wasm'), wtns);
const { proof, publicSignals } = await snarkjs.groth16.prove(join(BUILD, 'acta_dev.zkey'), wtns);
log(`  proof generated in ${(performance.now() - t0).toFixed(0)}ms`);
const call = {
  a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
  b: [[BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]],
  c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  signals: publicSignals.map(BigInt),
};
const enterHash = await wallet.writeContract({
  address: gate.address, abi: gate.abi, functionName: 'enter',
  args: [call.a, call.b, call.c, call.signals],
});
const enterR = await track(enterHash);
const paEvt = enterR.logs.map((l) => {
  try { return decodeEventLog({ abi: verifier.abi, data: l.data, topics: l.topics }); } catch { return null; }
}).find((e) => e?.eventName === 'PresentationAccepted');
log(`  PresentationAccepted on Base mainnet — tx ${enterHash} (gas ${enterR.gasUsed})`);
log(`  nullifier ${paEvt.args.nullifier}`);

log('\n[6/6] replay check (eth_call — costs nothing, must revert)');
let replayError = 'NOT REVERTED (bug!)';
try {
  await pub.simulateContract({
    address: gate.address, abi: [...gate.abi, ...verifier.abi, ...nullifiers.abi],
    functionName: 'enter', args: [call.a, call.b, call.c, call.signals], account: account.address,
  });
} catch (e) {
  replayError = e.cause?.data?.errorName ?? e.shortMessage;
}
log(`  replay → ${replayError}`);
if (!/NullifierAlreadyUsed/.test(replayError)) throw new Error('replay did not revert as expected');

const bal1 = await pub.getBalance({ address: account.address });
const spent = formatEther(bal0 - bal1);
log(`\ntotal gas ${totalGas}, spent ${spent} ETH`);

// --- write records ---
const scan = (a) => `https://basescan.org/address/${a}`;
const scanTx = (h) => `https://basescan.org/tx/${h}`;
const dep = {
  chain: 'base-mainnet (8453)',
  deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  deployer: account.address,
  contracts: {
    PoseidonT3: poseidonT3.address,
    CredentialAnchor: anchor.address,
    PolicyRegistry: policies.address,
    NullifierRegistry: nullifiers.address,
    Groth16CircuitVerifier: g16.address,
    PredicateVerifier: verifier.address,
    AgentAccessGate: gate.address,
  },
  demo: {
    policyId: 0,
    policyTx: polR.transactionHash,
    anchorTxs,
    presentationTx: enterHash,
    nullifier: paEvt.args.nullifier.toString(),
    predicateProgramHash: predHash.toString(),
    note: 'demo credential master secret is public (see deploy-base.js); dev-ceremony zkey — NOT a production trust setup',
  },
};
mkdirSync(join(ROOT, 'docs', 'deployments'), { recursive: true });
writeFileSync(join(ROOT, 'docs', 'deployments', 'base.json'), JSON.stringify(dep, null, 2) + '\n');

const md = `# ACTA on Base mainnet — deployment record

Deployed ${dep.deployedAt} by \`${dep.deployer}\`. Total gas ${totalGas} (${spent} ETH).
**Dev-ceremony zkey — a production deployment would re-run a multi-party ceremony.**

| Contract | Address |
|---|---|
${Object.entries(dep.contracts).map(([n, a]) => `| ${n} | [\`${a}\`](${scan(a)}) |`).join('\n')}

## The demo story, on-chain (click everything)

- Policy #0 — *"auditScore ≥ 80 AND jurisdiction ∉ OFAC(IR,KP,SY,CU)"* — [registration tx](${scanTx(dep.demo.policyTx)}); predicateProgramHash \`${dep.demo.predicateProgramHash}\`
- Anonymity set — 4 commitments anchored: ${anchorTxs.map((h, i) => `[#${i}](${scanTx(h)})`).join(' · ')}
- **The presentation** — [PresentationAccepted](${scanTx(dep.demo.presentationTx)}) (gas ${enterR.gasUsed}): the chain learned only \`(policyId=0, nullifier=${dep.demo.nullifier.slice(0, 12)}…)\`. No score, no jurisdiction, no identity.
- Replay of the same proof reverts \`NullifierAlreadyUsed\` (try it — \`eth_call\` costs nothing).

The demo credential's master secret is **public by design** (\`packages/demo-cli/deploy-base.js\`) so anyone can reproduce proofs against new policies. Real agents keep theirs client-side.
`;
writeFileSync(join(ROOT, 'docs', 'BASE-DEPLOYMENT.md'), md);
log('wrote docs/deployments/base.json + docs/BASE-DEPLOYMENT.md');
process.exit(0);
