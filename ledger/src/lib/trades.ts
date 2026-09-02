import { mutate } from './sync'
import { listRows, getRow } from './db'

/* ---------------------------------------------------------------------------
   The trade model.

   Two rules this file exists to enforce:

   1. NO P/L IS EVER COMPUTED FROM FILLS. Final dollars and percent are typed
      by hand. The derived numbers below (R-multiple, exit efficiency) are
      computed from what you typed, are always overridable, and never write
      themselves into the P/L fields.

   2. EVENT TIMES ARE YOURS; RECORD TIMES ARE NOT. executed_at, occurred_at and
      captured_at are user-editable. created_at and updated_at come from the
      server clock and are never touched here.
--------------------------------------------------------------------------- */

export const NY = 'America/New_York'

export type TradeStatus = 'draft' | 'open' | 'partially_closed' | 'closed' | 'cancelled' | 'archived'
export type Direction = 'long' | 'short'
export type Grade = 'A' | 'B' | 'C'
export type Adherence = 'yes' | 'no' | 'partially'

export type LegAction = 'buy' | 'sell' | 'short' | 'cover' | 'add' | 'reduce' | 'close' | 'custom'
export type LegRole = 'entry' | 'scale_in' | 'partial_exit' | 'final_exit' | 'other'

export type EventType =
  | 'trade_created' | 'entry' | 'add_to_position' | 'partial_exit' | 'full_exit'
  | 'stop_moved' | 'target_moved' | 'thesis_update' | 'market_observation'
  | 'economic_news' | 'coinglass_observation' | 'screenshot_added' | 'note'
  | 'mistake_or_rule_break' | 'custom'

export interface Trade {
  id: string
  trade_number?: number
  status: TradeStatus
  instrument_id?: string | null
  symbol_snapshot?: string | null
  asset_class?: string | null
  venue?: string | null
  account_label?: string | null
  direction?: Direction | null
  setup_id?: string | null
  setup_name_snapshot?: string | null
  market_condition?: string | null
  session_label?: string | null
  session_derived?: string | null
  grade_at_entry?: Grade | null
  conviction?: number | null
  thesis?: string | null
  invalidation_thesis?: string | null
  pre_trade_plan?: string | null
  planned_entry?: number | null
  planned_stop?: number | null
  planned_target?: number | null
  planned_rr?: number | null
  risk_amount?: number | null
  risk_unit?: string | null
  initial_stop?: number | null
  initial_target?: number | null
  current_stop?: number | null
  current_target?: number | null
  final_pnl_amount?: number | null
  final_pnl_percent?: number | null
  realized_r?: number | null
  mae_price?: number | null
  mfe_price?: number | null
  exit_efficiency?: number | null
  outcome?: 'win' | 'loss' | 'breakeven' | 'scratch' | null
  during_trade_notes?: string | null
  post_trade_review?: string | null
  what_went_well?: string | null
  what_went_wrong?: string | null
  lesson_learned?: string | null
  followed_plan?: Adherence | null
  would_take_again?: boolean | null
  process_grade?: number | null
  needs_review?: boolean
  reviewed_at?: string | null
  opened_at?: string | null
  closed_at?: string | null
  correlated_note?: string | null
  created_at?: string
  updated_at?: string
  deleted_at?: string | null
  rev?: number
}

export interface TradeLeg {
  id: string
  trade_id: string
  sequence: number
  action: LegAction
  action_custom?: string | null
  leg_role?: LegRole | null
  price: number
  quantity: number
  quantity_unit?: string | null
  executed_at: string
  notes?: string | null
  is_superseded?: boolean
  supersedes_id?: string | null
  deleted_at?: string | null
  rev?: number
}

export interface TradeEvent {
  id: string
  trade_id: string
  event_type: EventType
  event_type_custom?: string | null
  occurred_at: string
  title?: string | null
  description?: string | null
  importance?: 'low' | 'normal' | 'high'
  linked_leg_id?: string | null
  payload?: Record<string, unknown>
  is_superseded?: boolean
  deleted_at?: string | null
  rev?: number
}

