import { equalBytes } from '@noble/curves/utils.js'
import { signIssue } from '../keys'
import { encodeIssueBody, type Issue } from '../protocol'
import { PayError } from './pay'

/**
 * `PayDeps.sign` on the device: the native guard signs the stored issue. The issue was made recordable
 * before it was stored, so the device must not change it; one it changed has an id the receipt would not name.
 */
export async function signStoredIssue(issue: Issue): Promise<Uint8Array> {
  const signed = await signIssue(issue)
  if (!equalBytes(encodeIssueBody(signed.message), encodeIssueBody(issue))) throw new PayError('Mismatch')
  return signed.signature
}
