import AsyncStorage from '@react-native-async-storage/async-storage'
import { CameraView, type CameraType, useCameraPermissions } from 'expo-camera'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { Button } from '../../components/button'
import { IconButton } from '../../components/icon-button'
import { StatusNote } from '../../components/status-note'
import { textToFrame } from '../../transport/qr/text'
import { pasteInto } from './paste-source'

const FACING_KEY = 'qr:facing'

/**
 * The camera preview feeding scanned texts to `onText`, with Paste as the way in when the camera is
 * off or out of reach. The caller unmounts it when it has what it needs, which stops the camera.
 */
export function QrScanner({ onText }: { onText: (text: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions()
  const [facing, setFacing] = useState<CameraType>('back')
  const [torch, setTorch] = useState(false)
  const [rejected, setRejected] = useState(false)

  useEffect(() => {
    void requestPermission()
    // Once, when the scanner appears: the camera is never requested at app start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void AsyncStorage.getItem(FACING_KEY).then((stored) => stored === 'front' && setFacing('front'))
  }, [])

  const flip = () => {
    const next = facing === 'back' ? 'front' : 'back'
    setFacing(next)
    void AsyncStorage.setItem(FACING_KEY, next)
  }

  const paste = async () => {
    let text = ''
    const found = await pasteInto((pasted) => {
      text = pasted
      onText(pasted)
    })
    setRejected(!found || textToFrame(text) === null)
  }

  const denied = permission?.status === 'denied'

  return (
    <View className="flex-1 gap-3">
      <View className="flex-1 overflow-hidden rounded-3xl bg-surface-variant">
        {permission?.granted && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing={facing}
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => onText(data)}
          />
        )}
      </View>
      {denied && (
        <>
          <StatusNote
            tone="danger"
            message="Camera access is off. Allow it in Settings to scan, or paste the code instead."
          />
          <Button variant="tonal" label="Open Settings" onPress={() => void Linking.openSettings()} />
        </>
      )}
      <StatusNote tone="danger" message={rejected ? "That isn't a Buckspay code." : undefined} />
      <View className="flex-row items-center justify-between">
        <Button variant="text" label="Paste code" onPress={() => void paste()} />
        <View className="flex-row">
          <IconButton icon="cameraswitch" label="Use the front camera" onPress={flip} />
          <IconButton
            icon={torch ? 'flashlight_off' : 'flashlight_on'}
            label={torch ? 'Turn the light off' : 'Turn the light on'}
            onPress={() => setTorch(!torch)}
          />
        </View>
      </View>
    </View>
  )
}
