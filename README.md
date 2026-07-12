# trade-health-tracker

A self-hosted **multi-exchange futures trading health & PNL tracker**. Connect read-only API
keys from one or more exchanges and get a single dashboard of your realized PNL, win rate, fees,
rebates, loss patterns, position-sizing behavior, and holding-time habits. First-class adapters
for **Gate.io** and **Deepcoin**; the core is exchange-agnostic so more can be added.

Everything runs locally. Trade data is cached in a local SQLite file; API keys are stored on your
own machine and never leave it. This is a personal analytics tool, **not** a bot and **not**
financial advice.

---

## Requirements

- **Node.js ≥ 18** and npm (the only hard requirement; `better-sqlite3` builds a native module,
  so a working C/C++ toolchain may be needed on first `npm install`).
- **Read-only API keys** for the exchange(s) you want to track. No trade/withdraw permissions are
  needed or wanted.
- Windows is only required if you want the optional auto-start / auto-update scripts
  (Task Scheduler + PowerShell). The server itself runs anywhere Node runs.

## Install & run

```bash
# 1. get the code (git OR just download the ZIP from GitHub and extract)
git clone https://github.com/rijyori/trade-health-tracker.git
cd trade-health-tracker

# 2. install dependencies
npm install

# 3. start the server
npm start
```

Then open **http://localhost:3010** and click the gear (⚙) to add accounts. Pick the exchange,
paste a read-only API key/secret (Deepcoin also needs a passphrase), and optionally set your
rebate/voucher rate per account. Keys are verified on save and stored in the local SQLite DB.
Change the port with the `PORT` environment variable.

## Windows: always-on with auto-update (optional)

For an always-on box (e.g. a spare PC), the `scripts/` folder registers a Task Scheduler job that
starts the server on logon and keeps it up to date **without requiring git on the machine**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
```

- `start.ps1` — runs on logon: checks GitHub for a newer version and starts the server. If the
  update check fails (offline, etc.) it silently starts the existing code, so the app always comes up.
- `update.ps1` — **force update now**: compares the latest commit SHA via the GitHub API, and if it
  differs, downloads the repo ZIP archive, applies it over the working copy (leaving `data/` and
  `.env` untouched), runs `npm install` if dependencies changed, and restarts. No git needed.
- `restart.ps1` — stop + start the scheduled task (`schtasks /end` + `/run`).

Runs as the logged-in user at limited integrity — no admin rights needed at runtime.

---

## What the charts tell you

The dashboard is built around **trade-level** analytics (positions are reconstructed FIFO from raw
order fills, so entry fees are attributed to the matching exit). Beyond the summary cards, calendar,
and cumulative PNL curve, there are four distributions and two scatter plots designed to surface
**behavioral** problems that a single PNL number hides:

- **Net PNL vs Position Size** (scatter) — X is the notional size you put on, Y is realized net PNL.
  It separates *sizing discipline* from *edge*: a cloud of large losses at large sizes means your
  worst outcomes cluster where you bet the most. Reference lines show avg/median/max win & loss as
  horizontal dollar levels and as diagonal % lines (return relative to size); loss lines are mirrored
  onto the win side so you can eyeball your true win/loss asymmetry (payoff ratio).
- **Net PNL vs Holding Time** (scatter) — X is how long the position was held. The diagonal
  reference lines are **RPH (return per hour)**, i.e. dollars earned/lost per hour held. Great for
  spotting whether you bleed on trades you sit in too long, or cut winners too early.
- **Net PNL Distribution** vs **Expected PNL Distribution** (histograms) — the shape of your
  outcomes. *Net* is after fees; *Expected* adds your configured rebate/voucher rate
  (`Expected = Net + |fee| × rebateRate`). With no rebate the two are identical; side by side they
  show how much rebates move you across break-even.
- **Return% Distribution** and **Holding Time Distribution** — the spread of percentage returns and
  of holding durations, win vs loss. Fat left tails, or losers held far longer than winners, jump out.

Histograms use a **square-root y-axis** so that rare tail bins (1–2 trades) stay visible without the
crowded center bars dominating, while keeping a true zero baseline.

Core domain formulas (exchange-agnostic, computed after normalization):

```
Net PNL       = pnl(GROSS) − |fee| + rebate
Expected PNL  = Net PNL + |fee| × rebateRate
```

---

## Exchange API gotchas (notes for future integrators / agents)

These are real, empirically-verified quirks of the **Gate.io** and **Deepcoin** futures APIs that
cost hours to diagnose. Documenting them here so the next person (or AI agent) integrating these
exchanges can find them:

### Gate.io (USDT-margined futures, `/api/v4/futures/usdt`)

- **`orders` and `my_trades` silently ignore `from`/`to`.** The plain list endpoints return only a
  recent window regardless of the time range you pass — you *think* you have full history but you
  don't. Use the **`orders_timerange`** and **`my_trades_timerange`** endpoints for real
  time-bounded pagination.
- **Order IDs lose precision in `JSON.parse`.** Gate.io order IDs are 18–19 digit integers that
  exceed JS `Number.MAX_SAFE_INTEGER`; naive `JSON.parse` silently corrupts the last digits and
  collapses distinct orders. Parse the ID fields as **strings** (regex-based pre-parse) before
  `JSON.parse` touches them.
- **1 contract ≠ 1 unit of the underlying.** Notional must use the contract's `quanto_multiplier`
  from `/futures/usdt/contracts` (e.g. BTC_USDT is 0.0001 BTC/contract). Multiply
  `size × avgPrice × multiplier` for true notional.
- **Partial fills:** filled quantity is `abs(size) − abs(left)`, not `abs(size)`.

### Deepcoin (OKX-style, `/deepcoin/...`)

- **The `before` cursor is silently ignored on `trade/orders-history`.** Any value returns the same
  recent page, so pagination appears to "run out" after ~10 days when it's really just re-serving
  overlapping rows. Paginate with **`after`** instead — then you get the full history and an honest
  empty page at the end.
- **Don't filter on `state = 'filled'`.** Orders that actually executed can end up as
  `partially_filled_canceled`; filtering to `filled` drops legitimate fills and undercounts PNL.
  Filter on **`accFillSz > 0`** instead.
- **Rate limits are per-endpoint, not global.** e.g. orders-history ≈ 5 req/s, positions/instruments
  ≈ 10 req/s. A global 1 req/s throttle is needlessly slow; throttle per `apiKey::endpoint`.
- Signing is **HMAC-SHA512** over `method + "\n" + path + "\n" + query + "\n" + SHA512(body) + "\n" + ts`.

### Normalized storage

Raw responses are mapped to a shared orders/trades schema (modeled on Deepcoin/OKX field names).
Every table carries an `exchange` column and uses a composite `(exchange, id)` primary key, because
order IDs are only unique *within* an exchange — two exchanges can collide.

---

## License / disclaimer

Personal project, provided as-is. Read-only by design. Nothing here is investment advice.
