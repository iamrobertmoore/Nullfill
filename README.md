<p align="center"><img src="docs/brand/readme-banner.svg" alt="Nullfill. Settlement that stays correct when a transaction never happens." width="1000"></p>

<p align="center"><strong>An escrow for tokenised equities that stays correct when a transfer is never sequenced at all.</strong></p>

<p align="center"><a href="https://iamrobertmoore.github.io/Nullfill/">Open the settlement console</a> · <a href="https://iamrobertmoore.github.io/Nullfill/#classifier">Classify a transaction</a> · <a href="https://explorer.testnet.chain.robinhood.com/address/0x71029fac49E9b45CCC377812aEc01509FFD383A1">Deployed contract</a> · <a href="contracts/src/Nullfill.sol">Read the contract</a></p>

Ines runs settlement at a six-person desk that quotes tokenised equities on Robinhood Chain. Trades settle in escrow: her desk puts up the stock tokens, the counterparty puts up the cash, and the contract releases both when the trade completes.

The trouble is that on Robinhood Chain a submitted transaction has four possible fates, not two. Besides executing and reverting, it can be screened at the sequencer, in which case it is never sequenced at all. No revert, no receipt, no event, no gas. Her contract cannot see that anything was attempted. Neither can the counterparty, the indexer, or the auditor.

So when a settlement does not complete, Ines is left with a question she cannot answer for a day. Is this late, or is it never coming? Release the escrow early and she risks paying twice. Wait, and her capital sits idle. And if it is her own address that was screened, she cannot send the transaction that would recover the funds either, because that transaction would be screened too.

## The problem, counted

**A screened transfer leaves 0 bytes of on-chain trace, and the chain gives you 24 hours before you may treat it as gone.**

Both numbers are sourced rather than estimated. The zero is a property of the mechanism: the transaction is rejected before sequencing, so there is no receipt to find. The 24 hours is the Arbitrum force inclusion window, the period during which a transaction that was screened can still arrive by another route. Unwinding an escrow before that window closes is not caution, it is a bug, because the late arrival would settle on top of the refund.

## Try this

