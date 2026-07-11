import { PlatformAdapter } from '../PlatformAdapter.js';
import type { Campaign, ContentRecord, FetchDiagnostic, FetchResult, Kol } from '../../types.js';

const API = 'https://www.googleapis.com/youtube/v3';

/** A YouTube channel resource (only the fields we read). */
interface YtChannel {
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}
/** A YouTube playlist item (only the fields we read). */
interface YtPlaylistItem {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}
/** A YouTube video resource (only the fields we read). */
interface YtVideo {
  id?: string;
  snippet?: { title?: string; description?: string; publishedAt?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}
/**
 * A generic Data API list response.
 * @typeParam T - The item type of the `items` array.
 */
interface YtListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  error?: { message?: string };
}

/**
 * YouTube adapter backed by the official YouTube Data API v3 (free, quota-based).
 *
 * @remarks
 * Not Apify. Zero new dependency — uses the global `fetch` (Node >= 18). Three-stage
 * flow (all GET to `googleapis.com/youtube/v3`):
 *
 * 1. `channels.list?forHandle=@handle` → channelId + uploads playlistId;
 * 2. `playlistItems.list` (loop `pageToken`) → videoIds since `since`;
 * 3. `videos.list` (batch ≤50) → metrics + duration + title + description.
 *
 * It uses the uploads playlist (cheap, accurate), NOT `search.list` (100 units, often
 * misses). Fields were verified via a raw probe: views = `statistics.viewCount`,
 * likes = `likeCount`, comments = `commentCount`, date = `snippet.publishedAt`,
 * title = `snippet.title`, hashtags = regex over title+description (NOT `snippet.tags`),
 * type = Shorts/Video via duration. Hashtag filtering is NOT done here — `RecapService`
 * does it centrally.
 */
export class YouTubeAdapter extends PlatformAdapter {
  private readonly apiKey: string;

  /**
   * @param apiKey - YouTube Data API v3 key.
   * @throws If `apiKey` is missing.
   */
  constructor(apiKey: string) {
    super();
    if (!apiKey) throw new Error('YouTubeAdapter requires YOUTUBE_API_KEY');
    this.apiKey = apiKey;
  }

  /** @returns The platform label `"YouTube"`. */
  get platform(): string {
    return 'YouTube';
  }

  /**
   * @param kol - The KOL to check.
   * @returns `true` when the KOL has a YouTube channel handle.
   */
  canHandle(kol: Kol): boolean {
    return Boolean(kol.youtube_channel && kol.youtube_channel.trim());
  }

  /**
   * @param kol - The KOL.
   * @returns The cleaned YouTube handle (no `"@"`, no URL path).
   */
  handleFor(kol: Kol): string {
    return this.#normalizeHandle(kol.youtube_channel);
  }

