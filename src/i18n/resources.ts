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
import esCommon from './locales/es/common.json'
import esPayment from './locales/es/payment.json'
import esDebts from './locales/es/debts.json'
import esEvent from './locales/es/event.json'
import esWitness from './locales/es/witness.json'
import esRemote from './locales/es/remote.json'
import esNearby from './locales/es/nearby.json'
import esRewards from './locales/es/rewards.json'
import esZk from './locales/es/zk.json'
import esTransport from './locales/es/transport.json'
import esMesh from './locales/es/mesh.json'
import esIdentity from './locales/es/identity.json'
import esLock from './locales/es/lock.json'
import esSettlement from './locales/es/settlement.json'
import esSettings from './locales/es/settings.json'
import ptCommon from './locales/pt/common.json'
import ptPayment from './locales/pt/payment.json'
import ptDebts from './locales/pt/debts.json'
import ptEvent from './locales/pt/event.json'
import ptWitness from './locales/pt/witness.json'
import ptRemote from './locales/pt/remote.json'
import ptNearby from './locales/pt/nearby.json'
import ptRewards from './locales/pt/rewards.json'
import ptZk from './locales/pt/zk.json'
import ptTransport from './locales/pt/transport.json'
import ptMesh from './locales/pt/mesh.json'
import ptIdentity from './locales/pt/identity.json'
import ptLock from './locales/pt/lock.json'
import ptSettlement from './locales/pt/settlement.json'
import ptSettings from './locales/pt/settings.json'

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
  es: {
    common: esCommon,
    payment: esPayment,
    debts: esDebts,
    event: esEvent,
    witness: esWitness,
    remote: esRemote,
    nearby: esNearby,
    rewards: esRewards,
    zk: esZk,
    transport: esTransport,
    mesh: esMesh,
    identity: esIdentity,
    lock: esLock,
    settlement: esSettlement,
    settings: esSettings,
  },
  pt: {
    common: ptCommon,
    payment: ptPayment,
    debts: ptDebts,
    event: ptEvent,
    witness: ptWitness,
    remote: ptRemote,
    nearby: ptNearby,
    rewards: ptRewards,
    zk: ptZk,
    transport: ptTransport,
    mesh: ptMesh,
    identity: ptIdentity,
    lock: ptLock,
    settlement: ptSettlement,
    settings: ptSettings,
  },
} as const

export const NAMESPACES = Object.keys(resources.en) as (keyof (typeof resources)['en'])[]
