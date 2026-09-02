import {
  toNYParts, fromNYParts, derivedSession, realizedR, excursionR,
  exitEfficiency, plannedRR, avgEntry, openQuantity, fmtDuration,
  type Trade, type TradeLeg,
} from '../src/lib/trades'

let pass = 0, fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

console.log('\nNEW YORK TIME (the DST cases are the ones that silently shift a year of trades)')
// EDT, UTC-4
eq('summer 09:41 ET -> UTC', fromNYParts('2026-08-25','09:41'), '2026-08-25T13:41:00.000Z')
// EST, UTC-5
eq('winter 09:41 ET -> UTC', fromNYParts('2026-01-15','09:41'), '2026-01-15T14:41:00.000Z')
// spring forward: 2am doesn't exist on 2026-03-08
eq('day after spring-forward', fromNYParts('2026-03-09','09:30'), '2026-03-09T13:30:00.000Z')
eq('day before spring-forward', fromNYParts('2026-03-07','09:30'), '2026-03-07T14:30:00.000Z')
// fall back 2026-11-01
eq('day after fall-back', fromNYParts('2026-11-02','09:30'), '2026-11-02T14:30:00.000Z')
eq('day before fall-back', fromNYParts('2026-10-31','09:30'), '2026-10-31T13:30:00.000Z')
// round trips
for (const [d,t] of [['2026-08-25','09:41'],['2026-01-15','16:00'],['2026-03-09','04:00'],['2026-11-02','23:59'],['2026-12-31','00:00']] as const) {
  const back = toNYParts(fromNYParts(d,t))
  eq(`round trip ${d} ${t}`, [back.date, back.time], [d, t])
}

console.log('\nSESSION (derived from the NY clock, so filters work unlabelled)')
eq('09:41 ET Tue', derivedSession('2026-08-25T13:41:00Z'), 'NY AM')
eq('12:30 ET Tue', derivedSession('2026-08-25T16:30:00Z'), 'NY Lunch')
eq('15:00 ET Tue', derivedSession('2026-08-25T19:00:00Z'), 'NY PM')
eq('02:00 ET Tue', derivedSession('2026-08-25T06:00:00Z'), 'Globex Overnight')
eq('07:00 ET Tue', derivedSession('2026-08-25T11:00:00Z'), 'London')
eq('Saturday', derivedSession('2026-08-29T16:00:00Z'), 'Weekend')

console.log('\nDERIVED METRICS')
const legs: TradeLeg[] = [
  { id:'1', trade_id:'t', sequence:0, action:'short', leg_role:'entry', price:19742.5, quantity:2, executed_at:'2026-08-25T13:41:00Z' },
  { id:'2', trade_id:'t', sequence:1, action:'cover', leg_role:'partial_exit', price:19690, quantity:1, executed_at:'2026-08-25T14:31:00Z' },
]
eq('avg entry', avgEntry(legs), 19742.5)
eq('open quantity after partial', openQuantity(legs), 1)

const t: Trade = {
  id:'t', status:'closed', direction:'short',
  risk_amount:600, risk_unit:'$', initial_stop:19860,
  final_pnl_amount:1485, mae_price:19761, mfe_price:19644,
}
eq('realized R', realizedR(t), 2.48)
eq('MAE in R', excursionR(t, legs, 'mae'), -0.16)
eq('MFE in R', excursionR(t, legs, 'mfe'), 0.84)
eq('efficiency null on contradictory inputs', exitEfficiency(t, legs), null)

const t2: Trade = { id:'x', status:'closed', direction:'long',
  risk_amount:500, risk_unit:'$', initial_stop:100, final_pnl_amount:500,
  mfe_price:130, mae_price:98 }
const legs2: TradeLeg[] = [{ id:'a', trade_id:'x', sequence:0, action:'buy', leg_role:'entry', price:110, quantity:1, executed_at:'2026-08-25T13:00:00Z' }]
eq('long MFE in R', excursionR(t2, legs2, 'mfe'), 2)
eq('long MAE in R', excursionR(t2, legs2, 'mae'), -1.2)
eq('long efficiency', exitEfficiency(t2, legs2), 50)

eq('R is null without risk', realizedR({ id:'z', status:'closed', final_pnl_amount:100 }), null)
eq('R respects manual override', realizedR({ id:'z', status:'closed', final_pnl_amount:100, risk_amount:50, risk_unit:'$', realized_r:9 }), 9)
eq('R null when units mismatch', realizedR({ id:'z', status:'closed', final_pnl_amount:100, risk_amount:2, risk_unit:'%' }), null)
eq('planned RR', plannedRR({ id:'p', status:'draft', planned_entry:100, planned_stop:95, planned_target:115 }), 3)
eq('planned RR null when incomplete', plannedRR({ id:'p', status:'draft', planned_entry:100 }), null)

console.log('\nDURATION')
eq('45 min', fmtDuration('2026-08-25T13:00:00Z','2026-08-25T13:45:00Z'), '45m')
eq('1h 21m', fmtDuration('2026-08-25T13:00:00Z','2026-08-25T14:21:00Z'), '1h 21m')
eq('3d 4h', fmtDuration('2026-08-22T13:00:00Z','2026-08-25T17:00:00Z'), '3d 4h')

console.log(`\n${pass} passed, ${fail} failed\n`)


console.log('\nCONSISTENCY WARNINGS')
import { checkConsistency } from '../src/lib/trades'
eq('flags result exceeding MFE', checkConsistency(t, legs).length > 0, true)
eq('efficiency suppressed when impossible', exitEfficiency(t, legs), null)
eq('clean trade has no warnings', checkConsistency(t2, legs2), [])
const bad: Trade = { ...t2, mae_price: 130, mfe_price: 98 }
eq('flags swapped MAE/MFE', checkConsistency(bad, legs2).length >= 1, true)
console.log(`\nFINAL: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
