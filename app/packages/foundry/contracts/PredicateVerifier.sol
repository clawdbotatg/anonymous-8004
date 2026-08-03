// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICircuitVerifier} from "./interfaces/ICircuitVerifier.sol";
import {PolicyRegistry} from "./PolicyRegistry.sol";
import {CredentialAnchor} from "./CredentialAnchor.sol";
import {NullifierRegistry} from "./NullifierRegistry.sol";

/// @title PredicateVerifier — per-presentation verification against a policy.
/// @notice The 10-step verification sequence (kept from the author's design,
/// re-typed): policy → window → predicate hash → issuer → sanctions root →
/// anchor root → freshness → context → field bounds → proof → nullifier →
/// event. Emits only (policyId, nullifier, expiry) — no agent identity, no
/// attribute values, no wallet address (the ACTA privacy contract).
contract PredicateVerifier {
    /// BN254 scalar field modulus; all signals must be canonical (< R).
    uint256 public constant R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// Max allowed drift between the proof's currentTime signal and block time.
    uint256 public constant MAX_TIME_DRIFT = 1 hours;
    /// Domain separator for context hashes.
    bytes32 public constant CONTEXT_DOMAIN = keccak256("ACTA_CONTEXT_V1");

    PolicyRegistry public immutable policies;
    CredentialAnchor public immutable anchor;
    NullifierRegistry public immutable nullifiers;

    event PresentationAccepted(uint256 indexed policyId, uint256 nullifier, uint64 expiryTimestamp);

    error PolicyNotActive();
    error PredicateHashMismatch();
    error IssuerMismatch();
    error SanctionsRootMismatch();
    error UnknownAnchorRoot();
    error StaleTimestamp();
    error ContextMismatch();
    error SignalOutOfField();
    error InvalidProof();

    constructor(PolicyRegistry _policies, CredentialAnchor _anchor, NullifierRegistry _nullifiers) {
        policies = _policies;
        anchor = _anchor;
        nullifiers = _nullifiers;
    }

    /// @notice The context every presentation for (this verifier, policyId) is
    /// scoped to. One nullifier per (masterSecret, context): present once per
    /// policy. Epoch rotation is a v2 knob (kept out of v1 deliberately).
    function contextHash(uint256 policyId) public view returns (uint256) {
        return uint256(keccak256(abi.encode(CONTEXT_DOMAIN, address(this), policyId))) % R;
    }

    /// @param signals [nullifier, issuerKeyHash, anchorRoot, sanctionsRoot,
    ///                 predicateHash, contextHash, currentTime, sessionNonce]
    function verifyPresentation(
        uint256 policyId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata signals
    ) external returns (uint256 nullifier) {
        PolicyRegistry.Policy memory p = policies.getPolicy(policyId); // 1. exists

        // 2. validity window
        if (block.timestamp < p.validFrom || (p.validUntil != 0 && block.timestamp > p.validUntil)) {
            revert PolicyNotActive();
        }
        // 3. field bounds, defense in depth vs input aliasing (CVE-2023-33252 class)
        for (uint256 i = 0; i < 8; i++) {
            if (signals[i] >= R) revert SignalOutOfField();
        }
        // 4. policy bindings
        if (signals[4] != p.predicateHash) revert PredicateHashMismatch();
        if (signals[1] != p.issuerKeyHash) revert IssuerMismatch();
        if (signals[3] != p.sanctionsRoot) revert SanctionsRootMismatch();
        // 5. anonymity-set root known for the policy's issuer
        if (!anchor.isKnownRoot(p.issuer, signals[2])) revert UnknownAnchorRoot();
        // 6. freshness of the in-circuit expiry check
        uint256 t = signals[6];
        if (t > block.timestamp + MAX_TIME_DRIFT || t + MAX_TIME_DRIFT < block.timestamp) {
            revert StaleTimestamp();
        }
        // 7. context binding (nullifier scope)
        if (signals[5] != contextHash(policyId)) revert ContextMismatch();
        // 8. the proof itself, via the policy's immutable verifier
        if (!ICircuitVerifier(p.circuitVerifier).verify(a, b, c, signals)) revert InvalidProof();
        // 9. nullifier registration (reverts NullifierAlreadyUsed on replay)
        nullifier = signals[0];
        nullifiers.register(policyId, nullifier);
        // 10. the only thing the chain learns
        emit PresentationAccepted(policyId, nullifier, p.validUntil);
    }
}
