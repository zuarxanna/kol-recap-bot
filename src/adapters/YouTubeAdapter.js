// YouTubeAdapter — YouTube via the YouTube Data API v3 (official, FREE, not Apify).
// Same shape as the IG/TikTok adapters: scrape by channel + date, RETURN pre-filter
// records. Hashtag filtering is NOT done here — RecapService does it centrally (OCP).
//
// Zero new dependency: uses the global fetch (Node >= 18). No googleapis SDK needed.
//
// Three-stage flow (all GET to googleapis.com/youtube/v3):
//   1. channels.list forHandle=@handle -> channelId + uploads playlistId
//   2. playlistItems.list (loop pageToken) -> videoIds since `since`
//   3. videos.list (batch <=50) -> metrics + duration + title + description
// Uses the uploads playlist (cheap, accurate), NOT search.list (100 units, often misses).
//
// Fields verified via a raw probe before being trusted (same lesson as videoPlayCount):
//   views=statistics.viewCount, likes=likeCount, comments=commentCount,
//   date=snippet.publishedAt (ISO UTC), title=snippet.title, url=watch?v=<id>,
//   hashtags=regex over title+description (NOT snippet.tags), type=Shorts/Video via duration.

import { PlatformAdapter } from './PlatformAdapter.js';

const API = 'https://www.googleapis.com/youtube/v3';

/**
 * YouTube adapter backed by the official YouTube Data API v3 (free, quota-based).
 * @extends PlatformAdapter
 */
export class YouTubeAdapter extends PlatformAdapter {
  /**
   * @param {string} apiKey - YouTube Data API v3 key.
   */
  constructor(apiKey) {
    super();
    if (!apiKey) throw new Error('YouTubeAdapter requires YOUTUBE_API_KEY');
    this.apiKey = apiKey;
  }

  /** @returns {string} */
  get platform() { return 'YouTube'; }

  /**
   * @param {object} kol
   * @returns {boolean} True when the KOL has a YouTube channel handle.
   */
  canHandle(kol) { return Boolean(kol.youtube_channel && kol.youtube_channel.trim()); }

  /**
   * @param {object} kol
   * @returns {string} Cleaned YouTube handle (no "@", no URL path).
   */
  handleFor(kol) { return this.#normalizeHandle(kol.youtube_channel); }

  /**
   * Fetch a channel's uploads published since the campaign start.
   * @param {object} kol - KOL record.
   * @param {object} campaign - Active campaign.
   * @returns {Promise<import('./PlatformAdapter.js').FetchResult>}
   */
  async fetchContent(kol, campaign) {
    const handle = this.#normalizeHandle(kol.youtube_channel);
    // WIDEN by 1 day: publishedAt is UTC, our date is WIB (+7). An early-morning WIB
    // post on day 1 is the previous day in UTC, so without widening it can be dropped.
    // Over-fetching 1 day is safe (the hashtag filter keeps the output correct).
    const since = YouTubeAdapter.#minusOneDay(String(campaign.started_at || '').slice(0, 10));
    const sinceMs = Date.parse(`${since}T00:00:00Z`);

    const diag = {
      handle,
      name: kol.name,
      platform: this.platform,
      scraped: 0,
      errored: 0,
      allError: false,
      firstError: null,
      cost: 0, // official API is free (quota, not money)
    };

    try {
      // 1. resolve @handle -> channelId + uploads playlist
      const ch = await this.#get('channels', {
        part: 'contentDetails,snippet',
        forHandle: `@${handle}`,
      });
      const chan = ch.items?.[0];
      const uploads = chan?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) {
        diag.allError = true;
        diag.firstError = `channel @${handle} not found`;
        return { diagnostic: diag, records: [] };
      }

