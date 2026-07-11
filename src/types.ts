// types.ts — shared domain types for the whole project.
//
// These describe the data model (Kol, Campaign), the normalized content the adapters
// produce (ContentRecord), and the diagnostics/results that flow through RecapService.

/** A KOL (influencer) master record, stored in db/kols.json. */
export interface Kol {
  id: number;
  name: string;
  /** Instagram handle, bare (no "@"). Empty string = not on Instagram. */
  ig_username: string;
  /** TikTok handle, bare (no "@"). Empty string = not on TikTok. */
  tiktok_username: string;
  /** YouTube handle, bare (no "@"). Empty string = not on YouTube. */
  youtube_channel: string;
  /** ISO timestamp of when the KOL was added. */
  created_at: string;
}

/** A campaign master record, stored in db/campaigns.json. Exactly one is "active". */
export interface Campaign {
  id: number;
  name: string;
  /** Campaign hashtag, including the leading "#" (e.g. "#DemoOne"). */
  hashtag: string;
  status: 'active' | 'ended';
  /** Scrape start boundary, "YYYY-MM-DD". */
  started_at: string;
  ended_at: string | null;
}

/** A metric value: a real count, or "" when the platform does not expose it. */
export type Metric = number | string;

/** A single normalized piece of content, returned by an adapter PRE hashtag-filter. */
export interface ContentRecord {
  name: string;
  platform: string;
  /** CSV "Source Type" (e.g. "Reels", "Video", "Shorts", or "-" for a failed fetch). */
  type: string;
  /** Platform handle, without a leading "@". */
  handle: string;
  title: string;
  url: string;
  views: Metric;
  likes: Metric;
  comments: Metric;
  /** Publish date bucketed to WIB, "YYYY-MM-DD" (or "" if unknown). */
  date: string;
  /** Lowercased hashtags without "#". */
  hashtags: string[];
}

/** Per-fetch diagnostic: distinguishes "filter working" from "scrape broken". */
export interface FetchDiagnostic {
  handle: string;
  name: string;
  platform: string;
  scraped: number;
  errored: number;
  allError: boolean;
  firstError: string | null;
  /** Monetary cost in USD (0 for free APIs). */
  cost: number;
}

/** A diagnostic augmented by RecapService with the post-filter match count. */
export type DiagnosticWithMatched = FetchDiagnostic & { matched: number };

/** What every adapter's fetchContent resolves to. */
export interface FetchResult {
  diagnostic: FetchDiagnostic;
  records: ContentRecord[];
}

/** The per-KOL result handed to the onKolDone progress callback. */
export interface KolResult {
  kol: Kol;
  records: ContentRecord[];
  diagnostics: DiagnosticWithMatched[];
}

/** Options for RecapService.run / runRecap. */
export interface RunOptions {
  /**
   * Called after each KOL finishes (all its platforms). Awaited; errors thrown in it
   * are swallowed so a progress failure cannot fail the run.
   */
  onKolDone?: (result: KolResult) => void | Promise<void>;
}

/** One CSV row as an array of cells (strings or raw integers). */
export type CsvRow = Array<string | number>;

/** The full result of a recap run. */
export interface RecapResult {
  campaign: Campaign;
  hashtag: string;
  since: string;
  records: ContentRecord[];
  rows: CsvRow[];
  diagnostics: DiagnosticWithMatched[];
  totalCost: number;
  outPath: string;
}
