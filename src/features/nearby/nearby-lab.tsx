import { useRef, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { openPairing } from './handoff'
import { type LabRole, trial } from './lab-trial'

const SIZES = [387, 1136, 4144, 8192]
const TRIALS = 5

const log = (line: object) => console.log(`NEARBYLAB ${JSON.stringify(line)}`)

/** Pairs once, then moves each size back and forth `TRIALS` times and logs every trial. End-to-end builds only. */
export function NearbyLab() {
  const [status, setStatus] = useState('idle')
  const running = useRef(false)

  const run = async (role: LabRole) => {
    if (running.current) return
    running.current = true
    try {
      setStatus(`${role}: pairing`)
      const started = Date.now()
      const transport = await openPairing(role === 'host' ? 'receiver' : 'payer')
      log({ role, pairingMs: Date.now() - started })
      for (const size of SIZES) {
        let passed = 0
        for (let i = 0; i < TRIALS; i++) {
          setStatus(`${role} ${size} B: trial ${i + 1} of ${TRIALS}`)
          const result = await trial(transport, role, size, i)
          log(result)
          if (result.ok) passed++
        }
        log({ role, size, passed, of: TRIALS })
      }
      await transport.close()
      setStatus(`${role}: done`)
    } catch (error) {
      setStatus(`${role}: failed ${String((error as Error).message)}`)
    } finally {
      running.current = false
    }
  }

  return (
    <Screen testID="nearby-lab">
      <AppText variant="headline">Nearby lab</AppText>
      <AppText variant="body" testID="nearby-lab-status">
        {status}
      </AppText>
      <View className="gap-3">
        <Button variant="filled" label="Host" testID="nearby-lab-host" onPress={() => run('host')} />
        <Button variant="filled" label="Find" testID="nearby-lab-find" onPress={() => run('find')} />
      </View>
    </Screen>
  )
}
