// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ICircuitVerifier} from "./interfaces/ICircuitVerifier.sol";
import {Groth16Verifier} from "./generated/Groth16Verifier.sol";

/// @notice ICircuitVerifier backend for the ActaPresentation v1 Groth16
/// circuit. Thin adapter over the snarkjs-generated verifier (which already
/// checks every public signal < r; PredicateVerifier re-checks as defense in
/// depth). Fail-closed by construction: any deviation returns false.
contract Groth16CircuitVerifier is ICircuitVerifier {
    Groth16Verifier public immutable inner;

    constructor() {
        inner = new Groth16Verifier();
    }

    function verify(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata publicSignals
    ) external view returns (bool) {
        return inner.verifyProof(a, b, c, publicSignals);
    }
}
