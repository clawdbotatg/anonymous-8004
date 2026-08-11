"use client";

/**
 * ACTA three-panel demo (research doc 08, concept B).
 *
 * One page, three roles: an ISSUER signs + anchors a credential, a VERIFIER
 * org registers a predicate policy, and an AGENT proves it satisfies the
 * policy — with a real Groth16 proof generated IN THIS TAB (the master
 * secret and claims never leave the browser) and verified on-chain.
 * For the demo one connected wallet plays all three roles; in production
 * these are three different parties.
 */
import { useEffect, useMemo, useState } from "react";
import type { NextPage } from "next";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { useAccount, useSwitchChain } from "wagmi";
import deployedContracts from "~~/contracts/deployedContracts";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import {
  useDeployedContractInfo,
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { getParsedError, notification } from "~~/utils/scaffold-eth";
import {
  CompiledProgram,
  Credential,
  FIELD_MODULUS,
  SCHEMA_V1,
  compileDsl,
  evaluateProgram,
  issueCredential,
  nullifier as deriveNullifier,
  predicateProgramHash,
} from "~~/utils/acta/actaSdk";
import {
  ProofCalldata,
  SANCTIONED_JURISDICTIONS,
  buildWitnessInput,
  proveInBrowser,
  sanctionsExclusion,
} from "~~/utils/acta/prove";

/** Demo issuer signing key (EdDSA-BJJ). Fixed so the issuerKeyHash is stable. */
const DEMO_ISSUER_KEY = "acta-web-demo-issuer-key-v1";
const CONTEXT_DOMAIN = keccak256(toBytes("ACTA_CONTEXT_V1"));
const JURISDICTIONS = ["CH", "US", "DE", "JP", "SG", "BR", ...SANCTIONED_JURISDICTIONS];

const short = (v: bigint | string) => {
  const s = v.toString();
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
};

const randomFieldElement = () => {
  const bytes = new Uint8Array(31); // 248 bits < 254-bit field
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) + BigInt(b), 0n) % FIELD_MODULUS;
};

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-xs break-all">{children}</span>
);

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-2 text-sm">
    <span className="opacity-60 whitespace-nowrap">{k}</span>
    <Mono>{v}</Mono>
  </div>
);

