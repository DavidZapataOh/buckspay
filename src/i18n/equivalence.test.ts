import { describe, expect, it } from 'vitest'
import { copy } from '../features/payment/copy'
import { witnessCopy } from '../features/witness/copy'
import { remoteCopy } from '../features/remote/copy'
import { rewardsCopy } from '../features/rewards/copy'
import { eventCopy } from '../features/event/copy'
import { howCopy } from '../features/transport/copy'
import { debtsCopy } from '../features/debts/copy'
import { meshCopy } from '../features/mesh/copy'
import { zkCopy } from '../features/zk/copy'
import { failureText } from '../features/nearby/copy'
import { pointReasonText } from '../features/event/copy'
import { Reason } from '../payment/reasons'
import { i18n } from './index'
import { resources } from './resources'

type Tree = { [key: string]: unknown }
const leaves = (node: unknown, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : node && typeof node === 'object'
      ? Object.entries(node as Tree).flatMap(([key, value]) => leaves(value, [...path, key]))
      : []
const converted = (text: string) => text.replace(/\{(\w+)\}/g, '{{$1}}')
const lookup = (tree: unknown, key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree)

const modules: [string, unknown][] = [
  ['payment', copy],
  ['witness', witnessCopy],
  ['remote', remoteCopy],
  ['rewards', rewardsCopy],
  ['event', eventCopy],
  ['transport', howCopy],
  ['zk', zkCopy],
]

describe.each(modules)('the English catalog "%s"', (area, old) => {
  it('says exactly what the old module said, in every text', () => {
    for (const [key, text] of leaves(old)) {
      expect(lookup((resources.en as Tree)[area], key), `${area}.${key}`).toBe(converted(text))
    }
  })
})

describe('the functions that became texts with placeholders', () => {
  it('say what they said', () => {
    expect(i18n.t('debts:owed', { peer: 'Ana', amount: '5.00' })).toBe(debtsCopy.owed('Ana', '5.00'))
    expect(i18n.t('debts:owe', { peer: 'Ana', amount: '5.00' })).toBe(debtsCopy.owe('Ana', '5.00'))
    expect(i18n.t('debts:settled', { peer: 'Ana' })).toBe(debtsCopy.settled('Ana'))
    expect(i18n.t('debts:waiting', { peer: 'Ana' })).toBe(debtsCopy.waiting('Ana'))
    expect(i18n.t('debts:notSigned', { peer: 'Ana' })).toBe(debtsCopy.notSigned('Ana'))
    expect(i18n.t('debts:netted', { amount: '5.00', date: '12/10/2026' })).toBe(debtsCopy.netted('5.00', '12/10/2026'))
    expect(i18n.t('debts:settling', { amount: '5.00' })).toBe(debtsCopy.settling('5.00'))
    expect(i18n.t('debts:record', { code: 'AB12' })).toBe(debtsCopy.record('AB12'))
    expect(i18n.t('debts:dueOn', { date: '12/10/2026' })).toBe(debtsCopy.dueOn('12/10/2026'))
    expect(i18n.t('debts:before', { line: 'x' })).toBe(debtsCopy.before('x'))
    expect(i18n.t('debts:after', { line: 'x' })).toBe(debtsCopy.after('x'))
    expect(i18n.t('debts:declined', { peer: 'Ana' })).toBe(debtsCopy.declined('Ana'))
    expect(i18n.t('debts:paymentFailed', { amount: '5.00' })).toBe(debtsCopy.paymentFailed('5.00'))
    expect(i18n.t('debts:settleBefore', { date: '12/10/2026' })).toBe(debtsCopy.settleBefore('12/10/2026'))
    for (const count of [0, 1, 3]) {
      expect(i18n.t('mesh:warnings', { count })).toBe(meshCopy.warnings(count))
      expect(i18n.t('mesh:passedOn', { count })).toBe(meshCopy.passedOn(count))
    }
  })

  it('keep the zk states, the pairing failures and the point refusals', () => {
    const zk = (state: Parameters<typeof zkCopy.state>[0]) => zkCopy.state(state)
    expect(zk({ kind: 'ready' } as never)).toBe(i18n.t('zk:state.ready'))
    expect(zk({ kind: 'submitting' } as never)).toBe(i18n.t('zk:state.submitting'))
    expect(zk({ kind: 'settled' } as never)).toBe(i18n.t('zk:state.settled'))
    expect(zk({ kind: 'needs-key', progress: 0.5 } as never)).toBe(i18n.t('zk:state.needsKey', { percent: '50%' }))
    expect(zk({ kind: 'proving', proved: 1, total: 3 } as never)).toBe(
      i18n.t('zk:state.preparing', { proved: 1, total: 3 }),
    )
    expect(zk({ kind: 'failed', reason: 'retry' } as never)).toBe(i18n.t('zk:state.failed.retry'))
    for (const reason of ['Declined', 'Timeout', 'RadioOff', 'Permission', 'Unsupported', 'Error'] as const) {
      expect(i18n.t(`nearby:failed.${reason}`)).toBe(failureText(reason))
    }
    expect(i18n.t('event:pointReasons.doubleSpend')).toBe(pointReasonText(Reason.DoubleSpend))
    expect(i18n.t('event:pointReasons.scope')).toBe(pointReasonText(Reason.Scope))
    expect(i18n.t('event:pointReasons.notForYou')).toBe(pointReasonText(Reason.NotForYou))
  })
})
