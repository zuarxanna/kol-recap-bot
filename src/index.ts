import 'dotenv/config';
import { Telegraf, Markup, Context } from 'telegraf';
import { runRecap } from './recap/index.js';
import { Campaign, Kol } from './model/index.js';
import type { KolHandleField } from './model/index.js';
import type { ContentRecord, KolResult } from './types.js';

/**
 * Map a `/setkol` field alias to the actual {@link Kol} handle column. Operators type the
 * short code `ig` / `tt` / `yt` instead of the raw field name.
 */
const HANDLE_FIELDS: Record<string, KolHandleField> = {
  ig: 'ig_username',
  tt: 'tiktok_username',
  yt: 'youtube_channel',
};

const { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_IDS } = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN is missing from .env');
  process.exit(1);
}

/**
 * Allowlisted Telegram user ids (the money guard).
 *
 * @remarks
 * The bot triggers paid Apify scrapes, so access is fail-closed: parsed from
 * `TELEGRAM_ALLOWED_IDS` (comma-separated), and if empty the bot refuses to start so no
 * open bot can drain the balance. Unknown ids are ignored by the allowlist middleware.
 */
const ALLOWED: number[] = String(TELEGRAM_ALLOWED_IDS || '')
  .split(',')
  .map((rawId) => rawId.trim())
  .filter(Boolean)
  .map(Number);
if (ALLOWED.length === 0) {
  console.error('FATAL: TELEGRAM_ALLOWED_IDS is empty. Set the allowed user ids (comma-separated). The bot refuses to start without an allowlist.');
  process.exit(1);
}

/**
 * The Telegraf bot instance.
 *
 * @remarks
 * `handlerTimeout: Infinity` because `/recap` is intentionally long (multi-KOL Apify
 * scrape); Telegraf's default 90s would fire a `p-timeout` rejection outside the
 * handler's try/catch and crash the process. Duration is managed here instead (the
 * run-lock prevents pile-up).
 */
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: Infinity });

/** Lock preventing two `/recap` runs at once (avoids an Apify double-spend). */
let recapRunning = false;

/** Shared reply options: HTML parse mode (chosen over MarkdownV2 — only 3 escapes). */
const HTML = { parse_mode: 'HTML', disable_web_page_preview: true } as const;

/**
 * Escape a dynamic value for HTML.
 *
 * @remarks
 * MUST wrap EVERY dynamic value (name/title/error) because `<`, `&`, `>` can come from a
 * caption or error message.
 *
 * @param value - The value to escape.
 * @returns The HTML-safe string.
 */
const esc = (value: unknown): string =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Format a metric for chat display (en-US grouping, e.g. `649,644`). CSV stays raw.
 * @param value - The metric (a count, or `null` when the platform does not expose it).
 * @returns The grouped string, or `"-"` for a `null` metric.
 */
const num = (value: number | null): string =>
  typeof value === 'number' ? value.toLocaleString('en-US') : '-';

/**
 * Reply with the shared HTML options merged in.
 * @param ctx - The Telegraf context.
 * @param text - The message text (HTML).
 * @param extra - Extra reply options to merge.
 * @returns The Telegram API result.
 */
const say = (ctx: Context, text: string, extra?: object): Promise<unknown> =>
  ctx.reply(text, { ...HTML, ...extra });

/**
 * Edit the current message text with HTML options.
 * @param ctx - The Telegraf context.
 * @param text - The new message text (HTML).
 * @returns The Telegram API result.
 */
const editHtml = (ctx: Context, text: string): Promise<unknown> =>
  ctx.editMessageText(text, HTML) as Promise<unknown>;

/**
 * Shorten a URL for display (strip scheme/www and trailing slashes).
 * @param url - The URL.
 * @returns The shortened display string.
 */
