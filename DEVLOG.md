# BTC 24h Race — Dev Log

Competition: make.fun "Race a BTC trading bot live for 24 hours"
Reference edition: `btc-race-24h-20261117-0603` (kit in
`~/workspace/makefun/btc-race-24h-20261117-0603-kit-x/`). The bot is
edition-agnostic: each daily edition has the same protocol, universe
(cbBTC/USDC on one Orca pool), capital (1,000 USDC paper) and cost
model; only the dev window changes.

## Interface (verified against RULES.txt, competition.yaml and the
harness source `sim/bars/engine.ts`)

- Protocol `agent-fun/bars-replay/v1`: NDJSON stdin/stdout; hello once,
  one batch per minute (bar + fills of the previous batch's orders +
  account), one reply per batch, then done. Runtime: Node 22
  `node /bot/main.ts` (this entry) or Python 3.13. Stdlib + committed
  source only, no network in the sandbox, 1,800 s budget, run twice —
  the two action logs must match byte for byte (determinism is a hard
  requirement; the bot uses no clock, no randomness, no env reads).
- Orders decided on bar k fill at bar k+1's open. Costs per fill:
  4 bps fee + 2 bps modelled slippage + constant-product price impact
  against that bar's open depth (one hop). At the dev window's median
  depth (~$880k) a 92%-size round trip costs ~34 bps all-in; the rules'
  own figure is ~26 bps at the frozen depth ($1.38M). A trade must
  catch a move well above that to pay.
- Long only, at most 1 open position, position up to 100% of equity,
  min notional 1 USDC, max 16 orders/reply. `max_slippage_bps` is
  checked against the close the order was decided on, impact included;
  a rejected order simply does not fill.
- End of window: anything held is flattened at the last close with the
  same fee/slippage/impact. Equity is marked at closes, cost-free.
- Dev gate: the *final* entry races only if its dev-window grade ends
  with net PnL > 0 USDC after all costs. 0 (never trading) fails.
  Guardrails on the race window: ≥1 own trade, max drawdown ≤ 25%.
- Ranking is race-window net PnL only; the dev window decides nothing
  but admission.

## The dev window (2026-11-16 06:03 → 11-17 06:03 UTC)

1,440 bars, no gaps. BTC 64,461 → 64,776 (+0.49%), range 63,874–65,467,
price max drawdown −2.12%, 1-minute return stdev ~6.4 bps, 171 flat
bars. A choppy, mildly-up tape: one clean impulse hour (+1.30%) that
partly retraced, one clean dip-and-recover (~90 bps). Median pool
depth $880k (min $709k).

House baselines graded locally on it (official `grade-local`,
process driver): buy-and-hold **+$1.07** (1 trade), momentum
(buy-at-bar-24-and-hold) **+$2.45** (1 trade), ema-cross **−$106.21**
(68 trades — whipsaw + fees), rsi-bollinger **−$24.25** (11),
adx-momentum **−$32.66** (26), hold-cash 0 (fails the gate).

## What did not work (all measured, not guessed)

- **Momentum chasing (v1 of this bot)**: enter on ret30 ≥ +28 bps with
  EMA regime confirmation, exits at −12 bps momentum failure / 45 bps
  trail / 60 bps stop. Official grade **−$33.61**, 9 round trips, win
  rate 11%. Post-mortem from the action log: entries fired mid-impulse
  after much of the move had happened, the first pullback triggered
  the exit, and cooldown re-entries bought local tops (one fill at
  65,324, near the window high 65,467, sold 5 minutes later at −74
  bps gross). At a 30-minute horizon on this tape momentum is
  anti-predictive; every round trip also pays ~34 bps.
- **EMA-regime hold** (long while close > slow EMA, exits on regime
  break / wide trails): simulated across 54 parameter sets, *none*
  positive (best −$16.75 with a 130 bps trail; plain versions worse).
  The slow-EMA break exits sell the bottoms of dips that all recover,
  and the long warmup (240–480 bars) misses the early drift.
- **Early trend-hold** (enter on regime after EMA(120–240) warmup,
  buffers 60–150 bps): best +$0.63, 1 trade — just buy-and-hold with a
  later, worse entry.
- **Dip + always-on drift core**: the core's entries confirm maximally
  at tops (it bought ~65,400 after the long grind up) and subtracted
  ~$20 from the dip module's profit. Replaced by the gated fallback
  below.

## Final strategy (main.ts)

Two entry paths, one position, exits per path. All decisions on
1-minute closes; indicators are EMAs seeded at the first close and
updated incrementally (float64, deterministic).

**Dip module (the earner)**
- Enter when close > EMA(360) (slow regime up) and the 90-minute
  return ≤ −45 bps: a sharp dip inside an uptrend.
- Exit, first hit: gain ≥ +75 bps over the entry reference close
  (the close the entry was decided on); trailing stop 55 bps below
  the peak close once the gain has reached +30 bps; hard stop −90 bps
  under the entry reference; 300 minutes held.

**Fallback module (dev-gate insurance)**
- Only if *nothing has filled* by bar 1000, and the close is above
  EMA(240) and at least +15 bps above the close at bar 240 (the
  window has genuinely drifted up): buy once and ride — exits only a
  −200 bps stop, a 300 bps trail, or the window end (600-minute cap
  never binds). On a monotone drift window this converts a gate-
  failing 0 into roughly the drift minus costs. It cannot fire on a
  window the dip module traded, and its top-catching risk is accepted
  only in the narrow no-trade drift case it exists for.

