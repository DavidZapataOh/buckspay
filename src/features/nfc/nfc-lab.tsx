import { useRef, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { createNfcNative, nfcLinkStats } from '../../transport/nfc/native'
import { createNfcTransport } from '../../transport/nfc/transport'
import { describeTransportContract } from '../../transport/testing/contract'
import { runAll } from '../../transport/testing/vitest-shim'
import { MessageKind, type Transport } from '../../transport/types'

const SIZES = [35, 136, 387, 1136, 4144, 8192]
const TRIALS = 20
const CHUNK = 200

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff)
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const log = (line: object) => console.log(`NFCLAB ${JSON.stringify(line)}`)

/** Runs the transport contract through the real bridge on two in-memory phones; no radio is involved. */
async function runContract() {
  describeTransportContract('nfc', () => [
    createNfcTransport(createNfcNative(1)),
    createNfcTransport(createNfcNative(2)),
  ])
  const results = await runAll()
  for (const result of results) log({ suite: 'contract', ...result })
  const failed = results.filter((result) => !result.ok).length
  log({ suite: 'contract', passed: results.length - failed, failed })
  return failed === 0
}

/** One trial: the card shows `bytes(size, trial)`, the reader takes it and pushes `bytes(size, trial + 1000)` back. */
async function trial(transport: Transport, role: 'card' | 'reader', size: number, index: number) {
  const started = Date.now()
  const stats = () => nfcLinkStats().at(-1)
  let ok = false
  let result = 'ok'
  try {
    if (role === 'card') {
      await transport.send({ kind: MessageKind.Request, payload: bytes(size, index) })
      const back = await transport.receive({ accept: [MessageKind.Payment], timeoutMs: 60_000 })
      ok = same(back.payload, bytes(size, index + 1000))
    } else {
      const got = await transport.receive({ accept: [MessageKind.Request], timeoutMs: 60_000 })
      ok = same(got.payload, bytes(size, index))
      await transport.send({ kind: MessageKind.Payment, payload: bytes(size, index + 1000) })
    }
  } catch (error) {
    result = String((error as Error).message)
  }
  const link = stats()
  log({
    role,
    size,
    trial: index,
    chunks: Math.ceil((8 + size) / CHUNK),
    ok,
    ms: Date.now() - started,
    apdus: link?.commands,
    rttP50: link?.rttMsP50,
    rttP95: link?.rttMsP95,
    rttMax: link?.rttMsMax,
    result,
  })
  return ok
}

export function NfcLab() {
  const [size, setSize] = useState(387)
  const [status, setStatus] = useState('idle')
  const running = useRef(false)

  const run = async (role: 'card' | 'reader') => {
    if (running.current) return
    running.current = true
    const transport = createNfcTransport(createNfcNative(), role)
    let passed = 0
    for (let i = 0; i < TRIALS; i++) {
      setStatus(`${role} ${size} B: trial ${i + 1} of ${TRIALS}`)
      if (await trial(transport, role, size, i)) passed++
    }
    await transport.close()
    setStatus(`${role} ${size} B: ${passed} of ${TRIALS}`)
    running.current = false
  }

  return (
    <Screen testID="nfc-lab">
      <AppText variant="headline">NFC lab</AppText>
      <AppText variant="body" testID="nfc-lab-status">
        {status}
      </AppText>
      <View className="gap-3">
        <Button
          variant="filled"
          label="Run contract"
          testID="nfc-run-contract"
          onPress={async () => {
            setStatus('contract running')
            setStatus((await runContract()) ? 'contract passed' : 'contract failed')
          }}
        />
        <AppText variant="label">Message size</AppText>
        {SIZES.map((candidate) => (
          <Button
            key={candidate}
            variant={candidate === size ? 'tonal' : 'text'}
            label={`${candidate} B`}
            onPress={() => setSize(candidate)}
          />
        ))}
        <Button variant="filled" label="Card" onPress={() => run('card')} />
        <Button variant="filled" label="Reader" onPress={() => run('reader')} />
      </View>
    </Screen>
  )
}
