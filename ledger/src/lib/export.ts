import {
  type Trade, type TradeLeg, type TradeEvent,
  listTrades, legsFor, eventsFor,
  realizedR, excursionR, exitEfficiency, plannedRR,
  fmtTime, fmtDate, derivedSession,
} from './trades'
import { listRows } from './db'

/* ---------------------------------------------------------------------------
   Analysis export.

   This is the primary analysis interface for this app — not a backup format.
   You paste the output into a chat and ask questions of it.

   One rule shapes everything below: NEVER HAND A MODEL RAW ROWS AND ASK IT TO
   DO ARITHMETIC. Every derived number — R-multiple, excursions in R, exit
   efficiency, win rate, expectancy, profit factor — is computed here, once,
   deterministically. A model reading the result will reliably spot that your
   C-grade setups lose money. It will not reliably average 200 R-multiples.

   Markdown rather than JSON: fewer tokens, readable by both of you, and it
   pastes cleanly on a phone.
--------------------------------------------------------------------------- */

export type Profile = 'stats' | 'deep' | 'prep'

export interface ExportFilter {
  from?: string | null
  to?: string | null
  symbols?: string[]
  directions?: string[]
  statuses?: string[]
  setups?: string[]
  outcomes?: string[]
  sessions?: string[]
  onlyLosses?: boolean
  onlyWins?: boolean
}

const n2 = (v: number | null | undefined, d = '—') =>
  v == null || Number.isNaN(v) ? d : (Math.round(v * 100) / 100).toString()

const money = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString()}`

/** When a trade happened, for sorting and display. Falls back through the
 *  record clock, then to epoch, so a half-filled draft still sorts sanely. */
export const tradeAt = (t: Trade): string =>
  tradeAt(t) ?? '1970-01-01T00:00:00.000Z'

function inRange(t: Trade, f: ExportFilter): boolean {
  const at = tradeAt(t)
  if (f.from && at < f.from) return false
  if (f.to && at > f.to) return false
  if (f.symbols?.length && !f.symbols.includes(t.symbol_snapshot ?? '')) return false
  if (f.directions?.length && !f.directions.includes(t.direction ?? '')) return false
  if (f.statuses?.length && !f.statuses.includes(t.status)) return false
  if (f.setups?.length && !f.setups.includes(t.setup_name_snapshot ?? '')) return false
  if (f.sessions?.length && !f.sessions.includes(t.session_label ?? t.session_derived ?? '')) return false
  if (f.onlyLosses && !((t.final_pnl_amount ?? 0) < 0)) return false
  if (f.onlyWins && !((t.final_pnl_amount ?? 0) > 0)) return false
  return true
}

/* --- summary stats, computed not guessed ---------------------------------- */

export function summarize(trades: Trade[], legsMap: Map<string, TradeLeg[]>) {
  const closed = trades.filter(t => t.final_pnl_amount != null)
  const wins = closed.filter(t => (t.final_pnl_amount ?? 0) > 0)
  const losses = closed.filter(t => (t.final_pnl_amount ?? 0) < 0)
  const gp = wins.reduce((s, t) => s + (t.final_pnl_amount ?? 0), 0)
  const gl = Math.abs(losses.reduce((s, t) => s + (t.final_pnl_amount ?? 0), 0))
  const rs = closed.map(realizedR).filter((r): r is number => r != null)
  const effs = closed
    .map(t => exitEfficiency(t, legsMap.get(t.id) ?? []))
    .filter((e): e is number => e != null)
    .sort((a, b) => a - b)

  return {
    n: closed.length,
    open: trades.filter(t => t.status === 'open' || t.status === 'partially_closed').length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    expectancy: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    profitFactor: gl ? gp / gl : null,
    net: closed.reduce((s, t) => s + (t.final_pnl_amount ?? 0), 0),
    medianEff: effs.length ? (effs[Math.floor(effs.length / 2)] ?? null) : null,
  }
}

/** Grouped breakdowns. Same discipline: computed here, read there. */
function breakdown(trades: Trade[], key: (t: Trade) => string | null): string[] {
  const groups = new Map<string, Trade[]>()
  for (const t of trades) {
    if (t.final_pnl_amount == null) continue
    const k = key(t) || '(unset)'
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  const rows = [...groups.entries()].map(([k, ts]) => {
    const rs = ts.map(realizedR).filter((r): r is number => r != null)
    const avg = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null
    const wins = ts.filter(t => (t.final_pnl_amount ?? 0) > 0).length
    return {
      k, n: ts.length, avg,
      win: Math.round((wins / ts.length) * 100),
      net: ts.reduce((s, t) => s + (t.final_pnl_amount ?? 0), 0),
    }
  }).sort((a, b) => (b.avg ?? -99) - (a.avg ?? -99))

  return rows.map(r =>
    `| ${r.k} | ${r.n} | ${r.win}% | ${r.avg == null ? '—' : (r.avg >= 0 ? '+' : '') + n2(r.avg)}R | ${money(r.net)} |`)
}

/* --- Profile A: stats pack ------------------------------------------------ */

const SCHEMA_NOTE = `**Columns.** \`gr\` = setup grade assigned at entry, before the outcome was known (A/B/C). \`cnv\` = conviction 1-5 at entry. \`plan\` = did I follow my plan. \`1R\` = amount risked. \`R\` = result in multiples of 1R. \`MAE_R\` = worst move against me, in R. \`MFE_R\` = best move in my favour, in R. \`eff\` = percent of the available move actually captured (R ÷ MFE_R). All P/L values were entered by hand; derived columns are computed from them. Nothing is imported from a broker.`

