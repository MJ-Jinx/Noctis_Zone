# Changelog — Noctis Protocol

Notable changes to the Noctis Protocol, by release. Internal development history predating this file lives in a local, non-public record.

---

## [Unreleased]

### Changed

- Bonding curve trades on Tier A and Tier B are priced by summing the price of each
  token a trade moves through, so a trade costs the same whether it is made in one
  transaction or several. A buyer pays the range rounded up and a seller receives it
  rounded down. The validator computes both the price and the 2.0% fee split from its
  own state, so a trade names only an amount and a wallet.
- Any token amount can be traded. Fee slices floor independently and the remainder
  stays with the curve.
- Trade prices shown in the UI and the price chart are recomputed from the curve state
  each trade executed against, and are reported as an average per token — a large buy
  spans a range of prices rather than executing at one.
- Both bonding curve validators locate their own input and continuing output through
  one shared pair of helpers instead of repeating the lookup at each call site. The
  two helpers differ by intent: one requires a continuing output, and one returns an
  option for the checks that must distinguish "no continuing output" from "the wrong
  one" and reject the first cleanly. Both curves are smaller as a result and each fits
  in a single published reference script.

---

## [1.0.0] - 2026-07-31

Initial public release of the consolidated Noctis Protocol codebase.

- Cardano L1 contracts (Tier A, Tier B) — bonding curve, LP escrow, CTO governance, vesting, staking, ZK anchor, N-hop challenge
- Midnight Network contracts (Tier C, design-complete, build-blocked pending ecosystem dependencies) — bonding curve, eligibility gate, creator escrow, treasury, vesting, LP escrow, CTO governance, staking
- Integration layer — chain clients, ZK proof tooling, CLI submitters, browser widgets
- Full public documentation set — see [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/PSM_ARCHITECTURE.md](docs/PSM_ARCHITECTURE.md), [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md), and [ROADMAP.md](ROADMAP.md)

Going forward, entries here describe what shipped, not how it was built — see the docs above for architecture and security detail.
