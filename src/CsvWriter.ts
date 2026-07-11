import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Campaign, ContentRecord, CsvRow } from './types.js';

/**
 * Writes normalized records to the team's 21-column recap CSV template.
 *
 * @remarks
 * Manual columns (Kode, Product, Brand, Type Content, Tone Article, Value, Name of
 * Event, ID) are left blank to be filled in the spreadsheet after export. Numbers
 * (View/Commentar) are RAW integers so the spreadsheet can compute on them; dates are
 * `DD/MM/YYYY`; Month Entry is English. There is no hashtag/likes column (not in the
 * template) — hashtags remain an internal filter concern only.
 *
 * The {@link CsvWriter.HEADER} strings intentionally match the client's actual
 * spreadsheet (Indonesian labels, the `"Commentar(s)"` typo included) and must NOT be
 * translated.
 */
export class CsvWriter {
  /** Team template column order (verbatim — matches the client sheet). */
  static readonly HEADER: string[] = [
    'Kode', 'Tanggal Rekap', 'Nama Blogger/Vlogger', 'Domain Blog/Vlog', 'Source',
    'Source Type', 'Release Date', 'Month Entry', 'Title Article/Video', 'Link',
    'Product', 'Brand', 'Type Content', 'Tone Article', 'Commentar(s)', 'View(s)',
    'Value', 'Name of Event', 'JML', 'ID', 'YEAR',
  ];

  /** English month abbreviations, indexed 0–11, for the Month Entry column. */
  static readonly MONTHS: string[] = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /**
   * @param outputDir - Absolute path to the output folder (created on write if missing).
   */
  constructor(private readonly outputDir: string) {}

  /**
   * RFC-4180 cell escaping.
   * @param v - The raw cell value.
   * @returns The value, quoted if it contains a comma/quote/newline (inner quotes doubled).
   */
  #cell(v: string | number | null | undefined): string {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * Join a row's values into one escaped CSV line.
   * @param arr - The row cells.
   * @returns The comma-joined, escaped line.
   */
  #row(arr: CsvRow): string {
    return arr.map((v) => this.#cell(v)).join(',');
  }

  /**
   * Slugify a name for the output filename.
   * @param name - The campaign name.
   * @returns A lowercase, hyphenated slug.
   */
  #slug(name: string): string {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Parse `"YYYY-MM-DD"` (WIB, from an adapter) into CSV date parts.
   *
   * @remarks
   * Parses the string directly (NOT `new Date`) so there is no further timezone shift.
   *
   * @param iso - Date as `"YYYY-MM-DD"`.
   * @returns `{ date: "DD/MM/YYYY", month: "Jun", year: "2026" }`, or empty strings if unparseable.
   */
  #dateParts(iso: string): { date: string; month: string; year: string } {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return { date: '', month: '', year: '' };
    const [, y, mo, d] = m;
    return { date: `${d}/${mo}/${y}`, month: CsvWriter.MONTHS[Number(mo) - 1] ?? '', year: y ?? '' };
  }

  /**
   * Write normalized records (already filtered & sorted) to the campaign's CSV file.
   *
   * @remarks
   * The header is always written, even with zero rows — the file must exist for the
   * manual spreadsheet work.
   *
   * @param records - The records to write.
   * @param campaign - The campaign (used for the output filename).
   * @returns The absolute output path plus the row arrays that were written.
   */
  write(records: ContentRecord[], campaign: Campaign): { outPath: string; rows: CsvRow[] } {
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
    const recapDate = this.#dateParts(todayIso).date;

    const rows: CsvRow[] = records.map((r) => {
      const p = this.#dateParts(r.date);
      return [
        '',                    // Kode — manual
        recapDate,             // Tanggal Rekap
        r.name,                // Nama Blogger/Vlogger
        `@${r.handle}`,        // Domain Blog/Vlog
        r.platform,            // Source
        r.type,                // Source Type (IG='Reels')
        p.date,                // Release Date
        p.month,               // Month Entry
        r.title,               // Title Article/Video
        r.url,                 // Link
        '',                    // Product — manual
        '',                    // Brand — manual
        '',                    // Type Content — manual
        '',                    // Tone Article — manual
        r.comments,            // Commentar(s)
        r.views,               // View(s)
        '',                    // Value — manual
        '',                    // Name of Event — manual
        1,                     // JML
        '',                    // ID — manual
        p.year,                // YEAR
      ];
    });

    const outPath = join(this.outputDir, `${this.#slug(campaign.name)}_${todayIso}.csv`);
    mkdirSync(this.outputDir, { recursive: true });
    const csv = [this.#row(CsvWriter.HEADER), ...rows.map((r) => this.#row(r))].join('\n') + '\n';
    writeFileSync(outPath, csv);

    return { outPath, rows };
  }
}