export async function buildStatsPack(filter: ExportFilter = {}): Promise<string> {
  const all = (await listTrades()).filter(t => !t.deleted_at && inRange(t, filter))
  const trades = all.sort((a, b) =>
    tradeAt(a).localeCompare(tradeAt(b)))

  const legsMap = new Map<string, TradeLeg[]>()
  for (const t of trades) legsMap.set(t.id, await legsFor(t.id))

  const s = summarize(trades, legsMap)
  const out: string[] = []

  out.push('# Ledger — analysis export')
  out.push('')
  out.push('Profile A (stats pack) · schema 1.0.0 · all times America/New_York')
  out.push('')
  out.push(SCHEMA_NOTE)
  out.push('')

  if (trades.length) {
    const first = trades[0]!, last = trades[trades.length - 1]!
    out.push(`**Period.** ${fmtDate(tradeAt(first))} to ${fmtDate(tradeAt(last))} · ${trades.length} trades (${s.n} closed, ${s.open} open)`)
  }
  out.push(`**Totals.** win rate ${s.winRate ?? '—'}% · avg ${s.avgR == null ? '—' : (s.avgR >= 0 ? '+' : '') + n2(s.avgR) + 'R'} · expectancy ${s.expectancy == null ? '—' : (s.expectancy >= 0 ? '+' : '') + n2(s.expectancy) + 'R'} · profit factor ${n2(s.profitFactor)} · net $${money(s.net)} · median exit efficiency ${s.medianEff ?? '—'}%`)
  out.push('')

  out.push('| # | date | time | sym | dir | setup | sess | dow | gr | cnv | plan | 1R | P/L | % | R | MAE_R | MFE_R | eff | legs | mistakes |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')

  for (const t of trades) {
    const legs = legsMap.get(t.id) ?? []
    const at = tradeAt(t)
    const mistakes = (await listRows('trade_mistakes', r => r.trade_id === t.id))
      .map(m => m.mistake_key as string)
    out.push([
      t.trade_number ?? '—',
      fmtDate(at).replace(/^\w+,?\s*/, ''),
      fmtTime(at),
      t.symbol_snapshot ?? '—',
      t.direction === 'long' ? 'L' : t.direction === 'short' ? 'S' : '—',
      t.setup_name_snapshot ?? '—',
      t.session_label ?? t.session_derived ?? derivedSession(at),
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(at)),
      t.grade_at_entry ?? '—',
      t.conviction ?? '—',
      t.followed_plan ?? '—',
      t.risk_amount ?? '—',
      money(t.final_pnl_amount),
      t.final_pnl_percent == null ? '—' : (t.final_pnl_percent >= 0 ? '+' : '') + n2(t.final_pnl_percent),
      (() => { const r = realizedR(t); return r == null ? '—' : (r >= 0 ? '+' : '') + n2(r) })(),
      n2(excursionR(t, legs, 'mae')),
      n2(excursionR(t, legs, 'mfe')),
      (() => { const e = exitEfficiency(t, legs); return e == null ? '—' : e + '%' })(),
      legs.filter(l => !l.is_superseded && !l.deleted_at).length,
      mistakes.length ? mistakes.join(',') : '—',
    ].join(' | ').replace(/^/, '| ') + ' |')
  }

  const closed = trades.filter(t => t.final_pnl_amount != null)
  if (closed.length >= 5) {
    out.push('')
    out.push('## Breakdowns')
    for (const [title, fn] of [
      ['By session', (t: Trade) => t.session_label ?? t.session_derived],
      ['By setup', (t: Trade) => t.setup_name_snapshot],
      ['By grade at entry', (t: Trade) => t.grade_at_entry],
      ['By symbol', (t: Trade) => t.symbol_snapshot],
      ['By day of week', (t: Trade) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(tradeAt(t)))],
    ] as [string, (t: Trade) => string | null][]) {
      out.push('')
      out.push(`**${title}**`)
      out.push('')
      out.push('| group | n | win | avg R | net |')
      out.push('|---|---|---|---|---|')
      out.push(...breakdown(closed, fn))
    }
  }

  return out.join('\n') + '\n'
}

