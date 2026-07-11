// Model.ts — abstract ActiveRecord-style base for JSON-file-backed models.
//
// Each concrete model (Kol, Campaign) is one object in an array inside
// <DATA_DIR>/<table>. The base provides generic CRUD; subclasses supply their backing
// file (`static table`), how to rebuild an instance from a plain row (`static hydrate`),
// and how to serialize back to a plain row (`toRow`).
//
// DATA_DIR resolves from the working directory (process.cwd()/db) so the compiled
// dist/db/model/*.js still reads the real db/*.json and the Docker volume. Override
// with DATA_DIR.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'db');

/** The minimum shape of any persisted row — every model has at least these. */
export interface ModelRow {
  id: number;
  created_at: string;
}

/** Static side of a concrete Model subclass (used to type the generic CRUD helpers). */
export interface ModelStatic<T extends Model> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructors have
  // per-subclass row types; this type only asserts "is a constructor for T".
  new (row?: any): T;
  table: string;
  hydrate(row: ModelRow): T;
}

const fileFor = (table: string): string => resolve(DATA_DIR, table);

/** Read the raw JSON array backing a table. */
const readRows = (table: string): ModelRow[] =>
  JSON.parse(readFileSync(fileFor(table), 'utf8')) as ModelRow[];

/** Overwrite a table's JSON array (pretty-printed, trailing newline). */
const writeRows = (table: string, rows: ModelRow[]): void => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(fileFor(table), JSON.stringify(rows, null, 2) + '\n');
};

/** Next integer id for a set of rows: max(id) + 1, or 1 when empty. */
const nextId = (rows: ModelRow[]): number =>
  rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) + 1 : 1;

/**
 * Abstract base every persisted model extends.
 *
 * Subclasses MUST provide:
 *   - `static table` — the backing JSON filename (e.g. "kols.json")
 *   - `static hydrate(row)` — build an instance from a plain row
 *   - `toRow()` — serialize this instance to a plain row
 */
export abstract class Model implements ModelRow {
  /** Backing JSON filename. Overridden by each subclass. */
  static table = '';

  id: number;
  created_at: string;

  constructor(row: Partial<ModelRow> = {}) {
    this.id = Number(row.id ?? 0);
    this.created_at = row.created_at ?? new Date().toISOString();
  }

  /** Serialize this instance to a plain JSON row. Subclasses extend with their fields. */
  abstract toRow(): ModelRow;

  // ---- CRUD: read (static / collection) ----

  /** All records of this model, as hydrated instances. */
  static all<T extends Model>(this: ModelStatic<T>): T[] {
    return readRows(this.table).map((r) => this.hydrate(r));
  }

  /** The record with this id, or null. */
  static find<T extends Model>(this: ModelStatic<T>, id: number): T | null {
    const row = readRows(this.table).find((r) => r.id === id);
    return row ? this.hydrate(row) : null;
  }

  /** Overwrite the whole collection with these instances (bulk update). */
  static saveAll<T extends Model>(this: ModelStatic<T>, models: T[]): void {
    writeRows(this.table, models.map((m) => m.toRow()));
  }

  // ---- CRUD: write (instance) ----

  /** Insert this record (assigning a fresh id) or update it if its id already exists. */
  save(): this {
    const { table } = this.constructor as typeof Model;
    const rows = readRows(table);
    const idx = this.id ? rows.findIndex((r) => r.id === this.id) : -1;
    if (idx >= 0) {
      rows[idx] = this.toRow();
    } else {
      this.id = this.id || nextId(rows);
      rows.push(this.toRow());
    }
    writeRows(table, rows);
    return this;
  }

  /** Remove this record from the backing file. */
  delete(): void {
    const { table } = this.constructor as typeof Model;
    writeRows(table, readRows(table).filter((r) => r.id !== this.id));
  }
}
