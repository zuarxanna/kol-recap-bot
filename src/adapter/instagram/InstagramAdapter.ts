import { ApifyClient } from 'apify-client';
import { PlatformAdapter } from '../PlatformAdapter.js';
import type { Campaign, ContentRecord, FetchResult, Kol } from '../../types.js';

const ACTOR = 'apify/instagram-reel-scraper';

/** One raw item as returned by the Apify actor (only the fields we read). */
interface IgItem {
  /** Present when the item failed (deleted/private); such items are dropped. */
  error?: string;
  caption?: string;
  url?: string;
  /** Real view count. NOT `videoViewCount`, which is junk (0/27). */
  videoPlayCount?: number;
  likesCount?: number;
  commentsCount?: number;
  /** UTC timestamp (`...Z`). */
  timestamp?: string;
  hashtags?: string[];
}

/**
 * Instagram Reels adapter backed by the Apify actor `apify/instagram-reel-scraper`.
 *
 * @remarks
 * Views come from `videoPlayCount` (NOT `videoViewCount`, which is junk). Timestamps
 * are UTC and get bucketed to a WIB (Asia/Jakarta) date. Hashtag filtering is NOT done
 * here — `RecapService` does it centrally.
 */
export class InstagramAdapter extends PlatformAdapter {
  private readonly client: ApifyClient;

  /**
   * @param token - Apify API token.
   * @throws If `token` is missing.
   */
  constructor(token: string) {
    super();
    if (!token) throw new Error('InstagramAdapter requires APIFY_TOKEN');
    this.client = new ApifyClient({ token });
  }

  /** @returns The platform label `"Instagram"`. */
  get platform(): string {
    return 'Instagram';
  }

  /**
   * @param kol - The KOL to check.
   * @returns `true` when the KOL has an Instagram username.
   */
  canHandle(kol: Kol): boolean {
    return Boolean(kol.ig_username && kol.ig_username.trim());
  }

  /**
   * @param kol - The KOL.
   * @returns The cleaned Instagram handle.
   */
  getHandleFor(kol: Kol): string {
    return String(kol.ig_username || '').trim();
  }

  /**
   * Scrape a KOL's Reels published since the campaign start.
   * @param kol - The KOL to scrape.
   * @param campaign - The active campaign (provides `started_at`).
   * @returns A diagnostic plus normalized records, PRE hashtag-filter.
   */
  async fetchContent(kol: Kol, campaign: Campaign): Promise<FetchResult> {
    const handle = kol.ig_username.trim();
    const since = String(campaign.started_at || '').slice(0, 10); // YYYY-MM-DD

    const run = await this.client.actor(ACTOR).call({
      username: [`https://www.instagram.com/${handle}/reels`],
      resultsLimit: 30, // do NOT use 10 — campaign content can fall out of the window
      onlyPostsNewerThan: since, // SERVER-SIDE date filter
      skipPinnedPosts: true,
    });
    const { items } = await this.client.dataset(run.defaultDatasetId).listItems();
    const list = items as unknown as IgItem[];

    const errored = list.filter((item) => item.error);
    const clean = list.filter((item) => !item.error); // drop deleted/private items
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
   * @param handle - The Instagram handle.
   * @returns The normalized record.
   */
  #normalize(item: IgItem, kol: Kol, handle: string): ContentRecord {
    return {
      name: kol.name,
      platform: this.platform,
      type: 'Reels', // team template "Source Type"; per-platform (TikTok/YT use 'Video')
      handle,
      title: this.#toTitle(item.caption),
      url: item.url ?? '',
      views: item.videoPlayCount ?? '', // videoPlayCount = the real number
      likes: item.likesCount ?? '',
      comments: item.commentsCount ?? '',
      date: this.#toWibDate(item.timestamp),
      hashtags: Array.isArray(item.hashtags) ? item.hashtags.map((tag) => String(tag).toLowerCase()) : [],
    };
  }

  /**
   * Derive a title from a caption: first line, truncated so CSV cells stay small.
   * @param caption - The raw caption.
   * @returns The title (≤120 chars).
   */
  #toTitle(caption: string | undefined): string {
    const firstLine = String(caption || '').split('\n')[0]!.trim();
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  /**
   * Convert a UTC timestamp to a WIB (Asia/Jakarta) date string, not a naive slice.
   * @param ts - The UTC timestamp.
   * @returns `"YYYY-MM-DD"`, or `""` if unparseable.
   */
  #toWibDate(ts: string | undefined): string {
    const date = new Date(ts ?? '');
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }
}
