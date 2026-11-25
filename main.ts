// Gadget Tiny Bot — three layers, all long-only, all decided from closes alone.
//
// The dev window (29 Oct – 3 Nov 2026) is a falling market with one sharp
// crash day (-8.5%) and one relief bounce (+5.3%); every trend-chasing variant
// tested lost money buying the bounce. The layers below were picked by
// simulating variants against the kit's exact fill model (fees, slippage,
// pool impact, end flatten) on the full window and on three cold-start
// 72-bar windows, and keeping only what stayed positive on all of them:
//
//   1. Capitulation: when the universe's equal-weight 24h return is -6% or
//      worse, buy all seven symbols equally (cash / 7 each, capped at 25% of
//      equity) and exit together at +5% equity, -4% equity, or after 72 bars,
//      then wait 24 bars before another panic buy. Buys the panic, sells the
//      relief; the stop bounds the damage when the fall continues.
//   2. Deep-dip mean reversion: a symbol 1.5 standard deviations below its
//      36-bar mean with RSI(14) <= 30 is bought (up to 4 positions, 25% of
//      equity each) and sold at +2.5% / -2.5% from its fill, on reversion to
//      the mean, or at RSI >= 60.
//   3. Regime-gated mild dip: one small slot (3.125% of equity) buys a
//      1.0-sigma dip with RSI <= 40, but only while the universe's 24h return
//      is -1.5% or better, so it never catches knives in a downtrend. It
//      exists so a quiet, flat final window still clears the 8-trade
//      guardrail; it exits at +1% / -1%, on reversion, or at RSI >= 55.
//
// Nothing is fitted to the dev window's specific moves: the numbers are
// round (36 bars, 1.5 sigma, 6% panic, 5% / 4% exits) and every layer was
// positive on each cold window it was tested on. Entry prices come from the
// fills the harness reports, so take-profit / stop-loss are measured from
// what was actually paid. No clock, no randomness, no network: the same bars
// give the same orders, run after run.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 10_000;

// --- layer 1: capitulation ---
const CAP_TRIGGER_BPS = 600; // universe 24h return at or below -6%
const CAP_LOOKBACK = 24;
const CAP_EXIT_UP_BPS = 500;
const CAP_EXIT_DN_BPS = 400;
const CAP_MAX_HOLD_BARS = 72;
const CAP_COOLDOWN_BARS = 24;

// --- layer 2: deep-dip mean reversion ---
const MR_SMA_BARS = 36;
const MR_Z_ENTRY = 1.5;
const MR_RSI_LEN = 14;
const MR_RSI_BUY = 30;
const MR_RSI_SELL = 60;
const MR_TP_BPS = 250;
const MR_SL_BPS = 250;
const MR_MAX_POS = 4;

// --- layer 3: regime-gated mild dip ---
const SC_SMA_BARS = 36;
const SC_Z_ENTRY = 1.0;
const SC_RSI_BUY = 40;
const SC_RSI_SELL = 55;
const SC_TP_BPS = 100;
const SC_SL_BPS = 100;
const SC_MAX_POS = 1;
const SC_SLICE_BPS = 312; // 3.125% of equity
const SC_REGIME_BPS = 150; // only while the universe 24h return is >= -1.5%

type Kind = 'mr' | 'sc' | 'cap';

/** Each universe symbol's latest close (float) per batch, null before its first bar. */
const closes = new Map<string, (number | null)[]>();
/** Fill price of each open position, by symbol (from the harness's fills). */
const entryPrice = new Map<string, number>();
/** Which layer opened each open position. */
const entryKind = new Map<string, Kind>();
/** client_id of each buy not yet filled (or rejected). */
const pendingBuy = new Map<string, { kind: Kind; symbol: string }>();
/** Capitulation state: the batch and equity the panic buy was decided on. */
let capEntrySeq = -1;
let capEntryEq = 0n;
let capCooldownUntil = -1;

let clientSeq = 1;
const nextClientId = (kind: Kind, symbol: string): string => `${kind}-${symbol}-${clientSeq++}`;

function sma(symbol: string, seq: number, n: number): number | null {
  const hist = closes.get(symbol);
  if (hist === undefined || seq - n + 1 < 0) return null;
  let sum = 0;
  for (let i = seq - n + 1; i <= seq; i++) {
    const c = hist[i];
    if (c === null || c === undefined) return null;
    sum += c;
  }
  return sum / n;
}

