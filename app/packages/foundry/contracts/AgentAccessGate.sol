// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {PredicateVerifier} from "./PredicateVerifier.sol";

/// @title AgentAccessGate — demo consumer contract.
/// @notice The protocol-side gate from the ACTA post's step 10: an agent
/// enters by presenting a proof; access is granted to the nullifier on first
/// use; a replay reverts (NullifierAlreadyUsed surfaces from the registry,
/// step 9 of verifyPresentation). The gate never learns who entered.
contract AgentAccessGate {
    PredicateVerifier public immutable verifier;
    uint256 public immutable policyId;

    mapping(uint256 nullifier => uint64 enteredAt) public entered;

    event AccessGranted(uint256 nullifier);

    constructor(PredicateVerifier _verifier, uint256 _policyId) {
        verifier = _verifier;
        policyId = _policyId;
    }

    function enter(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata signals
    ) external returns (uint256 nullifier) {
        nullifier = verifier.verifyPresentation(policyId, a, b, c, signals);
        entered[nullifier] = uint64(block.timestamp);
        emit AccessGranted(nullifier);
    }
}