export interface Instrument {
  id: string
  symbol: string
  display_name?: string | null
  asset_class?: string | null
  venue?: string | null
  is_active?: boolean
  sort_order?: number
}

export interface Setup {
  id: string
  name: string
  description?: string | null
  version?: number
  is_active?: boolean
}

/* --- New York time ------------------------------------------------------- */

const NY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
})
const NY_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false,
})

/** ISO instant → the `YYYY-MM-DD` and `HH:mm` a New York clock would show. */
export function toNYParts(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return { date: NY_DATE.format(d), time: NY_TIME.format(d) }
}

/**
 * New York wall-clock back to an instant.
 * Solved by probing the actual offset at that moment rather than assuming a
 * fixed one, so the March and November DST changes land correctly instead of
 * silently shifting an hour of trades.
 */
export function fromNYParts(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const guess = Date.UTC(y!, (m ?? 1) - 1, d!, hh ?? 0, mm ?? 0)
  let ts = guess
  for (let i = 0; i < 3; i++) {
    const shown = NY_DATE.format(new Date(ts)) + ' ' + NY_TIME.format(new Date(ts))
    const want = `${date} ${time}`
    if (shown === want) break
    const shownMs = Date.parse(shown.replace(' ', 'T') + 'Z')
    ts += guess - shownMs
  }
  return new Date(ts).toISOString()
}

export function nowNYParts() { return toNYParts(new Date().toISOString()) }

export function fmtTime(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))
}

export function fmtDate(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY, weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(iso))
}

export function fmtDuration(fromIso: string, toIso?: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

/** Session inferred from the NY clock, so filters work even when unlabelled. */
export function derivedSession(iso: string): string {
  const d = new Date(iso)
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: NY, hour: '2-digit', hour12: false,
  }).format(d))
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' }).format(d)
  if (dow === 'Sat' || dow === 'Sun') return 'Weekend'
  if (hour < 4) return 'Globex Overnight'
  if (hour < 9) return 'London'
  if (hour < 12) return 'NY AM'
  if (hour < 14) return 'NY Lunch'
  if (hour < 17) return 'NY PM'
  return 'Globex Overnight'
}

/* --- derived metrics ----------------------------------------------------- */
/* All nullable. A missing input yields null, never a guess. */

export function realizedR(t: Trade): number | null {
  if (t.realized_r != null) return t.realized_r        // manual override wins
  if (t.final_pnl_amount == null || !t.risk_amount) return null
  if (t.risk_unit && t.risk_unit !== '$') return null   // units must match
  return round(t.final_pnl_amount / t.risk_amount, 2)
}

/** Excursion in R, measured from the average entry. */
export function excursionR(t: Trade, legs: TradeLeg[], which: 'mae' | 'mfe'): number | null {
  const price = which === 'mae' ? t.mae_price : t.mfe_price
  const entry = avgEntry(legs)
  if (price == null || entry == null || !t.risk_amount || !t.direction) return null
  const stop = t.initial_stop
  if (stop == null) return null
  const perUnit = Math.abs(entry - stop)
  if (perUnit === 0) return null
  const move = t.direction === 'long' ? price - entry : entry - price
  return round(move / perUnit, 2)
}

/** Share of the available move actually captured. Below ~60% is a systematic exit problem. */
export function exitEfficiency(t: Trade, legs: TradeLeg[]): number | null {
  if (t.exit_efficiency != null) return t.exit_efficiency
  const r = realizedR(t)
  const mfe = excursionR(t, legs, 'mfe')
  if (r == null || mfe == null || mfe <= 0 || r <= 0) return null
  // Above 100% means the inputs contradict each other rather than that you had
  // a remarkable exit. Surfaced by checkConsistency instead of shown as a stat.
  const pct = Math.round((r / mfe) * 100)
  return pct > 100 ? null : pct
}

/**
 * Contradictions between the numbers you typed.
 *
 * These are cheap to catch now and nearly impossible to catch later: a year
 * from now the chart is gone and you have no way to tell which of three
 * numbers was the wrong one. Warnings only — nothing is blocked or corrected,
 * because sometimes the odd-looking number is the true one.
 */
