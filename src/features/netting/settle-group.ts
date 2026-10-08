import type { SettlementRequest } from '../lock/gateway'
import { call, type FetchDeps, refusal } from './record'

export const MAX_GROUP = 8

export type GroupAnswer = {
  transactions: { signature: string; indexes: number[] }[]
  refused: { index: number; reason: string }[]
}

/** Settles up to eight chains together, packed into as few transactions as the gateway can; the answer names each chain's fate by its index. */
export async function settleGroup(chains: SettlementRequest[], deps: FetchDeps = {}): Promise<GroupAnswer> {
  if (chains.length === 0 || chains.length > MAX_GROUP) throw new RangeError('a group settles one to eight chains')
  const { status, json } = await call(deps, '/v1/settlements/group', { settlements: chains })
  if (status !== 200) throw refusal(status, json)
  return json as GroupAnswer
}
