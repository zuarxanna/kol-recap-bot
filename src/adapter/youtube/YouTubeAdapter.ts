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
  getHandleFor(kol: Kol): string {
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
    const since = YouTubeAdapter.#subtractOneDay(String(campaign.started_at || '').slice(0, 10));
    const sinceMs = Date.parse(`${since}T00:00:00Z`);

    const diagnostic: FetchDiagnostic = {
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
      const channelResponse = await this.#get<YtListResponse<YtChannel>>('channels', {
        part: 'contentDetails,snippet',
        forHandle: `@${handle}`,
      });
      const uploads = channelResponse.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) {
        diagnostic.allError = true;
        diagnostic.firstError = `channel @${handle} not found`;
        return { diagnostic, records: [] };
      }

      // 2. page the uploads playlist, collect videoIds since `since` (newest first)
      const videoIds: string[] = [];
      let pageToken: string | undefined;
      let reachedCutoff = false;
      do {
        const playlistResponse = await this.#get<YtListResponse<YtPlaylistItem>>('playlistItems', {
          part: 'contentDetails',
          playlistId: uploads,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const playlistItem of playlistResponse.items ?? []) {
          const publishedMs = Date.parse(playlistItem.contentDetails?.videoPublishedAt ?? '');
          if (Number.isNaN(publishedMs)) continue;
          if (publishedMs < sinceMs) {
            reachedCutoff = true;
            break;
          } // older than `since` -> stop
          if (playlistItem.contentDetails?.videoId) videoIds.push(playlistItem.contentDetails.videoId);
        }
        pageToken = reachedCutoff ? undefined : playlistResponse.nextPageToken;
      } while (pageToken);

      // 3. batch videos.list (<=50 ids/call) -> stats + duration + snippet
      const records: ContentRecord[] = [];
      for (let offset = 0; offset < videoIds.length; offset += 50) {
        const batchIds = videoIds.slice(offset, offset + 50);
        const videosResponse = await this.#get<YtListResponse<YtVideo>>('videos', {
          part: 'snippet,statistics,contentDetails',
          id: batchIds.join(','),
        });
        for (const video of videosResponse.items ?? []) records.push(this.#normalize(video, kol, handle));
      }

      diagnostic.scraped = records.length;
      diagnostic.errored = videoIds.length - records.length; // ids requested but not returned = error/gone
      diagnostic.allError = videoIds.length > 0 && records.length === 0;
      return { diagnostic, records };
    } catch (error) {
      // one channel error must not kill the whole run — report it via the diagnostic
      diagnostic.allError = true;
      diagnostic.firstError = error instanceof Error ? error.message : String(error);
      return { diagnostic, records: [] };
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
    const query = new URLSearchParams({ ...params, key: this.apiKey });
    const response = await fetch(`${API}/${resource}?${query}`);
    const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!response.ok) {
      const message = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`YouTube ${resource}: ${message}`);
    }
    return data;
  }

  /**
   * Map one raw video resource to a normalized {@link ContentRecord}.
   * @param video - The raw video resource.
   * @param kol - The KOL it belongs to.
   * @param handle - The YouTube handle.
   * @returns The normalized record.
   */
  #normalize(video: YtVideo, kol: Kol, handle: string): ContentRecord {
    const stats = video.statistics ?? {};
    return {
      name: kol.name,
      platform: this.platform,
      type: this.#isShort(video.contentDetails?.duration) ? 'Shorts' : 'Video',
      handle, // without @; CsvWriter renders `@handle`
      title: this.#toTitle(video.snippet?.title),
      url: `https://www.youtube.com/watch?v=${video.id ?? ''}`,
      views: stats.viewCount != null ? Number(stats.viewCount) : '',
      likes: stats.likeCount != null ? Number(stats.likeCount) : '', // '' when likes are hidden
      comments: stats.commentCount != null ? Number(stats.commentCount) : '', // '' when comments are disabled
      date: this.#toWibDate(video.snippet?.publishedAt),
      // YouTube has no structured hashtag array -> extract from title+description (NOT snippet.tags)
      hashtags: this.#extractHashtags(`${video.snippet?.title || ''}\n${video.snippet?.description || ''}`),
    };
  }

  /**
   * Extract hashtags from free text.
   * @param text - The text to scan (title + description).
   * @returns Lowercased hashtags without `"#"`, deduped.
   */
  #extractHashtags(text: string): string[] {
    const tagSet = new Set<string>();
    for (const match of String(text).matchAll(/#[\p{L}\p{N}_]+/gu)) {
      tagSet.add(match[0].slice(1).toLowerCase());
    }
    return [...tagSet];
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
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
    if (!match) return false;
    const totalSeconds = (+(match[1] ?? 0)) * 3600 + (+(match[2] ?? 0)) * 60 + (+(match[3] ?? 0));
    return totalSeconds > 0 && totalSeconds <= 60;
  }

  /**
   * Normalize `"@handle"` / a URL / a plain string into a clean handle.
   * @param raw - The stored handle in any form.
   * @returns The handle without `"@"` or any URL path.
   */
  #normalizeHandle(raw: string): string {
    let cleaned = String(raw || '').trim();
    const atIndex = cleaned.lastIndexOf('@');
    if (atIndex >= 0) cleaned = cleaned.slice(atIndex + 1); // take everything after "@" (also handles URLs like .../@name)
    return cleaned.split(/[/?#]/)[0] ?? '';
  }

  /**
   * Derive a title: first line of the video title, truncated so CSV cells stay small.
   * @param title - The raw video title.
   * @returns The title (≤120 chars).
   */
  #toTitle(title: string | undefined): string {
    const firstLine = String(title || '').split('\n')[0]!.trim();
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
