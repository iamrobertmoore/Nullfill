// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Nullfill} from "../src/Nullfill.sol";
import {RobinhoodChain} from "../src/RobinhoodChain.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Fork test
/// @notice Re-reads every address in `RobinhoodChain` from a live chain and fails if any of them has
///         moved.
///
/// @dev The registry holds hand-written decimals. A hand-written figure is a claim, and this is the
///      thing that holds it to account. Run it before trusting a decimal count, and after any token
///      upgrade:
///
///        FOUNDRY_PROFILE=fork ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com \
///          forge test --match-path test/Fork.t.sol -vv
///
///      The `fork` profile raises the EVM version to Cancun, and it is required rather than optional.
///      The live tokens were compiled with PUSH0, and the entry's own deployment target of Paris
///      refuses that instruction. Without the profile every call to a real token fails with
///      `EvmError: NotActivated`, which reads like a broken test rather than an EVM setting.
///
///      Without `ROBINHOOD_RPC` set, every test here reports as **skipped**, not passed. That
///      distinction is deliberate. A network check that quietly reports success when it did not run
///      is worse than no check at all, because it reads as evidence.
///
///      Last run: 28 September 2026, all three passing, against Robinhood Chain testnet.
contract ForkTest is Test {
    /// @dev The live deployment on Robinhood Chain testnet, deployed 16 September 2026.
    address internal constant NULLFILL = 0x71029fac49E9b45CCC377812aEc01509FFD383A1;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function _requireFork() internal {
        if (!forked) {
            vm.skip(true);
        }
    }

    function test_Fork_UsdgMetadataMatchesWhatTheRegistryClaims() public {
        _requireFork();

        IERC20Metadata token = IERC20Metadata(address(RobinhoodChain.usdg()));

        assertEq(token.name(), "Global Dollar", "name");
        assertEq(token.symbol(), "USDG", "symbol");
        assertEq(
            token.decimals(),
            6,
            "USDG is six decimals. Every amount in this project assumes it, and split6() hardcodes it"
        );
    }

    function test_Fork_EveryRegistryEquityStillMatches() public {
        _requireFork();

        RobinhoodChain.Asset[] memory list = RobinhoodChain.equities(block.chainid);
        assertGt(list.length, 0, "nothing to check on this chain");

        for (uint256 i = 0; i < list.length; ++i) {
            IERC20Metadata token = IERC20Metadata(list[i].token);
            assertEq(
                token.symbol(),
                RobinhoodChain.symbolString(list[i].symbol),
                "ticker moved"
            );
            assertEq(token.decimals(), list[i].decimals, "decimals moved");
        }
    }

    /// The entry's own deployment, checked the same way a reviewer would: read it back off the chain
    /// rather than trusting the broadcast log.
    function test_Fork_TheDeployedContractIsStillThereAndStillSaysTwentyFourHours() public {
        _requireFork();

        if (block.chainid != RobinhoodChain.TESTNET) {
            vm.skip(true);
        }

        assertGt(NULLFILL.code.length, 0, "no runtime code at the recorded address");

        Nullfill deployed = Nullfill(NULLFILL);
        assertEq(deployed.FORCE_INCLUSION_WINDOW(), 24 hours, "the window is still a day");
        assertEq(
            uint256(deployed.statusOf(keccak256("never-opened"))),
            uint256(Nullfill.Status.None),
            "the mapping is reachable and an unknown reference is None"
        );
    }
}