export function checkConsistency(t: Trade, legs: TradeLeg[]): string[] {
  const out: string[] = []
  const r = realizedR(t)
  const mfeR = excursionR(t, legs, 'mfe')
  const maeR = excursionR(t, legs, 'mae')
  const entry = avgEntry(legs)

  if (r != null && mfeR != null && r > mfeR + 0.01) {
    out.push(`Result (${r.toFixed(2)}R) is larger than the best move available (${mfeR.toFixed(2)}R). One of P/L, MFE, or risk is off.`)
  }
  if (maeR != null && maeR > 0.01) {
    out.push('MAE is on the profitable side of entry — that should be the worst price against you.')
  }
  if (mfeR != null && mfeR < -0.01) {
    out.push('MFE is on the losing side of entry — that should be the best price in your favour.')
  }
  if (entry != null && t.mae_price != null && t.mfe_price != null && t.direction) {
    const lo = Math.min(t.mae_price, t.mfe_price), hi = Math.max(t.mae_price, t.mfe_price)
    if (entry < lo || entry > hi) out.push('Average entry sits outside the MAE–MFE range.')
  }
  if (t.final_pnl_amount != null && t.outcome === 'win' && t.final_pnl_amount < 0) {
    out.push('Marked a win but P/L is negative.')
  }
  return out
}

export function plannedRR(t: Trade): number | null {
  const { planned_entry: e, planned_stop: s, planned_target: tg } = t
  if (e == null || s == null || tg == null) return null
  const risk = Math.abs(e - s)
  if (risk === 0) return null
  return round(Math.abs(tg - e) / risk, 2)
}

export function avgEntry(legs: TradeLeg[]): number | null {
  const entries = live(legs).filter(l => l.leg_role === 'entry' || l.leg_role === 'scale_in')
  const qty = entries.reduce((s, l) => s + l.quantity, 0)
  if (qty === 0) return null
  return round(entries.reduce((s, l) => s + l.price * l.quantity, 0) / qty, 8)
}

export function openQuantity(legs: TradeLeg[]): number {
  return round(live(legs).reduce((s, l) => {
    const adds = l.leg_role === 'entry' || l.leg_role === 'scale_in'
    return s + (adds ? l.quantity : -l.quantity)
  }, 0), 8)
}

const live = (legs: TradeLeg[]) => legs.filter(l => !l.is_superseded && !l.deleted_at)
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp

/* --- reads --------------------------------------------------------------- */

export const listTrades   = () => listRows<Trade>('trades')
export const getTrade     = (id: string) => getRow<Trade>('trades', id)
export const listInstruments = async () =>
  (await listRows<Instrument>('instruments', r => r.is_active !== false))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
export const listSetups = async () =>
  (await listRows<Setup>('setups', r => r.is_active !== false))
    .sort((a, b) => a.name.localeCompare(b.name))

export const legsFor = async (trade_id: string) =>
  (await listRows<TradeLeg>('trade_legs', r => r.trade_id === trade_id && !r.is_superseded))
    .sort((a, b) => a.executed_at.localeCompare(b.executed_at))

export const eventsFor = async (trade_id: string) =>
  (await listRows<TradeEvent>('trade_events', r => r.trade_id === trade_id && !r.is_superseded))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))

export const openTrades = async () =>
  (await listTrades())
    .filter(t => t.status === 'open' || t.status === 'partially_closed')
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))

export const draftTrades = async () =>
  (await listTrades()).filter(t => t.status === 'draft')

export const needsReview = async () =>
  (await listTrades()).filter(t => t.status === 'closed' && t.needs_review)

/* --- writes -------------------------------------------------------------- */

const uuid = () => crypto.randomUUID()