const shortUrl = (url: string): string =>
  String(url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

/**
 * Extract the raw text of the incoming message.
 * @param ctx - The Telegraf context.
 * @returns The message text, or `""` if there is none.
 */
const commandText = (ctx: Context): string => {
  const message = ctx.message;
  return message && 'text' in message ? message.text : '';
};

/**
 * Format a campaign for display.
 * @param campaign - The campaign.
 * @returns An HTML snippet.
 */
const fmtCampaign = (campaign: Campaign): string =>
  `<b>#${campaign.id} ${esc(campaign.name)}</b>\n` +
  `tag <code>${esc(campaign.hashtag)}</code> · ${campaign.isActive ? 'active' : 'ended'} · since <code>${esc(String(campaign.started_at).slice(0, 10))}</code>`;

/**
 * Format a KOL for display.
 * @param kol - The KOL.
 * @returns An HTML snippet.
 */
const fmtKol = (kol: Kol): string =>
  `<b>#${kol.id} ${esc(kol.name)}</b>\n` +
  `ig ${kol.ig_username ? '<code>@' + esc(kol.ig_username) + '</code>' : '-'}` +
  ` · tt ${kol.tiktok_username ? '<code>@' + esc(kol.tiktok_username) + '</code>' : '-'}` +
  ` · yt ${kol.youtube_channel ? '<code>' + esc(kol.youtube_channel) + '</code>' : '-'}`;

/**
 * Format one content card: name | platform | handle / metrics / tappable link.
 * @param record - The content record.
 * @returns An HTML snippet.
 */
const card = (record: ContentRecord): string =>
  `<b>${esc(record.name)}</b> | ${esc(record.platform)} | <code>@${esc(record.handle)}</code>\n` +
  `👁 ${num(record.views)}  ❤ ${num(record.likes)}  💬 ${num(record.comments)}\n` +
  `🔗 <a href="${esc(record.url)}">${esc(shortUrl(record.url))}</a>`;

/**
 * Send content cards in chunks under ~3500 chars (Telegram's limit is 4096) so a large
 * batch does not fail.
 * @param ctx - The Telegraf context.
 * @param records - The records to render as cards.
 */
async function sendCards(ctx: Context, records: ContentRecord[]): Promise<void> {
  const separator = '\n──────────────\n';
  let buffer = '';
  for (const record of records) {
    const cardText = card(record);
    if (buffer && buffer.length + separator.length + cardText.length > 3500) {
      await say(ctx, buffer);
      buffer = cardText;
    } else {
      buffer = buffer ? buffer + separator + cardText : cardText;
    }
  }
  if (buffer) await say(ctx, buffer);
}

/** IT contact name shown in error messages. */
const IT_CONTACT = 'Ikhsun Tampan';
/** Deep link to the IT contact (CHANGE if the IT handle differs). */
const IT_CONTACT_URL = 'https://t.me/zuarxanna';
/** The user-facing internal-error message. */
const ERR_MSG = `⚠️ Internal error. Contact IT: <b>${IT_CONTACT}</b>.`;

/**
 * Build the extra options for an error message: HTML + a tap-to-contact button.
 * @returns Telegraf reply extra options.
 */
const errExtra = (): object => ({
  ...HTML,
  ...Markup.inlineKeyboard([Markup.button.url(`Contact ${IT_CONTACT}`, IT_CONTACT_URL)]),
});

// Telegraf safety net: an error in a handler must not kill the process.
bot.catch((error: unknown, ctx: Context) => {
  console.error('bot error:', error);
  recapRunning = false; // release the lock if the error happened during /recap
  try {
    ctx.reply?.(ERR_MSG, errExtra());
  } catch {
    /* ignore */
  }
});

// Allowlist middleware: an unknown id is ignored (reply once, then stop).
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId == null || !ALLOWED.includes(userId)) {
    console.warn(`BLOCKED uid=${userId} name=${ctx.from?.username || '?'}`);
    if (ctx.chat) await ctx.reply('Not for you. Access denied.');
    return; // do NOT next() — the command does not run
  }
  return next();
});

