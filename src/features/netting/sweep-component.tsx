import { address } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { type ReactElement, useMemo } from 'react'
import { useDebts } from '../debts/use-debts'
import { usePayments } from '../payment/payments-provider'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { createChainReads, nettingOutcome } from './record'
import { receivedPaymentIn, type SweepDeps, sweepAll } from './sweep'
import { useNettingSweep } from './use-sweep'
import { noteStateDeps } from './note-reads'
import { noteState } from './remainder'

const PROGRAM = address(ACTIVE_PROFILE.programId)

/** Reads the chain for every netting and repayment this phone is waiting on, in the background. Renders nothing. */
export function NettingSweep(): ReactElement | null {
  const { db, domains } = usePayments()
  const debts = useDebts()
  const { client } = useMobileWallet()
  const deps = useMemo(() => {
    if (!db || !debts) return undefined
    const reads = createChainReads(client.rpc, PROGRAM)
    const notes = noteStateDeps(reads, domains.noteDomain)
    return {
      db,
      now: debts.now,
      nettingOutcome: (statement: Parameters<typeof nettingOutcome>[0]) => nettingOutcome(statement, { reads }),
      noteState: (input: Parameters<typeof noteState>[0]) => noteState(input, notes),
      receivedPayment: receivedPaymentIn(db),
    }
  }, [db, debts, domains.noteDomain, client.rpc])
  return deps ? <Sweeper deps={deps} /> : null
}

function Sweeper({ deps }: { deps: SweepDeps }): null {
  useNettingSweep(() => sweepAll(deps))
  return null
}