export async function createTrade(input: {
  instrument_id?: string
  symbol: string
  direction: Direction
  setup_id?: string | null
  setup_name?: string | null
  asset_class?: string | null
  entry?: { price: number; quantity: number; unit?: string; executed_at: string }
  plan?: Partial<Pick<Trade,
    'planned_entry' | 'planned_stop' | 'planned_target' | 'risk_amount' | 'risk_unit' |
    'grade_at_entry' | 'conviction' | 'thesis' | 'invalidation_thesis' | 'pre_trade_plan'>>
}): Promise<string> {
  const id = uuid()
  const at = input.entry?.executed_at ?? new Date().toISOString()

  const trade: Record<string, unknown> = {
    status: input.entry ? 'open' : 'draft',
    instrument_id: input.instrument_id ?? null,
    symbol_snapshot: input.symbol,
    asset_class: input.asset_class ?? null,
    direction: input.direction,
    setup_id: input.setup_id ?? null,
    setup_name_snapshot: input.setup_name ?? null,
    session_derived: derivedSession(at),
    opened_at: input.entry ? at : null,
    needs_review: true,
    tz_label: NY,
    ...input.plan,
  }
  if (input.plan) {
    const rr = plannedRR(input.plan as Trade)
    if (rr != null) trade.planned_rr = rr
    if (input.plan.planned_stop != null)   trade.initial_stop = input.plan.planned_stop
    if (input.plan.planned_target != null) trade.initial_target = input.plan.planned_target
    if (input.plan.planned_stop != null)   trade.current_stop = input.plan.planned_stop
    if (input.plan.planned_target != null) trade.current_target = input.plan.planned_target
  }

  await mutate('trades', id, 'insert', trade)
  await addEvent(id, 'trade_created', at, { title: `${input.direction === 'long' ? 'Long' : 'Short'} ${input.symbol}` })

  if (input.entry) {
    await addLeg(id, {
      action: input.direction === 'long' ? 'buy' : 'short',
      leg_role: 'entry',
      price: input.entry.price,
      quantity: input.entry.quantity,
      quantity_unit: input.entry.unit ?? null,
      executed_at: at,
    })
  }
  return id
}

export async function updateTrade(id: string, patch: Partial<Trade>) {
  await mutate('trades', id, 'update', patch as Record<string, unknown>)
}

export async function addLeg(trade_id: string, leg: {
  action: LegAction
  leg_role: LegRole
  price: number
  quantity: number
  quantity_unit?: string | null
  executed_at: string
  notes?: string | null
}): Promise<string> {
  const id = uuid()
  const existing = await legsFor(trade_id)
  await mutate('trade_legs', id, 'insert', {
    trade_id,
    sequence: existing.length,
    tz_label: NY,
    ...leg,
  })

  const evt: EventType =
    leg.leg_role === 'entry'         ? 'entry'
    : leg.leg_role === 'scale_in'    ? 'add_to_position'
    : leg.leg_role === 'partial_exit'? 'partial_exit'
    : leg.leg_role === 'final_exit'  ? 'full_exit'
    : 'note'
  await addEvent(trade_id, evt, leg.executed_at, {
    title: `${leg.quantity} @ ${leg.price}`,
    description: leg.notes ?? null,
    linked_leg_id: id,
  })

  // Status follows the position, not the other way round.
  const trade = await getTrade(trade_id)
  if (trade) {
    const legs = await legsFor(trade_id)
    const remaining = openQuantity(legs)
    let status: TradeStatus = trade.status
    if (remaining <= 0 && legs.some(l => l.leg_role?.includes('exit'))) status = 'closed'
    else if (leg.leg_role === 'partial_exit') status = 'partially_closed'
    else if (trade.status === 'draft') status = 'open'

    const patch: Partial<Trade> = {}
    if (status !== trade.status) patch.status = status
    if (!trade.opened_at && leg.leg_role === 'entry') patch.opened_at = leg.executed_at
    if (status === 'closed' && !trade.closed_at) patch.closed_at = leg.executed_at
    if (Object.keys(patch).length) await updateTrade(trade_id, patch)
  }
  return id
}

/**
 * Editing a leg inserts a revision and marks the old one superseded rather
 * than overwriting. That is what makes "full edit history" real instead of a
 * claim — the previous price and time remain queryable and exportable.
 */