/** The `/start` and `/help` text (`<id>` escaped so it is not read as an HTML tag). */
const HELP = [
  '<b>KOL Metrics Recap bot</b>',
  '',
  '/recap — recap the active campaign, send the CSV',
  '/status — active campaign + KOL count',
  '/campaigns — list all campaigns',
  '/kols — list all KOLs',
  '',
  '<b>Manage KOLs</b>',
  '<code>/addkol Name | ig | tiktok | youtube</code> — name + at least one handle',
  '<code>/setkol &lt;id&gt; | ig|tt|yt | handle</code> — set/clear one handle',
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
  const campaign = Campaign.findActive();
  const igCount = Kol.getAll().filter((kol) => kol.ig_username?.trim()).length;
  if (!campaign) return say(ctx, `No active campaign.\n<b>KOLs with IG:</b> ${igCount}`);
  return say(ctx, `<b>Active campaign</b>\n${fmtCampaign(campaign)}\n\n<b>KOLs with IG:</b> ${igCount}`);
});

// --- /campaigns ---
bot.command('campaigns', (ctx) => {
  const list = Campaign.getAll();
  if (!list.length) return say(ctx, 'No campaigns yet.');
  return say(ctx, list.map(fmtCampaign).join('\n\n'));
});

// --- /kols ---
bot.command('kols', (ctx) => {
  const list = Kol.getAll();
  if (!list.length) return say(ctx, 'No KOLs yet.');
  return say(ctx, list.map(fmtKol).join('\n\n'));
});

// --- /recap ---
bot.command('recap', async (ctx) => {
  const campaign = Campaign.findActive();
  if (!campaign) return say(ctx, 'No active campaign. Run /activate first.');
  if (recapRunning) return say(ctx, 'A recap is already running. Wait for it to finish.');

  recapRunning = true;
  await say(
    ctx,
    `⏳ Starting recap <b>${esc(campaign.name)}</b> <code>#${esc(String(campaign.hashtag).replace(/^#/, ''))}</code>...\nApify scrape per KOL (~15-30s/KOL). Progress is sent as each KOL finishes.`,
  );
  try {
    // Progress streaming: as each KOL finishes -> send only its content metric cards
    // (no diagnostic summary). Diagnostics stay in the server log + totals at the end.
    const onKolDone = async (kolResult: KolResult): Promise<void> => {
      if (kolResult.records.length) await sendCards(ctx, kolResult.records);
    };

    const recapResult = await runRecap({ onKolDone });

    // Final: totals + CSV. (Diagnostics & cards were already streamed per KOL above.)
    const summary = [
      `<b>✅ Done: ${esc(recapResult.campaign.name)}</b> <code>#${esc(recapResult.hashtag)}</code>`,
      `<b>${recapResult.records.length} rows</b> · cost $${recapResult.totalCost.toFixed(4)}`,
      recapResult.records.length === 0
        ? '\nEmpty CSV — scraped&gt;0 but 0 matched = the filter tradeoff (audit manually); scraped 0 / all errored = a scrape problem.'
        : '\nReminder: fill <b>Tone</b> + audit missed (untagged) content in the spreadsheet.',
    ].join('\n');
    await say(ctx, summary);
    await ctx.replyWithDocument({ source: recapResult.outPath });
  } catch (error) {
    console.error('recap error:', error);
    await say(ctx, `Recap failed: ${esc(error instanceof Error ? error.message : String(error))}`);
  } finally {
    recapRunning = false;
  }
  return undefined;
});

// --- /addkol Name | ig | tiktok | youtube (handles optional; needs >=1) ---
bot.command('addkol', (ctx) => {
  const argsText = commandText(ctx).replace(/^\/addkol(@\S+)?\s*/, '');
  const [name, igRaw, tiktokRaw, youtubeRaw] = argsText.split('|').map((part) => part.trim());
  const format = 'Format: <code>/addkol Full Name | ig | tiktok | youtube</code>\nName + at least one handle. Leave a slot blank to skip that platform.';
  if (!name) return say(ctx, format);

  const igUsername = Kol.sanitizeHandle(igRaw ?? '');
  const tiktokUsername = Kol.sanitizeHandle(tiktokRaw ?? '');
  const youtubeChannel = Kol.sanitizeHandle(youtubeRaw ?? '');
  if (!igUsername && !tiktokUsername && !youtubeChannel) return say(ctx, format);

  // Dedup PER PLATFORM: a create is rejected only if one of the given handles already
  // belongs to another KOL on that same platform (no silent IG-only requirement).
  const givenHandles: ReadonlyArray<readonly [KolHandleField, string, string]> = [
    ['ig_username', igUsername, 'ig'],
    ['tiktok_username', tiktokUsername, 'tiktok'],
    ['youtube_channel', youtubeChannel, 'yt'],
  ];
  for (const [field, value, label] of givenHandles) {
    if (!value) continue;
    const existing = Kol.findByHandle(field, value);
    if (existing) {
      return say(ctx, `${label} <code>@${esc(value)}</code> already used by #${existing.id} ${esc(existing.name)}.`);
    }
  }

  const kol = new Kol({ name, ig_username: igUsername, tiktok_username: tiktokUsername, youtube_channel: youtubeChannel }).save();
  return say(ctx, `✅ Added:\n${fmtKol(kol)}`);
});

