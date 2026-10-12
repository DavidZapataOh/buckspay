import esCommon from './locales/es/common.json'
import ptCommon from './locales/pt/common.json'
import enCommon from './locales/en/common.json'
import enPayment from './locales/en/payment.json'
import enDebts from './locales/en/debts.json'
import enEvent from './locales/en/event.json'
import enWitness from './locales/en/witness.json'
import enRemote from './locales/en/remote.json'
import enNearby from './locales/en/nearby.json'
import enRewards from './locales/en/rewards.json'
import enZk from './locales/en/zk.json'
import enTransport from './locales/en/transport.json'
import enMesh from './locales/en/mesh.json'
import enIdentity from './locales/en/identity.json'
import enLock from './locales/en/lock.json'
import enSettlement from './locales/en/settlement.json'
import enSettings from './locales/en/settings.json'

export const resources = {
  en: {
    common: enCommon,
    payment: enPayment,
    debts: enDebts,
    event: enEvent,
    witness: enWitness,
    remote: enRemote,
    nearby: enNearby,
    rewards: enRewards,
    zk: enZk,
    transport: enTransport,
    mesh: enMesh,
    identity: enIdentity,
    lock: enLock,
    settlement: enSettlement,
    settings: enSettings,
  },
  es: { common: esCommon },
  pt: { common: ptCommon },
} as const

export const NAMESPACES = Object.keys(resources.en) as (keyof (typeof resources)['en'])[]
