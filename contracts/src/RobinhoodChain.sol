// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title RobinhoodChain
/// @notice The canonical asset addresses for Robinhood Chain, and the resolution logic that picks
///         the right one for whichever chain the calling code is running on.
///
/// @dev Nullfill is asset agnostic on purpose. `open()` takes any `IERC20`, so nothing in the escrow
///      changes when the desk switches from one settlement asset to another. What does not come for
///      free is knowing *which* contract is the real one. A desk settling against the wrong USDG
///      address, or against a lookalike equity token, has a problem no escrow can see.
///
///      So this library pins the addresses and, more usefully, says how each one was verified. Every
///      entry below was read back from the chain rather than copied from a page:
///
///      USDG, testnet, 0x7E95...802F
///        name()     "Global Dollar"
///        symbol()   "USDG"
///        decimals() 6
///        Read on 28 September 2026. 3,850 holders and 78,877 transfers at that moment, so this is
///        not a stub contract. It is a verified USDG implementation behind an ERC1967 proxy, with
///        role gated mint and increaseSupply and no public mint.
///
///      USDG, mainnet, 0x5fc5...d168
///        name()     "Global Dollar"
///        decimals() 6
///        Read on 28 September 2026 against https://rpc.mainnet.chain.robinhood.com.
///
///      The five equity tokens are testnet stand-ins issued for development. Each is 18 decimals and
///      each was read back the same way.
///
///      **The decimals are a claim, not a constant.** They are what the token reported on the date
///      above, and a token can be upgraded. `test/Fork.t.sol` re-reads every entry in this library
///      against a live chain and fails if any of them has moved. Run it with an RPC before trusting
///      a decimal count in production:
///
///        FOUNDRY_PROFILE=fork ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com \
///          forge test --match-path test/Fork.t.sol
///
///      The `fork` profile is required. The live tokens use PUSH0 and this project deploys Paris
///      bytecode, so without it every call to a real token fails with `EvmError: NotActivated`.
///
///      Nothing here is a token list. It is the small set of addresses this project has actually
///      verified, plus the machinery to fail loudly on an unknown chain rather than guess.
library RobinhoodChain {
    /// @notice Robinhood Chain testnet. The chain this entry is deployed to.
    uint256 internal constant TESTNET = 46630;

    /// @notice Robinhood Chain mainnet.
    uint256 internal constant MAINNET = 4663;

    /// @notice USDG on Robinhood Chain testnet.
    address internal constant USDG_TESTNET = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    /// @notice USDG on Robinhood Chain mainnet.
    address internal constant USDG_MAINNET = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @notice An asset this library knows about.
    /// @param token The ERC-20 contract.
    /// @param symbol The ticker, as bytes32. `"TSLA"` rather than a string, because this is an
    ///        identifier and not display text.
    /// @param decimals What the token reported when it was read. See the note above: a claim with a
    ///        date, re-checked by `test/Fork.t.sol`.
    struct Asset {
        address token;
        bytes32 symbol;
        uint8 decimals;
    }

    error UnknownChain(uint256 chainId);
    error UnknownSymbol(bytes32 symbol);

    /// @notice USDG on a named chain.
    /// @dev Reverts rather than returning the zero address. A silent zero would put a desk one
    ///      `open()` call away from an escrow against `address(0)`, which the escrow rejects, so the
    ///      failure would surface late and far from its cause.
    function usdg(uint256 chainId) internal pure returns (IERC20) {
        if (chainId == TESTNET) return IERC20(USDG_TESTNET);
        if (chainId == MAINNET) return IERC20(USDG_MAINNET);
        revert UnknownChain(chainId);
    }

    /// @notice USDG on the chain this code is running on.
    function usdg() internal view returns (IERC20) {
        return usdg(block.chainid);
    }

    /// @notice Whether `token` is USDG on either chain this library knows.
    /// @dev Chain agnostic on purpose. The question a caller is asking is usually "is this the
    ///      dollar leg", not "is this the testnet dollar leg".
    function isUsdg(address token) internal pure returns (bool) {
        return token == USDG_TESTNET || token == USDG_MAINNET;
    }

    /// @notice The equity tokens verified for a chain, in registry order.
    /// @dev Mainnet returns an empty array rather than reverting, because there is nothing wrong with
    ///      asking and the answer is genuinely "none verified yet". Testnet reverts on an unknown
    ///      chain id, because there the caller has made a mistake.
    function equities(uint256 chainId) internal pure returns (Asset[] memory list) {
        if (chainId == TESTNET) {
            list = new Asset[](5);
            list[0] = Asset(0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, "TSLA", 18);
            list[1] = Asset(0x71178BAc73cBeb415514eB542a8995b82669778d, "AMD", 18);
            list[2] = Asset(0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02, "AMZN", 18);
            list[3] = Asset(0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93, "NFLX", 18);
            list[4] = Asset(0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0, "PLTR", 18);
            return list;
        }
        if (chainId == MAINNET) return new Asset[](0);
        revert UnknownChain(chainId);
    }

    /// @notice Look up one equity token by ticker on a chain.
    function equity(uint256 chainId, bytes32 symbol) internal pure returns (Asset memory) {
        Asset[] memory list = equities(chainId);
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i].symbol == symbol) return list[i];
        }
        revert UnknownSymbol(symbol);
    }

    /// @notice Whether `token` is one of the equity tokens verified for a chain.
    function isEquity(uint256 chainId, address token) internal pure returns (bool) {
        Asset[] memory list = equities(chainId);
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i].token == token) return true;
        }
        return false;
    }

    /// @notice Whether `token` is either leg this library has verified: the cash leg or an equity.
    /// @dev The useful check for a desk. It answers "did someone hand me a real contract, or a
    ///      lookalike", which is the one question the escrow itself cannot ask.
    function isVerified(uint256 chainId, address token) internal pure returns (bool) {
        return isUsdg(token) || isEquity(chainId, token);
    }

    /// @notice Render a ticker for display.
    /// @dev Symbols are stored as `bytes32`, which is exact and cheap on chain and awkward
    ///      everywhere else. `abi.encodePacked` on a `bytes32` gives 32 bytes with trailing zeros,
    ///      not a ticker, and a caller that reaches for that gets a string that looks right in a
    ///      debugger and compares wrong in a test. This is the one place the conversion happens, so a
    ///      console, a test and a registry lookup cannot disagree about what a symbol is.
    function symbolString(bytes32 symbol) internal pure returns (string memory) {
        uint256 length = 0;
        while (length < 32 && symbol[length] != 0) ++length;

        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            out[i] = symbol[i];
        }
        return string(out);
    }

    /// @notice Format an amount of a 6 decimal asset for display, without a floating point library.
    /// @dev USDG is 6 decimals, so an amount is a whole number of micro-dollars. This returns the
    ///      whole part and the six digit fraction separately, which is what a console actually needs
    ///      and is exact at every magnitude. A desk that divides by 1e6 in a `uint256` before it has
    ///      decided on a display format is how a rounding bug gets into a settlement screen.
    function split6(uint256 amount) internal pure returns (uint256 whole, uint256 fraction) {
        whole = amount / 1e6;
        fraction = amount % 1e6;
    }
}