// --- /setkol <id> | field | handle — set/clear one platform handle on an existing KOL ---
bot.command('setkol', (ctx) => {
  const argsText = commandText(ctx).replace(/^\/setkol(@\S+)?\s*/, '');
  const [idRaw, fieldRaw, valueRaw] = argsText.split('|').map((part) => part.trim());
  const id = Number(idRaw);
  const field = HANDLE_FIELDS[String(fieldRaw ?? '').toLowerCase()];
  if (!id || !field) {
    return say(ctx, 'Format: <code>/setkol &lt;id&gt; | ig|tt|yt | handle</code>\nBlank handle clears that platform.');
  }
  const kol = Kol.find(id);
  if (!kol) return say(ctx, `KOL #${id} does not exist.`);

  const value = Kol.sanitizeHandle(valueRaw ?? '');
  if (value) {
    const existing = Kol.findByHandle(field, value);
    if (existing && existing.id !== id) {
      return say(ctx, `That handle is already used by #${existing.id} ${esc(existing.name)}.`);
    }
  }
  kol[field] = value; // "" clears the platform (canHandle then skips it)
  kol.save();
  return say(ctx, `✅ Updated:\n${fmtKol(kol)}`);
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

// --- /addcampaign Name | #hashtag | YYYY-MM-DD (inactive; /activate to enable) ---
bot.command('addcampaign', (ctx) => {
  const argsText = commandText(ctx).replace(/^\/addcampaign(@\S+)?\s*/, '');
  const [name, tag, since] = argsText.split('|').map((part) => part.trim());
  if (!name || !tag || !since) {
    return say(ctx, 'Format: <code>/addcampaign Name | #hashtag | YYYY-MM-DD</code>');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return say(ctx, 'started_at must be YYYY-MM-DD.');
  const hashtag = tag.startsWith('#') ? tag : '#' + tag;
  const campaign = new Campaign({ name, hashtag, isActive: false, started_at: since, ended_at: null }).save();
  return say(ctx, `✅ Added (inactive, <code>/activate ${campaign.id}</code> to enable):\n${fmtCampaign(campaign)}`);
});

// --- /activate <id> — set active, the rest become ended (keep the single-active invariant) ---
bot.command('activate', (ctx) => {
  const id = Number(commandText(ctx).replace(/^\/activate(@\S+)?\s*/, '').trim());
  if (!id) return say(ctx, 'Format: <code>/activate &lt;id&gt;</code>');
  const activated = Campaign.activate(id);
  if (!activated) return say(ctx, `Campaign #${id} does not exist.`);
  return say(ctx, `✅ Active now:\n${fmtCampaign(activated)}`);
});

// Launch (long-polling). getMe() first: validate the token + connectivity before
// polling (launch() itself resolves on STOP, not start).
const botInfo = await bot.telegram.getMe();
void bot.launch();
console.log(`bot @${botInfo.username} running. allowlist: ${ALLOWED.join(', ')}`);

/**
 * Notify every allowlisted user (best-effort; send failures are ignored).
 * @param text - The message text (HTML).
 * @param extra - Extra reply options (defaults to {@link HTML}).
 */
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
process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error);
  recapRunning = false;
  void notifyAll(ERR_MSG, errExtra());
});

/**
 * Stop the bot on a shutdown signal, guarding against a startup/shutdown race.
 * @param signal - The received signal.
 */
const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
  try {
    bot.stop(signal);
  } catch {
    /* not started yet, ignore */
  }
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
