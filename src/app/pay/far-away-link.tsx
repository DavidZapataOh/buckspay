import { router } from 'expo-router'
import { useState } from 'react'
import { FarAwayLink } from '../../features/remote/far-away-link'
import { useFarAway } from '../../features/remote/use-far-away'
import { pasteInto } from '../../features/qr/paste-source'

export default function PayFarAwayLink() {
  const far = useFarAway()
  const [notice, setNotice] = useState<string>()
  const submit = async (text: string) => {
    const failure = await far.addLink(text)
    if (failure) setNotice(failure)
    else router.back()
  }
  return (
    <FarAwayLink
      notice={notice}
      onText={(text) => void submit(text)}
      onPaste={() => void pasteInto((text) => void submit(text))}
      onCancel={() => router.back()}
    />
  )
}