export async function reviseLeg(leg: TradeLeg, patch: Partial<TradeLeg>) {
  const id = uuid()
  await mutate('trade_legs', id, 'insert', {
    trade_id: leg.trade_id,
    sequence: leg.sequence,
    action: leg.action,
    leg_role: leg.leg_role,
    price: leg.price,
    quantity: leg.quantity,
    quantity_unit: leg.quantity_unit ?? null,
    executed_at: leg.executed_at,
    notes: leg.notes ?? null,
    tz_label: NY,
    supersedes_id: leg.id,
    ...patch,
  })
  await mutate('trade_legs', leg.id, 'update', { is_superseded: true })
}

export async function addEvent(
  trade_id: string,
  event_type: EventType,
  occurred_at: string,
  extra: Partial<TradeEvent> = {},
): Promise<string> {
  const id = uuid()
  await mutate('trade_events', id, 'insert', {
    trade_id, event_type, occurred_at, tz_label: NY, ...extra,
  })
  return id
}

/**
 * Edit an entry after the fact.
 *
 * You will not always be able to log something the moment it happens, and a
 * time you typed from memory an hour later is often wrong. So the recorded
 * time is a claim you can revise, not a fact the app owns.
 *
 * Updated in place rather than superseded: the database audit trigger already
 * records every field's before and after, so the full edit history exists
 * without doubling every row. What you changed and when is recoverable; the
 * timeline itself stays readable.
 */
export async function editEvent(
  id: string,
  patch: Partial<Pick<TradeEvent, 'occurred_at' | 'title' | 'description' | 'event_type' | 'importance'>>,
): Promise<void> {
  await mutate('trade_events', id, 'update', patch)
}

/** Soft delete. Recoverable from the trash, like everything else here. */
export async function removeEvent(id: string): Promise<void> {
  await mutate('trade_events', id, 'delete', {})
}

/** Oldest first — how the trade actually unfolded. */
export const timelineFor = async (trade_id: string) =>
  (await eventsFor(trade_id)).slice().sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

export async function moveLevel(
  trade_id: string,
  kind: 'stop' | 'target',
  price: number,
  effective_at: string,
  reason?: string,
) {
  await mutate('trade_levels', uuid(), 'insert', {
    trade_id, kind, price, effective_at, reason: reason ?? null, tz_label: NY,
  })
  await updateTrade(trade_id, kind === 'stop' ? { current_stop: price } : { current_target: price })
  await addEvent(trade_id, kind === 'stop' ? 'stop_moved' : 'target_moved', effective_at, {
    title: String(price), description: reason ?? null,
  })
}

export async function closeTrade(trade_id: string, input: {
  exit?: { price: number; quantity: number; executed_at: string }
  final_pnl_amount?: number | null
  final_pnl_percent?: number | null
  mae_price?: number | null
  mfe_price?: number | null
  followed_plan?: Adherence | null
  lesson_learned?: string | null
  deferReview?: boolean
}) {
  if (input.exit) {
    const trade = await getTrade(trade_id)
    await addLeg(trade_id, {
      action: trade?.direction === 'long' ? 'sell' : 'cover',
      leg_role: 'final_exit',
      price: input.exit.price,
      quantity: input.exit.quantity,
      executed_at: input.exit.executed_at,
    })
  }

  const patch: Partial<Trade> = {
    status: 'closed',
    closed_at: input.exit?.executed_at ?? new Date().toISOString(),
    final_pnl_amount: input.final_pnl_amount ?? null,
    final_pnl_percent: input.final_pnl_percent ?? null,
    mae_price: input.mae_price ?? null,
    mfe_price: input.mfe_price ?? null,
    followed_plan: input.followed_plan ?? null,
    lesson_learned: input.lesson_learned ?? null,
    needs_review: input.deferReview !== false,
  }
  if (input.final_pnl_amount != null) {
    patch.outcome = input.final_pnl_amount > 0 ? 'win'
                  : input.final_pnl_amount < 0 ? 'loss' : 'breakeven'
  }
  await updateTrade(trade_id, patch)
}

export async function softDeleteTrade(id: string) {
  await mutate('trades', id, 'delete')
}

export async function restoreTrade(id: string) {
  await mutate('trades', id, 'restore')
}
