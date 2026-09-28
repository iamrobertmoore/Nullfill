# Reproducing the screening behaviour locally

The README says the screening mechanism was reproduced on a local Nitro testnode before any Solidity
was written, and that the three places where the documentation is wrong are written up. This is that
writeup. It exists because the claim was published before the writeup was, which is the wrong order,
and this is the correction.

Everything below runs on a local chain. **None of it requires, or should involve, sending a
transaction to a real restricted address on a live network.**

## Why reproduce it at all

Arbitrum's documentation says, in bold:

> **Compliance Filtering is disabled by default.** Chain owners must explicitly configure and enable
> each component.

So the premise of this project rests on an assumption that cannot be read off a page: that the
mechanism, when enabled, does what the documentation says. A chain operator's prose is not a
measurement. Bringing up a node with the filter genuinely on is.

## What was run

`nitro-testnode`, the official Arbitrum development chain, with transaction filtering enabled:

```
BUILDX_CONFIG=/tmp/dockercfg/buildx ./test-node.bash --init --l2-tx-filtering
```

That brings up a local L2 on chain id `412346` at `127.0.0.1:8547`, with a configurable restricted
address list. One throwaway address was added to the list, and then transactions were sent from it,
to it, and between two unrestricted addresses as a control.

## What it does

Four outcomes, not two. All four were observed or confirmed against primary sources.

| Path | What the sender sees | On-chain trace | Gas |
|---|---|---|---|
| Normal inclusion | Receipt, success | Full | Normal |
| Revert | Receipt, failure | Full | Spent |
| Screened at the sequencer | RPC error `-32000 Transaction rejected by chain policy` | **None at all** | **Not spent** |
| Screened, arriving via delayed inbox | Included, **forcibly failed** | Failure receipt | **Spent, deliberately** |

The third row is the premise of this repository. The transaction is rejected before sequencing, so
there is no receipt, no log, no event and no gas. A balance query on the same address still works
perfectly, because the filter applies to writes and not to reads.

The fourth row is the one that surprises people, and it is why the contract encodes a 24 hour window.
The obvious objection to any product in this space is "so use force inclusion". Arbitrum closed that
door deliberately:

> **Force inclusion protection:** Without STF-level enforcement via the Transaction Guardian, a
> restricted user could bypass Sequencer filtering by waiting for the force inclusion window. The
> sentinel + precompile combination closes this gap.

> When the STF processes a transaction from the delayed inbox, it checks whether that transaction's
> hash has been registered in the guardian. If so, the transaction is **forcibly failed on inclusion,
> consuming any gas attached to prevent spam**.

So force inclusion is not a rescue route. It is a way to spend gas learning that you are blocked, and
it produces a failure receipt that is indistinguishable from an ordinary revert.

## Three places the documentation is wrong

Each of these cost real time to work out, and all three are still live. They are recorded here
because anyone else attempting this build will hit them.

**1. The address list schema in the docs is incomplete.** The documentation shows four keys: `salt`,
`hashes`, `issued_at`, `hashing_scheme`. A node rejects a list with exactly those keys. It needs six:

```json
{
  "id": "<uuid>",
  "extract_uuid": "<uuid>",
  "salt": "<uuid>",
  "issued_at": "<timestamp>",
  "hashing_scheme": "sha256-rawbytesinput",
  "hashes": ["<sha256 hex>"]
}
```

`id` and `extract_uuid` are missing from the documentation. Without `id` the sequencer rejects the
file with `invalid filter set ID UUID: invalid UUID length: 0`, and **silently keeps the previous
list**, logging only an `ERROR` line. A filter that fails to load looks exactly like a filter that
loaded and matched nothing.

**2. The documented default hashing scheme is not the one the tooling uses.** The documentation
presents `sha256-stringinput` first, as though it were the default. The testnode's own `config.ts`
uses `sha256-rawbytesinput`, over the raw 16 salt bytes and the raw 20 address bytes:

```
sha256(salt_16_raw_bytes || address_20_raw_bytes)
```

with the salt's dashes stripped and the address lowercased, with no `0x` prefix.

**3. The flag name in the docs does not exist.** The documentation nests the address filter under
`--execution.transaction-filtering.address-filter.enable`. The flag that actually exists is
`--execution.transaction-filtering.enable`. The incorrect form appears in the testnode's own
`scripts/config.ts` as well as in the docs.

The authoritative copies of all three are in the testnode's own `config.ts` and in the generated
`initial_address_hashes.json` in the config volume. Read those, not the docs.

## What this does not establish

Three things stay open, and they are stated here rather than left for a reviewer to find.

**Whether Robinhood Chain runs the same configuration.** The mechanism is confirmed by their
documentation, which points directly at Arbitrum's compliance filtering page and names TRM Labs as
the compliance and risk management partner on their ecosystem page. The configuration itself is not
observable from outside. The contract is designed to be correct whether or not the delayed inbox
layer is active, which is the only honest way to handle it.

**Whether the 24 hour force inclusion window is the value in use on this chain.** 24 hours is the
documented default and is what the contract encodes. It was not measured on Robinhood Chain.

**Which addresses are on the list.** Addresses are stored as salted hashes precisely so that the list
cannot be enumerated, and that is the correct design. Nothing here attempts to reverse it, and nothing
here can tell you whether a given address is on it.

## A note on the local testnode

The testnode used for this reproduction is a checkout of Arbitrum's own `nitro-testnode`, and it is
not committed here. Reproduce it with the command above rather than by trusting this document. If the
documentation has been fixed since, and the three bugs above no longer apply, that is a better outcome
than being right.
