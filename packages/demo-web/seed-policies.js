// Seeds a local anvil chain with the ACTA stack, an anchored population, and
// SIX policies spanning the reasonable→over-asking spectrum, so the auditor
// dashboard (auditor.html) has something real to score. All on-chain.
//   node packages/demo-web/seed-policies.js
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon1, poseidon2 } from 'poseidon-lite';
import { SCHEMA_V1, compileDsl, predicateProgramHash, normalizeClaim, FORMAT } from '@acta/sdk';


const require = createRequire(import.meta.url);
const { newMemEmptyTrie } = require('circomlibjs');
const { derivePublicKey } = require('@zk-kit/eddsa-poseidon');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'app', 'packages', 'foundry', 'out');
const RPC = 'http://127.0.0.1:8545';

const art = (n) => {
  const j = JSON.parse(readFileSync(join(OUT, `${n}.sol`, `${n}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
let anvil = null;
try { await pub.getChainId(); } catch {
  anvil = spawn('anvil', ['--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  console.log('started anvil (leave it running for the dashboard)');
  anvil.unref();
}
const wallet = createWalletClient({
  account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  chain: foundry, transport: http(RPC),
});
const deploy = async (name, args = [], libs = {}) => {
  let { abi, bytecode } = art(name);
  for (const addr of Object.values(libs)) bytecode = bytecode.replace(/__\$[0-9a-f]{34}\$__/g, addr.slice(2).toLowerCase());
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress, abi };
};
const write = async (c, fn, args) => {
  const hash = await wallet.writeContract({ address: c.address, abi: c.abi, functionName: fn, args });
  return pub.waitForTransactionReceipt({ hash });
};

console.log('deploying stack…');
const poseidonT3 = await deploy('PoseidonT3');
const anchor = await deploy('CredentialAnchor', [], { PoseidonT3: poseidonT3.address });
const policies = await deploy('PolicyRegistry');
const nullifiers = await deploy('NullifierRegistry');
const g16 = await deploy('Groth16CircuitVerifier');
const verifier = await deploy('PredicateVerifier', [policies.address, anchor.address, nullifiers.address]);
await write(nullifiers, 'setVerifier', [verifier.address]);

console.log('anchoring a 64-holder population…');
const imt = new LeanIMT((a, b) => poseidon2([a, b]));
for (let i = 0; i < 64; i++) {
  const c = poseidon1([1_000_000n + BigInt(i)]);
  imt.insert(c);
  await write(anchor, 'anchor', [c]);
}

// sanctions SMT (IR KP SY CU) — reused by all seeded policies
const smtTree = await newMemEmptyTrie();
for (const cc of ['IR', 'KP', 'SY', 'CU']) await smtTree.insert(normalizeClaim(cc, FORMAT.STRING), 1n);
const sanctionsRoot = smtTree.F.toObject(smtTree.root);
const issuerKeyHash = (() => {
  const pk = derivePublicKey('acta-seed-issuer');
  return poseidon2([pk[0], pk[1]]);
})();

// the spectrum: from minimal to de-anonymizing
const SEEDS = [
  { uri: 'Lending vault: baseline audit gate', dsl: { claim: 'auditScore', op: '>=', value: 60 } },
  { uri: 'DEX router: standard compliance', dsl: { all: [
      { claim: 'auditScore', op: '>=', value: 80 },
      { not: { claim: 'jurisdiction', op: '==', value: 'IR' } } ] } },
  { uri: 'Perps protocol: senior agents only', dsl: { all: [
      { claim: 'auditScore', op: '>=', value: 90 },
      { claim: 'capabilities', op: '>=', value: 4 } ] } },
  { uri: 'Options desk: elite + fresh credential', dsl: { all: [
      { claim: 'auditScore', op: '>=', value: 95 },
      { claim: 'capabilities', op: '==', value: 7 } ] } },
  { uri: 'Sketchy aggregator: EXACT profile match', dsl: { all: [
      { claim: 'auditScore', op: '==', value: 97 },
      { claim: 'jurisdiction', op: '==', value: 'CH' } ] } },
  { uri: 'Data broker: fingerprint-grade demands', dsl: { all: [
      { claim: 'auditScore', op: '==', value: 99 },
      { all: [ { claim: 'capabilities', op: '==', value: 5 },
               { claim: 'validUntil', op: '<=', value: 1767225600 } ] } ] } },
];

console.log('registering 6 policies…');
for (const s of SEEDS) {
  const program = compileDsl(s.dsl, SCHEMA_V1);
  await write(policies, 'registerPolicy', [{
    predicateHash: predicateProgramHash(program),
    issuerKeyHash,
    issuer: wallet.account.address,
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
    uri: s.uri,
  }]);
}

const cfg = {
  rpc: RPC,
  chainId: 31337,
  policyRegistry: policies.address,
  credentialAnchor: anchor.address,
  nullifierRegistry: nullifiers.address,
  predicateVerifier: verifier.address,
  groth16CircuitVerifier: g16.address,
  poseidonT3: poseidonT3.address,
  issuer: wallet.account.address,
};
writeFileSync(join(HERE, 'deployed.local.json'), JSON.stringify(cfg, null, 2) + '\n');
console.log('seeded. config → packages/demo-web/deployed.local.json');
console.log(`PolicyRegistry ${policies.address} — open auditor.html (see README)`);
process.exit(0);
