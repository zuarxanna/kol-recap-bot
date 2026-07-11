# Guide Book — Using the KOL Recap Bot

Day-to-day usage. For architecture and installation, see [README.md](./README.md).

---

## The mental model

1. Keep a list of **KOLs** (name + their IG/TikTok/YouTube handles).
2. Keep a list of **campaigns**; exactly one is **active** at a time. A campaign is a
   `#hashtag` plus a `started_at` date.
3. Run **`/recap`** near the cutoff. The bot scrapes each KOL's recent content, keeps
   only posts tagged with the active campaign's hashtag, and returns a **CSV**.
4. Open the CSV in the team spreadsheet and finish the **manual columns** (tone,
   campaign constants) and **audit** anything the hashtag filter missed.

You interact either through the **Telegram bot** (day-to-day) or the **CLI**
(`npm run recap`, same output, no chat).

---

## First-time bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token into
   `TELEGRAM_BOT_TOKEN` in `.env`.
2. Find your Telegram user id via [@userinfobot](https://t.me/userinfobot) → put it in
   `TELEGRAM_ALLOWED_IDS` (comma-separated for multiple users).
3. Start the bot: `npm run bot` (or `docker compose up -d`).
4. Message the bot `/start` — you should see the help menu.

> **Money guard:** the bot triggers **paid** Apify scrapes. Only the ids in
> `TELEGRAM_ALLOWED_IDS` can use it; anyone else is refused. If the allowlist is empty
> the bot will not even start.

---

## Commands

### Recap & status

| Command | What it does |
| --- | --- |
| `/recap` | Recap the active campaign. Streams a metrics card per KOL as each finishes, then sends the summary + CSV file. Runs ~15–30s per KOL. |
| `/status` | Show the active campaign and the number of KOLs with an IG handle. |
| `/campaigns` | List all campaigns. |
| `/kols` | List all KOLs and their handles. |

While a `/recap` is running, a second `/recap` is rejected (prevents double-spend).

### Managing KOLs

| Command | Example |
| --- | --- |
| `/addkol Name \| ig_username` | `/addkol Jane Rider \| janerider_demo` |
| `/delkol <id>` | `/delkol 3` — asks for inline confirmation before deleting |

`/addkol` only sets the Instagram handle. To add a TikTok or YouTube handle to a KOL,
edit `db/kols.json` directly (set `tiktok_username` / `youtube_channel`), bare — no
`@`. The change is picked up on the next command; no restart needed.

### Managing campaigns

| Command | Example |
| --- | --- |
| `/addcampaign Name \| #hashtag \| YYYY-MM-DD` | `/addcampaign Demo Campaign \| #DemoOne \| 2026-06-27` |
| `/activate <id>` | `/activate 2` — makes this campaign active, marks the rest `ended` |

A new campaign is created inactive (`isActive: false`). Use `/activate` to switch which one is
live — there is always **exactly one** active campaign.

---

## A typical recap run

1. Make sure the right campaign is active: `/status` (switch with `/activate <id>` if
   needed).
2. Confirm your KOLs and handles: `/kols`.
3. Run `/recap`. Watch the per-KOL cards stream in.
4. When it finishes, the bot sends a summary line and the **CSV document**. Download it.
5. Open the CSV in the team spreadsheet and:
   - fill the **manual columns** — Kode, Product, Brand, Type Content, Tone Article,
     Value, Name of Event, ID;
   - **audit each KOL**: add any content the hashtag filter missed (posts the KOL did
     not tag), and remove any off-campaign post that happened to use the tag;
   - add TikTok/YouTube rows for any KOL whose handle you have not registered yet.

---

## Reading the result

The summary shows `N rows · cost $X`. An **empty or short CSV is not automatically a
bug** — check the server log's per-KOL diagnostic:

- `scraped N>0` but `matched 0` → the filter is working; the KOL simply did not tag the
  post. Audit manually.
- `scraped 0` / **all errored** → an actual scrape problem: wrong handle, private
  account, or a bad/empty API token.

Rows with `-` in the data columns mean the fetch was **attempted but failed** for a KOL
who does have that handle — fill those in manually.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Bot won't start, logs `TELEGRAM_ALLOWED_IDS is empty` | Set your user id in `.env`. |
| Bot ignores your messages | Your id is not in `TELEGRAM_ALLOWED_IDS`. |
| `/recap` says "No active campaign" | `/activate <id>` first, or add one with `/addcampaign`. |
| Bot stops responding (hosted on a laptop) | The machine slept (e.g. lid closed) and paused Docker. Host it on a VPS. |
| YouTube rows never appear | `YOUTUBE_API_KEY` is not set — YouTube is skipped by design. |
| Empty CSV | See [Reading the result](#reading-the-result) — usually the filter tradeoff, not a bug. |