      // 2. page the uploads playlist, collect videoIds since `since` (newest first)
      const ids = [];
      let pageToken;
      let done = false;
      do {
        const pl = await this.#get('playlistItems', {
          part: 'contentDetails',
          playlistId: uploads,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const it of pl.items || []) {
          const pub = Date.parse(it.contentDetails?.videoPublishedAt || '');
          if (Number.isNaN(pub)) continue;
          if (pub < sinceMs) { done = true; break; } // older than `since` -> stop
          if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
        }
        pageToken = done ? null : pl.nextPageToken;
      } while (pageToken);

      // 3. batch videos.list (<=50 ids/call) -> stats + duration + snippet
      const records = [];
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const vids = await this.#get('videos', {
          part: 'snippet,statistics,contentDetails',
          id: batch.join(','),
        });
        for (const v of vids.items || []) records.push(this.#normalize(v, kol, handle));
      }

      diag.scraped = records.length;
      diag.errored = ids.length - records.length; // ids requested but not returned = error/gone
      diag.allError = ids.length > 0 && records.length === 0;
      return { diagnostic: diag, records };
    } catch (e) {
      // one channel error must not kill the whole run — report it via the diagnostic
      diag.allError = true;
      diag.firstError = e.message;
      return { diagnostic: diag, records: [] };
    }
  }

  /**
   * GET a Data API resource with the API key; throws with a clear message on non-2xx.
   * @param {string} resource - API resource (e.g. "channels").
   * @param {Record<string,string>} params - Query params (key is added automatically).
   * @returns {Promise<object>} Parsed JSON response.
   */
  async #get(resource, params) {
    const qs = new URLSearchParams({ ...params, key: this.apiKey });
    const res = await fetch(`${API}/${resource}?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      throw new Error(`YouTube ${resource}: ${msg}`);
    }
    return data;
  }

  /**
   * Map one raw video resource to a normalized ContentRecord.
   * @param {object} v - Raw videos.list item.
   * @param {object} kol - KOL record.
   * @param {string} handle - YouTube handle.
   * @returns {import('./PlatformAdapter.js').ContentRecord}
   */
  #normalize(v, kol, handle) {
    const s = v.statistics || {};
    return {
      name: kol.name,
      platform: this.platform,
      type: this.#isShort(v.contentDetails?.duration) ? 'Shorts' : 'Video',
      handle, // without @; CsvWriter renders `@handle`
      title: this.#toTitle(v.snippet?.title),
      url: `https://www.youtube.com/watch?v=${v.id}`,
      views: s.viewCount != null ? Number(s.viewCount) : '',
      likes: s.likeCount != null ? Number(s.likeCount) : '',   // '' when likes are hidden
      comments: s.commentCount != null ? Number(s.commentCount) : '', // '' when comments are disabled
      date: this.#toWibDate(v.snippet?.publishedAt),
      // YouTube has no structured hashtag array -> extract from title+description (NOT snippet.tags)
      hashtags: this.#extractHashtags(`${v.snippet?.title || ''}\n${v.snippet?.description || ''}`),
    };
  }

  /**
   * Extract hashtags from free text -> [lowercase without "#"], deduped.
   * @param {string} text
   * @returns {string[]}
   */
  #extractHashtags(text) {
    const set = new Set();
    for (const m of String(text).matchAll(/#[\p{L}\p{N}_]+/gu)) {
      set.add(m[0].slice(1).toLowerCase());
    }
    return [...set];
  }

  /**
   * Heuristic Shorts detection (no official flag): ISO-8601 duration <= 60s = Shorts.
   * Known caveat: newer Shorts can run up to 3 min, so those > 60s are labeled Video
   * (fixed manually).
   * @param {string} iso - ISO-8601 duration (e.g. "PT45S").
   * @returns {boolean}
   */
  #isShort(iso) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
    if (!m) return false;
    const secs = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return secs > 0 && secs <= 60;
  }

  /**
   * Normalize "@handle" / URL / plain into a clean handle without "@" or path.
   * @param {string} raw
   * @returns {string}
   */
  #normalizeHandle(raw) {
    let h = String(raw || '').trim();
    const at = h.lastIndexOf('@');
    if (at >= 0) h = h.slice(at + 1); // take everything after "@" (also handles URLs like .../@name)
    return h.split(/[/?#]/)[0];
  }

  /**
   * Derive a title: first line of the video title, truncated so CSV cells stay small.
   * @param {string} title
   * @returns {string}
   */
  #toTitle(title) {
    const first = String(title || '').split('\n')[0].trim();
    return first.length > 120 ? first.slice(0, 117) + '...' : first;
  }

  /**
   * Convert a UTC timestamp to a WIB (Asia/Jakarta) date string.
   * @param {string} ts - UTC timestamp.
   * @returns {string} "YYYY-MM-DD", or "" if unparseable.
   */
  #toWibDate(ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }

  /**
   * Subtract one day from a "YYYY-MM-DD" string. Forces UTC ("Z") to avoid any
   * local-timezone shift.
   * @param {string} iso - Date as "YYYY-MM-DD".
   * @returns {string} Date minus one day, or the input if unparseable.
   */
  static #minusOneDay(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
