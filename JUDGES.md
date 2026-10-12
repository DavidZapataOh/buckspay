# Buckspay: guide for judges

Buckspay lets two phones pay each other with no internet: the payer hands over a signed bearer note over Bluetooth,
NFC or a QR code, the note can be passed on, and whoever holds it credits it to their wallet once they are online.
A security deposit locked on Solana backs every note, so cheating costs more than it gains.

Everything here runs on **Solana devnet**. The "USDC" is a free test token with no value, and a server we run
(`https://gw.lateo.network`) pays the network fees, so **you need no SOL**.

## What you need

- An Android phone (tested on Android 15).
- [Phantom](https://phantom.app) or [Solflare](https://solflare.com), switched to **Devnet**:
  - Phantom: Settings → Developer Settings → Testnet Mode, then pick Solana Devnet.
  - Solflare: Settings → Network → Devnet.
- A second Android phone, only to try payments with no internet. Everything else works with one.

## Install

1. Download `buckspay-1.0.0-devnet.apk` from
   [the release page](https://github.com/DavidZapataOh/buckspay/releases/latest) and open it. Android will ask you to
   allow installing from this source.
2. To check the file: its SHA-256 is `5569096b5bbf090e78b55055a0a9414b12af21a49b8799a6aeb43e84fa6e83f5`, and it is signed with the certificate whose SHA-256 is
   `78:6B:67:EC:2D:8E:61:7F:2C:DB:73:40:9A:2A:CC:0D:F8:C2:AE:5B:00:D1:69:E4:0E:61:77:B0:FA:F7:CF:85`
   (`apksigner verify --print-certs buckspay-1.0.0-devnet.apk`).

## Try it with one phone (about 5 minutes)

1. Open Buckspay. When it asks for nearby devices, Bluetooth and notifications, tap **Allow**.
2. On Home, tap **Set up payments**.
3. **Connect wallet.** Phantom or Solflare opens; approve. The wallet must be on Devnet.
4. **Secure this phone.** It makes a key inside the phone's secure hardware that never leaves it.
5. **Add money.** If your wallet has no test USDC, tap **Get test USDC** (20 test USDC, once a day per wallet).
   Keep the amount it suggests and tap **Activate**, then approve in your wallet. A few seconds later Home shows
   your balance for paying without internet.
6. **Pay someone far away.** Copy this link:

   ```
   BP:X500%HD-AX2LD*RA6WVXRML57K9P*HHZ6WT53%5XT8C.5*-JSTM$R8OVMU94EMUSRI%60P351I046CB-PLQK4PUMDFL51110F5L3I8QPCWQENECP340$CL2
   ```

   Then Pay → **Pay someone far away** → **Add from a pay link** → **Paste a pay link**. Choose "Buckspay Demo",
   type `1`, tap **Review** and **Pay**.

7. Open **History**. The payment goes from on its way to credited once the server settles it; tap it to see its
   details. Payments under 0.05 USDC are credited later; if you try one, the payment's screen offers **Credit it
   yourself**, which settles it from your own wallet.

## Try it with two phones, with no internet

Install and set up both phones as above, then turn on airplane mode and switch Bluetooth back on.

1. **Phone A** (gets paid): Get paid → type an amount → **Charge**. It shows a code.
2. **Phone B** (pays): Pay → pick **Nearby** → **Scan** → choose the code.
3. Both phones show a number: check it is the same and tap **Yes, same**.
4. Phone B shows who and how much: tap **Pay**. Both show a check and play a short sound.

If Bluetooth is not available, pick **QR code** on both: one phone shows a code and the other scans it.
When a phone is online again, its received payments are credited to its wallet by themselves.

**Debts** and **Cancel debts** (Home → History) record what friends owe each other and cancel circles of debt among
three or more phones.

## If something does not work

- The wallet must be on **Devnet**. A wallet on mainnet shows a zero balance and the app will say it cannot read it.
- **Get test USDC** appears only while your wallet holds less than the amount to add; each wallet can ask once every 24
  hours. Another wallet gets its own 20.
- "Can't reach the server": check your internet. `https://gw.lateo.network/health` answers `{"status":"ok"}` when it is
  up.
- To start from zero, uninstall the app. Its key lives in the phone and goes with it.
- The sound and vibration can be turned off in Settings.

The source is in this repository; `README.md` explains how to build it.
