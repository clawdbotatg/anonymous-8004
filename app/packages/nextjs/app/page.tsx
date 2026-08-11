"use client";

import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import Link from "next/link";
import { BeakerIcon, CpuChipIcon, EyeSlashIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import deployedContracts from "~~/contracts/deployedContracts";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

const CONTRACT_BLURBS: Record<string, string> = {
  PoseidonT3: "Poseidon hash library backing the anchor tree",
  PredicateVerifier: "entry point — verifies a presentation, records the nullifier, emits the acceptance",
  Groth16CircuitVerifier: "auto-generated verifier for the 45,438-constraint ACTA circuit",
  CredentialAnchor: "per-issuer LeanIMT of credential commitments (the anonymity set)",
  PolicyRegistry: "immutable predicate policies — the full compiled program lives on-chain",
  NullifierRegistry: "one presentation per agent per context, forever",
};

const Home: NextPage = () => {
  const { targetNetwork } = useTargetNetwork();
  const chainContracts = (deployedContracts as Record<number, Record<string, { address: string }>>)[targetNetwork.id];

  return (
    <div className="flex items-center flex-col grow pt-12">
      <div className="px-5 text-center max-w-3xl">
        <h1 className="text-5xl font-bold">ACTA</h1>
        <p className="text-xl mt-3 mb-1 font-medium">Anonymous Credentials for Trustless Agents</p>
        <p className="text-base opacity-70">
          A zero-knowledge privacy layer for{" "}
          <a href="https://eips.ethereum.org/EIPS/eip-8004" target="_blank" rel="noreferrer" className="link">
            ERC-8004
          </a>
          : an AI agent proves <i>“a real auditor scored me ≥ 80 and I’m not sanctioned”</i> without revealing its
          score, jurisdiction, identity, or history. The chain learns only that the policy holds — plus an unlinkable
          nullifier that blocks replays.
        </p>
        <div className="flex justify-center gap-3 mt-6">
          <Link href="/demo" passHref className="btn btn-primary">
            Launch the demo
          </Link>
          <a
            href="https://github.com/clawdbotatg/anonymous-8004"
            target="_blank"
            rel="noreferrer"
            className="btn btn-outline"
          >
            Read the source
          </a>
        </div>
      </div>

      <div className="grow bg-base-300 w-full mt-14 px-8 py-12">
        <div className="flex justify-center items-stretch gap-8 flex-col md:flex-row max-w-6xl mx-auto">
          <div className="flex flex-col bg-base-100 border border-base-300 px-8 py-8 text-center items-center flex-1 rounded-xl">
            <EyeSlashIcon className="h-8 w-8" />
            <h3 className="font-bold mt-2">Prove, don’t reveal</h3>
            <p className="text-sm">
              Predicate policies compile to an on-chain program: score thresholds, sanctions exclusion via SMT
              non-membership, issuer pinning. Satisfying claims stay in the agent’s hands.
            </p>
          </div>
          <div className="flex flex-col bg-base-100 border border-base-300 px-8 py-8 text-center items-center flex-1 rounded-xl">
            <CpuChipIcon className="h-8 w-8" />
            <h3 className="font-bold mt-2">Proving happens in your browser</h3>
            <p className="text-sm">
              Real Groth16 proofs — 45,438 constraints in roughly a second — generated in the tab. The master secret,
              the claims, and the merkle path never leave your machine.
            </p>
          </div>
          <div className="flex flex-col bg-base-100 border border-base-300 px-8 py-8 text-center items-center flex-1 rounded-xl">
            <LockClosedIcon className="h-8 w-8" />
            <h3 className="font-bold mt-2">Nothing to trust on-chain</h3>
            <p className="text-sm">
              Five immutable, ownerless contracts on {targetNetwork.name}, source verified on the block explorer. No
              admin keys, no upgrades, no pause switch — anyone can call them directly.
            </p>
          </div>
        </div>

        <div className="max-w-3xl mx-auto mt-10 bg-base-100 border border-base-300 rounded-xl px-8 py-6">
          <h3 className="font-bold text-lg mb-3">Deployed on {targetNetwork.name}</h3>
          <div className="flex flex-col gap-2">
            {Object.entries(chainContracts ?? {}).map(([name, { address }]) => (
              <div key={name} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <div>
                  <span className="font-mono font-semibold text-sm">{name}</span>
                  <span className="text-xs opacity-60 block sm:inline sm:ml-2">{CONTRACT_BLURBS[name] ?? ""}</span>
                </div>
                <Address address={address} chain={targetNetwork} size="sm" />
              </div>
            ))}
          </div>
          <p className="text-xs opacity-60 mt-4 flex items-center gap-1">
            <BeakerIcon className="h-4 w-4 inline" />
            Research reference implementation of{" "}
            <a
              href="https://ethresear.ch/t/anonymous-credentials-for-trustless-agents-acta/24797"
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              the ACTA proposal
            </a>
            — the circuit uses a dev trusted setup, not a production ceremony. Poke at the raw contracts in the{" "}
            <Link href="/debug" passHref className="link">
              Debug tab
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
};

export default Home;
