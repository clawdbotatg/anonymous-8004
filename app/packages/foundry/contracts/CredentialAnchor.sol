// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {InternalLeanIMT, LeanIMTData} from "lean-imt/InternalLeanIMT.sol";

/// @title CredentialAnchor — per-issuer LeanIMT of holder commitments.
/// @notice The anonymity-set accumulator. Issuers append holder commitments
/// (Poseidon(masterSecret), ADR-0003: never an agentId, never an address —
/// nothing address-shaped appears in this ABI beyond msg.sender-as-issuer).
/// Trees are append-only; any historical root of an issuer verifies (the tree
/// only grows, so an old root is a subset anonymity set; revocation is out of
/// scope for v1, as in the ACTA post).
contract CredentialAnchor {
    using InternalLeanIMT for LeanIMTData;

    uint256 public constant MAX_DEPTH = 16; // must match the circuit parameter

    mapping(address issuer => LeanIMTData tree) private _trees;
    mapping(address issuer => mapping(uint256 root => uint256 timestamp)) private _roots;

    event CommitmentAnchored(address indexed issuer, uint256 commitment, uint256 newRoot, uint256 leafIndex);

    error TreeFull();

    /// @notice Anchor a holder commitment into the calling issuer's tree.
    function anchor(uint256 commitment) external returns (uint256 newRoot) {
        if (_trees[msg.sender].size >= (1 << MAX_DEPTH)) revert TreeFull();
        newRoot = _trees[msg.sender]._insert(commitment);
        _roots[msg.sender][newRoot] = block.timestamp;
        emit CommitmentAnchored(msg.sender, commitment, newRoot, _trees[msg.sender].size - 1);
    }

    function isKnownRoot(address issuer, uint256 root) external view returns (bool) {
        return root != 0 && _roots[issuer][root] != 0;
    }

    function currentRoot(address issuer) external view returns (uint256) {
        return _trees[issuer]._root();
    }

    function treeSize(address issuer) external view returns (uint256) {
        return _trees[issuer].size;
    }
}
