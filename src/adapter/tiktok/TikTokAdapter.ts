import { ApifyClient } from 'apify-client';
import { PlatformAdapter } from '../PlatformAdapter.js';
import type { Campaign, ContentRecord, FetchResult, Kol } from '../../types.js';

const ACTOR = 'clockworks/tiktok-scraper';

/** One raw item as returned by the Apify actor (only the fields we read). */
interface TikTokItem {
  /** Present when the item failed (private/missing); such items are dropped. */
  error?: string;
  /** Caption text. */
  text?: string;
  webVideoUrl?: string;
  /** Real view count. */
  playCount?: number;
  /** Like count. */
  diggCount?: number;
  commentCount?: number;
  /** ISO UTC timestamp (`...Z`). */
  createTimeISO?: string;
  /** Already-parsed hashtag objects. */
  hashtags?: Array<{ name?: string }>;
}

/**
 * TikTok adapter backed by the Apify actor `clockworks/tiktok-scraper`.
 *
 * @remarks
 * Same shape as {@link InstagramAdapter}: scrape by username + date, return pre-filter
 * records. Hashtag filtering is NOT done here — `RecapService` does it centrally.
 *
 * Fields were verified against real raw output (NOT guessed): views = `playCount`,
 * likes = `diggCount`, comments = `commentCount`, timestamp = `createTimeISO`,
 * url = `webVideoUrl`, caption = `text`, hashtags = `hashtags[].name`.
 */
export class TikTokAdapter extends PlatformAdapter {
  private readonly client: ApifyClient;

  /**
   * @param token - Apify API token.
   * @throws If `token` is missing.
   */
  constructor(token: string) {
    super();
    if (!token) throw new Error('TikTokAdapter requires APIFY_TOKEN');
    this.client = new ApifyClient({ token });
  }

  /** @returns The platform label `"TikTok"`. */
  get platform(): string {
    return 'TikTok';
  }

  /**
   * @param kol - The KOL to check.
   * @returns `true` when the KOL has a TikTok username.
   */
  canHandle(kol: Kol): boolean {
    return Boolean(kol.tiktok_username && kol.tiktok_username.trim());
  }

  /**
   * @param kol - The KOL.
   * @returns The cleaned TikTok handle.
   */
  getHandleFor(kol: Kol): string {
    return String(kol.tiktok_username || '').trim();
  }

  /**
   * Scrape a KOL's videos published since the campaign start.
   * @param kol - The KOL to scrape.
   * @param campaign - The active campaign (provides `started_at`).
   * @returns A diagnostic plus normalized records, PRE hashtag-filter.
   */
  async fetchContent(kol: Kol, campaign: Campaign): Promise<FetchResult> {
    const handle = kol.tiktok_username.trim();
    // WIDEN by 1 day: Apify filters in UTC, our date is WIB (+7). An early-morning WIB
    // post on campaign day 1 is the previous day in UTC, so without widening it would be
    // silently dropped. Over-fetching 1 day is safe: the hashtag filter and WIB bucketing
    // keep the output correct. Mirrors the console test that works.
    const since = TikTokAdapter.#subtractOneDay(String(campaign.started_at || '').slice(0, 10));

    // Input MIRRORS the console test proven to work. Date param = oldestPostDateUnified
    // (NOT oldestPostDate — that name is silently ignored).
    const run = await this.client.actor(ACTOR).call({
      profiles: [handle],
      resultsPerPage: 100, // per-profile cap
      oldestPostDateUnified: since, // SERVER-SIDE date filter (UTC)
      profileSorting: 'latest',
      excludePinnedPosts: true, // drop pinned — avoid old pinned posts leaking in (parity with IG)
      commentsPerPost: 0,
      topLevelCommentsPerPost: 0,
      maxRepliesPerComment: 0,
      maxFollowersPerProfile: 0,
      maxFollowingPerProfile: 0,
      scrapeAdditionalAuthorMeta: false,
      scrapeRelatedSearchWords: false,
      scrapeRelatedVideos: false,
      shouldDownloadAvatars: false,
      shouldDownloadCovers: false,
      shouldDownloadMusicCovers: false,
      shouldDownloadSlideshowImages: false,
      shouldDownloadVideos: false,
    });
    const { items } = await this.client.dataset(run.defaultDatasetId).listItems();
    const list = items as unknown as TikTokItem[];

    const errored = list.filter((item) => item.error);
    const clean = list.filter((item) => !item.error); // drop error items (private/missing)
    const records = clean.map((item) => this.#normalize(item, kol, handle));

    return {
      diagnostic: {
        handle,
        name: kol.name,
        platform: this.platform,
        scraped: list.length,
        errored: errored.length,
        allError: errored.length > 0 && clean.length === 0,
        firstError: errored[0]?.error ?? null,
        cost: run.usageTotalUsd ?? 0,
      },
      records,
    };
  }

  /**
   * Map one raw Apify item to a normalized {@link ContentRecord}.
   * @param item - The raw Apify item.
   * @param kol - The KOL it belongs to.
   * @param handle - The TikTok handle.
   * @returns The normalized record.
   */
  #normalize(item: TikTokItem, kol: Kol, handle: string): ContentRecord {
    return {
      name: kol.name,
      platform: this.platform,
      type: 'Video', // team template "Source Type" (IG='Reels', TikTok/YT='Video')
      handle,
      title: this.#toTitle(item.text),
      url: item.webVideoUrl ?? '',
      views: item.playCount ?? '', // playCount = the real views (verified)
      likes: item.diggCount ?? '',
      comments: item.commentCount ?? '',
      date: this.#toWibDate(item.createTimeISO),
      // hashtags: [{name}] -> [lowercase string]. RecapService's filter needs this array.
      hashtags: Array.isArray(item.hashtags)
        ? item.hashtags.map((tag) => String(tag?.name || '').toLowerCase()).filter(Boolean)
        : [],
    };
  }

  /**
   * Derive a title from a caption: first line, truncated so CSV cells stay small.
   * @param text - The raw caption.
   * @returns The title (≤120 chars).
   */
  #toTitle(text: string | undefined): string {
    const firstLine = String(text || '').split('\n')[0]!.trim();
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  /**
   * Convert a UTC timestamp to a WIB (Asia/Jakarta) date string.
   * @param ts - The UTC timestamp.
   * @returns `"YYYY-MM-DD"`, or `""` if unparseable.
   */
  #toWibDate(ts: string | undefined): string {
    const date = new Date(ts ?? '');
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }

  /**
   * Subtract one day from a `"YYYY-MM-DD"` string. Forces UTC (`"Z"`) to avoid any
   * local-timezone shift.
   * @param iso - Date as `"YYYY-MM-DD"`.
   * @returns The date minus one day, or the input if unparseable.
   */
  static #subtractOneDay(iso: string): string {
    const date = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return iso;
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
}