/* --- Profile B: deep dive ------------------------------------------------- */

export async function buildDeepDive(filter: ExportFilter = {}): Promise<string> {
  const all = (await listTrades()).filter(t => !t.deleted_at)
  const picked = all.filter(t => inRange(t, filter))
    .sort((a, b) => tradeAt(a).localeCompare(tradeAt(b)))

  const allLegs = new Map<string, TradeLeg[]>()
  for (const t of all) allLegs.set(t.id, await legsFor(t.id))

  const sAll = summarize(all, allLegs)
  const sPick = summarize(picked, allLegs)

  const out: string[] = []
  out.push('# Ledger — analysis export')
  out.push('')
  out.push('Profile B (deep dive) · schema 1.0.0 · all times America/New_York')
  out.push('')
  out.push(`Filter matched ${picked.length} of ${all.length} trades.`)
  out.push('')
  out.push('**Anchor table.** Stats for the full record, so the detail below sits against everything rather than just the filtered slice.')
  out.push('')
  out.push('| scope | n | win | avg R | expectancy | PF | median eff |')
  out.push('|---|---|---|---|---|---|---|')
  out.push(`| all trades | ${sAll.n} | ${sAll.winRate ?? '—'}% | ${n2(sAll.avgR)}R | ${n2(sAll.expectancy)}R | ${n2(sAll.profitFactor)} | ${sAll.medianEff ?? '—'}% |`)
  out.push(`| this filter | ${sPick.n} | ${sPick.winRate ?? '—'}% | ${n2(sPick.avgR)}R | ${n2(sPick.expectancy)}R | ${n2(sPick.profitFactor)} | ${sPick.medianEff ?? '—'}% |`)

  for (const t of picked) {
    const legs = (allLegs.get(t.id) ?? []).filter(l => !l.is_superseded && !l.deleted_at)
    const events = (await eventsFor(t.id)).filter((e: TradeEvent) => !e.is_superseded && !e.deleted_at)
    const at = tradeAt(t)
    const r = realizedR(t)

    out.push('')
    out.push('---')
    out.push('')
    out.push(`## #${t.trade_number ?? '?'} · ${t.symbol_snapshot} ${t.direction} · ${fmtDate(at)} · ${t.session_label ?? t.session_derived ?? ''}`)
    out.push('')
    out.push(`**Result** ${t.final_pnl_amount == null ? 'open' : `$${money(t.final_pnl_amount)} · ${r == null ? '—' : (r >= 0 ? '+' : '') + n2(r) + 'R'}`} · 1R ${t.risk_amount ?? '—'} ${t.risk_unit ?? ''} · MAE ${n2(excursionR(t, legs, 'mae'))}R · MFE ${n2(excursionR(t, legs, 'mfe'))}R · eff ${exitEfficiency(t, legs) ?? '—'}%`)
    out.push(`**Setup** ${t.setup_name_snapshot ?? '—'} · grade **${t.grade_at_entry ?? '—'}** · conviction ${t.conviction ?? '—'} · followed plan: **${t.followed_plan ?? '—'}**`)
    if (plannedRR(t) != null) out.push(`**Plan** entry ${t.planned_entry ?? '—'} · stop ${t.planned_stop ?? '—'} · target ${t.planned_target ?? '—'} · R:R ${n2(plannedRR(t))}`)

    for (const [label, v] of [
      ['Thesis', t.thesis], ['Invalidation', t.invalidation_thesis],
      ['Pre-trade plan', t.pre_trade_plan], ['During trade', t.during_trade_notes],
    ] as [string, string | null | undefined][]) {
      if (v) { out.push(''); out.push(`**${label}**`); out.push(v) }
    }

    if (events.length) {
      out.push('')
      out.push('**Timeline**')
      out.push('```')
      for (const e of events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
        const bits = [e.title, e.description].filter(Boolean).join(' — ')
        out.push(`${fmtTime(e.occurred_at).padStart(8)}  ${e.event_type.padEnd(18)} ${bits}`)
      }
      out.push('```')
    }

    if (legs.length) {
      out.push('')
      out.push('**Legs**')
      out.push('')
      out.push('| time | action | price | qty |')
      out.push('|---|---|---|---|')
      for (const l of legs.sort((a, b) => a.executed_at.localeCompare(b.executed_at))) {
        out.push(`| ${fmtTime(l.executed_at)} | ${l.action} | ${l.price} | ${l.quantity} |`)
      }
    }

    for (const [label, v] of [
      ['Review', t.post_trade_review], ['What went well', t.what_went_well],
      ['What went wrong', t.what_went_wrong], ['Lesson', t.lesson_learned],
    ] as [string, string | null | undefined][]) {
      if (v) { out.push(''); out.push(`**${label}** · ${v}`) }
    }
  }

  return out.join('\n') + '\n'
}

/* --- Lossless JSON, for backup and restore -------------------------------- */

export async function buildJSON(): Promise<string> {
  const tables = ['instruments', 'setups', 'trades', 'trade_legs', 'trade_levels',
                  'trade_events', 'trade_mistakes', 'daily_preps']
  const data: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  for (const t of tables) {
    const rows = await listRows(t)
    data[t] = rows
    counts[t] = rows.length
  }
  return JSON.stringify({
    format: 'trading-journal-export',
    format_version: '1.0.0',
    schema_version: '1.0.0',
    exported_at: new Date().toISOString(),
    timezone: 'America/New_York',
    counts,
    data,
  }, null, 2)
}

export async function buildExport(profile: Profile, filter: ExportFilter = {}) {
  if (profile === 'deep') return buildDeepDive(filter)
  if (profile === 'prep') return buildStatsPack(filter)
  return buildStatsPack(filter)
}

/** Clipboard first — that's the primary action on a phone. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
