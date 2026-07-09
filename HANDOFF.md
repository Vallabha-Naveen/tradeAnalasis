# HANDOFF: Telegram Trade Analyzer → Live Auto-Trading

## What Exists Today

A **Node.js + TypeScript** project that:
1. Downloads historical trade screenshots from a Telegram channel (user-auth, not bot)
2. Analyzes them offline to detect **NIFTY/BANKNIFTY** (symbol) and **CE/PE** (option type)
3. Stores results in SQLite

**Current pipeline is batch/offline only.** There is NO live monitoring or order placement yet.

---

## Project Structure

```
src/
├── app.ts                          # Main entry — DOWNLOAD ONLY, no analysis
├── config/config.ts                # Env vars: API_ID, API_HASH, CHANNEL_USERNAME, paths
├── telegram/
│   ├── auth.ts                     # Telegram user-auth (phone+OTP), session persistence
│   ├── historyDownloader.ts        # Batch download past messages, incremental via msg ID dedup
│   ├── mediaDownloader.ts          # Download single photo from a Telegram message
│   └── liveListener.ts             # ⚠️ STUB — placeholder for live message listening
├── database/
│   ├── db.ts                       # SQLite singleton (better-sqlite3, WAL mode)
│   ├── schema.ts                   # CREATE TABLE trades (all snake_case columns)
│   └── tradeRepository.ts          # CRUD — has snake→camel mapper (COLUMN_MAP + toTradeRow)
├── analyzer/
│   ├── detectSymbolByWhitespace.ts # NIFTY vs BANKNIFTY via header whitespace ratio
│   ├── detectOptionType.ts         # CE/PE via multi-strategy OCR (3 strategies + tiebreaker)
│   ├── detectSymbol.ts             # OLD bar-width approach (deprecated, still used for bar metrics)
│   ├── ocr.ts                      # Tesseract wrapper (recognizeBuffer)
│   ├── confidence.ts               # DetectionScore<T> type, clampConfidence()
│   └── detectTimestamp.ts          # Timestamp extraction (not critical)
├── models/Trade.ts                 # Domain types: Trade, TradeRow, TelegramMeta, etc.
├── scripts/
│   ├── analyze.ts                  # Offline analysis: validation → whitespace → CE/PE OCR
│   ├── calibrateWhitespace.ts      # Calibration pipeline for whitespace thresholds
│   ├── query.ts                    # Query trade records
│   └── reprocess.ts                # Reprocess with newer parser
└── utils/
    ├── logger.ts                   # Winston logger
    ├── image.ts                    # Sharp helpers
    └── file.ts                     # File system helpers
```

---

## How Analysis Works (Current)

### Step 1: Screenshot Validation (3-gate)
In `analyze.ts` → `validateScreenshot()`:
- **Gate 1:** Portrait orientation (H > W), height ≥ 800px, aspect ratio 0.30–0.75
- **Gate 2:** Colored pixel scan (top 200px) — must have ≥ 300 colored pixels in densest row
- **Gate 3:** Contiguous colored bar must be 30%–70% of image width

Non-trade screenshots (charts, text posts, memes) get filtered here and marked as skipped.

### Step 2: Symbol Detection (NIFTY vs BANKNIFTY)
In `detectSymbolByWhitespace.ts`:
- Crop header (top 100px), upscale 4x for OCR
- Find the **rightmost OCR word** (highest x1 coordinate)
- `remainingWhitespace = imageWidth - rightMostX`
- Classify using calibrated Gaussian distributions (z-score comparison)
- Calibration file: `config/whitespace-calibration.json`

### Step 3: CE/PE Detection
In `detectOptionType.ts`:
- Find the red bar position via colored pixel scanning
- Run 3 OCR strategies **in parallel**:
  1. Full-width inverted band (80px) — best overall
  2. Post-bar focused with 24 Y-offset scans
  3. Tall inverted band (120px) for deep text
- Majority vote. Tiebreaker: 17 narrow-band scans (requires ≥2 votes)
- Handles fuzzy OCR misreads: CF→PE, GE→CE
- False-positive guards: rejects PEOPLE, PEACE, RECEIPT, etc.

---

## Database Schema

```sql
CREATE TABLE trades (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_message_id   INTEGER NOT NULL,
  telegram_channel_id   TEXT NOT NULL,
  telegram_message_time TEXT NOT NULL,   -- ISO 8601
  symbol                TEXT DEFAULT NULL,     -- NIFTY / BANKNIFTY
  option_type           TEXT DEFAULT NULL,     -- CE / PE
  strike                REAL DEFAULT NULL,
  quantity              INTEGER DEFAULT NULL,
  confidence            REAL NOT NULL DEFAULT 0,
  detection_method      TEXT DEFAULT NULL,
  image_path            TEXT NOT NULL,
  processed_at          TEXT NOT NULL,
  inserted_at           TEXT NOT NULL,
  parser_version        TEXT NOT NULL DEFAULT '0.1.0',
  caption               TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
-- UNIQUE INDEX on (telegram_channel_id, telegram_message_id)
```

**IMPORTANT:** All DB columns are snake_case. The repository (`tradeRepository.ts`) has a `COLUMN_MAP` + `toTradeRow()` mapper that converts to camelCase before passing to `rowToTrade()`. Any new read methods MUST use `toTradeRow()` — never cast raw SQLite rows directly to `TradeRow`.

---

## Key Technical Decisions

