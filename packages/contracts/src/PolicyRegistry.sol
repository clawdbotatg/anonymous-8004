// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title PolicyRegistry — verifier-registered predicate policies.
/// @notice Standalone (the ACTA post names IPolicyRegistry as its own
/// component; the author's PoC folded it into the verifier — we don't).
/// Policies are IMMUTABLE once registered, including their circuit verifier
/// address (audit pitfall 19: an owner must never be able to retroactively
/// change what a policy means). The full compiled predicate program is stored
/// on-chain so anyone can audit what a policy demands (the "over-asking
/// auditor" of demo C reads exactly this).
contract PolicyRegistry {
    struct Policy {
        // proof binding
        uint256 predicateHash;   // ACTA predicateProgramHash v1
        uint256 issuerKeyHash;   // Poseidon(Ax, Ay) of the trusted issuer key
        address issuer;          // anchor-tree owner in CredentialAnchor
        uint256 sanctionsRoot;   // SMT root the presentation must exclude against (0 = empty tree)
        address circuitVerifier; // ICircuitVerifier, immutable per policy
        // validity
        uint64 validFrom;
        uint64 validUntil;       // 0 = no expiry
        // transparency: the compiled program (preimage of predicateHash)
        uint256[4] predClaimRef;
        uint256[4] predOp;
        uint256[4] predValue;
        uint256[16] tokType;
        uint256[16] tokArg;
        // metadata
        address registrant;
        string uri; // human-readable policy description
    }

    Policy[] private _policies;

    event PolicyRegistered(
        uint256 indexed policyId,
        address indexed registrant,
        uint256 predicateHash,
        uint256 issuerKeyHash,
        address circuitVerifier
    );

    error ZeroVerifier();
    error InvalidWindow();
    error UnknownPolicy();

    function registerPolicy(Policy calldata p) external returns (uint256 policyId) {
        if (p.circuitVerifier == address(0)) revert ZeroVerifier();
        if (p.validUntil != 0 && p.validUntil <= p.validFrom) revert InvalidWindow();
        policyId = _policies.length;
        _policies.push(p);
        _policies[policyId].registrant = msg.sender;
        emit PolicyRegistered(policyId, msg.sender, p.predicateHash, p.issuerKeyHash, p.circuitVerifier);
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        if (policyId >= _policies.length) revert UnknownPolicy();
        return _policies[policyId];
    }

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }
}
