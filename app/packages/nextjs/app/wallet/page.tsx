"use client";

/**
 * The ACTA credential wallet (doc 13, v1) — where an agent actually HOLDS
 * credentials, and where proofs are approved and generated.
 *
 * Sign one fixed message with your wallet → the signature becomes the key
 * that encrypts your credentials on this device. Credentials arrive from an
 * issuer via /wallet#import=<vc> (URL fragments never reach a server) and
 * leave only as ZK proofs, approved here against the policy read back from
 * the chain.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import deployedContracts from "~~/contracts/deployedContracts";
import {
  useDeployedContractInfo,
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { CompiledProgram, Credential, evaluateProgram, holderCommitment } from "~~/utils/acta/actaSdk";
import { contextHashFor } from "~~/utils/acta/context";
import { describeProgram } from "~~/utils/acta/policyWords";
import { ProofCalldata, buildWitnessInput, proveInBrowser } from "~~/utils/acta/prove";
import {
  VAULT_MESSAGE,
  VaultData,
  deriveVaultKey,
  loadVault,
  randomFieldElement,
  saveVault,
} from "~~/utils/acta/vault";
import { ActaVerifiableCredential, decodeRequestFragment, decodeVCFragment, vcToCredential } from "~~/utils/acta/vc";
import { getBlockExplorerTxLink, getParsedError, notification } from "~~/utils/scaffold-eth";

const short = (v: bigint | string) => {
  const s = v.toString();
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
};

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-2 text-sm">
    <span className="opacity-60 whitespace-nowrap">{k}</span>
    <span className="font-mono text-xs break-all text-right">{v}</span>
  </div>
);

type PendingImport = { vc: ActaVerifiableCredential; cred: Credential; sigOk: boolean } | { error: string };

const WalletPage: NextPage = () => {
  const { address, chain: connectedChain } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChain } = useSwitchChain();
  const { targetNetwork } = useTargetNetwork();
  const wrongNetwork = !!connectedChain && connectedChain.id !== targetNetwork.id;

  const guardTx = (button: React.ReactNode) => {
    if (!address) return <RainbowKitCustomConnectButton />;
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

  // ------------------------------------------------------------------ vault
  const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null);
  const [vault, setVault] = useState<VaultData | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const unlocked = !!vault && !!vaultKey;

  // A different connected wallet means a different vault — relock.
  useEffect(() => {
    setVaultKey(null);
    setVault(null);
  }, [address]);

  const unlock = async () => {
    if (!address) return;
    setUnlockBusy(true);
    try {
      const sig = await signMessageAsync({ message: VAULT_MESSAGE });
      const key = await deriveVaultKey(sig);
      let data = await loadVault(address, key);
      if (!data) {
        // First unlock: adopt the browser's existing agent identity (the demo
        // page's master secret) so demo-issued credentials stay provable here;
        // mint one if this browser has none. v1 keeps the plaintext mirror the
        // demo page reads — see the honesty note at the foot of the page.
        let secret = window.localStorage.getItem("acta-master-secret");
        if (!secret) {
          secret = randomFieldElement().toString();
          window.localStorage.setItem("acta-master-secret", secret);
        }
        data = { masterSecret: secret, vcs: [] };
        await saveVault(address, key, data);
      }
      setVaultKey(key);
      setVault(data);
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setUnlockBusy(false);
    }
  };

  const persist = async (next: VaultData) => {
    if (!address || !vaultKey) return;
    await saveVault(address, vaultKey, next);
    setVault(next);
  };

  const myCommitment = useMemo(() => (vault ? holderCommitment(BigInt(vault.masterSecret)) : null), [vault]);

  // ------------------------------------------------- fragment hand-off routes
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [requestPolicyId, setRequestPolicyId] = useState<bigint | null>(null);

  useEffect(() => {
    const handle = () => {
      const imp = window.location.hash.match(/#import=([A-Za-z0-9_-]+)/);
      const req = window.location.hash.match(/#request=([A-Za-z0-9_-]+)/);
      if (imp) {
        try {
          const vc = decodeVCFragment(imp[1]);
          const { cred, sigOk } = vcToCredential(vc);
          setPendingImport({ vc, cred, sigOk });
        } catch (e) {
          setPendingImport({ error: getParsedError(e) });
        }
      }
      if (req) {
        try {
          setRequestPolicyId(decodeRequestFragment(req[1]));
        } catch (e) {
          notification.error(`bad proof request in URL: ${getParsedError(e)}`);
        }
      }
    };
    handle();
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);

  const clearFragment = useCallback(() => {
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const acceptImport = async () => {
    if (!vault || !pendingImport || "error" in pendingImport) return;
    const dupe = vault.vcs.some(
      v => v.proof.S === pendingImport.vc.proof.S && v.proof.R8x === pendingImport.vc.proof.R8x,
    );
    if (!dupe) await persist({ ...vault, vcs: [...vault.vcs, pendingImport.vc] });
    setPendingImport(null);
    clearFragment();
    notification.success(
      dupe ? "That exact credential is already in your wallet" : "Stored — encrypted under your wallet key",
    );
  };

  const rejectImport = () => {
    setPendingImport(null);
    clearFragment();
  };

  const removeVC = async (i: number) => {
    if (!vault) return;
    await persist({ ...vault, vcs: vault.vcs.filter((_, j) => j !== i) });
  };

  const exportVC = (vc: ActaVerifiableCredential) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(vc, null, 2)], { type: "application/json" }));
    a.download = "acta-credential.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ------------------------------------------------------------- chain state
  const { data: anchorEvents } = useScaffoldEventHistory({
    contractName: "CredentialAnchor",
    eventName: "CommitmentAnchored",
    fromBlock,
    watch: true,
  });
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
  const anchoredAnywhere = useCallback(
    (commitment: bigint) => (anchorEvents ?? []).some(e => (e.args.commitment as bigint) === commitment),
    [anchorEvents],
  );

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

  // ------------------------------------------------------------ present flow
  const [presentPolicyId, setPresentPolicyId] = useState<bigint | null>(null);
  const [presentVcIndex, setPresentVcIndex] = useState<number | null>(null);
  useEffect(() => {
    if (requestPolicyId !== null) setPresentPolicyId(requestPolicyId);
  }, [requestPolicyId]);

  const { data: policy } = useScaffoldReadContract({
    contractName: "PolicyRegistry",
    functionName: "getPolicy",
    args: [presentPolicyId ?? undefined],
  });
  const program: CompiledProgram | null = useMemo(
    () =>
      policy
        ? {
            predicates: policy.predClaimRef.map((c: bigint, i: number) => ({
              claimRef: c,
              op: policy.predOp[i],
              compareValue: policy.predValue[i],
            })),
            tokens: policy.tokType.map((t: bigint, i: number) => ({ type: t, arg: policy.tokArg[i] })),
          }
        : null,
    [policy],
  );

  /** Why a stored credential can(not) answer this policy — shown, not hidden.
   * Plain (unmemoized) computation: N is tiny and React Compiler handles caching. */
  const fitness = (vc: ActaVerifiableCredential): { cred: Credential; ok: boolean; why: string } => {
    const { cred, sigOk } = vcToCredential(vc);
    if (!sigOk) return { cred, ok: false, why: "issuer signature does not verify" };
    if (!policy || !program) return { cred, ok: false, why: "policy not loaded yet" };
    if (cred.issuerPubKeyHash !== policy.issuerKeyHash)
      return { cred, ok: false, why: "issued by a different key than the policy trusts" };
    if (myCommitment !== null && cred.holderCommitment !== myCommitment)
      return { cred, ok: false, why: "bound to a different agent identity than this wallet holds" };
    if (!evaluateProgram(program, cred.claims)) return { cred, ok: false, why: "claims do not satisfy the policy" };
    if (!leavesFor(policy.issuer).includes(cred.holderCommitment))
      return { cred, ok: false, why: "not anchored in the policy issuer's on-chain tree" };
    return { cred, ok: true, why: "" };
  };

  const chosen = (() => {
    if (!vault || presentPolicyId === null) return null;
    if (presentVcIndex !== null && vault.vcs[presentVcIndex]) {
      return { index: presentVcIndex, ...fitness(vault.vcs[presentVcIndex]) };
    }
    for (let i = 0; i < vault.vcs.length; i++) {
      const f = fitness(vault.vcs[i]);
      if (f.ok) return { index: i, ...f };
    }
    return null;
  })();

  const chosenClaims =
    chosen && vault
      ? Object.entries(vault.vcs[chosen.index].credentialSubject)
          .filter(([k]) => k !== "id")
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : null;

  const [stage, setStage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    policyId: bigint;
    call: ProofCalldata;
    txHash: string | null;
    ms: number;
  } | null>(null);
  const { writeContractAsync: writeVerifier } = useScaffoldWriteContract({ contractName: "PredicateVerifier" });

  const approveAndPresent = async () => {
    if (!vault || !policy || !program || !chosen?.ok || presentPolicyId === null || !predicateVerifier) return;
    setStage("building witness…");
    setReceipt(null);
    try {
      const input = await buildWitnessInput({
        masterSecret: BigInt(vault.masterSecret),
        cred: chosen.cred,
        program,
        anchorLeaves: leavesFor(policy.issuer),
        predicateHash: policy.predicateHash,
        contextHash: contextHashFor(predicateVerifier.address, presentPolicyId),
        sessionNonce: randomFieldElement() % (1n << 64n),
      });
      const { call, ms } = await proveInBrowser(input, setStage);
      setStage("presenting on-chain…");
      const txHash = await writeVerifier({
        functionName: "verifyPresentation",
        args: [presentPolicyId, call.a, call.b, call.c, call.signals as any],
      });
      setReceipt({ policyId: presentPolicyId, call, txHash: txHash ?? null, ms });
      setRequestPolicyId(null);
      clearFragment();
      notification.success("Presented — the chain learned only that the policy holds");
    } catch (e) {
      notification.error(getParsedError(e));
    } finally {
      setStage(null);
    }
  };

  const closePresent = () => {
    setPresentPolicyId(null);
    setPresentVcIndex(null);
    setReceipt(null);
    setRequestPolicyId(null);
    clearFragment();
  };

  // ---------------------------------------------------------------------- UI
  return (
    <div className="flex flex-col items-center px-4 py-8 gap-6">
      <div className="text-center max-w-2xl">
        <h1 className="text-3xl font-bold">Your credential wallet</h1>
        <p className="text-sm opacity-70 mt-2">
          Credentials live here, encrypted under a key only your wallet&apos;s signature can derive. They arrive from
          issuers as links, and leave only as zero-knowledge proofs you approve.
        </p>
      </div>

      {/* IMPORT CONSENT — renders even locked; storing requires unlock */}
      {pendingImport && (
        <div className="card bg-base-100 shadow-xl w-full max-w-2xl border-t-4 border-primary">
          <div className="card-body gap-3">
            {"error" in pendingImport ? (
              <>
                <h2 className="card-title text-base">Credential offer — unreadable</h2>
                <p className="text-sm grow-0">{pendingImport.error}</p>
                <button className="btn btn-outline btn-sm w-fit" onClick={rejectImport}>
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <h2 className="card-title text-base">An issuer is handing you a credential</h2>
                <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-1">
                  <Row k="issuer key hash" v={short(pendingImport.cred.issuerPubKeyHash)} />
                  {Object.entries(pendingImport.vc.credentialSubject)
                    .filter(([k]) => k !== "id")
                    .map(([k, v]) => (
                      <Row key={k} k={k} v={v} />
                    ))}
                  <Row
                    k="issuer signature"
                    v={pendingImport.sigOk ? "✓ verifies (EdDSA-BabyJubJub)" : "✗ DOES NOT VERIFY"}
                  />
                  {myCommitment !== null && pendingImport.cred.holderCommitment !== myCommitment && (
                    <Row k="⚠ identity" v="bound to a different agent identity than this wallet holds" />
                  )}
                </div>
                <p className="text-xs opacity-60 grow-0">
                  This credential traveled inside the link&apos;s #fragment — it never touched a server.
                </p>
                <div className="flex gap-2">
                  {unlocked ? (
                    <button className="btn btn-primary btn-sm" onClick={acceptImport} disabled={!pendingImport.sigOk}>
                      Accept &amp; store encrypted
                    </button>
                  ) : (
                    <span className="text-sm self-center opacity-70">unlock below to store it</span>
                  )}
                  <button className="btn btn-outline btn-sm" onClick={rejectImport}>
                    Reject
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* LOCK / UNLOCK */}
      {!unlocked && (
        <div className="card bg-base-100 shadow-xl w-full max-w-2xl">
          <div className="card-body gap-3 items-center text-center">
            <h2 className="card-title text-base">🔒 Locked</h2>
            <p className="text-sm opacity-70 grow-0 max-w-md">
              Sign one message to derive this device&apos;s encryption key. No transaction, no cost, no account — the
              signature itself is the key, so only your wallet can open the vault.
            </p>
            {guardTx(
              <button className="btn btn-primary" onClick={unlock} disabled={unlockBusy}>
                {unlockBusy ? <span className="loading loading-spinner loading-xs" /> : null}
                Unlock with wallet signature
              </button>,
            )}
          </div>
        </div>
      )}

      {/* CREDENTIALS */}
      {unlocked && vault && (
        <div className="w-full max-w-2xl flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm opacity-70">
              {vault.vcs.length === 0
                ? "no credentials yet"
                : `${vault.vcs.length} credential${vault.vcs.length > 1 ? "s" : ""}`}{" "}
              · agent identity {short(myCommitment ?? "")}
            </span>
            <button className="btn btn-ghost btn-xs" onClick={() => (setVault(null), setVaultKey(null))}>
              lock
            </button>
          </div>

          {vault.vcs.length === 0 && (
            <div className="card bg-base-100 shadow-xl">
              <div className="card-body items-center text-center gap-2">
                <p className="text-sm opacity-70 grow-0">
                  A credential is a signed statement about you that only ever leaves this wallet as a proof.
                </p>
                <Link href="/demo" className="btn btn-outline btn-sm">
                  Get one from the demo issuer →
                </Link>
              </div>
            </div>
          )}

          {vault.vcs.map((vc, i) => {
            const { cred, sigOk } = vcToCredential(vc);
            return (
              <div key={i} className="card bg-base-100 shadow-xl border-t-4 border-accent">
                <div className="card-body gap-2">
                  <h2 className="card-title text-base">AgentCapabilityCredential</h2>
                  <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-1">
                    {Object.entries(vc.credentialSubject)
                      .filter(([k]) => k !== "id")
                      .map(([k, v]) => (
                        <Row key={k} k={k} v={v} />
                      ))}
                    <Row k="issuer key hash" v={short(cred.issuerPubKeyHash)} />
                    <Row k="signature" v={sigOk ? "✓ verifies" : "✗ broken"} />
                    <Row
                      k="on-chain anchor"
                      v={anchoredAnywhere(cred.holderCommitment) ? "✓ commitment anchored" : "not anchored yet"}
                    />
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setPresentVcIndex(i);
                        setPresentPolicyId(prev => prev ?? (policyIds.length ? policyIds[policyIds.length - 1] : null));
                        setReceipt(null);
                      }}
                      disabled={policyIds.length === 0}
                    >
                      Present…
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => exportVC(vc)}>
                      Export JSON
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeVC(i)}>
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* PRESENT SHEET — the consent moment */}
      {presentPolicyId !== null && (
        <div className="card bg-base-100 shadow-xl w-full max-w-2xl border-t-4 border-secondary">
          <div className="card-body gap-3">
            <h2 className="card-title text-base">
              {requestPolicyId !== null ? "A verifier requests a proof" : "Present a proof"}
            </h2>
            <label className="form-control">
              <span className="label-text">against policy</span>
              <select
                className="select select-bordered select-sm"
                value={presentPolicyId.toString()}
                onChange={e => setPresentPolicyId(BigInt(e.target.value))}
              >
                {policyIds.map(id => (
                  <option key={id.toString()} value={id.toString()}>
                    policy #{id.toString()}
                  </option>
                ))}
              </select>
            </label>

            {policy && program ? (
              <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-2">
                <span className="text-xs font-semibold opacity-70">
                  THIS PROOF WILL SHOW (read back from the chain)
                </span>
                <span className="font-mono text-sm">{describeProgram(program)}</span>
                {policy.sanctionsRoot !== 0n && (
                  <span className="text-xs opacity-70">plus: jurisdiction is not on the pinned sanctions list</span>
                )}
                <span className="text-xs font-semibold opacity-70 mt-1">IT WILL NOT REVEAL</span>
                <span className="text-xs opacity-70">
                  your actual values{chosenClaims ? ` (${chosenClaims})` : ""}, which anchored commitment is yours, or
                  your master secret. The chain sees one bit — policy satisfied — plus a one-time nullifier.
                </span>
              </div>
            ) : (
              <p className="text-sm opacity-60">loading policy from chain…</p>
            )}

            {vault && chosen && !chosen.ok && (
              <div className="alert alert-warning py-2 text-sm">
                <span>can&apos;t present: {chosen.why}</span>
              </div>
            )}
            {vault && !chosen && (
              <div className="alert alert-warning py-2 text-sm">
                <span>no credential in this wallet satisfies policy #{presentPolicyId.toString()}</span>
              </div>
            )}
            {!unlocked && <p className="text-sm opacity-70">unlock above to approve</p>}

            {stage && <p className="text-xs font-mono opacity-70">{stage}</p>}

            {receipt ? (
              <div className="bg-base-200 rounded-lg p-3 flex flex-col gap-1">
                <Row k={`policy #${receipt.policyId.toString()}`} v="satisfied — PresentationAccepted" />
                <Row k="nullifier" v={`${short(receipt.call.signals[0])} — spent, replays revert`} />
                <Row k="proved in" v={`${receipt.ms}ms, in this tab`} />
                {receipt.txHash && (
                  <a
                    className="link text-sm"
                    href={getBlockExplorerTxLink(targetNetwork.id, receipt.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open the transaction on {targetNetwork.blockExplorers?.default?.name ?? "the block explorer"}
                  </a>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                {unlocked &&
                  guardTx(
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={approveAndPresent}
                      disabled={!chosen?.ok || !!stage}
                    >
                      {stage ? <span className="loading loading-spinner loading-xs" /> : null}
                      Approve — prove &amp; present
                    </button>,
                  )}
                <button className="btn btn-outline btn-sm" onClick={closePresent}>
                  {receipt ? "Close" : "Decline"}
                </button>
              </div>
            )}
            {receipt && (
              <button className="btn btn-outline btn-sm w-fit" onClick={closePresent}>
                Close
              </button>
            )}
          </div>
        </div>
      )}

      <p className="text-xs opacity-50 max-w-2xl text-center">
        v1 honesty: works with normal (EOA) wallets only — smart-account signatures aren&apos;t deterministic, so they
        can&apos;t re-derive the key. The{" "}
        <Link href="/demo" className="link">
          demo page
        </Link>{" "}
        shares this browser&apos;s agent identity, which v1 still mirrors unencrypted for that page; the encrypted vault
        becomes its only home when the demo moves fully onto the wallet.
      </p>
    </div>
  );
};

export default WalletPage;
