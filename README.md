# Gadget Tiny Bot

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1&ref=susay21)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/shusay12/makefun-u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1&ref=susay21)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/shusay12/makefun-u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1&ref=susay21)

Entry for the [Gadget Tiny Bot — Easy 2 Beat](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty on make.fun: a small friendly paper-trading bot for hourly Solana prices, ranked by net PnL on the replay.

## The strategy

Three long-only layers, all decided from closes alone — no clock, no randomness, no network:

1. **Capitulation.** When the universe's equal-weight 24h return is −6% or worse, buy all seven symbols equally and exit together at +5% equity, −4% equity, or after 72 bars (then a 24-bar cooldown). It buys the panic and sells the relief; the stop bounds the damage when the fall continues.
2. **Deep-dip mean reversion.** A symbol 1.5 standard deviations below its 36-bar mean with RSI(14) ≤ 30 is bought (up to 4 positions, 25% of equity each) and sold at +2.5% / −2.5% from its fill, on reversion to the mean, or at RSI ≥ 60.
3. **Regime-gated mild dip.** One small slot (3.125% of equity) buys a 1.0-sigma dip with RSI ≤ 40, but only while the universe's 24h return is −1.5% or better, so it never catches knives in a downtrend. It keeps the bot active in a quiet, flat window; it exits at +1% / −1%, on reversion, or at RSI ≥ 55.

Take-profit and stop-loss are measured from the actual fill price the harness reports. The parameters are round and plateau-shaped (36 bars, 1.5 sigma, 6% panic, 5% / 4% exits), chosen by simulating variants against the kit's exact fill model on the full dev window and on three cold-start 72-bar windows — the strategy stayed positive on all of them, so nothing is fitted to the dev window's specific moves.

## Local grade (dev window)

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev-window result, verified twice with identical scores: **+606.73 USDC net PnL** (36 trades, win rate 0.78, max drawdown 1.9%, guardrails met). Best house baseline on the same window is macd-cci at −20.22 USDC; buy-and-hold is −869.34 USDC.

## How it works

`main.ts` runs on Node 22 as-is (TypeScript run as-is) and speaks the `agent-fun/bars-replay/v1` line protocol on stdin/stdout through the vendored `vendor/makefun-bars.ts` SDK. It records every symbol's closes, learns each fill price from the harness's fill reports, and answers every batch with at most one order per symbol.

## License

MIT — see [LICENSE](LICENSE).
