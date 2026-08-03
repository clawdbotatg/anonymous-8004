// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice ACTA's proof-system abstraction (per the ACTA proposal): policies
/// pin a verifier implementation at registration; SNARK/STARK/zkVM backends
/// are swappable per policy, never per deployed policy (immutability rule).
/// v1 fixes the public-signal layout at 8:
/// [nullifier, issuerKeyHash, anchorRoot, sanctionsRoot, predicateHash,
///  contextHash, currentTime, sessionNonce]
interface ICircuitVerifier {
    function verify(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata publicSignals
    ) external view returns (bool);
}
