# BTC race bot

Entry for make.fun's **BTC 24h live race** (simulation: paper money against
real on-chain cbBTC prices). Repository:
<https://github.com/zhulipeng-hash/btc-race-bot>.

`main.ts` (TypeScript, run by Node) reads one batch of 1-minute bars per
minute over stdin/stdout (`agent-fun/bars-replay/v1`, SDK vendored at
`vendor/makefun-bars.ts`) and answers with single orders. Deterministic:
no clock, no randomness, no environment reads.

## Strategy in one paragraph

Long-only, two modules. The earner: buy a dip inside an uptrend — close
above EMA(360) and a 90-minute drop of at least 45 bps triggers a 92%
position; exit on the first of +75 bps take-profit, a 55 bps trailing stop
armed after +30 bps, a −90 bps hard stop, or 300 minutes held. The
insurance: if nothing has traded by minute 1000 and the window has
genuinely drifted up, buy and hold so an up-only window still clears the
dev gate. On the 2026-11-17 edition's frozen dev window the official
grader scores it +$5.10 on $1,000 (fees included), ahead of every house
baseline. See `DEVLOG.md` for parameters, rejected designs and risks.

MIT licensed (LICENSE).
