// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Nullfill} from "../src/Nullfill.sol";
import {RobinhoodChain} from "../src/RobinhoodChain.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev USDG as it actually behaves: six decimals, not eighteen. The decimal count is the whole
///      reason this file exists. A desk that escrows 2,500 USDG is moving the integer 2500000000, and
///      a rounding step anywhere in that path is a real amount of money. The live contract is at
///      `RobinhoodChain.USDG_TESTNET`; this stand-in mirrors its interface so the arithmetic can be
///      tested without a network. `test/Fork.t.sol` checks the real one.
contract MockUsdg is ERC20 {
    constructor() ERC20("Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A token that keeps one percent of every transfer. No Robinhood Chain asset does this today,
///      and that is exactly why it belongs in the suite: the escrow claims to accept any ERC-20, and
///      this is the token that tests whether that claim is true.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev `RobinhoodChain` is a library, so every call to it is inlined into the caller. That matters
///      for testing the failure cases: an inlined revert happens at the same call depth as the test
///      itself, and `vm.expectRevert` only matches a revert that happens one depth down. Calling
///      `RobinhoodChain.usdg(1)` directly therefore fails with "call didn't revert at a lower depth
///      than cheatcode call depth", which reads like the guard is broken when it is working.
///      This harness puts a real call frame between the test and the library.
contract RegistryHarness {
    function usdg(uint256 chainId) external pure returns (address) {
        return address(RobinhoodChain.usdg(chainId));
    }

    function equities(uint256 chainId) external pure returns (RobinhoodChain.Asset[] memory) {
        return RobinhoodChain.equities(chainId);
    }

    function equity(uint256 chainId, bytes32 symbol)
        external
        pure
        returns (RobinhoodChain.Asset memory)
    {
        return RobinhoodChain.equity(chainId, symbol);
    }
}

/// @dev Cheatcode ordering applies here too: every deadline is computed into a local before it is
///      used as a call argument, because an argument expression that makes an external call consumes
///      the pending `vm.prank`.
contract RobinhoodChainTest is Test {
    Nullfill internal nullfill;
    MockUsdg internal usdg;
    FeeOnTransferToken internal feeToken;
    RegistryHarness internal registry;

    address internal funder = makeAddr("funder");
    address internal beneficiary = makeAddr("beneficiary");
    address internal recovery = makeAddr("recovery");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant REF = keccak256("usdg-trade-0001");

    function setUp() public {
        nullfill = new Nullfill();
        usdg = new MockUsdg();
        feeToken = new FeeOnTransferToken();
        registry = new RegistryHarness();

        usdg.mint(funder, 1_000_000e6);
        feeToken.mint(funder, 1_000_000e6);

        vm.startPrank(funder);
        usdg.approve(address(nullfill), type(uint256).max);
        feeToken.approve(address(nullfill), type(uint256).max);
        vm.stopPrank();
    }

    function _earliestDeadline() internal view returns (uint64) {
        return uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW();
    }

    // -------------------------------------------------------------- registry

    function test_Usdg_ResolvesOnBothRobinhoodChains() public pure {
        assertEq(
            address(RobinhoodChain.usdg(RobinhoodChain.TESTNET)),
            RobinhoodChain.USDG_TESTNET,
            "testnet"
        );
        assertEq(
            address(RobinhoodChain.usdg(RobinhoodChain.MAINNET)),
            RobinhoodChain.USDG_MAINNET,
            "mainnet"
        );
    }

    function test_Usdg_RevertsOnAnUnknownChainRatherThanReturningZero() public {
        vm.expectRevert(abi.encodeWithSelector(RobinhoodChain.UnknownChain.selector, uint256(1)));
        registry.usdg(1);
    }

    function test_IsUsdg_IsChainAgnostic() public pure {
        assertTrue(RobinhoodChain.isUsdg(RobinhoodChain.USDG_TESTNET));
        assertTrue(RobinhoodChain.isUsdg(RobinhoodChain.USDG_MAINNET));
        assertFalse(RobinhoodChain.isUsdg(address(0xdead)));
    }

    function test_Equities_AreDistinctAndAllEighteenDecimals() public pure {
        RobinhoodChain.Asset[] memory list = RobinhoodChain.equities(RobinhoodChain.TESTNET);
        assertEq(list.length, 5, "five verified testnet equities");

        for (uint256 i = 0; i < list.length; ++i) {
            assertEq(list[i].decimals, 18, "equities are 18 decimals, unlike USDG");
            assertTrue(list[i].token != address(0));
            for (uint256 j = i + 1; j < list.length; ++j) {
                assertTrue(list[i].token != list[j].token, "no duplicate addresses");
                assertTrue(list[i].symbol != list[j].symbol, "no duplicate tickers");
            }
        }
    }

    function test_Equity_LooksUpByTickerAndRevertsOnAnUnknownOne() public {
        RobinhoodChain.Asset memory tsla = RobinhoodChain.equity(RobinhoodChain.TESTNET, "TSLA");
        assertEq(tsla.token, 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E);
        assertEq(tsla.decimals, 18);

        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodChain.UnknownSymbol.selector, bytes32("NVDA"))
        );
        registry.equity(RobinhoodChain.TESTNET, "NVDA");
    }

    function test_IsVerified_SeparatesRealContractsFromLookalikes() public pure {
        assertTrue(RobinhoodChain.isVerified(RobinhoodChain.TESTNET, RobinhoodChain.USDG_TESTNET));
        assertTrue(
            RobinhoodChain.isVerified(
                RobinhoodChain.TESTNET, 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E
            )
        );
        assertFalse(
            RobinhoodChain.isVerified(
                RobinhoodChain.TESTNET, 0x000000000000000000000000000000000000dEaD
            )
        );
    }

    /// The escrow is asset agnostic, so the registry has to be the thing that refuses a chain it does
    /// not know. An empty list is a real answer for mainnet: no equities verified there yet.
    function test_Equities_MainnetIsEmptyAndAnUnknownChainReverts() public {
        assertEq(RobinhoodChain.equities(RobinhoodChain.MAINNET).length, 0);

        vm.expectRevert(abi.encodeWithSelector(RobinhoodChain.UnknownChain.selector, uint256(1)));
        registry.equities(1);
    }

    function testFuzz_Split6_IsExactAtEveryMagnitude(uint256 amount) public pure {
        (uint256 whole, uint256 fraction) = RobinhoodChain.split6(amount);
        assertEq(whole * 1e6 + fraction, amount, "no micro-dollar lost in formatting");
        assertLt(fraction, 1e6, "the fraction is always under one dollar");
    }

    /// A `bytes32` ticker is not a string, and the obvious conversion is wrong in a way that looks
    /// right. `abi.encodePacked(bytes32("TSLA"))` is 32 bytes with trailing zeros, so a naive
    /// comparison against a live token's `symbol()` fails while printing two things that look
    /// identical. This is the assertion that catches it.
    function test_SymbolString_StripsThePadding() public pure {
        assertEq(RobinhoodChain.symbolString("TSLA"), "TSLA");
        assertEq(RobinhoodChain.symbolString("AMD"), "AMD");
        assertEq(
            bytes(RobinhoodChain.symbolString("TSLA")).length,
            4,
            "not 32, which is what abi.encodePacked would give"
        );
        assertEq(
            bytes(RobinhoodChain.symbolString(bytes32(0))).length, 0, "an empty symbol is empty"
        );
    }

    function test_SymbolString_RoundTripsEveryRegisteredEquity() public pure {
        RobinhoodChain.Asset[] memory list = RobinhoodChain.equities(RobinhoodChain.TESTNET);
        for (uint256 i = 0; i < list.length; ++i) {
            string memory rendered = RobinhoodChain.symbolString(list[i].symbol);
            bytes memory raw = bytes(rendered);

            assertGt(raw.length, 0, "no empty tickers");
            assertLt(raw.length, 6, "tickers are short");
            for (uint256 j = 0; j < raw.length; ++j) {
                assertTrue(raw[j] >= "A" && raw[j] <= "Z", "uppercase, and no stray padding byte");
            }
        }
    }

    // ---------------------------------------------------- USDG cash leg

    /// A settlement on this chain has two legs: tokenised equity one way, dollars the other. The
    /// dollars are USDG. This is the cash leg, escrowed and released, at USDG's own precision.
    function test_UsdgCashLeg_Settles() public {
        uint64 deadline = _earliestDeadline();
        uint256 amount = 2_500e6; // 2,500 USDG

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(usdg)), amount, deadline, recovery);

        assertEq(usdg.balanceOf(address(nullfill)), amount, "escrow holds 2500 USDG exactly");

        vm.prank(beneficiary);
        nullfill.settle(REF);

        assertEq(usdg.balanceOf(beneficiary), amount, "beneficiary receives 2500 USDG exactly");
        assertEq(usdg.balanceOf(address(nullfill)), 0);
    }

    function test_UsdgCashLeg_UnwindsAfterTheForceInclusionWindow() public {
        uint64 deadline = _earliestDeadline();
        uint256 amount = 1_234.567891e6; // a deliberately awkward six decimal amount

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(usdg)), amount, deadline, recovery);

        vm.warp(deadline);
        vm.prank(stranger);
        nullfill.unwind(REF);

        assertEq(usdg.balanceOf(recovery), amount, "recovered to the micro-dollar");
        assertEq(usdg.balanceOf(address(nullfill)), 0);
    }

    /// The property, stated in one sentence a reader can repeat back:
    ///
    ///   Every micro-dollar that goes into a USDG escrow comes out again, to the unit, whichever way
    ///   it leaves, and the escrow keeps nothing.
    ///
    /// Both exits are exercised in the same run, because a conservation claim that only tests one
    /// path is not a conservation claim.
    function testFuzz_UsdgEscrow_ConservesEveryMicroDollar(
        uint96 settledAmount,
        uint96 unwoundAmount
    ) public {
        vm.assume(settledAmount > 0 && unwoundAmount > 0);

        uint256 total = uint256(settledAmount) + uint256(unwoundAmount);
        usdg.mint(funder, total);

        uint64 deadline = _earliestDeadline();
        bytes32 settleRef = keccak256("usdg-cash-leg");
        bytes32 unwindRef = keccak256("usdg-cash-leg-expired");

        vm.startPrank(funder);
        nullfill.open(
            settleRef, beneficiary, IERC20(address(usdg)), settledAmount, deadline, recovery
        );
        nullfill.open(
            unwindRef, beneficiary, IERC20(address(usdg)), unwoundAmount, deadline, recovery
        );
        vm.stopPrank();

        assertEq(usdg.balanceOf(address(nullfill)), total, "both deposits arrived in full");

        vm.prank(beneficiary);
        nullfill.settle(settleRef);

        vm.warp(deadline);
        vm.prank(stranger);
        nullfill.unwind(unwindRef);

        assertEq(usdg.balanceOf(beneficiary), settledAmount, "settled leg, exact");
        assertEq(usdg.balanceOf(recovery), unwoundAmount, "unwound leg, exact");
        assertEq(usdg.balanceOf(address(nullfill)), 0, "escrow keeps nothing, not one micro-dollar");
    }

    // ------------------------------------------- the asset agnostic claim

    /// "Takes any ERC-20" is a claim, and this is the token that tests it. Without the balance delta
    /// check in `open`, the escrow would record the amount it was asked for while holding one percent
    /// less, and the shortfall would be paid out of the next order's balance. That is one escrow
    /// spending another escrow's money, and it needs no attacker to happen.
    function test_FeeOnTransferToken_IsRejectedRatherThanUnderFundingAnEscrow() public {
        uint64 deadline = _earliestDeadline();
        uint256 amount = 1_000e6;

        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(Nullfill.TransferNotExact.selector, amount, amount - amount / 100)
        );
        nullfill.open(REF, beneficiary, IERC20(address(feeToken)), amount, deadline, recovery);

        assertEq(
            uint256(nullfill.statusOf(REF)), uint256(Nullfill.Status.None), "no order was created"
        );
        assertEq(feeToken.balanceOf(address(nullfill)), 0, "and nothing was left in the escrow");
    }

    /// The same guard applied to the shape of the attack rather than the token. Two escrows in the
    /// same asset must not be able to touch each other's balance.
    function test_TwoUsdgEscrows_DoNotShareABalance() public {
        uint64 deadline = _earliestDeadline();
        bytes32 firstRef = keccak256("desk-a");
        bytes32 secondRef = keccak256("desk-b");
        uint256 firstAmount = 100e6;
        uint256 secondAmount = 900e6;

        vm.startPrank(funder);
        nullfill.open(firstRef, beneficiary, IERC20(address(usdg)), firstAmount, deadline, recovery);
        nullfill.open(secondRef, beneficiary, IERC20(address(usdg)), secondAmount, deadline, recovery);
        vm.stopPrank();

        vm.prank(beneficiary);
        nullfill.settle(firstRef);

        assertEq(usdg.balanceOf(address(nullfill)), secondAmount, "the second escrow is untouched");
        assertEq(
            uint256(nullfill.statusOf(secondRef)),
            uint256(Nullfill.Status.Open),
            "and still open"
        );
    }
}
