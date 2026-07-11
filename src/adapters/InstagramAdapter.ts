// InstagramAdapter — Instagram via the Apify actor apify/instagram-reel-scraper.
//
// views = videoPlayCount (NOT videoViewCount, which is junk 0/27). timestamp is UTC
// and is bucketed to a WIB (Asia/Jakarta) date. Hashtag filtering is NOT done here —
// RecapService does it centrally.

import { ApifyClient } from 'apify-client';
import { PlatformAdapter } from './PlatformAdapter.js';
import type { Campaign, ContentRecord, FetchResult, Kol } from '../types.js';

const ACTOR = 'apify/instagram-reel-scraper';

/** One raw item as returned by the Apify actor (only the fields we read). */
interface IgItem {
  error?: string;
  caption?: string;
  url?: string;
  videoPlayCount?: number;
  likesCount?: number;
  commentsCount?: number;
  timestamp?: string;
  hashtags?: string[];
}

/** Instagram Reels adapter backed by an Apify actor. */
export class InstagramAdapter extends PlatformAdapter {
  private readonly client: ApifyClient;

  constructor(token: string) {
    super();
    if (!token) throw new Error('InstagramAdapter requires APIFY_TOKEN');
    this.client = new ApifyClient({ token });
  }

  get platform(): string {
    return 'Instagram';
  }

  canHandle(kol: Kol): boolean {
    return Boolean(kol.ig_username && kol.ig_username.trim());
  }

  handleFor(kol: Kol): string {
    return String(kol.ig_username || '').trim();
  }

  /** Scrape a KOL's Reels published since the campaign start. */
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

    const errored = list.filter((it) => it.error);
    const clean = list.filter((it) => !it.error); // drop deleted/private items
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
  #normalize(it: IgItem, kol: Kol, handle: string): ContentRecord {
    return {
      name: kol.name,
      platform: this.platform,
      type: 'Reels', // team template "Source Type"; per-platform (TikTok/YT use 'Video')
      handle,
      title: this.#toTitle(it.caption),
      url: it.url ?? '',
      views: it.videoPlayCount ?? '', // videoPlayCount = the real number
      likes: it.likesCount ?? '',
      comments: it.commentsCount ?? '',
      date: this.#toWibDate(it.timestamp),
      hashtags: Array.isArray(it.hashtags) ? it.hashtags.map((h) => String(h).toLowerCase()) : [],
    };
  }

  /** Derive a title from a caption: first line, truncated so CSV cells stay small. */
  #toTitle(caption: string | undefined): string {
    const first = String(caption || '').split('\n')[0]!.trim();
    return first.length > 120 ? first.slice(0, 117) + '...' : first;
  }

  /** Convert a UTC timestamp to a WIB (Asia/Jakarta) date string, not a naive slice. */
  #toWibDate(ts: string | undefined): string {
    const d = new Date(ts ?? '');
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }
}