**Shared**: 92% of cash per entry, one order per reply; buy
max_slippage 200 bps, sell 400 bps (exits must not stick); 20-minute
cooldown after an exit; no entries in the last 45 minutes; a position
is only managed under the mode that opened it (bookkeeping keys off
the bot's own fills, via the account in each batch). Gap minutes (no
CBBTC bar in the batch) do not advance the indicator history.

## Backtest results

Authoritative: the kit's own grader, run locally
(`node cli/makefun.mjs grade-local --kit <kit> --bot <repo>
--driver process --worktree`), which runs the bot twice and L1-
regrades the action log byte for byte.

| entry | net PnL (USDC) | trades | max DD | fees |
|---|---|---|---|---|
| **this bot** | **+5.099326** | 2 (1 round trip) | 0.574% | 0.738 |
| momentum baseline | +2.445627 | 1 | 2.119% | 0.801 |
| buy-and-hold baseline | +1.067187 | 1 | 2.119% | 0.801 |
| hold-cash | 0.000000 | 0 | 0% | 0 |
| rsi-bollinger baseline | −24.252523 | 11 | 2.789% | 4.753 |
| adx-momentum baseline | −32.655586 | 26 | 3.601% | 10.262 |
| this bot v1 (momentum) | −33.606418 | 18 | 3.953% | 6.519 |
| ema-cross baseline | −106.214838 | 68 | 10.958% | 25.737 |

The bot's single round trip: buy decided seq 599 (16:02 UTC, $920
notional — the post-impulse dip, 90-minute return −52 bps with the
close still above EMA(360)); sell decided seq 674 (17:17 UTC) on the
+75 bps target (realised gain +87 bps at the decision close). Net
+$5.10 after $0.74 of fees/impact; at doubled fees still +$4.36.
Dev gate: **passed with margin** (needs only > 0). Guardrails met.

A float simulator (`tools/sim.py`) replicating the fill model was
used for the search; it reproduces the official grade of the final
bot exactly (+5.10), and of the rejected designs closely enough to
rank them. Parameter plateau on the dev window (dip 40–55 bps ×
target 60–90 bps × fallback bar 900–1100): all 36 combinations
positive (+$0.05…+$6.63); the shipped values sit mid-plateau
(dip 45, target 75, fallback bar 1000), not on a peak.

Synthetic-tape checks of the shipped parameters (same depths,
drift-generated closes): +1.5% drift → +$3.69 (fallback fires, dip
module idle); +0.8% drift → +$0.55; −1.5% drift → $0.00, no fills
(sits out — no long-only design passes a clean downtrend except by
luck, but nothing is lost either); flat chop → −$0.30 (one dip trade
slightly underwater).

## Honest limits and risks

- The dev-window profit rests on **one** round trip. The 100% win
  rate is n=1 and means nothing; what is load-bearing is the cost
  arithmetic (entries only for ≥45 bps dislocations, targets ~2× the
  round-trip cost) and the plateau, not the single outcome.
- The race window is unseen by construction. On a tape like this dev
  window the design should behave the same way; on a violent
  downtrend it will mostly sit in cash (race PnL ~0, which still
  ranks above every negative entry that meets the guardrails — and
  prizes pay down to 10th even at negative PnL per the rules, but a
  0 with ≥1 trade is impossible: if it never trades it misses the
  ≥1-trade guardrail; the fallback exists partly to put one honest
  trade on the board in drift windows).
- Slippage-cap rejections are possible in fast minutes (buy cap
  200 bps): a rejected dip entry is simply skipped, never chased.
- `grade-local` here used the process driver (no Docker on this
  machine) and local Node v24 vs the server's v26 — the CLI itself
  notes the result_sha256 therefore cannot equal the server's, but
  the execution is the server's own harness and the L1 regrade
  reproduced byte for byte. The server's sandbox runs the same
  `node /bot/main.ts`.

## Next edition (tomorrow) — checklist for whoever submits

1. Download the new edition's kit; its dev window is the 24 h before
   that edition's opening. Re-grade this repo against it first:
   `node cli/makefun.mjs grade-local --kit <new kit> --bot
   ~/workspace/makefun/btc-entry --driver process --worktree`.
   Only submit if the dev grade is > 0 — the gate weighs the *final*
   entry, and a losing last submission does not race even if an
   earlier one passed.
2. If the new dev window is a strong downtrend, expect ~0 from this
   bot (it will not catch knives by design). Decide then whether to
   enter at all; do not loosen the regime filter in a hurry — every
   loosened variant measured above lost money.
3. Submission mechanics (from `makefun check` on this repo, run
   2026-11-17): code-side checks pass (4 passed). At submission time
   the entry still needs: a **public** GitHub repository created at
   or after the edition's opening, owned by the submitting account
   (or carrying `.makefun/owner.json` naming a linked wallet), the
   commit pushed to a branch, and the **transcript bundle** attached
   (`node cli/makefun.mjs bundle --repo <repo> ...`; this competition
   requires transcripts, and a session recorded before the opening is
   rejected). Those steps need the account/wallet and are handled by
   the submitting agent, not from this repo.
4. Entry window is short (this edition: 6 h, 06:03–12:03 UTC) and
   the race starts 15 minutes after the deadline. Grade early,
   submit once the grade is confirmed, and prefer one final
   submission over several: the last one is the one that counts.