1. **Telegram user-auth, not bot.** Uses `telegram` npm package (gramJS) with `StringSession`. First run prompts for phone+OTP, session saved to disk.
2. **Tesseract v5** for OCR. Needs 4-10x upscaling (lanczos2) to read small header text.
3. **Sharp** for all image manipulation (crop, resize, extract, raw pixel access).
4. **better-sqlite3** (synchronous) — not async. Good for single-process use.
5. **Separate download and analyze.** `npm start` downloads only. `npm run analyze` processes offline.
6. **The red bar is ALWAYS red** in this trading app. Bar color does NOT indicate CE/PE.

---

## NEW REQUIREMENT: Live Monitoring + Auto-Trading

### Goal
Continuously monitor the same Telegram group in real-time. When a trade screenshot is posted:
1. Download the image
2. Analyze it (reuse existing detection pipeline)
3. Fire the same trade in the user's **Fyers** brokerage account

### User Requirements
- **Fyers API: GREENFIELD** — user has not used Fyers API before, needs full integration from scratch
- **Safeguards: YES** — must have risk controls
- **Dry-run first: YES** — paper trading / simulation mode before real money

### What Needs to Be Built

#### 1. Live Telegram Listener (replace `liveListener.ts` stub)
- Use `client.addEventHandler()` from gramJS to listen for new messages in real-time
- Filter for photo messages only
- Download + analyze + trade in a single pipeline
- Must reuse existing `downloadMessagePhoto()`, `validateScreenshot()`, `detectByWhitespace()`, `detectOptionTypeByOcr()`

#### 2. Fyers API Integration (NEW module)
- Fyers API v3: https://api-docs.fyers.in/
- Auth: OAuth2 flow (get auth code → get access token → refresh token)
- Key endpoints needed:
  - **Order placement:** Place NIFTY/BANKNIFTY options orders (CE/PE)
  - **Order book:** Check order status
  - **Positions:** Check open positions
  - **Funds/limits:** Check available margin
- Need to figure out:
  - Lot size for NIFTY (usually 25) and BANKNIFTY (usually 15)
  - How to find the correct strike price and symbol token
  - Market hours check (only trade during 9:15 AM – 3:30 PM IST)
  - Order types: MARKET vs LIMIT

#### 3. Trade Execution Engine (NEW module)
- Takes analysis result (symbol + optionType) and converts to a Fyers order
- Needs strike price detection (currently NOT implemented — only symbol + CE/PE are detected)
- **QUESTION:** Does the user want to trade AT-MONEY (ATM) options? Or does the screenshot show a specific strike?

#### 4. Risk Management / Safeguards (NEW module)
Suggested safeguards:
- **Max order value per trade** (e.g., max ₹50,000)
- **Daily loss limit** — stop trading if cumulative loss exceeds threshold
- **Max open positions** — limit concurrent positions
- **Max trades per day** — prevent runaway trading
- **Order confirmation** (optional) — require manual approve for first N trades in dry-run
- **Market hours only** — no orders outside 9:15–3:30 IST
- **Cooldown between trades** — prevent rapid-fire orders
- **Confidence threshold** — only trade if detection confidence > X%

#### 5. Dry-Run / Paper Trading Mode
- All the same logic, but instead of calling Fyers order API:
  - Log what order WOULD have been placed
  - Track paper P&L against actual market prices (optional)
  - Compare paper trades vs real market movement to validate strategy
- Controlled via env var: `DRY_RUN=true`

#### 6. DB Schema Changes
Likely need new tables:
- `orders` — track every order placed (real or paper)
- `trades_executed` — link Telegram signal → Fyers order
- `daily_stats` — daily P&L, trade count, limits tracking

---

## Environment Variables (Current + Needed)

### Current (.env)
```
API_ID=...
API_HASH=...
SESSION_PATH=session.telegram-trade-analyzer
CHANNEL_USERNAME=...
DATABASE_PATH=./database/trades.db
DOWNLOAD_DIRECTORY=./downloads/raw
LOG_LEVEL=info
HISTORY_START_DATE=2025-01-01
PARSER_VERSION=0.2.0
```

### New (to be added)
```
# Fyers API
FYERS_APP_ID=...
FYERS_APP_SECRET=...
FYERS_REDIRECT_URI=http://localhost:8080
FYERS_ACCESS_TOKEN=...
FYERS_REFRESH_TOKEN=...

# Trading mode
DRY_RUN=true
MAX_ORDER_VALUE=50000
DAILY_LOSS_LIMIT=10000
MAX_DAILY_TRADES=20
CONFIDENCE_THRESHOLD=70
```

---

## Important Notes for the New Agent

1. **This project runs on Windows** (user's machine at `E:\vallabhaneni\work\trades\`)
2. **Node.js + TypeScript** — strict mode, ESM imports with `.js` extensions
3. **The `tradeRepository.ts` snake→camel fix was just applied** — make sure new code follows the same pattern
4. **The existing `analyze.ts` pipeline is the reference** for the full analysis flow (validation → whitespace → CE/PE)
5. **Strike price is NOT currently detected** — only symbol (NIFTY/BANKNIFTY) and option type (CE/PE). For auto-trading, you'll need to either:
   - Add strike price OCR (complex)
   - Trade ATM options (simpler, just need to find current ATM strike via Fyers quote API)
6. **The user wants this as a SEPARATE conversation/session** — do NOT try to merge with the existing codebase history