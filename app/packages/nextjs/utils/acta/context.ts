/**
 * Context hash derivation — shared by /demo and /wallet so the two pages can
 * never drift on what a nullifier context is. Must mirror the on-chain
 * derivation in PredicateVerifier (ACTA_CONTEXT_V1 domain).
 */
import { FIELD_MODULUS } from "./actaSdk";
import { encodeAbiParameters, keccak256, toBytes } from "viem";

export const CONTEXT_DOMAIN = keccak256(toBytes("ACTA_CONTEXT_V1"));

export function contextHashFor(verifierAddress: string, policyId: bigint): bigint {
  return (
    BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
          [CONTEXT_DOMAIN, verifierAddress as `0x${string}`, policyId],
        ),
      ),
    ) % FIELD_MODULUS
  );
}
