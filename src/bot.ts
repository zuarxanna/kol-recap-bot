// bot.ts — Telegram trigger + deliver + manage db (long-polling, no webhook).
//
// MONEY GUARD: the bot triggers paid Apify scrapes. HARD ALLOWLIST via
// TELEGRAM_ALLOWED_IDS (.env, comma-separated user ids). An unknown id is ignored.
// Without an allowlist the bot refuses to start (fail-closed) — so no open bot can
// drain the balance.
//
// Run:  tsx src/bot.ts   (dev)   |   node dist/src/bot.js   (built)
// Requires in .env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS, APIFY_TOKEN
// (YOUTUBE_API_KEY optional).

import 'dotenv/config';
import { Telegraf, Markup, Context } from 'telegraf';
import { runRecap } from './recap.js';
import { Campaign, Kol } from './model/index.js';
import type { ContentRecord, KolResult } from './types.js';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS } = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN is missing from .env');
  process.exit(1);
}
// fail-closed: without an allowlist, do NOT start (an open bot = anyone drains Apify)
const ALLOWED: number[] = String(TELEGRAM_ALLOWED_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
if (ALLOWED.length === 0) {
  console.error('FATAL: TELEGRAM_ALLOWED_IDS is empty. Set the allowed user ids (comma-separated). The bot refuses to start without an allowlist.');
  process.exit(1);
}

// handlerTimeout Infinity: /recap is intentionally long (multi-KOL Apify scrape).
// Telegraf's default 90s -> p-timeout rejection -> process CRASH. We manage the duration
// ourselves (the run-lock prevents pile-up).
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: Infinity });

// --- lock: prevent two /recap runs at once (Apify double-spend) ---
let recapRunning = false;

// --- HTML formatting helpers (parse_mode HTML chosen over MarkdownV2: only 3 escapes) ---

const HTML = { parse_mode: 'HTML', disable_web_page_preview: true } as const;

/**
 * Escape a dynamic value for HTML. MUST wrap EVERY dynamic value (name/title/error)
 * because < & > can come from a caption or error message.
 */
const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Format a number for chat display (en-US grouping, e.g. 649,644). CSV stays raw. */
const num = (n: number | string): string =>
  typeof n === 'number' ? n.toLocaleString('en-US') : n === '' || n == null ? '-' : String(n);

/** Reply with the shared HTML options merged in. */
const say = (ctx: Context, text: string, extra?: object): Promise<unknown> =>
  ctx.reply(text, { ...HTML, ...extra });

/** Edit the current message text with HTML options. */
const editHtml = (ctx: Context, text: string): Promise<unknown> =>
  ctx.editMessageText(text, HTML) as Promise<unknown>;

/** Shorten a URL for display (strip scheme/www and trailing slashes). */
const shortUrl = (u: string): string =>
  String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

/** Extract the raw text of the incoming message (empty string if none). */
const commandText = (ctx: Context): string => {
  const msg = ctx.message;
  return msg && 'text' in msg ? msg.text : '';
};

/** Format a campaign for display. */
const fmtCampaign = (c: Campaign): string =>
  `<b>#${c.id} ${esc(c.name)}</b>\n` +
  `tag <code>${esc(c.hashtag)}</code> · ${esc(c.status)} · since <code>${esc(String(c.started_at).slice(0, 10))}</code>`;

/** Format a KOL for display. */
const fmtKol = (k: Kol): string =>
  `<b>#${k.id} ${esc(k.name)}</b>\n` +
  `ig ${k.ig_username ? '<code>@' + esc(k.ig_username) + '</code>' : '-'}` +
  ` · tt ${k.tiktok_username ? '<code>@' + esc(k.tiktok_username) + '</code>' : '-'}` +
  ` · yt ${k.youtube_channel ? '<code>' + esc(k.youtube_channel) + '</code>' : '-'}`;

/** Format one content card: name | platform | handle / metrics / tappable link. */
const card = (r: ContentRecord): string =>
  `<b>${esc(r.name)}</b> | ${esc(r.platform)} | <code>@${esc(r.handle)}</code>\n` +
  `👁 ${num(r.views)}  ❤ ${num(r.likes)}  💬 ${num(r.comments)}\n` +
  `🔗 <a href="${esc(r.url)}">${esc(shortUrl(r.url))}</a>`;

/**
 * Send content cards in chunks under ~3500 chars (Telegram's limit is 4096) so a large
 * batch does not fail.
 */
async function sendCards(ctx: Context, records: ContentRecord[]): Promise<void> {
  const sep = '\n──────────────\n';
  let buf = '';
  for (const r of records) {
    const c = card(r);
    if (buf && buf.length + sep.length + c.length > 3500) {
      await say(ctx, buf);
      buf = c;
    } else {
      buf = buf ? buf + sep + c : c;
    }
  }
  if (buf) await say(ctx, buf);
}

