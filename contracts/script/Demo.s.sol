// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Nullfill} from "../src/Nullfill.sol";
import {RobinhoodChain} from "../src/RobinhoodChain.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Demo
/// @notice Drives one real order on the deployed contract, on a real chain, with a real Robinhood
///         Chain asset. One command per step, and every step prints what a reviewer would need.
///
/// @dev The shape is:
///
///        export RPC=https://rpc.testnet.chain.robinhood.com
///        export PRIVATE_KEY=0x...
///
///        DEMO_ACTION=open   forge script script/Demo.s.sol:Demo --rpc-url $RPC --private-key $PRIVATE_KEY --broadcast
///        DEMO_ACTION=settle forge script script/Demo.s.sol:Demo --rpc-url $RPC --private-key $PRIVATE_KEY --broadcast
///
///      Environment:
///        DEMO_ACTION  open | settle | unwind | status. Required.
///        DEMO_ASSET   auto | USDG | TSLA | AMD | AMZN | NFLX | PLTR. Defaults to auto, which prefers
///                     USDG when the wallet is funded with it and falls back to the first equity the
///                     wallet holds. It logs which one it chose, so the choice is never silent.
///        DEMO_AMOUNT  Whole units, as a decimal number of the asset. Defaults to 1.
///        DEMO_NONCE   Integer. Part of the order reference, so a second run is a second order.
///                     Defaults to 1.
///        DEMO_UNWIND_KEY  Optional. A second private key to send `unwind` from. This is the step
///                     worth doing, because it is the whole argument: recovery does not depend on
///                     the funder being able to transact, so a wallet the funder has never used can
///                     complete it. Generate one with `cast wallet new`, fund it with a little ETH,
///                     and pass it here. Without it, unwind is sent from the same key as open, which
///                     works but demonstrates less.
///
///      The reference is derived, not generated, so `open` and `settle` agree on it without anything
///      being copied between commands:
///
///        ref = keccak256("nullfill-demo", symbol, nonce)
contract Demo is Script {
    /// @dev The live deployment, Robinhood Chain testnet, deployed 16 September 2026. Overridable
    ///      with NULLFILL so the same script can drive a redeployment without being edited.
    address internal constant DEFAULT_NULLFILL = 0x71029fac49E9b45CCC377812aEc01509FFD383A1;

    error UnknownAction(string action);
    error NoFundedAsset(address wallet);
    error UnknownAsset(string symbol);

    function run() external {
        Nullfill nullfill = Nullfill(vm.envOr("NULLFILL", DEFAULT_NULLFILL));
        string memory action = vm.envOr("DEMO_ACTION", string("status"));
        uint256 nonce = vm.envOr("DEMO_NONCE", uint256(1));

        if (_eq(action, "status")) {
            _status(nullfill, nonce);
            return;
        }

        (IERC20Metadata token, bytes32 symbol) = _resolveAsset();
        bytes32 ref = keccak256(abi.encodePacked("nullfill-demo", symbol, nonce));
        uint256 amount = _parseUnits(vm.envOr("DEMO_AMOUNT", string("1")), token.decimals());

        console.log("");
        console.log("Nullfill demo");
        console.log("  contract ", address(nullfill));
        console.log("  asset    ", token.symbol());
        console.log("  amount   ", amount, "raw units at");
        console.log("  decimals ", token.decimals());
        console.log("  ref      ", vm.toString(ref));

        if (_eq(action, "open")) {
            _open(nullfill, token, ref, amount);
        } else if (_eq(action, "settle")) {
            _settle(nullfill, ref);
        } else if (_eq(action, "unwind")) {
            _unwind(nullfill, ref);
        } else {
            revert UnknownAction(action);
        }
    }

    // ------------------------------------------------------------------ actions

    function _open(Nullfill nullfill, IERC20Metadata token, bytes32 ref, uint256 amount) internal {
        address beneficiary = vm.envOr("DEMO_BENEFICIARY", msg.sender);
        address unwindTo = vm.envOr("DEMO_UNWIND_TO", msg.sender);

        uint64 deadline = uint64(block.timestamp) + nullfill.FORCE_INCLUSION_WINDOW();

        console.log("");
        console.log("Opening. The deadline is the earliest the escrow may be unwound, and it is the");
        console.log("force inclusion window from now. Before it, the outcome is genuinely unknown.");
        console.log("  beneficiary", beneficiary);
        console.log("  unwindTo   ", unwindTo);
        console.log("  deadline   ", deadline);

        vm.startBroadcast();
        IERC20(address(token)).approve(address(nullfill), amount);
        nullfill.open(ref, beneficiary, IERC20(address(token)), amount, deadline, unwindTo);
        vm.stopBroadcast();

        console.log("");
        console.log("Opened. Unwind becomes possible at timestamp", deadline);
    }

    function _settle(Nullfill nullfill, bytes32 ref) internal {
        _describe(nullfill, ref);
        vm.startBroadcast();
        nullfill.settle(ref);
        vm.stopBroadcast();
        console.log("");
        console.log("Settled. The beneficiary has the asset and the order is closed.");
    }

    function _unwind(Nullfill nullfill, bytes32 ref) internal {
        _describe(nullfill, ref);

        if (!nullfill.isUnwindable(ref)) {
            console.log("");
            console.log("Not yet. The deadline has not passed, and unwinding before it would be the");
            console.log("bug this contract exists to prevent. Come back after the deadline.");
            return;
        }

        // The point of the demo. If a second key is supplied, this transaction is sent by a wallet
        // the funder has never used, and the funds still reach the nominated recovery address.
        uint256 unwindKey = vm.envOr("DEMO_UNWIND_KEY", uint256(0));

        if (unwindKey != 0) {
            address sender = vm.addr(unwindKey);
            console.log("");
            console.log("Unwinding from a second wallet, not the funder:", sender);
            vm.startBroadcast(unwindKey);
        } else {
            console.log("");
            console.log("Unwinding. No caller check exists on this function, which is the point.");
            console.log("Set DEMO_UNWIND_KEY to send it from a wallet the funder has never used.");
            vm.startBroadcast();
        }

        nullfill.unwind(ref);
        vm.stopBroadcast();

        console.log("");
        console.log("Unwound. The recovery address has the asset, and the caller kept nothing.");
    }

    function _status(Nullfill nullfill, uint256 nonce) internal view {
        console.log("Nullfill at", address(nullfill));
        console.log("Force inclusion window, seconds:", nullfill.FORCE_INCLUSION_WINDOW());

        string[6] memory symbols = ["USDG", "TSLA", "AMD", "AMZN", "NFLX", "PLTR"];
        for (uint256 i = 0; i < symbols.length; ++i) {
            bytes32 symbol = _symbol(symbols[i]);
            _describe(nullfill, keccak256(abi.encodePacked("nullfill-demo", symbol, nonce)));
        }
    }

    function _describe(Nullfill nullfill, bytes32 ref) internal view {
        Nullfill.Status status = nullfill.statusOf(ref);
        console.log("");
        console.log("ref", vm.toString(ref));
        console.log("  status    ", _statusName(status));
        if (status == Nullfill.Status.None) return;

        Nullfill.Order memory o = nullfill.orderOf(ref);
        console.log("  funder    ", o.funder);
        console.log("  token     ", address(o.token));
        console.log("  amount    ", o.amount);
        console.log("  deadline  ", o.deadline);
        console.log("  unwindTo  ", o.unwindTo);
        console.log("  unwindable", nullfill.isUnwindable(ref));
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Pick the settlement asset. USDG first, because it is the chain's designated dollar and
    ///      the cash leg of a trade here, then the first equity the wallet actually holds. The choice
    ///      is logged rather than assumed, because "which token did it use" is exactly the thing a
    ///      reviewer will want to check.
    function _resolveAsset() internal view returns (IERC20Metadata token, bytes32 symbol) {
        string memory requested = vm.envOr("DEMO_ASSET", string("auto"));

        if (!_eq(requested, "auto")) {
            (address addr, bytes32 sym) = _lookup(requested);
            token = IERC20Metadata(addr);
            symbol = sym;
            if (token.balanceOf(msg.sender) == 0) {
                console.log("Warning: this wallet holds no", token.symbol());
            }
            return (token, symbol);
        }

        address usdg = address(RobinhoodChain.usdg());
        if (IERC20Metadata(usdg).balanceOf(msg.sender) > 0) {
            return (IERC20Metadata(usdg), "USDG");
        }

        RobinhoodChain.Asset[] memory list = RobinhoodChain.equities(block.chainid);
        for (uint256 i = 0; i < list.length; ++i) {
            if (IERC20Metadata(list[i].token).balanceOf(msg.sender) > 0) {
                console.log(
                    "No USDG in this wallet, falling back to", RobinhoodChain.symbolString(list[i].symbol)
                );
                return (IERC20Metadata(list[i].token), list[i].symbol);
            }
        }

        revert NoFundedAsset(msg.sender);
    }

    function _lookup(string memory name) internal view returns (address, bytes32) {
        if (_eq(name, "USDG")) return (address(RobinhoodChain.usdg()), "USDG");
        bytes32 symbol = _symbol(name);
        return (RobinhoodChain.equity(block.chainid, symbol).token, symbol);
    }

    /// @dev Parse a decimal string into raw units at `decimals`. Hand rolled rather than pulled in,
    ///      because a settlement script that rounds differently from the contract is a bug waiting to
    ///      be discovered in production, and this way there is one obvious place to read.
    function _parseUnits(string memory value, uint8 decimals) internal pure returns (uint256) {
        bytes memory raw = bytes(value);
        uint256 whole = 0;
        uint256 fraction = 0;
        uint256 fractionDigits = 0;
        bool afterPoint = false;

        for (uint256 i = 0; i < raw.length; ++i) {
            if (raw[i] == ".") {
                afterPoint = true;
                continue;
            }
            require(raw[i] >= "0" && raw[i] <= "9", "not a number");
            uint256 digit = uint256(uint8(raw[i]) - 48);
            if (afterPoint) {
                if (fractionDigits == decimals) continue; // truncate, never round up
                fraction = fraction * 10 + digit;
                fractionDigits++;
            } else {
                whole = whole * 10 + digit;
            }
        }

        while (fractionDigits < decimals) {
            fraction *= 10;
            fractionDigits++;
        }

        return whole * (10 ** decimals) + fraction;
    }

    function _statusName(Nullfill.Status status) internal pure returns (string memory) {
        if (status == Nullfill.Status.None) return "None (no such order)";
        if (status == Nullfill.Status.Open) return "Open";
        if (status == Nullfill.Status.Settled) return "Settled";
        return "Unwound";
    }

    function _symbol(string memory name) internal pure returns (bytes32 out) {
        bytes memory raw = bytes(name);
        require(raw.length <= 32, "symbol too long");
        assembly {
            out := mload(add(raw, 32))
        }
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
