// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Nullfill
/// @notice Escrow for tokenised equities that stays correct when a transaction is never included.
///
/// @dev Most chains give a submitted transaction two possible fates. It executes, or it reverts.
///      Robinhood Chain gives it four. A transaction can be screened at the sequencer, in which
///      case it is never sequenced at all: no revert, no receipt, no event, no gas. Every contract
///      and indexer on the chain sees nothing, because nothing happened. Robinhood Chain documents
///      this in the present tense: "Since a blocked transfer is never processed, it simply appears
///      as though the event never occurred."
///
///      That breaks the assumption every escrow is built on. The classic escrow reasons "if the
///      seller has not delivered by the deadline, I will send myself the money back". That reasoning
///      needs the funder to be able to send a transaction. If the funder is the screened party, they
///      cannot, and the escrow is stuck forever.
///
///      Nullfill fixes that with three decisions:
///
///      1. Unwind is permissionless. Anyone can release an expired escrow. Recovery never depends on
///         the screened party being able to transact.
///      2. The recovery address is nominated up front, at open time, and can be changed while the
///         escrow is still open. A funder whose primary address is restricted names a different
///         address before they need it.
///      3. Orders are keyed by an external reference and every state transition is one way. A retried
///         transaction cannot execute twice.
///
///      One limitation is deliberate and documented rather than hidden. Screening happens before
///      execution, so the EVM cannot observe it and `try`/`catch` cannot help. If the nominated
///      recovery address is itself screened, this contract cannot detect that, because the transfer
///      simply never runs. Nominate a recovery address you expect to stay usable.
contract Nullfill is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Lifecycle of an order.
    /// @dev `None` means no order exists for that reference.
    enum Status {
        None,
        Open,
        Settled,
        Unwound
    }

    /// @notice A single escrowed settlement.
    /// @param funder The party who deposited the tokens.
    /// @param beneficiary The party who receives them on settlement.
    /// @param unwindTo The party who receives them if settlement never happens.
    /// @param token The ERC-20 being escrowed.
    /// @param amount The escrowed amount.
    /// @param deadline The earliest moment the escrow may be unwound.
    /// @param status Current lifecycle state.
    struct Order {
        address funder;
        address beneficiary;
        address unwindTo;
        IERC20 token;
        uint256 amount;
        uint64 deadline;
        Status status;
    }

    /// @notice The window Arbitrum gives a screened transaction to arrive by force inclusion.
    /// @dev A settlement must not be unwound before this window has passed, because a transaction
    ///      submitted through the delayed inbox can still land. Arbitrum closes that window with the
    ///      Transaction Guardian Precompile: a restricted transaction that does arrive by force
    ///      inclusion is forcibly failed on inclusion and burns its attached gas. So the window is
    ///      not a rescue, it is the period during which the outcome is still genuinely unknown.
    ///      Every deadline is therefore at least this far in the future.
    uint64 public constant FORCE_INCLUSION_WINDOW = 24 hours;

    mapping(bytes32 ref => Order) private _orders;

    error RefAlreadyUsed(bytes32 ref);
    error UnknownRef(bytes32 ref);
    error NotOpen(bytes32 ref, Status status);
    error DeadlineTooSoon(uint64 earliest);
    error DeadlineNotLater(uint64 current);
    error NotYetUnwindable(bytes32 ref, uint64 deadline);
    error NotAParty(bytes32 ref, address caller);
    error ZeroAddress();
    error ZeroAmount();

    /// @notice Emitted when tokens are escrowed.
    event Opened(
        bytes32 indexed ref,
        address indexed funder,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint64 deadline,
        address unwindTo
    );

    /// @notice Emitted when an order settles and tokens reach the beneficiary.
    event Settled(bytes32 indexed ref, address indexed by, address indexed beneficiary, uint256 amount);

    /// @notice Emitted when an order is unwound and tokens reach the recovery address.
    /// @param by The caller. Not necessarily the funder, because unwind is permissionless.
    event Unwound(bytes32 indexed ref, address indexed by, address indexed unwindTo, uint256 amount);

    /// @notice Emitted when the parties buy more time instead of letting the escrow unwind.
    event Extended(bytes32 indexed ref, uint64 newDeadline);

    /// @notice Emitted when the recovery address is changed before the escrow expires.
    event UnwindToChanged(bytes32 indexed ref, address newUnwindTo);

    /// @notice Escrow `amount` of `token` against a reference.
    /// @dev The reference is the idempotency key. Reusing one reverts, so a retried transaction can
    ///      never open a second escrow.
    /// @param ref Caller-chosen unique reference for this settlement.
    /// @param beneficiary Receives the tokens on settlement.
    /// @param token The ERC-20 to escrow.
    /// @param amount The amount to escrow.
    /// @param deadline Earliest unwind time. Must be at least FORCE_INCLUSION_WINDOW from now.
    /// @param unwindTo Recovery address. Pass the zero address to default to the caller.
    function open(
        bytes32 ref,
        address beneficiary,
        IERC20 token,
        uint256 amount,
        uint64 deadline,
        address unwindTo
    ) external nonReentrant {
        if (beneficiary == address(0) || address(token) == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_orders[ref].status != Status.None) revert RefAlreadyUsed(ref);

        uint64 earliest = uint64(block.timestamp) + FORCE_INCLUSION_WINDOW;
        if (deadline < earliest) revert DeadlineTooSoon(earliest);

        address recovery = unwindTo == address(0) ? msg.sender : unwindTo;

        _orders[ref] = Order({
            funder: msg.sender,
            beneficiary: beneficiary,
            unwindTo: recovery,
            token: token,
            amount: amount,
            deadline: deadline,
            status: Status.Open
        });

        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Opened(ref, msg.sender, beneficiary, address(token), amount, deadline, recovery);
    }

    /// @notice Release an escrow to the beneficiary.
    /// @dev Callable by either party, on purpose. If the beneficiary has been screened and cannot
    ///      transact, the funder can still complete the settlement. A funder calling this is giving
    ///      the tokens away, since they always go to the beneficiary, so there is no incentive to
    ///      abuse the second path.
    /// @dev This stays available after the deadline. The deadline gates unwind only. If the trade
    ///      genuinely happened, settling late is still the right outcome.
    function settle(bytes32 ref) external nonReentrant {
        Order storage o = _orders[ref];
        if (o.status == Status.None) revert UnknownRef(ref);
        if (o.status != Status.Open) revert NotOpen(ref, o.status);
        if (msg.sender != o.funder && msg.sender != o.beneficiary) revert NotAParty(ref, msg.sender);

        o.status = Status.Settled;
        o.token.safeTransfer(o.beneficiary, o.amount);

        emit Settled(ref, msg.sender, o.beneficiary, o.amount);
    }

    /// @notice Return an expired escrow to its recovery address.
    /// @dev Permissionless. This is the mechanism that stops a screened party stranding funds.
    /// @param ref The order to unwind.
    function unwind(bytes32 ref) external nonReentrant {
        Order storage o = _orders[ref];
        if (o.status == Status.None) revert UnknownRef(ref);
        if (o.status != Status.Open) revert NotOpen(ref, o.status);
        if (block.timestamp < o.deadline) revert NotYetUnwindable(ref, o.deadline);

        o.status = Status.Unwound;
        o.token.safeTransfer(o.unwindTo, o.amount);

        emit Unwound(ref, msg.sender, o.unwindTo, o.amount);
    }

    /// @notice Push the deadline out rather than let an in flight retry expire.
    /// @dev The scenario this exists for: a settlement transaction was screened, the parties want to
    ///      retry, and the retry needs its own full force inclusion window. Callable by either party.
    function extend(bytes32 ref, uint64 newDeadline) external {
        Order storage o = _orders[ref];
        if (o.status == Status.None) revert UnknownRef(ref);
        if (o.status != Status.Open) revert NotOpen(ref, o.status);
        if (msg.sender != o.funder && msg.sender != o.beneficiary) revert NotAParty(ref, msg.sender);

        uint64 earliest = uint64(block.timestamp) + FORCE_INCLUSION_WINDOW;
        if (newDeadline < earliest) revert DeadlineTooSoon(earliest);
        if (newDeadline <= o.deadline) revert DeadlineNotLater(o.deadline);

        o.deadline = newDeadline;

        emit Extended(ref, newDeadline);
    }

    /// @notice Change the recovery address while the escrow is still open.
    /// @dev The scenario this exists for: the funder discovers their nominated recovery address is
    ///      also restricted. They can repoint it, but only while they can still transact. Once they
    ///      cannot, this function is unreachable and the escrow is stuck. That is a real limitation
    ///      of doing this on chain, and it is why nomination should happen before it is needed.
    ///      Funder only, since the recovery address is the funder's money.
    function setUnwindTo(bytes32 ref, address newUnwindTo) external {
        Order storage o = _orders[ref];
        if (o.status == Status.None) revert UnknownRef(ref);
        if (o.status != Status.Open) revert NotOpen(ref, o.status);
        if (msg.sender != o.funder) revert NotAParty(ref, msg.sender);
        if (newUnwindTo == address(0)) revert ZeroAddress();

        o.unwindTo = newUnwindTo;

        emit UnwindToChanged(ref, newUnwindTo);
    }

    /// @notice Read the full order.
    function orderOf(bytes32 ref) external view returns (Order memory) {
        return _orders[ref];
    }

    /// @notice Read just the lifecycle state.
    function statusOf(bytes32 ref) external view returns (Status) {
        return _orders[ref].status;
    }

    /// @notice Whether this escrow can be unwound right now.
    /// @dev The console calls this rather than computing the deadline itself, so there is one
    ///      definition of "expired" and it lives on chain.
    function isUnwindable(bytes32 ref) external view returns (bool) {
        Order storage o = _orders[ref];
        return o.status == Status.Open && block.timestamp >= o.deadline;
    }

    /// @notice Everything a client needs about one order, in a single call.
    function describe(bytes32 ref)
        external
        view
        returns (
            Status status,
            address funder,
            address beneficiary,
            address unwindTo,
            address token,
            uint256 amount,
            uint64 deadline,
            bool unwindable
        )
    {
        Order storage o = _orders[ref];
        return (
            o.status,
            o.funder,
            o.beneficiary,
            o.unwindTo,
            address(o.token),
            o.amount,
            o.deadline,
            o.status == Status.Open && block.timestamp >= o.deadline
        );
    }
}
