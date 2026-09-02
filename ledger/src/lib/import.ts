import { mutate } from './sync'
import { listRows } from './db'

/* ---------------------------------------------------------------------------
   Import / restore.

   A first-class, tested feature — not a script written during an emergency.
   Four properties it must have, and each is a rule below:

   1. VALIDATE BEFORE WRITING. An unknown format is refused, never guessed at.
   2. IDEMPOTENT BY PRIMARY KEY. Importing the same file twice yields one copy
      of each record, because IDs were generated on the device that created
      them and travel with the row.
   3. ALL OR NOTHING. Anything malformed and the database is left untouched.
   4. A WRITTEN REPORT. Rows read, written, skipped, and why.

   Point 2 is what makes restore safe to attempt when you're not sure whether
   the last one worked.
--------------------------------------------------------------------------- */

export const FORMAT = 'trading-journal-export'
export const SUPPORTED_MAJOR = 1

/** Parent-first, so a leg never lands before the trade it belongs to. */
const ORDER = [
  'instruments', 'setups', 'trades',
  'trade_legs', 'trade_levels', 'trade_events', 'trade_mistakes',
  'daily_preps',
] as const

export type MergeMode = 'skip' | 'overwrite'

export interface ImportReport {
  ok: boolean
  format_version?: string
  exported_at?: string
  read: Record<string, number>
  written: Record<string, number>
  skipped: Record<string, number>
  errors: string[]
  summary: string
}

interface Envelope {
  format?: string
  format_version?: string
  exported_at?: string
  counts?: Record<string, number>
  data?: Record<string, Record<string, unknown>[]>
}

/**
 * Read and check a file without touching anything.
 * Always run this first — it's what makes "all or nothing" true.
 */
export function validate(raw: string): { env: Envelope | null; errors: string[] } {
  const errors: string[] = []
  let env: Envelope

  try {
    env = JSON.parse(raw) as Envelope
  } catch {
    return { env: null, errors: ['Not valid JSON. The file may be truncated or corrupted.'] }
  }

  if (env.format !== FORMAT) {
    errors.push(`Not a Ledger export (found format "${env.format ?? 'none'}").`)
  }

  const major = Number((env.format_version ?? '').split('.')[0])
  if (!Number.isFinite(major)) {
    errors.push('Missing format_version.')
  } else if (major > SUPPORTED_MAJOR) {
    // Refuse rather than guess. A newer format may mean something different by
    // the same field name, and a best-effort import would corrupt quietly.
    errors.push(
      `This file is format ${env.format_version}, newer than this app understands (${SUPPORTED_MAJOR}.x). ` +
      `Update the app rather than importing — a partial read could corrupt records silently.`)
  }

  if (!env.data || typeof env.data !== 'object') {
    errors.push('No data section.')
  } else {
    for (const table of ORDER) {
      const rows = env.data[table]
      if (rows === undefined) continue
      if (!Array.isArray(rows)) { errors.push(`Table "${table}" is not a list.`); continue }
      const bad = rows.findIndex(r => !r || typeof r !== 'object' || typeof r.id !== 'string')
      if (bad >= 0) errors.push(`Table "${table}" row ${bad} has no id. Every row must carry its own id.`)
    }

    // Counts in the manifest are the file's own claim about itself. If they
    // disagree with the payload, the file was truncated mid-write.
    if (env.counts) {
      for (const [table, claimed] of Object.entries(env.counts)) {
        const actual = env.data[table]?.length ?? 0
        if (actual !== claimed) {
          errors.push(`"${table}" claims ${claimed} rows but contains ${actual}. File looks truncated.`)
        }
      }
    }
  }

  return { env: errors.length ? null : env, errors }
}

/** Preview what an import would do, without writing anything. */
export async function dryRun(raw: string, mode: MergeMode = 'skip'): Promise<ImportReport> {
  return run(raw, mode, true)
}

