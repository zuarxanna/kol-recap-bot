import type { Kol, Campaign } from './model/index.js';

/**
 * Re-export of the data-model entities.
 *
 * @remarks
 * `Kol` and `Campaign` are class-based models that own their own persistence — they
 * live in `src/model/` (the data itself lives in `db/`). They are re-exported here so
 * the rest of the app imports domain types from a single place.
 */
export type { Kol, Campaign };

/** A metric value: a real count, or `null` when the platform does not expose it
 * (hidden likes, disabled comments, a failed fetch). `null` is written to the CSV as an
 * empty cell. */
export type Metric = number | null;

/**
 * A single normalized piece of content, as returned by an adapter PRE hashtag-filter.
 */
export interface ContentRecord {
  /** KOL display name. */
  name: string;
  /** Platform label (e.g. `"Instagram"`). */
  platform: string;
  /** CSV "Source Type" (e.g. `"Reels"`, `"Video"`, `"Shorts"`, or `"-"` for a failed fetch). */
  type: string;
  /** Platform handle, without a leading `"@"`. */
  handle: string;
  /** Short title (first line of caption/title, truncated). */
  title: string;
  /** Canonical link to the content. */
  url: string;
  /** View count. */
  views: Metric;
  /** Like count. */
  likes: Metric;
  /** Comment count. */
  comments: Metric;
  /** Publish date bucketed to WIB, `"YYYY-MM-DD"` (or `""` if unknown). */
  date: string;
  /** Lowercased hashtags without `"#"`. */
  hashtags: string[];
}

/**
 * Per-fetch diagnostic — distinguishes "filter working" from "scrape broken".
 */
export interface FetchDiagnostic {
  /** Handle that was fetched. */
  handle: string;
  /** KOL display name. */
  name: string;
  /** Platform label. */
  platform: string;
  /** Number of items returned by the source. */
  scraped: number;
  /** Number of items that came back as errors (deleted/private/missing). */
  errored: number;
  /** True when every item failed (the fetch effectively failed). */
  allError: boolean;
  /** First error message, if any. */
  firstError: string | null;
  /** Monetary cost in USD (0 for free APIs). */
  cost: number;
}

/** A {@link FetchDiagnostic} augmented by RecapService with the post-filter match count. */
export type DiagnosticWithMatched = FetchDiagnostic & {
  /** Number of records that matched the campaign hashtag. */
  matched: number;
};

/** What every adapter's `fetchContent` resolves to. */
export interface FetchResult {
  /** Diagnostic for this fetch. */
  diagnostic: FetchDiagnostic;
  /** Normalized records, PRE hashtag-filter. */
  records: ContentRecord[];
}

/** The per-KOL result handed to the {@link RunOptions.onKolDone} progress callback. */
export interface KolResult {
  /** The KOL that was processed. */
  kol: Kol;
  /** That KOL's matched records across all its platforms. */
  records: ContentRecord[];
  /** That KOL's per-platform diagnostics. */
  diagnostics: DiagnosticWithMatched[];
}

/** Options for `RecapService.run` / `runRecap`. */
export interface RunOptions {
  /**
   * Called after each KOL finishes (all its platforms).
   *
   * @remarks
   * It is awaited, and errors thrown in it are swallowed so a progress failure cannot
   * fail the run.
   *
   * @param result - The finished KOL's records + diagnostics.
   */
  onKolDone?: (result: KolResult) => void | Promise<void>;
}

/** One CSV row as an array of cells (strings, raw integers, or `null` = empty cell). */
export type CsvRow = Array<string | number | null>;

/** The full result of a recap run. */
export interface RecapResult {
  /** The active campaign that was recapped. */
  campaign: Campaign;
  /** The campaign hashtag, lowercased, without `"#"`. */
  hashtag: string;
  /** Scrape start boundary, `"YYYY-MM-DD"`. */
  since: string;
  /** All matched records, sorted by KOL name. */
  records: ContentRecord[];
  /** The CSV rows written (parallel to {@link RecapResult.records}). */
  rows: CsvRow[];
  /** Per-platform diagnostics across all KOLs. */
  diagnostics: DiagnosticWithMatched[];
  /** Total monetary cost of the run, in USD. */
  totalCost: number;
  /** Absolute path to the written CSV. */
  outPath: string;
}