| Try this | Watch what happens |
|---|---|
| [Classify a transaction](https://iamrobertmoore.github.io/Nullfill/#classifier) | Paste any Robinhood Chain hash. The console reads a real receipt and tells you which of the four states it is in, and says plainly when it cannot tell. |
| [Open a screened escrow](https://iamrobertmoore.github.io/Nullfill/#detail-panel) | The escrow is untouched and still open. Nothing was spent, and nothing is recorded anywhere on chain. |
| [A bridge deposit that arrived nowhere](https://iamrobertmoore.github.io/Nullfill/#recovery-panel) | ETH left Ethereum, no credit landed on Robinhood Chain, and no system on either chain will ever mention it. |

## The problem, in the chain's own words

This is not a hypothetical I invented. Robinhood Chain documents the behaviour in the present tense, in a page about how the chain differs from Ethereum:

> Robinhood Chain maintains compliance standards through sequencer-level screening. While rare, this mechanism can influence smart-contract execution; for instance, any transaction associated with a sanctioned address will be excluded from inclusion. Standard read operations, such as `eth_call`, `eth_getLogs`, or balance queries, remain fully accessible and unaffected. Since a blocked transfer is never processed, it simply appears as though the event never occurred, ensuring indexers remain synchronized with the actual state.

Read the last sentence again. It is offered as a reassurance, and for an indexer it is. For anyone holding funds in escrow it is the bug.

The mechanism is Arbitrum's, introduced in ArbOS 61 and off by default. Robinhood turned it on, and their documentation links directly to Arbitrum's compliance filtering page. TRM Labs appears on the Robinhood Chain ecosystem page under Compliance and Risk Management, which is the same role Arbitrum's documentation names for the address list provider. So this is a mechanism with a named supplier, running on a live chain, described by both parties.

I reproduced it locally before writing any Solidity, on a Nitro testnode with the filter genuinely enabled. A transaction from a restricted address is rejected with `-32000 Transaction rejected by chain policy`. A transaction to a restricted address is rejected the same way. A balance query on a restricted address works perfectly. A control transaction between two unrestricted addresses succeeds. The full setup, including the three places where Arbitrum's documentation is wrong, is in [`docs/reproduction.md`](docs/reproduction.md).

## The failure the contract cannot fix, and the monitor that can

There is one path where this gets worse than a stalled settlement, and Arbitrum's own security notes describe it:

> If a restricted address deposits ETH via `depositEth()` on the parent chain, the ETH enters the bridge contract on the parent chain before any filtering occurs on the child chain. If the corresponding credit is dropped on the child chain, the ETH may become locked in the bridge with no corresponding child chain asset. Chain owners should account for this in their compliance design and user communication strategy.

Money leaves the wallet. It arrives nowhere. It is locked in a bridge contract, and the documentation's answer is that the chain owner should have a communication strategy about it. That strategy does not exist. Nothing on either chain will tell the user, because on the child chain nothing happened.

No contract can fix this, because the failure is on the other side of the bridge. So the console watches for it instead, matches parent chain deposits against child chain credits, and produces the evidence. That is the third panel on the page.

## How it works

![Nullfill architecture: three addresses, an escrow on Robinhood Chain, two routes in, four states out](docs/architecture.svg)

**The escrow holds tokens against a reference.** A reference can only be used once, and every state transition is one way, so a retried transaction cannot pay out twice. This matters more than usual here, because the natural human response to a transaction that did not land is to send it again.

**Unwind is permissionless.** Anyone can release an expired escrow to the recovery address. This is the single most important decision in the contract. The conventional pattern, "if the seller has not delivered by the deadline I will send myself the money back", requires the funder to be able to send a transaction. If the funder is the screened party, they cannot, and the funds are stuck forever. Making recovery permissionless means it never depends on the person most likely to be blocked.

**The recovery address is nominated before it is needed.** It is set when the escrow opens and can be changed while the escrow is still open. A desk whose primary address is restricted names a different address in advance, rather than discovering the problem when they can no longer transact.

**Both parties can settle, and the deadline only gates the refund.** If the beneficiary has been screened and cannot transact, the funder can still complete the settlement, and the tokens still go to the beneficiary. A late settlement is still a settlement, so settling remains available after the deadline. Only the refund is time gated.

**Every deadline is at least 24 hours out.** The contract enforces this, because it is the force inclusion window. A screened transaction can still arrive through the delayed inbox during that period, and Arbitrum closes that route deliberately with the Transaction Guardian precompile: a restricted transaction that does arrive is forcibly failed on inclusion and burns its attached gas. So force inclusion is not an escape hatch. It is a way to spend gas learning that you are blocked.

## The assets this settles

A settlement on this chain has two legs. Tokenised equity one way, dollars the other. The dollars are **USDG**, and that is not a choice made here to please anyone. It is the dollar Robinhood Chain names on its own ecosystem page, under Stablecoin, supplied by Paxos. The same page names TRM Labs as the compliance and risk management partner, so the chain's own partner list carries both the filter and the dollar.

The contract is asset agnostic. `open()` takes any `IERC20`, so nothing changes if a desk settles in a different dollar. What does not come for free is knowing which contract is the real one, so [`contracts/src/RobinhoodChain.sol`](contracts/src/RobinhoodChain.sol) pins the canonical addresses for both chains and the five verified testnet equities. Every address in it was read back from the chain rather than copied from a page.

**USDG is six decimals, not eighteen.** A desk escrowing 2,500 USDG is moving the integer `2500000000`, and a rounding step anywhere in that path is real money. So the property is stated once and fuzzed:

> Every micro-dollar that goes into a USDG escrow comes out again, to the unit, whichever way it leaves, and the escrow keeps nothing.

Two limits, stated rather than discovered.

**USDG cannot be minted by this project, and the route to acquiring testnet USDG is not documented.** The token has a role gated `mint` and no public one, and the chain's own docs list no faucet. The official faucet at `faucet.testnet.chain.robinhood.com` sits behind a bot check that could not be read from here, so whether it dispenses USDG is unverified. USDG is certainly live and moving on this chain, with 3,850 holders and 78,877 transfers as of 28 September, and an address was observed handing 100 USDG to a fresh wallet every few minutes. Somebody has a route. It is not one this project can prove. So the test suite uses a six decimal stand-in that mirrors the real interface, and [`test/Fork.t.sol`](contracts/test/Fork.t.sol) reads the real contract on chain.

**A hand-written decimal count is a claim, not a constant.** A token can be upgraded. The fork test re-reads every entry in the registry against a live chain and fails if any of them has moved.

## What this will not claim

Four limits, stated here rather than discovered by a reviewer.

**A failure receipt cannot tell you why it failed.** A contract revert and a transaction that arrived by force inclusion and was forcibly failed both produce a receipt with a failure status, no logs, and burned gas. Nothing in the receipt separates them.

**Screening is only directly observable at submit time.** If you did not send the transaction, you can never be certain it was screened rather than dropped. From outside, both leave nothing at all, and the console says so instead of guessing.

**The restricted address list is private, and should be.** Addresses are stored as salted hashes precisely so the list cannot be enumerated. Nothing here tries to reverse it and nothing here can tell you whether a given address is on it.

**Screening happens before execution, so the EVM cannot catch it.** A transfer to a restricted recovery address does not revert, it simply never runs. `try`/`catch` cannot help, and no contract can detect this from the inside. That is exactly why the recovery address has to be nominated in advance, and it is a real limitation rather than a design choice.

## Build and run

The console is static. No build step, no dependencies:

```bash
cd web && python3 -m http.server 8080
```

Then open `http://localhost:8080`. The live classifier works against Robinhood Chain testnet out of the box, and it will point at mainnet or a custom RPC from the dropdown.

The contract needs Foundry:

```bash
cd contracts
git submodule update --init --recursive
forge test
```

45 tests, four of them fuzzed, all passing. Four more run against a live chain and report as **skipped** rather than passed when there is no RPC, which is deliberate: a network check that quietly reports success when it did not run reads as evidence.

```bash
FOUNDRY_PROFILE=fork ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-path test/Fork.t.sol
```

The `fork` profile raises the EVM version to Cancun, and it is required rather than optional. The live tokens use `PUSH0` and this project deploys Paris bytecode, so without it every call to a real token fails with `EvmError: NotActivated`. The default stays Paris on purpose: the deployed contract is Paris bytecode and Paris bytecode runs on any chain at or above it.

There is one more check, and it is the one that matters most. It asserts that the bytecode on chain is what this repository compiles to, because a repository that does not match its own deployment is worse than a contract missing one hardening:

```bash
ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-path test/Deployment.t.sol
```

Run it under the default profile, not the fork profile, so the comparison is against the bytecode this project actually deploys.

To deploy to Robinhood Chain testnet:

```bash
cd contracts && forge script script/Deploy.s.sol:DeployNullfill --rpc-url https://rpc.testnet.chain.robinhood.com --private-key $PRIVATE_KEY --broadcast
```

The contract takes no constructor arguments and has no owner. A deployment is just the bytecode, and there is nothing to configure afterwards.

It is live on Robinhood Chain testnet at [`0x71029fac49E9b45CCC377812aEc01509FFD383A1`](https://explorer.testnet.chain.robinhood.com/address/0x71029fac49E9b45CCC377812aEc01509FFD383A1). `FORCE_INCLUSION_WINDOW()` returns `86400`, and `statusOf()` on an unknown reference returns `0`.

To drive one real order against that deployment, [`script/Demo.s.sol`](contracts/script/Demo.s.sol) takes one environment variable per step:

```bash
DEMO_ACTION=status forge script script/Demo.s.sol:Demo --rpc-url $RPC --sender 0x0000000000000000000000000000000000000000
```

`status` reads and needs no key. `open`, `settle` and `unwind` broadcast. It resolves the settlement asset itself, preferring USDG when the wallet is funded with it and falling back to the first equity the wallet holds, and it says which one it chose. A silent choice of asset is exactly the thing a reviewer would want to check.

## Prior art, and what is actually new

The mechanism is not mine. Arbitrum documents compliance filtering, Robinhood Chain documents that it is on, and Chainstack Labs publishes a sequencer feed decoder that names the same failure in its own risk warnings. None of that is a claim to novelty, and the honest version of this section names what already exists.

**Idempotent escrow already exists.** Paylock, built on Arbitrum Sepolia during this buildathon, rejects a second payment against a settled invoice with `already_settled`. Replay protection has been arrived at independently by more than one entry in this field, so it is not a differentiator, and this README does not lead with it. It appears here as one of four consequences of keying orders by an external reference.

**Deadline based release already exists.** Stagepay releases escrowed milestones to a freelancer when a review window passes in silence, and its suite fuzzes fund conservation over 2,000 runs. Nullfill has the same shape and the same test discipline, and the difference is the argument rather than the mechanism. Silence past a deadline is treated there as a decision. The claim here is that on this chain an absent transaction is not a decision, and acting on it before the force inclusion window closes is the bug.

**What does not exist** is anything that treats non-inclusion as a first class settlement outcome. A keyword sweep of the 86 projects in this buildathon's field on 28 September 2026 returns zero hits for `force inclusion`, `non-inclusion`, `restricted address`, `censorship` and `settlement finality`. Every escrow on every chain assumes a submitted transaction either lands or reverts. This one handles the third case, where it never happened, and names the two things that follow: recovery must not depend on the screened party transacting, and no deadline may sit inside the force inclusion window.

That is the claim. It is narrower than "nobody has thought about compliance on this chain", which would be false, and it is the one the code supports.

## Checking every claim on this page

Every number and address above can be checked rather than believed. This table is the list.

| Claim | How to check it | What you should see |
|---|---|---|
| **The deployment is this source** | `ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-path test/Deployment.t.sol` | 2 passing. This compares the bytecode on chain against what the repository compiles to, and it fails loudly if they diverge. |
| The contract is deployed and the window is 24 hours | `cast call 0x71029fac49E9b45CCC377812aEc01509FFD383A1 "FORCE_INCLUSION_WINDOW()(uint64)" --rpc-url https://rpc.testnet.chain.robinhood.com` | `86400` |
| USDG is at that address and is six decimals | `cast call 0x7E955252E15c84f5768B83c41a71F9eba181802F "decimals()(uint8)" --rpc-url https://rpc.testnet.chain.robinhood.com` | `6` |
| Every address in the registry still matches the chain | `FOUNDRY_PROFILE=fork ROBINHOOD_RPC=https://rpc.testnet.chain.robinhood.com forge test --match-path test/Fork.t.sol` | 3 passing |
| The contract's own test suite | `cd contracts && forge test` | 45 passing, 4 skipped |
| The console's own test suite | `cd web && npm test` | 22 passing |
| The asset panel really checks the chain | Open the deployed console and read the right hand column | Six rows, each saying what the chain said |
| The screening behaviour is real | [`docs/reproduction.md`](docs/reproduction.md), run the command in it | `-32000 Transaction rejected by chain policy` |
| The quotes are the chain's words | The four links under Sources | Each quote appears on the page linked |

Two of those rows are skipped rather than passed when there is no RPC, and one of them is the row that
matters most. A check that reports success when it did not run is worse than no check, so the counts
above name the skips rather than hiding them.

## Corrections

Claims this repository published and then changed. Kept because a correction is more useful than a silent edit, and because the list is the honest measure of how much of the rest survived checking.

**28 September 2026.** This README said the local reproduction was "written up in the repository history". It was not. No commit and no file mentioned it. The writeup now exists at [`docs/reproduction.md`](docs/reproduction.md), and the sentence points at it. The claim was true about the work and false about the record.

**28 September 2026.** The test count above said 29. It was 29 when written and 44 by the time anyone read it, because a second test file was added. A count is only meaningful with a date attached, and it had none.

**28 September 2026.** The deposit path accepted an amount without checking what arrived, so a fee on transfer token would have left one order able to spend another order's balance. Found while writing the USDG tests. The contract now measures the balance delta and reverts on a mismatch, and the reasoning is in the commit that made the change.

**28 September 2026.** An earlier internal note stated that no faucet dispenses USDG on this chain. That is not supported. The official faucet sits behind a bot check that could not be read, and an address was observed distributing 100 USDG to fresh wallets every few minutes. The claim was removed rather than softened.

## Where this goes next

The Arbitrum D.A.O. Grant Program runs in seasons and publishes its own evaluation rubrics and proposal templates, and it funds exactly this kind of primitive: small, verifiable, and useful to anyone else building on the chain. A settlement layer that other desks can build on is a better outcome than one desk's internal tool, and the grant programme is the route to it.

The nearer term work is the monitor. Detection is currently per transaction. The useful version watches a set of addresses continuously, matches parent chain deposits against child chain credits on a schedule, and tells a desk what it is holding that it does not know about.

## Sources

Every claim above is quoted from a primary source, checked on 15 September 2026.

- Robinhood Chain, [Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/), the Transaction screening section
- Arbitrum, [Compliance filtering](https://docs.arbitrum.io/launch-arbitrum-chain/configure-your-chain/advanced/compliance-filtering), including the force inclusion protection and parent chain bridge deposit notes
- Arbitrum, [Compliance filtering](https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/sequencer/compliance-filtering) configuration reference, the address list schema
- Robinhood Chain, [About](https://docs.robinhood.com/chain/), the ecosystem partner list

Built for the Arbitrum Open House Singapore online buildathon.