const ActaDemo: NextPage = () => {
  const { address: connectedAddress, chain: connectedChain } = useAccount();
  const { switchChain } = useSwitchChain();
  const { targetNetwork } = useTargetNetwork();
  const wrongNetwork = !!connectedChain && connectedChain.id !== targetNetwork.id;

  /**
   * Every on-chain CTA slot renders exactly one of: Connect → Switch network →
   * the real action button. The header dropdown alone is not enough — clicking
   * an action on the wrong chain would otherwise die as a toast.
   */
  const guardTx = (button: React.ReactNode) => {
    if (!connectedAddress) return <RainbowKitCustomConnectButton />;
    if (wrongNetwork)
      return (
        <button className="btn btn-warning btn-sm" onClick={() => switchChain({ chainId: targetNetwork.id })}>
          Switch to {targetNetwork.name}
        </button>
      );
    return button;
  };
  const chainContracts = (deployedContracts as Record<number, any>)[targetNetwork.id];
  const fromBlock = BigInt(chainContracts?.CredentialAnchor?.deployedOnBlock ?? 0);

  const { data: predicateVerifier } = useDeployedContractInfo({ contractName: "PredicateVerifier" });
  const { data: g16Verifier } = useDeployedContractInfo({ contractName: "Groth16CircuitVerifier" });

  // ------------------------------------------------------------- agent secret
  const [masterSecret, setMasterSecret] = useState<bigint | null>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem("acta-master-secret");
    if (saved) setMasterSecret(BigInt(saved));
    else {
      const s = randomFieldElement();
      window.localStorage.setItem("acta-master-secret", s.toString());
      setMasterSecret(s);
    }
  }, []);

  // ------------------------------------------------------------ issuer panel
  const [auditScore, setAuditScore] = useState(85);
  const [jurisdiction, setJurisdiction] = useState("CH");
  const [cred, setCred] = useState<Credential | null>(null);
  const [anchoring, setAnchoring] = useState(false);
  // Covers the confirm→event-cache gap: the receipt lands ~3s before
  // useScaffoldEventHistory repolls, and in that window isAnchored is still
  // false — without a cooldown a second click anchors a duplicate leaf.
  const [anchorCooldown, setAnchorCooldown] = useState(false);

  const { writeContractAsync: writeAnchor } = useScaffoldWriteContract({ contractName: "CredentialAnchor" });
  const { data: treeSize } = useScaffoldReadContract({
    contractName: "CredentialAnchor",
    functionName: "treeSize",
    args: [connectedAddress],
    watch: true,
  });
  const { data: anchorEvents } = useScaffoldEventHistory({
    contractName: "CredentialAnchor",
    eventName: "CommitmentAnchored",
    fromBlock,
    watch: true,
  });
  /** Per-issuer leaf lists — each issuer address owns its own LeanIMT. */
  const leavesFor = useMemo(() => {
    const byIssuer = new Map<string, { leaf: bigint; idx: bigint }[]>();
    for (const e of anchorEvents ?? []) {
      const issuer = (e.args.issuer as string).toLowerCase();
      if (!byIssuer.has(issuer)) byIssuer.set(issuer, []);
      byIssuer.get(issuer)!.push({ leaf: e.args.commitment as bigint, idx: e.args.leafIndex as bigint });
    }
    return (issuer?: string) =>
      (byIssuer.get(issuer?.toLowerCase() ?? "") ?? []).sort((a, b) => (a.idx < b.idx ? -1 : 1)).map(x => x.leaf);
  }, [anchorEvents]);
  const anchorLeaves = useMemo(() => leavesFor(connectedAddress), [leavesFor, connectedAddress]);
  const isAnchored = !!cred && anchorLeaves.includes(cred.holderCommitment);

  const issue = () => {
    if (!masterSecret) return;
    try {
      const c = issueCredential(DEMO_ISSUER_KEY, masterSecret, {
        auditScore,
        jurisdiction,
        capabilities: 5,
        validUntil: 1893456000, // 2030-01-01 — checked in-circuit against currentTime
      });
      setCred(c);
      setCall(null);
      notification.success("Credential signed off-chain (EdDSA-BabyJubJub). Nothing touched the chain.");
    } catch (e) {
      notification.error(getParsedError(e));
    }
  };

  const anchorCommitment = async (leaf: bigint, what: string) => {
    setAnchoring(true);
    try {
      await writeAnchor({ functionName: "anchor", args: [leaf] });
      setAnchorCooldown(true);
      setTimeout(() => setAnchorCooldown(false), 4000);
      notification.success(`${what} anchored in the issuer's on-chain LeanIMT`);
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setAnchoring(false);
    }
  };

  // ---------------------------------------------------------- verifier panel
  const [minScore, setMinScore] = useState(80);
  const [registering, setRegistering] = useState(false);
  const { writeContractAsync: writePolicy } = useScaffoldWriteContract({ contractName: "PolicyRegistry" });
  const { data: policyEvents } = useScaffoldEventHistory({
    contractName: "PolicyRegistry",
    eventName: "PolicyRegistered",
    fromBlock,
    watch: true,
  });
  const policyIds = useMemo(
    () => (policyEvents ?? []).map(e => e.args.policyId as bigint).sort((a, b) => (a < b ? -1 : 1)),
    [policyEvents],
  );

  const registerPolicy = async () => {
    if (!connectedAddress || !g16Verifier || !cred) {
      notification.error("connect a wallet and issue a credential first (the policy pins the issuer key)");
      return;
    }
    setRegistering(true);
    try {
      // "auditScore >= minScore AND NOT (jurisdiction == IR)" + SMT exclusion of the whole list
      const program = compileDsl({
        all: [
          { claim: "auditScore", op: ">=", value: minScore },
          { not: { claim: "jurisdiction", op: "==", value: "IR" } },
        ],
      });
      const { sanctionsRoot } = await sanctionsExclusion(0n); // key 0 is never sanctioned → root of the fixed list
      await writePolicy({
        functionName: "registerPolicy",
        args: [
          {
            predicateHash: predicateProgramHash(program),
            issuerKeyHash: cred.issuerPubKeyHash,
            issuer: connectedAddress,
            sanctionsRoot,
            circuitVerifier: g16Verifier.address,
            validFrom: 0n,
            validUntil: 0n,
            predClaimRef: program.predicates.map(p => p.claimRef) as [bigint, bigint, bigint, bigint],
            predOp: program.predicates.map(p => p.op) as [bigint, bigint, bigint, bigint],
            predValue: program.predicates.map(p => p.compareValue) as [bigint, bigint, bigint, bigint],
            tokType: program.tokens.map(t => t.type) as any,
            tokArg: program.tokens.map(t => t.arg) as any,
            registrant: "0x0000000000000000000000000000000000000000",
            uri: `demo: auditScore>=${minScore} AND jurisdiction not-in OFAC(${SANCTIONED_JURISDICTIONS.join(",")})`,
          },
        ],
      });
      notification.success("Policy registered — the full compiled program is on-chain, auditable by anyone");
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setRegistering(false);
    }
  };

  // ------------------------------------------------------------- agent panel
  const [selectedPolicyId, setSelectedPolicyId] = useState<bigint | null>(null);
  useEffect(() => {
    if (selectedPolicyId === null && policyIds.length > 0) setSelectedPolicyId(policyIds[policyIds.length - 1]);
  }, [policyIds, selectedPolicyId]);

  const { data: policy } = useScaffoldReadContract({
    contractName: "PolicyRegistry",
    functionName: "getPolicy",
    args: [selectedPolicyId ?? undefined],
  });

  const [stage, setStage] = useState<string | null>(null);
  const [proveMs, setProveMs] = useState<number | null>(null);
  const [call, setCall] = useState<ProofCalldata | null>(null);
  const [presenting, setPresenting] = useState(false);
  const { writeContractAsync: writeVerifier } = useScaffoldWriteContract({ contractName: "PredicateVerifier" });

  const contextHashFor = (policyId: bigint) => {
    if (!predicateVerifier) throw new Error("PredicateVerifier not loaded");
    return (
      BigInt(
        keccak256(
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
            [CONTEXT_DOMAIN, predicateVerifier.address, policyId],
          ),
        ),
      ) % FIELD_MODULUS
    );
  };

  /** The agent trusts nothing off-chain: program + hash are read back from the registry. */
  const programFromChain = (): { program: CompiledProgram; predicateHash: bigint } => {
    if (!policy) throw new Error("policy not loaded from chain yet");
    return {
      program: {
        predicates: policy.predClaimRef.map((c: bigint, i: number) => ({
          claimRef: c,
          op: policy.predOp[i],
          compareValue: policy.predValue[i],
        })),
        tokens: policy.tokType.map((t: bigint, i: number) => ({ type: t, arg: policy.tokArg[i] })),
      },
      predicateHash: policy.predicateHash,
    };
  };

  const prove = async (tamper?: (claims: bigint[]) => bigint[]) => {
    if (!cred || !masterSecret || selectedPolicyId === null) return null;
    const { program, predicateHash } = programFromChain();
    if (!tamper && !evaluateProgram(program, cred.claims)) {
      throw new Error("credential does not satisfy this policy (checked locally before proving)");
    }
    // The merkle proof must live in the POLICY's issuer tree — a proof against
    // any other tree reverts UnknownAnchorRoot on-chain.
    const policyIssuerLeaves = leavesFor(policy!.issuer);
    if (!policyIssuerLeaves.includes(cred.holderCommitment)) {
      throw new Error(
        `policy #${selectedPolicyId} pins issuer ${policy!.issuer.slice(0, 8)}… and your credential is not anchored in that issuer's tree — anchor it from that wallet or pick a policy registered for your issuer`,
      );
    }
    const input = await buildWitnessInput({
      masterSecret,
      cred,
      program,
      anchorLeaves: policyIssuerLeaves,
      predicateHash,
      contextHash: contextHashFor(selectedPolicyId),
      sessionNonce: randomFieldElement() % (1n << 64n),
      tamperClaims: tamper,
    });
    return proveInBrowser(input, setStage);
  };

  const proveHonest = async () => {
    setStage("starting…");
    setCall(null);
    try {
      const res = await prove();
      if (res) {
        setCall(res.call);
        setProveMs(res.ms);
        notification.success(`Groth16 proof generated in this tab in ${res.ms}ms`);
      }
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setStage(null);
    }
  };

  const present = async () => {
    if (!call || selectedPolicyId === null) return;
    setPresenting(true);
    try {
      await writeVerifier({
        functionName: "verifyPresentation",
        args: [selectedPolicyId, call.a, call.b, call.c, call.signals as any],
      });
      notification.success("PresentationAccepted — the chain learned ONLY that the policy holds");
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setPresenting(false);
    }
  };

  // ------------------------------------------------------------- failure lab
  const [labBusy, setLabBusy] = useState<string | null>(null);
  const [labLog, setLabLog] = useState<{ title: string; body: string; ok: boolean }[]>([]);
  const lab = (title: string, body: string, ok: boolean) => setLabLog(l => [{ title, body, ok }, ...l].slice(0, 6));

  const labReplay = async () => {
    if (!call || selectedPolicyId === null) return;
    setLabBusy("replay");
    try {
      await writeVerifier({
        functionName: "verifyPresentation",
        args: [selectedPolicyId, call.a, call.b, call.c, call.signals as any],
      });
      lab("replay", "accepted — THIS IS A BUG", false);
    } catch (e) {
      // 0xcad2ae02 = NullifierAlreadyUsed() — raised by the NullifierRegistry,
      // whose ABI the verifier hook doesn't carry, so decode it by selector.
      const msg = getParsedError(e);
      lab(
        "replay same proof",
        msg.includes("0xcad2ae02")
          ? "reverted NullifierAlreadyUsed() — one presentation per agent per context, ever"
          : `reverted as designed: ${msg.slice(0, 120)}`,
        true,
      );
    } finally {
      setLabBusy(null);
    }
  };

  const labTamper = async () => {
    setLabBusy("tamper");
    setStage("trying to prove a forged score…");
    try {
      await prove(claims => {
        const c = [...claims];
        c[0] = BigInt(Math.max(0, minScore - 1)); // below threshold AND breaks the issuer signature
        return c;
      });
      lab("tampered credential", "proof was produced — THIS IS A BUG", false);
    } catch {
      lab(
        "tampered credential",
        `witness generation failed locally: a forged auditScore=${minScore - 1} both fails the predicate and breaks the issuer's signature — a proof of a false statement cannot be constructed`,
        true,
      );
    } finally {
      setLabBusy(null);
      setStage(null);
    }
  };

  const labSanctioned = async () => {
    if (!masterSecret) return;
    setLabBusy("sanctioned");
    try {
      const irCred = issueCredential(DEMO_ISSUER_KEY, masterSecret + 1n, {
        auditScore: 99,
        jurisdiction: "IR",
        capabilities: 5,
        validUntil: 1893456000,
      });
      await sanctionsExclusion(irCred.claims[1]);
      lab("sanctioned jurisdiction", "exclusion proof produced for IR — THIS IS A BUG", false);
    } catch {
      lab(
        "sanctioned jurisdiction",
        "issuer happily signed jurisdiction=IR (score 99!), but IR is IN the sanctions SMT, so no non-membership witness exists — proving is impossible, even with a perfect score",
        true,
      );
    } finally {
      setLabBusy(null);
    }
  };

  const labUnlinkable = () => {
    if (!masterSecret || policyIds.length < 2) {
      notification.info("register a second policy first (any threshold) — unlinkability is across contexts");
      return;
    }
    const [a, b] = [policyIds[0], policyIds[policyIds.length - 1]];
    const na = deriveNullifier(masterSecret, contextHashFor(a));
    const nb = deriveNullifier(masterSecret, contextHashFor(b));
    lab(
      "unlinkability",
      `same secret, two contexts → nullifier(policy #${a}) = ${short(na)} vs nullifier(policy #${b}) = ${short(nb)} — no observer can tell they came from the same agent`,
      na !== nb,
    );
  };

  // -------------------------------------------------------------- event feed
  const { data: accepted } = useScaffoldEventHistory({
    contractName: "PredicateVerifier",
    eventName: "PresentationAccepted",
    fromBlock,
    watch: true,
  });

  const scoreClaim = cred ? Number(cred.claims[0]) : null;

  return (
    <div className="flex flex-col items-center px-4 py-8 gap-6">
      <div className="text-center max-w-3xl">
        <h1 className="text-3xl font-bold">ACTA — anonymous credential presentation</h1>
        <p className="text-sm opacity-70 mt-2">
          Issue → anchor → register policy → <b>prove in your browser</b> → verify on-chain. The proof takes seconds;
          the chain never sees the score, the jurisdiction, or which anchored commitment is yours. One wallet plays all
          three roles here — in production they are three parties.
        </p>
      </div>

      <div className="collapse collapse-arrow bg-base-200 w-full max-w-3xl">
        <input type="checkbox" />
        <div className="collapse-title text-sm font-medium py-2 min-h-0">
          ⚠️ Trust assumptions of this research demo — what you should NOT rely on
        </div>
        <div className="collapse-content text-xs opacity-80">
          <ul className="list-disc pl-4 flex flex-col gap-1">
            <li>
              The Groth16 proving key is a <b>single-party dev ceremony</b>, not a production multi-party setup —
              whoever ran it could in principle retain the toxic waste and forge proofs against the deployed verifier.
            </li>
            <li>
              The demo issuer’s signing key is a <b>fixed public string</b>, so anyone can mint “valid” demo
              credentials. A real deployment has real issuers with private keys.
            </li>
            <li>
              Your agent’s master secret is stored <b>unencrypted in this browser’s localStorage</b> (clear it to
              rotate). Fine for a demo, unacceptable for a real agent.
            </li>
            <li>
              One wallet playing issuer, verifier, and agent means an observer of <b>this wallet’s transactions</b> can
              correlate what the nullifiers alone would not reveal. The unlinkability shown in the failure lab is the
              real property; the single-wallet demo flow weakens it.
            </li>
            <li>
              The hosted frontend and RPC see your IP and wallet address. For a real privacy posture, run the app
              locally against your own RPC — the repo is public.
            </li>
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 w-full max-w-7xl">
        {/* ISSUER */}
        <div className="card bg-base-100 shadow-xl border-t-4 border-primary">
          <div className="card-body gap-3">
            <h2 className="card-title">1 · Issuer</h2>
            <p className="text-xs opacity-60 -mt-2">
              signs an AgentCapabilityCredential off-chain, anchors only a Poseidon commitment on-chain
            </p>
            <label className="form-control">
              <span className="label-text">auditScore</span>
              <input
                type="number"
                className="input input-bordered input-sm"
                value={auditScore}
                min={0}
                max={100}
                onChange={e => setAuditScore(Number(e.target.value))}
              />
            </label>
            <label className="form-control">
              <span className="label-text">operator jurisdiction</span>
              <select
                className="select select-bordered select-sm"
                value={jurisdiction}
                onChange={e => setJurisdiction(e.target.value)}
              >
                {JURISDICTIONS.map(j => (
                  <option key={j} value={j}>
                    {j}
                    {SANCTIONED_JURISDICTIONS.includes(j) ? " (sanctioned)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary btn-sm" onClick={issue} disabled={!masterSecret}>
              Issue credential (sign off-chain)
            </button>
            {cred && (
              <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-1">
                <Row k="holder commitment" v={short(cred.holderCommitment)} />
                <Row k="issuer key hash" v={short(cred.issuerPubKeyHash)} />
                <Row k="signed message M" v={short(cred.message)} />
              </div>
            )}
            {guardTx(
              <button
                className="btn btn-outline btn-sm"
                onClick={() => cred && anchorCommitment(cred.holderCommitment, "holder commitment")}
                disabled={!cred || anchoring || anchorCooldown || isAnchored}
              >
                {anchoring ? <span className="loading loading-spinner loading-xs" /> : null}
                {isAnchored ? "✓ commitment anchored" : "Anchor commitment on-chain"}
              </button>,
            )}
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => anchorCommitment(randomFieldElement(), "decoy")}
              disabled={anchoring || anchorCooldown || !connectedAddress || wrongNetwork}
            >
              + anchor a decoy (grow the anonymity set)
            </button>
            <Row k="anonymity set (tree size)" v={(treeSize ?? 0n).toString()} />
          </div>
        </div>

        {/* VERIFIER ORG */}
        <div className="card bg-base-100 shadow-xl border-t-4 border-secondary">
          <div className="card-body gap-3">
            <h2 className="card-title">2 · Verifier org</h2>
            <p className="text-xs opacity-60 -mt-2">
              registers an immutable policy: predicate hash + the full compiled program, on-chain and auditable
            </p>
            <label className="form-control">
              <span className="label-text">
                require auditScore ≥ … <span className="opacity-50">(AND jurisdiction ∉ {"{"}IR,KP,SY,CU{"}"})</span>
              </span>
              <input
                type="number"
                className="input input-bordered input-sm"
                value={minScore}
                min={0}
                max={100}
                onChange={e => setMinScore(Number(e.target.value))}
              />
            </label>
            {guardTx(
              <button className="btn btn-secondary btn-sm" onClick={registerPolicy} disabled={registering || !cred}>
                {registering ? <span className="loading loading-spinner loading-xs" /> : null}
                Register policy on-chain
              </button>,
            )}
            {!cred && <p className="text-xs opacity-50">issue a credential first — the policy pins its issuer key</p>}
            <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-1">
              <Row k="registered policies" v={policyIds.length.toString()} />
              {selectedPolicyId !== null && policy && (
                <>
                  <Row k={`policy #${selectedPolicyId} predicateHash`} v={short(policy.predicateHash)} />
                  <Row k="uri" v={policy.uri} />
                </>
              )}
            </div>
          </div>
        </div>

        {/* AGENT */}
        <div className="card bg-base-100 shadow-xl border-t-4 border-accent">
          <div className="card-body gap-3">
            <h2 className="card-title">3 · Agent</h2>
            <p className="text-xs opacity-60 -mt-2">
              reads the policy program back from the chain, proves it in-browser, presents from any wallet
            </p>
            <label className="form-control">
              <span className="label-text">policy</span>
              <select
                className="select select-bordered select-sm"
                value={selectedPolicyId?.toString() ?? ""}
                onChange={e => {
                  setSelectedPolicyId(BigInt(e.target.value));
                  setCall(null);
                }}
              >
                {policyIds.map(id => (
                  <option key={id.toString()} value={id.toString()}>
                    policy #{id.toString()}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-accent btn-sm"
              onClick={proveHonest}
              disabled={!cred || !isAnchored || selectedPolicyId === null || !policy || !!stage}
            >
              {stage ? <span className="loading loading-spinner loading-xs" /> : null}
              Generate ZK proof in this tab
            </button>
            {stage && <p className="text-xs font-mono opacity-70">{stage}</p>}
            {!isAnchored && cred && <p className="text-xs opacity-50">anchor the commitment first</p>}
            {call && (
              <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-1">
                <Row k="proved in" v={`${proveMs}ms (45,438 constraints)`} />
                <Row k="nullifier (public)" v={short(call.signals[0])} />
                <Row k="score / jurisdiction" v="not in the proof — private forever" />
                {scoreClaim !== null && (
                  <Row k="(this tab knows)" v={`score=${scoreClaim}, ${jurisdiction} — the chain never will`} />
                )}
              </div>
            )}
            {guardTx(
              <button className="btn btn-outline btn-sm" onClick={present} disabled={!call || presenting}>
                {presenting ? <span className="loading loading-spinner loading-xs" /> : null}
                Present on-chain (verifyPresentation)
              </button>,
            )}
          </div>
        </div>
      </div>

      {/* FAILURE LAB */}
      <div className="card bg-base-100 shadow-xl w-full max-w-7xl">
        <div className="card-body gap-3">
          <h2 className="card-title text-base">Failure lab — watch it refuse</h2>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-error btn-outline btn-sm" onClick={labReplay} disabled={!call || !!labBusy}>
              {labBusy === "replay" ? <span className="loading loading-spinner loading-xs" /> : null}
              Replay the same proof
            </button>
            <button
              className="btn btn-error btn-outline btn-sm"
              onClick={labTamper}
              disabled={!cred || !isAnchored || !policy || !!labBusy}
            >
              {labBusy === "tamper" ? <span className="loading loading-spinner loading-xs" /> : null}
              Forge auditScore={Math.max(0, minScore - 1)}
            </button>
            <button className="btn btn-error btn-outline btn-sm" onClick={labSanctioned} disabled={!!labBusy}>
              {labBusy === "sanctioned" ? <span className="loading loading-spinner loading-xs" /> : null}
              Try a sanctioned credential (IR)
            </button>
            <button className="btn btn-info btn-outline btn-sm" onClick={labUnlinkable} disabled={!masterSecret}>
              Show unlinkability across policies
            </button>
          </div>
          {labLog.map((l, i) => (
            <div key={i} className={`alert py-2 text-sm ${l.ok ? "alert-success" : "alert-error"}`}>
              <span>
                <b>{l.title}:</b> {l.body}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* EVENT FEED */}
      <div className="card bg-base-100 shadow-xl w-full max-w-7xl">
        <div className="card-body">
          <h2 className="card-title text-base">PresentationAccepted — everything the chain ever learns</h2>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>policyId</th>
                  <th>nullifier</th>
                  <th>expiry</th>
                </tr>
              </thead>
              <tbody>
                {(accepted ?? []).map((e, i) => (
                  <tr key={i}>
                    <td className="font-mono">{e.args.policyId?.toString()}</td>
                    <td className="font-mono">{short(e.args.nullifier as bigint)}</td>
                    <td className="font-mono">{e.args.expiryTimestamp === 0n ? "none" : e.args.expiryTimestamp?.toString()}</td>
                  </tr>
                ))}
                {(accepted ?? []).length === 0 && (
                  <tr>
                    <td colSpan={3} className="opacity-50">
                      no presentations yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActaDemo;
