// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./DeployHelpers.s.sol";
import { CredentialAnchor } from "../contracts/CredentialAnchor.sol";
import { PolicyRegistry } from "../contracts/PolicyRegistry.sol";
import { NullifierRegistry } from "../contracts/NullifierRegistry.sol";
import { PredicateVerifier } from "../contracts/PredicateVerifier.sol";
import { Groth16CircuitVerifier } from "../contracts/Groth16CircuitVerifier.sol";

/**
 * @notice Deploys the full ACTA stack (PoseidonT3 is auto-deployed/linked by
 * forge as CredentialAnchor's library dependency).
 * yarn deploy --file DeployActa.s.sol            # local anvil
 * yarn deploy --file DeployActa.s.sol --network base  # Base mainnet (keystore)
 */
contract DeployActa is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        CredentialAnchor anchor = new CredentialAnchor();
        PolicyRegistry policies = new PolicyRegistry();
        NullifierRegistry nullifiers = new NullifierRegistry();
        Groth16CircuitVerifier g16 = new Groth16CircuitVerifier();
        PredicateVerifier verifier = new PredicateVerifier(policies, anchor, nullifiers);
        nullifiers.setVerifier(address(verifier));

        deployments.push(Deployment("CredentialAnchor", address(anchor)));
        deployments.push(Deployment("PolicyRegistry", address(policies)));
        deployments.push(Deployment("NullifierRegistry", address(nullifiers)));
        deployments.push(Deployment("Groth16CircuitVerifier", address(g16)));
        deployments.push(Deployment("PredicateVerifier", address(verifier)));
    }
}
