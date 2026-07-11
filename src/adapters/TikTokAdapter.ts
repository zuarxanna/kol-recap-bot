// TikTokAdapter — TikTok via the Apify actor clockworks/tiktok-scraper.
//
// Same shape as InstagramAdapter: scrape by username + date, RETURN pre-filter records.
// Hashtag filtering is NOT done here — RecapService does it centrally.
//
// Fields verified against real raw output (NOT guessed):
//   views = playCount, likes = diggCount, comments = commentCount,
//   timestamp = createTimeISO (ISO UTC "...Z") -> WIB, url = webVideoUrl,
//   caption = text, hashtags = hashtags[].name (already an array, no regex needed).

import { ApifyClient } from 'apify-client';
import { PlatformAdapter } from './PlatformAdapter.js';
import type { Campaign, ContentRecord, FetchResult, Kol } from '../types.js';

const ACTOR = 'clockworks/tiktok-scraper';

/** One raw item as returned by the Apify actor (only the fields we read). */
interface TikTokItem {
  error?: string;
  text?: string;
  webVideoUrl?: string;
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  createTimeISO?: string;
  hashtags?: Array<{ name?: string }>;
}

/** TikTok adapter backed by an Apify actor. */
export class TikTokAdapter extends PlatformAdapter {
  private readonly client: ApifyClient;

  constructor(token: string) {
    super();
    if (!token) throw new Error('TikTokAdapter requires APIFY_TOKEN');
    this.client = new ApifyClient({ token });
  }

  get platform(): string {
    return 'TikTok';
  }

  canHandle(kol: Kol): boolean {
    return Boolean(kol.tiktok_username && kol.tiktok_username.trim());
  }

  handleFor(kol: Kol): string {
    return String(kol.tiktok_username || '').trim();
  }

  /** Scrape a KOL's videos published since the campaign start. */
  async fetchContent(kol: Kol, campaign: Campaign): Promise<FetchResult> {
    const handle = kol.tiktok_username.trim();
    // WIDEN by 1 day: Apify filters in UTC, our date is WIB (+7). An early-morning WIB
    // post on campaign day 1 is the previous day in UTC, so without widening it would be
    // silently dropped. Over-fetching 1 day is safe: the hashtag filter and WIB bucketing
    // keep the output correct. Mirrors the console test that works.
    const since = TikTokAdapter.#minusOneDay(String(campaign.started_at || '').slice(0, 10));

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

    const errored = list.filter((it) => it.error);
    const clean = list.filter((it) => !it.error); // drop error items (private/missing)
    const records = clean.map((it) => this.#normalize(it, kol, handle));

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

  /** Map one raw Apify item to a normalized ContentRecord. */
  #normalize(it: TikTokItem, kol: Kol, handle: string): ContentRecord {
    return {
      name: kol.name,
      platform: this.platform,
      type: 'Video', // team template "Source Type" (IG='Reels', TikTok/YT='Video')
      handle,
      title: this.#toTitle(it.text),
      url: it.webVideoUrl ?? '',
      views: it.playCount ?? '', // playCount = the real views (verified)
      likes: it.diggCount ?? '',
      comments: it.commentCount ?? '',
      date: this.#toWibDate(it.createTimeISO),
      // hashtags: [{name}] -> [lowercase string]. RecapService's filter needs this array.
      hashtags: Array.isArray(it.hashtags)
        ? it.hashtags.map((h) => String(h?.name || '').toLowerCase()).filter(Boolean)
        : [],
    };
  }

  /** Derive a title from a caption: first line, truncated so CSV cells stay small. */
  #toTitle(text: string | undefined): string {
    const first = String(text || '').split('\n')[0]!.trim();
    return first.length > 120 ? first.slice(0, 117) + '...' : first;
  }

  /** Convert a UTC timestamp to a WIB (Asia/Jakarta) date string. */
  #toWibDate(ts: string | undefined): string {
    const d = new Date(ts ?? '');
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }

  /**
   * Subtract one day from a "YYYY-MM-DD" string. Forces UTC ("Z") to avoid any
   * local-timezone shift.
   */
  static #minusOneDay(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