// --- error contact + safety-net reply ---
const IT_CONTACT = 'Ikhsun Tampan';
const IT_CONTACT_URL = 'https://t.me/zuarxanna'; // CHANGE if the IT handle differs
const ERR_MSG = `⚠️ Internal error. Contact IT: <b>${IT_CONTACT}</b>.`;

/** Extra options for an error message: HTML + a tap-to-contact button. */
const errExtra = (): object => ({
  ...HTML,
  ...Markup.inlineKeyboard([Markup.button.url(`Contact ${IT_CONTACT}`, IT_CONTACT_URL)]),
});

// Telegraf safety net: an error in a handler must not kill the process.
bot.catch((err: unknown, ctx: Context) => {
  console.error('bot error:', err);
  recapRunning = false; // release the lock if the error happened during /recap
  try {
    ctx.reply?.(ERR_MSG, errExtra());
  } catch {
    /* ignore */
  }
});

// --- allowlist middleware: an unknown id is ignored (reply once, then stop) ---
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (uid == null || !ALLOWED.includes(uid)) {
    console.warn(`BLOCKED uid=${uid} name=${ctx.from?.username || '?'}`);
    if (ctx.chat) await ctx.reply('Not for you. Access denied.');
    return; // do NOT next() — the command does not run
  }
  return next();
});

// --- /start, /help --- (<id> is escaped to &lt;id&gt; so it is not read as an HTML tag)
const HELP = [
  '<b>KOL Metrics Recap bot</b>',
  '',
  '/recap — recap the active campaign, send the CSV',
  '/status — active campaign + KOL count',
  '/campaigns — list all campaigns',
  '/kols — list all KOLs',
  '',
  '<b>Manage KOLs</b>',
  '<code>/addkol Name | ig_username</code>',
  '<code>/delkol &lt;id&gt;</code> — needs confirmation',
  '',
  '<b>Manage campaigns</b>',
  '<code>/addcampaign Name | #hashtag | YYYY-MM-DD</code>',
  '<code>/activate &lt;id&gt;</code> — the others become ended',
].join('\n');

bot.start((ctx) => say(ctx, HELP));
bot.help((ctx) => say(ctx, HELP));

// --- /status ---
bot.command('status', (ctx) => {
  const c = Campaign.active();
  const igCount = Kol.all().filter((k) => k.ig_username?.trim()).length;
  if (!c) return say(ctx, `No active campaign.\n<b>KOLs with IG:</b> ${igCount}`);
  return say(ctx, `<b>Active campaign</b>\n${fmtCampaign(c)}\n\n<b>KOLs with IG:</b> ${igCount}`);
});

// --- /campaigns ---
bot.command('campaigns', (ctx) => {
  const list = Campaign.all();
  if (!list.length) return say(ctx, 'No campaigns yet.');
  return say(ctx, list.map(fmtCampaign).join('\n\n'));
});

// --- /kols ---
bot.command('kols', (ctx) => {
  const list = Kol.all();
  if (!list.length) return say(ctx, 'No KOLs yet.');
  return say(ctx, list.map(fmtKol).join('\n\n'));
});

// --- /recap ---
bot.command('recap', async (ctx) => {
  const c = Campaign.active();
  if (!c) return say(ctx, 'No active campaign. Run /activate first.');
  if (recapRunning) return say(ctx, 'A recap is already running. Wait for it to finish.');

  recapRunning = true;
  await say(
    ctx,
    `⏳ Starting recap <b>${esc(c.name)}</b> <code>#${esc(String(c.hashtag).replace(/^#/, ''))}</code>...\nApify scrape per KOL (~15-30s/KOL). Progress is sent as each KOL finishes.`,
  );
  try {
    // Progress streaming: as each KOL finishes -> send only its content metric cards
    // (no diagnostic summary). Diagnostics stay in the server log + totals at the end.
    const onKolDone = async (res: KolResult): Promise<void> => {
      if (res.records.length) await sendCards(ctx, res.records);
    };

    const r = await runRecap({ onKolDone });

    // Final: totals + CSV. (Diagnostics & cards were already streamed per KOL above.)
    const summary = [
      `<b>✅ Done: ${esc(r.campaign.name)}</b> <code>#${esc(r.hashtag)}</code>`,
      `<b>${r.records.length} rows</b> · cost $${r.totalCost.toFixed(4)}`,
      r.records.length === 0
        ? '\nEmpty CSV — scraped&gt;0 but 0 matched = the filter tradeoff (audit manually); scraped 0 / all errored = a scrape problem.'
        : '\nReminder: fill <b>Tone</b> + audit missed (untagged) content in the spreadsheet.',
    ].join('\n');
    await say(ctx, summary);
    await ctx.replyWithDocument({ source: r.outPath });
  } catch (e) {
    console.error('recap error:', e);
    await say(ctx, `Recap failed: ${esc(e instanceof Error ? e.message : String(e))}`);
  } finally {
    recapRunning = false;
  }
  return undefined;
});

