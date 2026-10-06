import type { Bundle } from '../../../payment/messages'
import { MINT, makeTicket, NOW, type Party, signIssue } from '../../../payment/testing/world'

/** A payment of `issuer` to `to` as it arrives: a signed issue and the issuer's ticket. */
export function signedPayment(issuer: Party, to: Party): Bundle {
  return {
    issue: signIssue(issuer, {
      issuer: issuer.key,
      mint: MINT,
      lockSeq: 3,
      cumEnd: 7_000_000n,
      salt: new Uint8Array(16).fill(7),
      owner: { type: 'device', key: to.key },
      amount: 5_000_000n,
      caveats: { expiry: NOW + 72 * 3600, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
    }),
    spends: [],
    tickets: [
      makeTicket({
        device: issuer.key,
        mint: MINT,
        lockSeq: 3,
        bond: 50_000_000n,
        backing: 100_000_000n,
        lockUntil: NOW + 30 * 86400,
      }),
    ],
  }
}
