// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Nullfill} from "../src/Nullfill.sol";

/// @notice Deploys Nullfill to whichever chain the RPC points at.
///
/// Robinhood Chain testnet:
///   forge script script/Deploy.s.sol:DeployNullfill \
///     --rpc-url https://rpc.testnet.chain.robinhood.com \
///     --private-key $PRIVATE_KEY --broadcast
///
/// The contract takes no constructor arguments and has no owner, so a deployment is just the
/// bytecode. There is nothing to configure afterwards and nothing to hand over.
contract DeployNullfill is Script {
    function run() external returns (Nullfill nullfill) {
        vm.startBroadcast();
        nullfill = new Nullfill();
        vm.stopBroadcast();

        console.log("Nullfill deployed at", address(nullfill));
        console.log("Force inclusion window, seconds:", nullfill.FORCE_INCLUSION_WINDOW());
    }
}
