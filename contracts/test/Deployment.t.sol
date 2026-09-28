// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @title Deployment test
/// @notice Asserts that the bytecode at the recorded address is the bytecode this repository compiles
///         to.
///
/// @dev This file exists because that check was missed. The contract gained an exact-transfer guard
///      after the first deployment, so the deployed code was 4476 bytes and the source compiled to
///      4801. Nothing announced it. The address still answered, `cast call` still returned the right
///      values, the explorer still showed a contract, and every document still pointed at it. A
///      reviewer who builds the source and compares it to the chain finds a mismatch in about a
///      minute, and a repository that does not match its own deployment is worse than a contract
///      missing one hardening.
///
///      The source was restored to the deployed version rather than the contract being redeployed,
///      because the contract was frozen for the last week of the buildathon. The guard is held for the
///      next deployment, and `test/RobinhoodChain.t.sol` pins the limitation down in the meantime.
///
///      So the check is now a test rather than a habit.
///
///      **Run it under the default profile, not the fork profile.**
///
///        ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com \
///          forge test --match-path test/Deployment.t.sol
///
///      The default profile is the one the contract is deployed with. Running it under `fork` would
///      compile this source for Cancun and compare Cancun bytecode against a Paris deployment, which
///      fails for a reason that has nothing to do with the deployment being stale.
///
///      This file only reads code, it never executes a deployed contract, so it does not hit the
///      `EvmError: NotActivated` problem that `Fork.t.sol` hits when it calls a live token. That is
///      why it can run under Paris at all.
contract DeploymentTest is Test {
    /// @dev The live deployment. This constant is deliberately hardcoded: a check that reads the
    ///      address from the same place the documents do cannot catch the documents being wrong.
    address internal constant NULLFILL = 0x71029fac49E9b45CCC377812aEc01509FFD383A1;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function test_Deployment_BytecodeMatchesThisSource() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        bytes memory onChain = NULLFILL.code;
        bytes memory built = vm.getDeployedCode("Nullfill.sol:Nullfill");

        assertGt(onChain.length, 0, "nothing is deployed at the recorded address");

        if (keccak256(onChain) != keccak256(built)) {
            emit log_named_uint("deployed bytes", onChain.length);
            emit log_named_uint("source compiles to", built.length);
            emit log("The repository does not match its own deployment. Either redeploy the");
            emit log("contract from this source, or revert the change the deployment predates.");
        }

        assertEq(
            keccak256(onChain),
            keccak256(built),
            "the deployed bytecode is not what this source compiles to"
        );
    }

    /// A control. If the deployment is missing entirely, the check above would pass trivially on two
    /// empty byte strings, so this asserts the source side is non-empty as well.
    function test_Deployment_TheSourceBuildIsNotEmpty() public view {
        bytes memory built = vm.getDeployedCode("Nullfill.sol:Nullfill");
        assertGt(built.length, 1000, "the local build produced nothing usable");
    }
}
