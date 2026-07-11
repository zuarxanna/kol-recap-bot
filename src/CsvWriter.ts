// CsvWriter — filtered records -> a CSV file following the team's recap template
// (21 columns).
//
// Manual columns are left blank (filled in the spreadsheet after export):
//   Kode, Product, Brand, Type Content, Tone Article, Value, Name of Event, ID.
// The rest are auto-filled from the scrape/run. Numbers (View/Commentar) are RAW
// integers so the spreadsheet can compute on them. Dates are DD/MM/YYYY, Month Entry
// is English (Oct, ...). There is no hashtag/likes column (not in the template) —
// hashtags remain an internal filter concern only.
//
// NOTE: the HEADER strings below intentionally match the client's actual spreadsheet
// (Indonesian labels, "Commentar(s)" typo included). Do NOT translate them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Campaign, ContentRecord, CsvRow } from './types.js';

/** Writes normalized records to the team's 21-column recap CSV. */
export class CsvWriter {
  /** Team template column order (verbatim — matches the client sheet). */
  static readonly HEADER: string[] = [
    'Kode', 'Tanggal Rekap', 'Nama Blogger/Vlogger', 'Domain Blog/Vlog', 'Source',
    'Source Type', 'Release Date', 'Month Entry', 'Title Article/Video', 'Link',
    'Product', 'Brand', 'Type Content', 'Tone Article', 'Commentar(s)', 'View(s)',
    'Value', 'Name of Event', 'JML', 'ID', 'YEAR',
  ];

  /** English month abbreviations for the Month Entry column. */
  static readonly MONTHS: string[] = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /**
   * @param outputDir - Absolute path to the output folder (created if missing).
   */
  constructor(private readonly outputDir: string) {}

  /**
   * RFC-4180 cell escaping: wrap in quotes when the value contains a comma/quote/
   * newline; escape inner quotes as "".
   */
  #cell(v: string | number | null | undefined): string {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Join an array of values into one escaped CSV row. */
  #row(arr: CsvRow): string {
    return arr.map((v) => this.#cell(v)).join(',');
  }

  /** Slugify a name for the output filename. */
  #slug(name: string): string {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Parse "YYYY-MM-DD" (WIB, from an adapter) into CSV date parts. Parses the string
   * directly (NOT new Date) so there is no further timezone shift.
   */
  #dateParts(iso: string): { date: string; month: string; year: string } {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return { date: '', month: '', year: '' };
    const [, y, mo, d] = m;
    return { date: `${d}/${mo}/${y}`, month: CsvWriter.MONTHS[Number(mo) - 1] ?? '', year: y ?? '' };
  }

  /**
   * Write normalized records (already filtered & sorted) to the campaign's CSV file.
   * @returns Absolute output path + the row arrays.
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
    // The header is ALWAYS written even with 0 rows — the file must exist for manual work.
    const csv = [this.#row(CsvWriter.HEADER), ...rows.map((r) => this.#row(r))].join('\n') + '\n';
    writeFileSync(outPath, csv);

    return { outPath, rows };
  }
}
