<p align="center"><img src="docs/brand/readme-banner.svg" alt="Nullfill. Settlement that stays correct when a transaction never happens." width="1000"></p>

<p align="center"><strong>An escrow for tokenised equities that stays correct when a transfer is never sequenced at all.</strong></p>

<p align="center"><a href="https://iamrobertmoore.github.io/Nullfill/">Open the settlement console</a> · <a href="https://iamrobertmoore.github.io/Nullfill/#classifier">Classify a transaction</a> · <a href="contracts/src/Nullfill.sol">Read the contract</a></p>

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

I reproduced it locally before writing any Solidity, on a Nitro testnode with the filter genuinely enabled. A transaction from a restricted address is rejected with `-32000 Transaction rejected by chain policy`. A transaction to a restricted address is rejected the same way. A balance query on a restricted address works perfectly. A control transaction between two unrestricted addresses succeeds. The full setup, including the three places where the documentation is wrong, is written up in the repository history.

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

29 tests, two of them fuzzed, all passing. To deploy to Robinhood Chain testnet:

```bash
forge script script/Deploy.s.sol:DeployNullfill \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --private-key $PRIVATE_KEY --broadcast
```

The contract takes no constructor arguments and has no owner. A deployment is just the bytecode, and there is nothing to configure afterwards.

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
