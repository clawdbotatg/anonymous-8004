// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title NullifierRegistry — policy-scoped nullifier store.
/// @notice Nullifiers are scoped per policy (a weak-policy nullifier can never
/// unlock a strict gate — the author's `isAcceptedForPolicy` design, kept).
/// Registration is restricted to the PredicateVerifier, wired once; a used
/// nullifier can never be re-registered (including after policy expiry).
contract NullifierRegistry {
    address public verifier;
    address private immutable _deployer;

    mapping(uint256 policyId => mapping(uint256 nullifier => uint64 usedAt)) private _used;

    event NullifierRegistered(uint256 indexed policyId, uint256 nullifier);

    error VerifierAlreadySet();
    error NotDeployer();
    error NotVerifier();
    error NullifierAlreadyUsed();

    constructor() {
        _deployer = msg.sender;
    }

    /// @notice One-shot wiring: set the PredicateVerifier address exactly once.
    function setVerifier(address v) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (verifier != address(0)) revert VerifierAlreadySet();
        verifier = v;
    }

    function register(uint256 policyId, uint256 nullifier) external {
        if (msg.sender != verifier) revert NotVerifier();
        if (_used[policyId][nullifier] != 0) revert NullifierAlreadyUsed();
        _used[policyId][nullifier] = uint64(block.timestamp);
        emit NullifierRegistered(policyId, nullifier);
    }

    function isAcceptedForPolicy(uint256 policyId, uint256 nullifier) external view returns (bool) {
        return _used[policyId][nullifier] != 0;
    }
}