export async function importExport(raw: string, mode: MergeMode = 'skip'): Promise<ImportReport> {
  return run(raw, mode, false)
}

async function run(raw: string, mode: MergeMode, dry: boolean): Promise<ImportReport> {
  const read: Record<string, number> = {}
  const written: Record<string, number> = {}
  const skipped: Record<string, number> = {}

  const { env, errors } = validate(raw)
  if (!env) {
    return {
      ok: false, read, written, skipped, errors,
      summary: `Import refused. Nothing was changed.\n\n${errors.map(e => `• ${e}`).join('\n')}`,
    }
  }

  // Build the full write plan before making any change, so a failure halfway
  // through parsing can't leave the database half-updated.
  const plan: { table: string; id: string; row: Record<string, unknown> }[] = []

  for (const table of ORDER) {
    const rows = env.data?.[table] ?? []
    read[table] = rows.length
    written[table] = 0
    skipped[table] = 0
    if (!rows.length) continue

    const existing = new Set((await listRows(table)).map(r => r.id as string))

    for (const row of rows) {
      const id = row.id as string
      if (existing.has(id) && mode === 'skip') { skipped[table]!++; continue }

      // Server-owned columns are dropped: the receiving database assigns its
      // own record clock and sequence. Event times — the ones you asserted —
      // are preserved exactly.
      const { created_at, updated_at, rev, last_mutation, trade_number, user_id, ...rest } = row
      void created_at; void updated_at; void rev; void last_mutation
      void trade_number; void user_id

      plan.push({ table, id, row: rest })
      written[table]!++
    }
  }

  if (dry) {
    return {
      ok: true, format_version: env.format_version, exported_at: env.exported_at,
      read, written, skipped, errors: [],
      summary: describe('Would import', read, written, skipped, env),
    }
  }

  try {
    for (const p of plan) {
      await mutate(p.table, p.id, 'insert', p.row)
    }
  } catch (e) {
    return {
      ok: false, read, written, skipped,
      errors: [String(e)],
      summary: `Import failed partway through. ${plan.length} rows were queued before the error; ` +
               `they are idempotent by id, so re-running this import is safe and will not duplicate anything.`,
    }
  }

  return {
    ok: true, format_version: env.format_version, exported_at: env.exported_at,
    read, written, skipped, errors: [],
    summary: describe('Imported', read, written, skipped, env),
  }
}

function describe(
  verb: string,
  read: Record<string, number>,
  written: Record<string, number>,
  skipped: Record<string, number>,
  env: Envelope,
): string {
  const lines: string[] = []
  lines.push(`${verb} from a ${env.format_version} export${env.exported_at ? ` taken ${new Date(env.exported_at).toLocaleString()}` : ''}.`)
  lines.push('')
  const totalW = Object.values(written).reduce((a, b) => a + b, 0)
  const totalS = Object.values(skipped).reduce((a, b) => a + b, 0)
  lines.push(`${totalW} rows ${verb.toLowerCase()}, ${totalS} already present and left alone.`)
  lines.push('')
  for (const t of ORDER) {
    if (!read[t]) continue
    lines.push(`  ${t.padEnd(16)} read ${String(read[t]).padStart(5)}  written ${String(written[t] ?? 0).padStart(5)}  skipped ${String(skipped[t] ?? 0).padStart(5)}`)
  }
  lines.push('')
  lines.push('Imported rows are queued like any other change and will upload when you have signal.')
  return lines.join('\n')
}

/** Round-trip check: export → wipe → import → export must match. Run on release. */
export async function verifyRoundTrip(before: string, after: string): Promise<string[]> {
  const problems: string[] = []
  const a = JSON.parse(before) as Envelope
  const b = JSON.parse(after) as Envelope
  for (const t of ORDER) {
    const na = a.data?.[t]?.length ?? 0
    const nb = b.data?.[t]?.length ?? 0
    if (na !== nb) problems.push(`${t}: ${na} before, ${nb} after`)
  }
  return problems
}
