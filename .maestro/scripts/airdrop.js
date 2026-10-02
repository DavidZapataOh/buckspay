// Funds the connected wallet on the local validator and waits until the airdrop is confirmed.
const rpc = (method, params) =>
  json(
    http.post(RPC_URL, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
    }).body,
  )

const wallet = maestro.copiedText
const signature = rpc('requestAirdrop', [wallet, 2000000000, { commitment: 'confirmed' }]).result
let status = null
for (let i = 0; i < 5000 && !status; i++) {
  const value = rpc('getSignatureStatuses', [[signature]]).result.value[0]
  if (value && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')) status = value
}
if (!status) throw new Error('airdrop to ' + wallet + ' was not confirmed')
output.airdrop = signature
