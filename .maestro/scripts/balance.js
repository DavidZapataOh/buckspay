// Reads the balance of the copied wallet address at the flow's RPC_URL, in lamports.
const response = http.post(RPC_URL, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [maestro.copiedText, { commitment: 'confirmed' }],
  }),
})
output.balance = json(response.body).result.value