// --- /addkol Name | ig_username ---
bot.command('addkol', (ctx) => {
  const arg = commandText(ctx).replace(/^\/addkol(@\S+)?\s*/, '');
  const [name, ig] = arg.split('|').map((s) => s.trim());
  if (!name || !ig) return say(ctx, 'Format: <code>/addkol Full Name | ig_username</code>');
  if (Kol.findByIg(ig)) {
    return say(ctx, `A KOL with ig <code>@${esc(ig)}</code> already exists.`);
  }
  const kol = new Kol({ name, ig_username: ig }).save();
  return say(ctx, `✅ Added:\n${fmtKol(kol)}`);
});

// --- /delkol <id> -> inline confirmation ---
bot.command('delkol', (ctx) => {
  const id = Number(commandText(ctx).replace(/^\/delkol(@\S+)?\s*/, '').trim());
  if (!id) return say(ctx, 'Format: <code>/delkol &lt;id&gt;</code>');
  const kol = Kol.find(id);
  if (!kol) return say(ctx, `KOL #${id} does not exist.`);
  return say(
    ctx,
    `Delete this KOL?\n${fmtKol(kol)}`,
    Markup.inlineKeyboard([
      Markup.button.callback('Yes, delete', `delkol:${id}`),
      Markup.button.callback('Cancel', 'cancel'),
    ]),
  );
});

bot.action(/^delkol:(\d+)$/, (ctx) => {
  const id = Number(ctx.match[1]);
  const kol = Kol.find(id);
  if (!kol) {
    void ctx.answerCbQuery();
    return editHtml(ctx, `KOL #${id} no longer exists.`);
  }
  kol.delete();
  void ctx.answerCbQuery('Deleted');
  return editHtml(ctx, `🗑 Deleted: #${id} <b>${esc(kol.name)}</b>`);
});

bot.action('cancel', (ctx) => {
  void ctx.answerCbQuery('Cancelled');
  return editHtml(ctx, 'Cancelled.');
});

// --- /addcampaign Name | #hashtag | YYYY-MM-DD (status ended; /activate to enable) ---
bot.command('addcampaign', (ctx) => {
  const arg = commandText(ctx).replace(/^\/addcampaign(@\S+)?\s*/, '');
  const [name, tag, since] = arg.split('|').map((s) => s.trim());
  if (!name || !tag || !since) {
    return say(ctx, 'Format: <code>/addcampaign Name | #hashtag | YYYY-MM-DD</code>');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return say(ctx, 'started_at must be YYYY-MM-DD.');
  const hashtag = tag.startsWith('#') ? tag : '#' + tag;
  const c = new Campaign({ name, hashtag, status: 'ended', started_at: since, ended_at: null }).save();
  return say(ctx, `✅ Added (status ended, <code>/activate ${c.id}</code> to enable):\n${fmtCampaign(c)}`);
});

// --- /activate <id> — set active, the rest become ended (keep the single-active invariant) ---
bot.command('activate', (ctx) => {
  const id = Number(commandText(ctx).replace(/^\/activate(@\S+)?\s*/, '').trim());
  if (!id) return say(ctx, 'Format: <code>/activate &lt;id&gt;</code>');
  const active = Campaign.activate(id);
  if (!active) return say(ctx, `Campaign #${id} does not exist.`);
  return say(ctx, `✅ Active now:\n${fmtCampaign(active)}`);
});

// --- launch (long-polling) ---
// getMe() first: validate the token + connectivity before polling (launch() itself
// resolves on STOP, not start, so it cannot be used to know polling has begun).
const me = await bot.telegram.getMe();
void bot.launch();
console.log(`bot @${me.username} running. allowlist: ${ALLOWED.join(', ')}`);

/** Notify every allowlisted user (best-effort; send failures are ignored). */
async function notifyAll(text: string, extra?: object): Promise<void> {
  for (const id of ALLOWED) {
    try {
      await bot.telegram.sendMessage(id, text, extra ?? HTML);
    } catch {
      /* ignore */
    }
  }
}

// PROCESS SAFETY NET: an unhandled error must NOT crash the runtime. Log + release the
// recap lock + notify the user (contact IT). Do NOT process.exit.
// (Resuming after uncaughtException is theoretically risky, but for this single-user bot
// it is a deliberate choice: better alive + notify than silently dead.)
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  recapRunning = false;
  void notifyAll(ERR_MSG, errExtra());
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  recapRunning = false;
  void notifyAll(ERR_MSG, errExtra());
});

// stop can throw if shutdown races startup — guard it.
const stop = (sig: 'SIGINT' | 'SIGTERM'): void => {
  try {
    bot.stop(sig);
  } catch {
    /* not started yet, ignore */
  }
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