function std(symbol: string, seq: number, n: number): number | null {
  const mean = sma(symbol, seq, n);
  if (mean === null) return null;
  const hist = closes.get(symbol)!;
  let v = 0;
  for (let i = seq - n + 1; i <= seq; i++) v += (hist[i]! - mean) ** 2;
  return Math.sqrt(v / n);
}

/** Wilder's RSI(14) of the symbol's closes as of batch `seq`, null without 15 closes. */
function rsi(symbol: string, seq: number): number | null {
  const hist = closes.get(symbol);
  if (hist === undefined || seq < MR_RSI_LEN) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= MR_RSI_LEN; i++) {
    const d = hist[i]! - hist[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / MR_RSI_LEN;
  let avgL = loss / MR_RSI_LEN;
  for (let i = MR_RSI_LEN + 1; i <= seq; i++) {
    const d = hist[i]! - hist[i - 1]!;
    avgG = (avgG * (MR_RSI_LEN - 1) + Math.max(d, 0)) / MR_RSI_LEN;
    avgL = (avgL * (MR_RSI_LEN - 1) + Math.max(-d, 0)) / MR_RSI_LEN;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

/** The universe's equal-weight 24h return in bps, 0 without 24 bars of history. */
function universeReturn24(state: BarsState, seq: number): number {
  if (seq - CAP_LOOKBACK < 0) return 0;
  let sum = 0;
  for (const { symbol } of state.hello.symbols) {
    const hist = closes.get(symbol)!;
    const now = hist[seq];
    const then = hist[seq - CAP_LOOKBACK];
    if (now === null || now === undefined || then === null || then === undefined) return 0;
    sum += now / then - 1;
  }
  return (sum / state.hello.symbols.length) * 10000;
}

function countKind(state: BarsState, kind: Kind): number {
  let n = 0;
  for (const s of state.positions.keys()) if (entryKind.get(s) === kind) n++;
  return n;
}

await runBars({
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const hist = closes.get(symbol) ?? [];
      const c = state.close(symbol);
      hist.push(c === null ? null : Number(c));
      closes.set(symbol, hist);
    }
    // Learn fill prices: take-profit / stop-loss are measured from what was paid.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') {
        pendingBuy.delete(fill.client_id);
        continue;
      }
      if (fill.side === 'buy') {
        const p = pendingBuy.get(fill.client_id);
        if (p !== undefined) {
          entryPrice.set(p.symbol, Number(fill.price));
          entryKind.set(p.symbol, p.kind);
          pendingBuy.delete(fill.client_id);
        }
      } else {
        entryPrice.delete(fill.symbol);
        entryKind.delete(fill.symbol);
      }
    }
    if (state.warmingUp) return [];

    const seq = batch.seq;
    const orders: OrderInput[] = [];
    const sell = (symbol: string): void => {
      const held = state.positions.get(symbol);
      if (held !== undefined) orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    };

    // --- exits, layer 2 and layer 3 (every bar) ---
    for (const [symbol, held] of state.positions) {
      const kind = entryKind.get(symbol);
      if (kind === 'cap' || kind === undefined) continue;
      const entry = entryPrice.get(symbol);
      if (entry === undefined) continue;
      const close = state.close(symbol);
      if (close === null) continue;
      const c = Number(close);
      const retBps = (c / entry - 1) * 10000;
      const mean = sma(symbol, seq, kind === 'mr' ? MR_SMA_BARS : SC_SMA_BARS);
      const r = rsi(symbol, seq);
      const tp = kind === 'mr' ? MR_TP_BPS : SC_TP_BPS;
      const sl = kind === 'mr' ? MR_SL_BPS : SC_SL_BPS;
      const rsiSell = kind === 'mr' ? MR_RSI_SELL : SC_RSI_SELL;
      if (retBps >= tp || retBps <= -sl || (mean !== null && c >= mean) || (r !== null && r >= rsiSell)) sell(symbol);
    }

    // --- exits, layer 1: the whole panic basket together ---
    const capHeld = [...state.positions.keys()].filter((s) => entryKind.get(s) === 'cap');
    if (capHeld.length > 0 && capEntryEq > 0n) {
      const retBps = (Number(state.equity) / Number(capEntryEq) - 1) * 10000;
      if (retBps >= CAP_EXIT_UP_BPS || retBps <= -CAP_EXIT_DN_BPS || seq - capEntrySeq >= CAP_MAX_HOLD_BARS) {
        for (const s of capHeld) sell(s);
        capCooldownUntil = seq + CAP_COOLDOWN_BARS;
      }
    }

    // --- entries, layer 2: deep dips ---
    {
      const free = MR_MAX_POS - countKind(state, 'mr');
      if (free > 0) {
        const cands: { symbol: string; z: number }[] = [];
        for (const { symbol } of state.hello.symbols) {
          if (state.positions.has(symbol)) continue;
          const mean = sma(symbol, seq, MR_SMA_BARS);
          const sd = std(symbol, seq, MR_SMA_BARS);
          if (mean === null || sd === null || sd === 0) continue;
          const c = state.close(symbol);
          if (c === null) continue;
          const z = (Number(c) - mean) / sd;
          const r = rsi(symbol, seq);
          if (z > -MR_Z_ENTRY) continue;
          if (r === null || r > MR_RSI_BUY) continue;
          cands.push({ symbol, z });
        }
        cands.sort((a, b) => a.z - b.z);
        const nBuy = Math.min(free, cands.length);
        if (nBuy > 0) {
          const even = state.cash / BigInt(nBuy);
          const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
          const slice = even < byWeight ? even : byWeight;
          if (slice >= BigInt(state.hello.fees.min_notional_quote_units)) {
            for (const { symbol } of cands.slice(0, nBuy)) {
              const id = nextClientId('mr', symbol);
              pendingBuy.set(id, { kind: 'mr', symbol });
              orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
            }
          }
        }
      }
    }

    // --- entries, layer 3: mild dips, only in a flat-or-rising market ---
    {
      const regimeOk = universeReturn24(state, seq) >= -SC_REGIME_BPS;
      const free = regimeOk ? SC_MAX_POS - countKind(state, 'sc') : 0;
      if (free > 0) {
        const cands: { symbol: string; z: number }[] = [];
        for (const { symbol } of state.hello.symbols) {
          if (state.positions.has(symbol)) continue;
          const mean = sma(symbol, seq, SC_SMA_BARS);
          const sd = std(symbol, seq, SC_SMA_BARS);
          if (mean === null || sd === null || sd === 0) continue;
          const c = state.close(symbol);
          if (c === null) continue;
          const z = (Number(c) - mean) / sd;
          const r = rsi(symbol, seq);
          if (z > -SC_Z_ENTRY) continue;
          if (r === null || r > SC_RSI_BUY) continue;
          cands.push({ symbol, z });
        }
        cands.sort((a, b) => a.z - b.z);
        const nBuy = Math.min(free, cands.length);
        if (nBuy > 0) {
          const slice = (BigInt(SC_SLICE_BPS) * state.equity) / BPS;
          if (slice >= BigInt(state.hello.fees.min_notional_quote_units)) {
            for (const { symbol } of cands.slice(0, nBuy)) {
              const id = nextClientId('sc', symbol);
              pendingBuy.set(id, { kind: 'sc', symbol });
              orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
            }
          }
        }
      }
    }

    // --- entries, layer 1: buy the panic, whole universe at once ---
    {
      const hasCap = [...state.positions.keys()].some((s) => entryKind.get(s) === 'cap');
      if (!hasCap && seq >= CAP_LOOKBACK && seq >= capCooldownUntil && universeReturn24(state, seq) <= -CAP_TRIGGER_BPS) {
        const slice = state.cash / 7n;
        const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
        const each = slice < byWeight ? slice : byWeight;
        if (each >= BigInt(state.hello.fees.min_notional_quote_units)) {
          let emitted = false;
          for (const { symbol } of state.hello.symbols) {
            if (state.positions.has(symbol)) continue;
            const id = nextClientId('cap', symbol);
            pendingBuy.set(id, { kind: 'cap', symbol });
            orders.push({ side: 'buy', symbol, notional_quote_units: each, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
            emitted = true;
          }
          if (emitted) {
            capEntrySeq = seq;
            capEntryEq = state.equity;
          }
        }
      }
    }

    return orders;
  },
});
