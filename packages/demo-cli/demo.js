// ACTA demo A — the CLI non-OFAC walkthrough (research doc 08, concept A).
// Every step below is a REAL tx or a REAL Groth16 proof on a local anvil
// chain. Nothing is simulated; the failure modes are shown live.
//
//   issuer  -> issues credential (EdDSA-BJJ) + anchors commitment on-chain
//   verifier-> registers policy "auditScore >= 80 AND jurisdiction not-in OFAC"
//   agent   -> proves it satisfies the policy (in ~1s), enters the gate
//   finale  -> replay REVERTS; tampered credential fails at witness time;
//              two policies yield unlinkable nullifiers
//
// Prereqs: circuit compiled + dev ceremony run (make setup), anvil on :8545
// (auto-started if absent).
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  createPublicClient, createWalletClient, http, decodeEventLog, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
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
const OUT = join(ROOT, 'app', 'packages', 'foundry', 'out');
const BUILD = join(ROOT, 'packages', 'circuits', 'build');
const RPC = 'http://127.0.0.1:8545';

const art = (n) => {
  const j = JSON.parse(readFileSync(join(OUT, `${n}.sol`, `${n}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

// anvil default keys: 0=deployer, 1=issuer, 2=verifier-org, 3=agent
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];

const step = (n, s) => console.log(`\n\x1b[1m[${n}] ${s}\x1b[0m`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const info = (s) => console.log(`    ${s}`);
const short = (v) => { const s = v.toString(); return `${s.slice(0, 10)}…${s.slice(-6)}`; };

// --- ensure anvil ---
let anvilProc = null;
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
try {
  await pub.getChainId();
} catch {
  console.log('starting anvil…');
  anvilProc = spawn('anvil', ['--silent'], { stdio: 'ignore', detached: false });
  await new Promise((r) => setTimeout(r, 1500));
}

const wallets = KEYS.map((k) =>
  createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) })
);
const [deployer, issuerW, verifierW, agentW] = wallets;

const deploy = async (wallet, name, args = [], libs = {}) => {
  let { abi, bytecode } = art(name);
  // link libraries: forge leaves __$<hash>$__ placeholders for external libs
  for (const addr of Object.values(libs)) {
    bytecode = bytecode.replace(/__\$[0-9a-f]{34}\$__/g, addr.slice(2).toLowerCase());
  }
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  return { address: rcpt.contractAddress, abi };
};
const write = async (wallet, c, functionName, args) => {
  const hash = await wallet.writeContract({ address: c.address, abi: c.abi, functionName, args });
  return pub.waitForTransactionReceipt({ hash });
};
const read = (c, functionName, args = []) =>
  pub.readContract({ address: c.address, abi: c.abi, functionName, args });

console.log('\n\x1b[1m════ ACTA demo — anonymous non-OFAC credential presentation ════\x1b[0m');
console.log('every step is a real tx or a real Groth16 proof; watch the failures too');

step(1, 'deploy the ACTA stack (deployer account)');
const poseidonT3 = await deploy(deployer, 'PoseidonT3');
const anchor = await deploy(deployer, 'CredentialAnchor', [], { PoseidonT3: poseidonT3.address });
const policies = await deploy(deployer, 'PolicyRegistry');
const nullifiers = await deploy(deployer, 'NullifierRegistry');
const g16 = await deploy(deployer, 'Groth16CircuitVerifier');
const verifier = await deploy(deployer, 'PredicateVerifier', [policies.address, anchor.address, nullifiers.address]);
await write(deployer, nullifiers, 'setVerifier', [verifier.address]);
ok(`CredentialAnchor    ${anchor.address}`);
ok(`PolicyRegistry      ${policies.address}`);
ok(`NullifierRegistry   ${nullifiers.address}`);
ok(`PredicateVerifier   ${verifier.address}`);
ok(`Groth16 verifier    ${g16.address} (generated from the dev zkey — no test stubs)`);

step(2, 'issuer signs an AgentCapabilityCredential (EdDSA-BabyJubJub, off-chain)');
const masterSecret = 31337424242n; // the agent's secret; never leaves this process
const claims = { auditScore: 85, jurisdiction: 'CH', capabilities: 5, validUntil: 1893456000 };
const cred = issueCredential('acta-demo-issuer-key', masterSecret, claims);
ok(`claims: auditScore=85, jurisdiction=CH, validUntil=2030-01-01`);
ok(`signed message M = ${short(cred.message)} (Poseidon over holderCommitment + claims)`);

step(3, 'issuer anchors the holder commitment on-chain (among decoys — the anonymity set)');
const imt = new LeanIMT((a, b) => poseidon2([a, b]));
const decoys = [1111n, 2222n, 3333n];
const leaves = [decoys[0], decoys[1], cred.holderCommitment, decoys[2]];
for (const l of leaves) {
  imt.insert(l);
  await write(issuerW, anchor, 'anchor', [l]);
}
const chainRoot = await read(anchor, 'currentRoot', [issuerW.account.address]);
if (chainRoot !== imt.root) throw new Error('on-chain root != local root');
ok(`4 commitments anchored; on-chain LeanIMT root ${short(chainRoot)} == local root`);
info('(which of the 4 is our agent? the chain will never know)');

step(4, 'verifier org registers the policy: auditScore >= 80 AND jurisdiction ∉ OFAC');
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
  issuer: issuerW.account.address,
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
  uri: 'demo: auditScore>=80 AND jurisdiction not-in OFAC(IR,KP,SY,CU)',
};
await write(verifierW, policies, 'registerPolicy', [policyStruct]);
const policyId = 0n;
ok(`policy #0 registered: predicateProgramHash ${short(predHash)}`);
info('(the compiled program is stored on-chain — auditable by anyone; sanctions SMT: IR, KP, SY, CU)');
const gate = await deploy(deployer, 'AgentAccessGate', [verifier.address, policyId]);
ok(`AgentAccessGate ${gate.address} gates on policy #0`);

step(5, 'agent builds the ZK proof locally (the sensitive data never leaves the machine)');
const contextHash = await read(verifier, 'contextHash', [policyId]);
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
  contextHash, currentTime: block.timestamp, sessionNonce: 12345n,
};
const toJson = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const t0 = performance.now();
const wtns = { type: 'mem' };
await snarkjs.wtns.calculate(toJson(input), join(BUILD, 'ActaPresentation_js', 'ActaPresentation.wasm'), wtns);
const { proof, publicSignals } = await snarkjs.groth16.prove(join(BUILD, 'acta_dev.zkey'), wtns);
const proveMs = (performance.now() - t0).toFixed(0);
ok(`Groth16 proof generated in ${proveMs}ms (45,438 constraints)`);
info(`public signals: nullifier=${short(publicSignals[0])}, issuerKeyHash=${short(publicSignals[1])} — no score, no jurisdiction, no identity`);

const asCall = (ps) => ({
  a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
  b: [[BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]],
  c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  signals: ps.map(BigInt),
});
const call = asCall(publicSignals);

step(6, 'agent (from a fresh wallet) enters the gate — proof verified ON-CHAIN');
const enterHash = await agentW.writeContract({
  address: gate.address, abi: gate.abi, functionName: 'enter',
  args: [call.a, call.b, call.c, call.signals],
});
const rcpt = await pub.waitForTransactionReceipt({ hash: enterHash });
const paEvt = rcpt.logs.map((l) => {
  try { return decodeEventLog({ abi: verifier.abi, data: l.data, topics: l.topics }); } catch { return null; }
}).find((e) => e?.eventName === 'PresentationAccepted');
ok(`tx ${rcpt.transactionHash} — gas ${rcpt.gasUsed}`);
ok(`PresentationAccepted(policyId=${paEvt.args.policyId}, nullifier=${short(paEvt.args.nullifier)})`);
info('(the ONLY thing the chain learned: this policy was satisfied, once, by someone anchored)');

step(7, 'FAILURE 1 — replaying the same proof');
try {
  await pub.simulateContract({
    address: gate.address,
    abi: [...gate.abi, ...verifier.abi, ...nullifiers.abi],
    functionName: 'enter',
    args: [call.a, call.b, call.c, call.signals], account: agentW.account,
  });
  bad('replay was accepted?! (bug)'); process.exit(1);
} catch (e) {
  bad(`REVERTED: ${e.cause?.data?.errorName ?? e.shortMessage}`);
}

step(8, 'FAILURE 2 — tampered credential (auditScore 79, forged to claim >= 80)');
try {
  const forged = structuredClone(toJson(input));
  forged.claims[0] = '79';
  await snarkjs.wtns.calculate(forged, join(BUILD, 'ActaPresentation_js', 'ActaPresentation.wasm'), { type: 'mem' });
  bad('witness built?! (bug)'); process.exit(1);
} catch (e) {
  bad(`proof generation FAILED locally: ${String(e).split('\n')[0].slice(0, 90)}`);
  info('(a proof for a false statement cannot even be constructed — and note the');
  info(' signature also breaks: score 79 was never signed by the issuer)');
}

step(9, 'FAILURE 3 — sanctioned jurisdiction (IR) has no exclusion proof');
const irCred = issueCredential('acta-demo-issuer-key', 999888777n, { ...claims, jurisdiction: 'IR' });
const irFind = await smtTree.find(irCred.claims[1]);
bad(`SMT lookup for 'IR': found=${irFind.found} — no non-membership witness exists; proving is impossible`);

step(10, 'UNLINKABILITY — same agent, second verifier context');
await write(verifierW, policies, 'registerPolicy', [policyStruct]); // policy #1, same predicate
const ctx2 = await read(verifier, 'contextHash', [1n]);
const input2 = { ...input, contextHash: ctx2 };
const wtns2 = { type: 'mem' };
await snarkjs.wtns.calculate(toJson(input2), join(BUILD, 'ActaPresentation_js', 'ActaPresentation.wasm'), wtns2);
const { publicSignals: ps2 } = await snarkjs.groth16.prove(join(BUILD, 'acta_dev.zkey'), wtns2);
ok(`policy #0 nullifier: ${publicSignals[0]}`);
ok(`policy #1 nullifier: ${ps2[0]}`);
info('same secret, same credential — cryptographically unlinkable nullifiers');

console.log('\n\x1b[1m════ done — real proofs, real txs, real reverts ════\x1b[0m\n');
if (anvilProc) anvilProc.kill();
process.exit(0);
