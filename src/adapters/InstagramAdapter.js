// InstagramAdapter — Instagram via the Apify actor apify/instagram-reel-scraper.
//
// views = videoPlayCount (NOT videoViewCount, which is junk 0/27). timestamp is
// UTC and is bucketed to a WIB (Asia/Jakarta) date. Hashtag filtering is NOT done
// here — RecapService does it centrally.

import { ApifyClient } from 'apify-client';
import { PlatformAdapter } from './PlatformAdapter.js';

const ACTOR = 'apify/instagram-reel-scraper';

/**
 * Instagram Reels adapter backed by an Apify actor.
 * @extends PlatformAdapter
 */
export class InstagramAdapter extends PlatformAdapter {
  /**
   * @param {string} token - Apify API token.
   */
  constructor(token) {
    super();
    if (!token) throw new Error('InstagramAdapter requires APIFY_TOKEN');
    this.client = new ApifyClient({ token });
  }

  /** @returns {string} */
  get platform() { return 'Instagram'; }

  /**
   * @param {object} kol
   * @returns {boolean} True when the KOL has an Instagram username.
   */
  canHandle(kol) { return Boolean(kol.ig_username && kol.ig_username.trim()); }

  /**
   * @param {object} kol
   * @returns {string} Cleaned Instagram handle.
   */
  handleFor(kol) { return String(kol.ig_username || '').trim(); }

  /**
   * Scrape a KOL's Reels published since the campaign start.
   * @param {object} kol - KOL record.
   * @param {object} campaign - Active campaign.
   * @returns {Promise<import('./PlatformAdapter.js').FetchResult>}
   */
  async fetchContent(kol, campaign) {
    const handle = kol.ig_username.trim();
    const since = String(campaign.started_at || '').slice(0, 10); // YYYY-MM-DD

    const run = await this.client.actor(ACTOR).call({
      username: [`https://www.instagram.com/${handle}/reels`],
      resultsLimit: 30, // do NOT use 10 — campaign content can fall out of the window
      onlyPostsNewerThan: since, // SERVER-SIDE date filter
      skipPinnedPosts: true,
    });
    const { items } = await this.client.dataset(run.defaultDatasetId).listItems();

    const errored = items.filter((it) => it.error);
    const clean = items.filter((it) => !it.error); // drop deleted/private items
    const records = clean.map((it) => this.#normalize(it, kol, handle));

    return {
      diagnostic: {
        handle,
        name: kol.name,
        platform: this.platform,
        scraped: items.length,
        errored: errored.length,
        allError: errored.length > 0 && clean.length === 0,
        firstError: errored[0]?.error || null,
        cost: run.usageTotalUsd || 0,
      },
      records,
    };
  }

  /**
   * Map one raw Apify item to a normalized ContentRecord.
   * @param {object} it - Raw Apify item.
   * @param {object} kol - KOL record.
   * @param {string} handle - Instagram handle.
   * @returns {import('./PlatformAdapter.js').ContentRecord}
   */
  #normalize(it, kol, handle) {
    return {
      name: kol.name,
      platform: this.platform,
      type: 'Reels', // team template "Source Type"; per-platform (TikTok/YT use 'Video')
      handle,
      title: this.#toTitle(it.caption),
      url: it.url,
      views: it.videoPlayCount ?? '', // videoPlayCount = the real number
      likes: it.likesCount ?? '',
      comments: it.commentsCount ?? '',
      date: this.#toWibDate(it.timestamp),
      hashtags: Array.isArray(it.hashtags) ? it.hashtags.map((h) => String(h).toLowerCase()) : [],
    };
  }

  /**
   * Derive a title from a caption: first line, truncated so CSV cells stay small.
   * @param {string} caption
   * @returns {string}
   */
  #toTitle(caption) {
    const first = String(caption || '').split('\n')[0].trim();
    return first.length > 120 ? first.slice(0, 117) + '...' : first;
  }

  /**
   * Convert a UTC timestamp to a WIB (Asia/Jakarta) date string, not a naive slice.
   * @param {string} ts - UTC timestamp.
   * @returns {string} "YYYY-MM-DD", or "" if unparseable.
   */
  #toWibDate(ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }
}
