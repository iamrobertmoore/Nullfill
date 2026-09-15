// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Nullfill} from "../src/Nullfill.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Stand in for a Robinhood Chain stock token. The real testnet faucet dispenses five each of
///      TSLA, AMZN, PLTR, NFLX and AMD once per day.
contract StockToken is ERC20 {
    constructor() ERC20("Robinhood TSLA", "TSLA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Note on cheatcode ordering, because this bit me while writing these tests.
///      `vm.prank` and `vm.expectRevert` apply to the next external call. Solidity evaluates a
///      function's arguments before making the call, so if an argument expression itself makes an
///      external call, that call eats the cheatcode and the real call runs unpranked. Reading
///      `FORCE_INCLUSION_WINDOW()` inline as an argument does exactly this. Every deadline below is
///      therefore computed into a local first.
contract NullfillTest is Test {
    Nullfill internal nullfill;
    StockToken internal tsla;

    address internal funder = makeAddr("funder");
    address internal beneficiary = makeAddr("beneficiary");
    address internal recovery = makeAddr("recovery");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 5e18;
    bytes32 internal constant REF = keccak256("trade-0001");

    event Opened(
        bytes32 indexed ref,
        address indexed funder,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint64 deadline,
        address unwindTo
    );

    function setUp() public {
        nullfill = new Nullfill();
        tsla = new StockToken();
        tsla.mint(funder, 1_000e18);

        vm.prank(funder);
        tsla.approve(address(nullfill), type(uint256).max);
    }

    function _earliestDeadline() internal view returns (uint64) {
        return uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW();
    }

    function _open() internal returns (uint64 deadline) {
        deadline = _earliestDeadline();
        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, deadline, recovery);
    }

    // ---------------------------------------------------------------- open

    function test_Open_EscrowsTokens() public {
        _open();

        assertEq(tsla.balanceOf(address(nullfill)), AMOUNT, "escrow holds the tokens");
        assertEq(tsla.balanceOf(funder), 1_000e18 - AMOUNT, "funder is debited");
        assertEq(uint256(nullfill.statusOf(REF)), uint256(Nullfill.Status.Open), "order is open");
    }

    function test_Open_EmitsOpened() public {
        uint64 deadline = _earliestDeadline();

        vm.expectEmit(true, true, true, true, address(nullfill));
        emit Opened(REF, funder, beneficiary, address(tsla), AMOUNT, deadline, recovery);

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, deadline, recovery);
    }

    function test_Open_RevertsOnDuplicateRef() public {
        _open();
        uint64 deadline = _earliestDeadline();

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.RefAlreadyUsed.selector, REF));
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, deadline, recovery);
    }

    function test_Open_RevertsWhenDeadlineInsideForceInclusionWindow() public {
        uint64 tooSoon = uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW() - 1;
        uint64 earliest = uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW();

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.DeadlineTooSoon.selector, earliest));
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, tooSoon, recovery);
    }

    function test_Open_DefaultsUnwindToFunder() public {
        uint64 deadline = _earliestDeadline();

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, deadline, address(0));

        Nullfill.Order memory o = nullfill.orderOf(REF);
        assertEq(o.unwindTo, funder, "zero recovery address defaults to the funder");
    }

    function test_Open_RevertsOnZeroAmount() public {
        uint64 deadline = _earliestDeadline();

        vm.prank(funder);
        vm.expectRevert(Nullfill.ZeroAmount.selector);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), 0, deadline, recovery);
    }

    // -------------------------------------------------------------- settle

    function test_Settle_PaysBeneficiary() public {
        _open();

        vm.prank(beneficiary);
        nullfill.settle(REF);

        assertEq(tsla.balanceOf(beneficiary), AMOUNT, "beneficiary is paid");
        assertEq(tsla.balanceOf(address(nullfill)), 0, "escrow is empty");
        assertEq(uint256(nullfill.statusOf(REF)), uint256(Nullfill.Status.Settled));
    }

    /// The path that matters when the beneficiary has been screened and cannot send a transaction.
    function test_Settle_FunderCanCompleteWhenBeneficiaryIsBlocked() public {
        _open();

        vm.prank(funder);
        nullfill.settle(REF);

        assertEq(tsla.balanceOf(beneficiary), AMOUNT, "beneficiary still receives the tokens");
    }

    function test_Settle_RevertsForStranger() public {
        _open();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.NotAParty.selector, REF, stranger));
        nullfill.settle(REF);
    }

    /// A retried transaction must not execute twice.
    function test_Settle_RevertsOnSecondCall() public {
        _open();

        vm.prank(beneficiary);
        nullfill.settle(REF);

        vm.prank(beneficiary);
        vm.expectRevert(
            abi.encodeWithSelector(Nullfill.NotOpen.selector, REF, Nullfill.Status.Settled)
        );
        nullfill.settle(REF);

        assertEq(tsla.balanceOf(beneficiary), AMOUNT, "paid exactly once");
    }

    function test_Settle_StillWorksAfterDeadline() public {
        uint64 deadline = _open();

        vm.warp(deadline + 1 days);

        vm.prank(beneficiary);
        nullfill.settle(REF);

        assertEq(tsla.balanceOf(beneficiary), AMOUNT, "a late settlement is still a settlement");
    }

    // -------------------------------------------------------------- unwind

    /// The headline behaviour. A stranger recovers the escrow, because the funder may be unable to.
    function test_Unwind_StrangerRecoversAfterDeadline() public {
        uint64 deadline = _open();

        vm.warp(deadline);

        vm.prank(stranger);
        nullfill.unwind(REF);

        assertEq(tsla.balanceOf(recovery), AMOUNT, "recovery address is paid by a third party");
        assertEq(tsla.balanceOf(address(nullfill)), 0, "escrow is empty");
        assertEq(uint256(nullfill.statusOf(REF)), uint256(Nullfill.Status.Unwound));
    }

    function test_Unwind_RevertsBeforeDeadline() public {
        uint64 deadline = _open();

        vm.warp(deadline - 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.NotYetUnwindable.selector, REF, deadline));
        nullfill.unwind(REF);
    }

    function test_Unwind_RevertsOnSecondCall() public {
        uint64 deadline = _open();
        vm.warp(deadline);

        vm.prank(stranger);
        nullfill.unwind(REF);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Nullfill.NotOpen.selector, REF, Nullfill.Status.Unwound)
        );
        nullfill.unwind(REF);

        assertEq(tsla.balanceOf(recovery), AMOUNT, "recovered exactly once");
    }

    function test_Unwind_DefaultsToFunderWhenNoRecoveryNominated() public {
        uint64 deadline = _earliestDeadline();

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, deadline, address(0));

        vm.warp(deadline);
        vm.prank(stranger);
        nullfill.unwind(REF);

        assertEq(tsla.balanceOf(funder), 1_000e18, "funder is made whole");
    }

    function test_Unwind_CannotHappenAfterSettle() public {
        _open();

        vm.prank(beneficiary);
        nullfill.settle(REF);

        vm.warp(_earliestDeadline() + 30 days);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Nullfill.NotOpen.selector, REF, Nullfill.Status.Settled)
        );
        nullfill.unwind(REF);
    }

    // -------------------------------------------------------------- extend

    function test_Extend_PushesDeadlineOut() public {
        uint64 deadline = _open();
        uint64 later = deadline + 1 days;

        vm.prank(funder);
        nullfill.extend(REF, later);

        assertEq(nullfill.orderOf(REF).deadline, later, "deadline moved");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.NotYetUnwindable.selector, REF, later));
        nullfill.unwind(REF);
    }

    function test_Extend_BeneficiaryCanAlsoExtend() public {
        uint64 deadline = _open();

        vm.prank(beneficiary);
        nullfill.extend(REF, deadline + 1 hours);

        assertEq(nullfill.orderOf(REF).deadline, deadline + 1 hours);
    }

    function test_Extend_RevertsForStranger() public {
        uint64 deadline = _open();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.NotAParty.selector, REF, stranger));
        nullfill.extend(REF, deadline + 1 days);
    }

    function test_Extend_RevertsWhenNotLater() public {
        uint64 deadline = _open();

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.DeadlineNotLater.selector, deadline));
        nullfill.extend(REF, deadline);
    }

    function test_Extend_RevertsWhenNewDeadlineInsideWindow() public {
        uint64 deadline = _open();

        vm.warp(deadline + 1 days);
        uint64 tooSoon = uint64(block.timestamp) + 1 hours;
        uint64 earliest = uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW();

        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.DeadlineTooSoon.selector, earliest));
        nullfill.extend(REF, tooSoon);
    }

    // --------------------------------------------------------- setUnwindTo

    function test_SetUnwindTo_RepointsRecovery() public {
        _open();
        address newRecovery = makeAddr("newRecovery");

        vm.prank(funder);
        nullfill.setUnwindTo(REF, newRecovery);

        vm.warp(_earliestDeadline());
        vm.prank(stranger);
        nullfill.unwind(REF);

        assertEq(tsla.balanceOf(newRecovery), AMOUNT, "funds follow the updated address");
        assertEq(tsla.balanceOf(recovery), 0, "the old address gets nothing");
    }

    function test_SetUnwindTo_OnlyFunder() public {
        _open();

        vm.prank(beneficiary);
        vm.expectRevert(abi.encodeWithSelector(Nullfill.NotAParty.selector, REF, beneficiary));
        nullfill.setUnwindTo(REF, makeAddr("attacker"));
    }

    function test_SetUnwindTo_RevertsOnZero() public {
        _open();

        vm.prank(funder);
        vm.expectRevert(Nullfill.ZeroAddress.selector);
        nullfill.setUnwindTo(REF, address(0));
    }

    // ----------------------------------------------------------------- views

    function test_Describe_ReportsEverythingTheConsoleNeeds() public {
        uint64 deadline = _open();

        (
            Nullfill.Status status,
            address f,
            address b,
            address u,
            address t,
            uint256 amount,
            uint64 d,
            bool unwindable
        ) = nullfill.describe(REF);

        assertEq(uint256(status), uint256(Nullfill.Status.Open));
        assertEq(f, funder);
        assertEq(b, beneficiary);
        assertEq(u, recovery);
        assertEq(t, address(tsla));
        assertEq(amount, AMOUNT);
        assertEq(d, deadline);
        assertFalse(unwindable, "not yet");
    }

    function test_IsUnwindable_FlipsAtTheDeadline() public {
        uint64 deadline = _open();

        assertFalse(nullfill.isUnwindable(REF));
        vm.warp(deadline);
        assertTrue(nullfill.isUnwindable(REF));
    }

    function test_UnknownRefIsHarmless() public view {
        assertEq(uint256(nullfill.statusOf(bytes32("nope"))), uint256(Nullfill.Status.None));
        assertFalse(nullfill.isUnwindable(bytes32("nope")));
    }

    // ----------------------------------------------------------------- fuzz

    function testFuzz_OpenAndUnwind_AnyAmount(uint96 amount) public {
        vm.assume(amount > 0);

        tsla.mint(funder, amount);
        uint64 deadline = _earliestDeadline();

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), amount, deadline, recovery);

        assertEq(tsla.balanceOf(address(nullfill)), amount);

        vm.warp(deadline);
        vm.prank(stranger);
        nullfill.unwind(REF);

        assertEq(tsla.balanceOf(recovery), amount, "full amount recovered");
        assertEq(tsla.balanceOf(address(nullfill)), 0, "nothing left behind");
    }

    function testFuzz_DeadlineAlwaysAtLeastTheForceInclusionWindow(uint64 offset) public {
        vm.assume(offset < 3650 days);

        uint64 deadline = uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW() + offset;

        vm.prank(funder);
        nullfill.open(REF, beneficiary, IERC20(address(tsla)), AMOUNT, deadline, recovery);

        uint64 floor = uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW();
        assertGe(
            nullfill.orderOf(REF).deadline,
            floor,
            "no escrow can be unwound before a screened transaction could still arrive"
        );
    }
}
