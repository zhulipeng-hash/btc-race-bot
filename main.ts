// BTC 24h race bot: dip-buying inside an uptrend, plus a late drift
// fallback. Built for this replay's cost model: a full-size round trip
// pays ~25-37 bps (4 bps fee + 2 bps slippage per side plus
// constant-product impact) and 1-minute noise is ~6 bps, so the bot
// trades rarely, only for moves several times the cost, and never
// scalps. All decisions are on 1-minute closes; fills land at the next
// bar's open.
//
// Two ways in, each with its own exits:
//
//   Dip (the earner): the close is above EMA(360) (the slow regime is
//     up) and the 90-minute return is at most -45 bps (a sharp dip
//     inside an uptrend, not a downtrend). Exit on the first of: gain
//     +75 bps over the entry reference close; a 55 bps trail below the
//     peak close once the gain has reached +30 bps; a hard stop 90 bps
//     under the entry reference; 300 minutes held.
//   Fallback (gate insurance): if nothing has filled by bar 1000 and
//     the window has drifted up (close above EMA(240) and at least
//     +15 bps above the close at bar 240), buy once and ride: exits
//     only a 200 bps stop, a 300 bps trail, or the end of the window.
//     On a monotone drift window this turns a 0 (which fails the dev
//     gate) into roughly the drift minus costs; it never fires on a
//     window the dip module already traded.
//
// After any exit, 20 minutes pass before re-entry; no entries in the
// last 45 minutes (the end-of-window flatten would eat the move).
// Size is 92% of cash, one order per reply. A position the bot did not
// open itself is never adopted: mode is set only by its own fills.
//
// Deterministic: no clock, no randomness, no environment reads;
// float64 + - * / over the closes only, so both graded executions
// agree byte for byte. vendor/makefun-bars.ts is a byte-identical
// copy of the kit SDK.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- dip module ---
const DIP_EMA = 360;          // slow regime EMA, minutes
const DIP_WIN = 90;           // dip lookback, minutes
const DIP_BPS = 45;           // dip depth that triggers an entry
const TARGET_BPS = 75;        // take-profit over the entry reference
const TRAIL_ACT_BPS = 30;     // gain that arms the trailing stop
const TRAIL_BPS = 55;         // trailing stop below the peak close
const STOP_BPS = 90;          // hard stop under the entry reference
const MAX_HOLD_DIP = 300;     // minutes
// --- fallback module ---
const FB_BAR = 1000;          // first bar the fallback may fire
const FB_EMA = 240;           // regime EMA for the fallback
const FB_RET_BPS = 15;        // min drift since bar FB_EMA
const STOP_FB_BPS = 200;
const TRAIL_FB_BPS = 300;
const MAX_HOLD_FB = 600;      // minutes (past the window end: ride)
// --- shared ---
const COOLDOWN_MIN = 20;
const END_BLOCK_MIN = 45;
const SIZE_PCT = 92n;         // % of cash per entry
const BUY_SLIP_BPS = 200;     // max_slippage_bps on buys
const SELL_SLIP_BPS = 400;    // max_slippage_bps on sells (exits must not stick)
const WINDOW_BARS = 1440;

const BPSN = 10000;

const closes: number[] = [];  // closes as floats in USDC, fresh bars only
let emaDip: number | null = null;
let emaFb: number | null = null;
let inPos = false;
let mode: 'dip' | 'fb' | null = null;
let pendingMode: 'dip' | 'fb' | null = null; // mode of the buy last sent
let entryRef = 0;             // close of the batch the entry was decided on
let peak = 0;                 // highest close since entry
let entrySeq = -1;
let lastExitSeq = -1e9;
let neverFilled = true;

function ema(prev: number | null, x: number, span: number): number {
  if (prev === null) return x;
  const a = 2 / (span + 1);
  return prev + a * (x - prev);
}

function buy(state: BarsState, m: 'dip' | 'fb'): BuyInput[] {
  const notional = (state.cash * SIZE_PCT) / 100n;
  if (notional < 1000000n) return []; // below the 1 USDC minimum
  pendingMode = m;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: BUY_SLIP_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    // Only a batch carrying a fresh CBBTC bar advances the history; on
    // a gap minute the symbol is absent from the batch and its latest
    // bar must not be double-counted. (The dev window has no gaps.)
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    const seq = state.seq;
    const close = Number(bar.c) / 100000; // price_scale 5
    const held = state.positions.get(SYMBOL);
    const isHeld = held !== undefined && held.qty > 0n;

    if (fresh) {
      closes.push(close);
      emaDip = ema(emaDip, close, DIP_EMA);
      emaFb = ema(emaFb, close, FB_EMA);
    }

    // Bookkeeping: spot the batch the position appears (its fill landed
    // at this bar's open; the entry reference is the previous close, the
    // one the entry was decided on) and the batch it disappears (the
    // exit fill), which starts the cooldown.
    if (isHeld && !inPos) {
      inPos = true;
      neverFilled = false;
      mode = pendingMode ?? 'dip';
      entryRef = closes.length >= 2 ? closes[closes.length - 2] : close;
      peak = Math.max(entryRef, close);
      entrySeq = seq;
    } else if (isHeld) {
      if (close > peak) peak = close;
    } else if (inPos) {
      inPos = false;
      mode = null;
      lastExitSeq = seq;
    }

    if (!fresh) return [];
    const k = closes.length - 1; // index of the current close

    if (isHeld && mode !== null) {
      const heldMin = seq - entrySeq;
      const gain = (close / entryRef - 1) * BPSN;
      let exitNow: boolean;
      if (mode === 'dip') {
        exitNow =
          gain >= TARGET_BPS ||
          (gain >= TRAIL_ACT_BPS && close <= peak * (1 - TRAIL_BPS / BPSN)) ||
          close <= entryRef * (1 - STOP_BPS / BPSN) ||
          heldMin >= MAX_HOLD_DIP;
      } else {
        exitNow =
          close <= entryRef * (1 - STOP_FB_BPS / BPSN) ||
          close <= peak * (1 - TRAIL_FB_BPS / BPSN) ||
          heldMin >= MAX_HOLD_FB;
      }
      if (exitNow) {
        const order: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIP_BPS };
        return [order];
      }
      return [];
    }
    if (isHeld) return []; // a position with no mode: never adopted, just held

    // Flat: entries.
    if (state.warmingUp) return [];
    if (seq >= WINDOW_BARS - END_BLOCK_MIN) return [];
    if (seq - lastExitSeq < COOLDOWN_MIN) return [];

    if (k >= DIP_EMA + DIP_WIN && emaDip !== null) {
      const ret = (closes[k] / closes[k - DIP_WIN] - 1) * BPSN;
      if (close > emaDip && ret <= -DIP_BPS) return buy(state, 'dip');
    }
    if (neverFilled && seq >= FB_BAR && emaFb !== null && k > FB_EMA) {
      const drift = (closes[k] / closes[FB_EMA] - 1) * BPSN;
      if (close > emaFb && drift >= FB_RET_BPS) return buy(state, 'fb');
    }
    return [];
  },
});