  /**
   * Fetch a channel's uploads published since the campaign start.
   *
   * @remarks
   * A single channel error is reported via the diagnostic (never thrown) so it cannot
   * kill the whole run.
   *
   * @param kol - The KOL to scrape.
   * @param campaign - The active campaign (provides `started_at`).
   * @returns A diagnostic plus normalized records, PRE hashtag-filter.
   */
  async fetchContent(kol: Kol, campaign: Campaign): Promise<FetchResult> {
    const handle = this.#normalizeHandle(kol.youtube_channel);
    // WIDEN by 1 day: publishedAt is UTC, our date is WIB (+7). An early-morning WIB
    // post on day 1 is the previous day in UTC, so without widening it can be dropped.
    // Over-fetching 1 day is safe (the hashtag filter keeps the output correct).
    const since = YouTubeAdapter.#minusOneDay(String(campaign.started_at || '').slice(0, 10));
    const sinceMs = Date.parse(`${since}T00:00:00Z`);

    const diag: FetchDiagnostic = {
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
      const ch = await this.#get<YtListResponse<YtChannel>>('channels', {
        part: 'contentDetails,snippet',
        forHandle: `@${handle}`,
      });
      const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) {
        diag.allError = true;
        diag.firstError = `channel @${handle} not found`;
        return { diagnostic: diag, records: [] };
      }

      // 2. page the uploads playlist, collect videoIds since `since` (newest first)
      const ids: string[] = [];
      let pageToken: string | undefined;
      let done = false;
      do {
        const pl = await this.#get<YtListResponse<YtPlaylistItem>>('playlistItems', {
          part: 'contentDetails',
          playlistId: uploads,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const it of pl.items ?? []) {
          const pub = Date.parse(it.contentDetails?.videoPublishedAt ?? '');
          if (Number.isNaN(pub)) continue;
          if (pub < sinceMs) {
            done = true;
            break;
          } // older than `since` -> stop
          if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
        }
        pageToken = done ? undefined : pl.nextPageToken;
      } while (pageToken);

      // 3. batch videos.list (<=50 ids/call) -> stats + duration + snippet
      const records: ContentRecord[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const vids = await this.#get<YtListResponse<YtVideo>>('videos', {
          part: 'snippet,statistics,contentDetails',
          id: batch.join(','),
        });
        for (const v of vids.items ?? []) records.push(this.#normalize(v, kol, handle));
      }

      diag.scraped = records.length;
      diag.errored = ids.length - records.length; // ids requested but not returned = error/gone
      diag.allError = ids.length > 0 && records.length === 0;
      return { diagnostic: diag, records };
    } catch (e) {
      // one channel error must not kill the whole run — report it via the diagnostic
      diag.allError = true;
      diag.firstError = e instanceof Error ? e.message : String(e);
      return { diagnostic: diag, records: [] };
    }
  }

  /**
   * GET a Data API resource with the API key attached.
   * @typeParam T - The expected response shape.
   * @param resource - API resource (e.g. `"channels"`).
   * @param params - Query params (the `key` is added automatically).
   * @returns The parsed JSON response.
   * @throws If the response status is non-2xx (message from the API, else the status).
   */
  async #get<T>(resource: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, key: this.apiKey });
    const res = await fetch(`${API}/${resource}?${qs}`);
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      throw new Error(`YouTube ${resource}: ${msg}`);
    }
    return data;
  }

  /**
   * Map one raw video resource to a normalized {@link ContentRecord}.
   * @param v - The raw video resource.
   * @param kol - The KOL it belongs to.
   * @param handle - The YouTube handle.
   * @returns The normalized record.
   */
  #normalize(v: YtVideo, kol: Kol, handle: string): ContentRecord {
    const s = v.statistics ?? {};
    return {
      name: kol.name,
      platform: this.platform,
      type: this.#isShort(v.contentDetails?.duration) ? 'Shorts' : 'Video',
      handle, // without @; CsvWriter renders `@handle`
      title: this.#toTitle(v.snippet?.title),
      url: `https://www.youtube.com/watch?v=${v.id ?? ''}`,
      views: s.viewCount != null ? Number(s.viewCount) : '',
      likes: s.likeCount != null ? Number(s.likeCount) : '', // '' when likes are hidden
      comments: s.commentCount != null ? Number(s.commentCount) : '', // '' when comments are disabled
      date: this.#toWibDate(v.snippet?.publishedAt),
      // YouTube has no structured hashtag array -> extract from title+description (NOT snippet.tags)
      hashtags: this.#extractHashtags(`${v.snippet?.title || ''}\n${v.snippet?.description || ''}`),
    };
  }

  /**
   * Extract hashtags from free text.
   * @param text - The text to scan (title + description).
   * @returns Lowercased hashtags without `"#"`, deduped.
   */
  #extractHashtags(text: string): string[] {
    const set = new Set<string>();
    for (const m of String(text).matchAll(/#[\p{L}\p{N}_]+/gu)) {
      set.add(m[0].slice(1).toLowerCase());
    }
    return [...set];
  }

  /**
   * Heuristic Shorts detection (there is no official flag): ISO-8601 duration ≤ 60s.
   *
   * @remarks
   * Known caveat: newer Shorts can run up to 3 min, so those > 60s are labeled `Video`
   * and fixed manually.
   *
   * @param iso - ISO-8601 duration (e.g. `"PT45S"`).
   * @returns `true` if the duration is 1–60 seconds.
   */
  #isShort(iso: string | undefined): boolean {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
    if (!m) return false;
    const secs = (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
    return secs > 0 && secs <= 60;
  }

  /**
   * Normalize `"@handle"` / a URL / a plain string into a clean handle.
   * @param raw - The stored handle in any form.
   * @returns The handle without `"@"` or any URL path.
   */
  #normalizeHandle(raw: string): string {
    let h = String(raw || '').trim();
    const at = h.lastIndexOf('@');
    if (at >= 0) h = h.slice(at + 1); // take everything after "@" (also handles URLs like .../@name)
    return h.split(/[/?#]/)[0] ?? '';
  }

  /**
   * Derive a title: first line of the video title, truncated so CSV cells stay small.
   * @param title - The raw video title.
   * @returns The title (≤120 chars).
   */
  #toTitle(title: string | undefined): string {
    const first = String(title || '').split('\n')[0]!.trim();
    return first.length > 120 ? first.slice(0, 117) + '...' : first;
  }

  /**
   * Convert a UTC timestamp to a WIB (Asia/Jakarta) date string.
   * @param ts - The UTC timestamp.
   * @returns `"YYYY-MM-DD"`, or `""` if unparseable.
   */
  #toWibDate(ts: string | undefined): string {
    const d = new Date(ts ?? '');
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  }

  /**
   * Subtract one day from a `"YYYY-MM-DD"` string. Forces UTC (`"Z"`) to avoid any
   * local-timezone shift.
   * @param iso - Date as `"YYYY-MM-DD"`.
   * @returns The date minus one day, or the input if unparseable.
   */
  static #minusOneDay(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
