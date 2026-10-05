// Gives the copied wallet address 100 tokens of the test funding token, through the faucet that
// `usdc-faucet.mjs` serves at the flow's FAUCET_URL, and waits until they are confirmed.
const response = http.post(FAUCET_URL, {
  headers: { 'Content-Type': 'text/plain' },
  body: maestro.copiedText,
})
if (!response.ok) throw new Error('the faucet refused ' + maestro.copiedText + ': ' + response.body)
output.fundingAccount = response.body
