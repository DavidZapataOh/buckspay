/** Every sentence of the rewards screens. */
export const rewardsCopy = {
  title: 'Rewards',
  entry: 'Rewards',
  loading: 'Loading rewards…',
  empty: 'Nothing yet. When you hand a nearby payment in and it settles, the fee shows up here.',
  trust:
    'Tips are paid on trust. The network checks that a tip is genuine, not that you carried the payment: the payer and the service that settles it decide. Only the phone that hands the payment in gets the tip; phones that pass it along get nothing.',
  waiting: 'Delivered a payment · fee {amount} {symbol}, waiting to be paid in',
  ready: 'Ready to claim · {amount} {symbol}',
  claiming: 'Claiming to a new address',
  claimed: 'Claimed · {amount} {symbol} to a new address',
  notPaid: {
    not_delivered: 'Not paid: the payment was not delivered',
    not_added: 'Not paid: the gateway did not add it. Contact support',
    unknown: 'Not paid: the network did not accept this tip',
  },
  explorer: 'View claim on the explorer',
  claim: 'Claim',
  claimTitle: 'Claim to a new address',
  claimBody:
    'The claim goes to a new address. On the blockchain it is not linked to the payments you carried. The service that submits it sees your network address.',
  claimDelayed: 'Claim to a new address',
  claimDelayedNote: 'It is sent at a random time within a day.',
  claimNow: 'Claim now',
  claimNowNote: 'Sending at once is easier to link to the payments you carried.',
  claimScheduled: 'Claim scheduled.',
  claimFailed: 'Couldn’t claim. {reason}',
  move: 'Move to my wallet',
  moveWarning: 'Moving to your wallet links these rewards to that wallet on the blockchain.',
  moveAnyway: 'Move anyway',
  moved: 'Moved to your wallet.',
  moveFailed: 'Couldn’t move the rewards. {reason}',
  cancel: 'Cancel',
  working: 'Working',
  summary: {
    ready: '{amount} {symbol} ready to claim',
    waiting: '{amount} {symbol} waiting to be paid in',
    none: 'No rewards yet',
  },
  tipSwitch: 'Tip people who carry my payments',
  tipAmount: '{amount} {symbol} per delivered payment',
  tipNeedsBond: 'Tipping needs a deposit of at least 32 USDC.',
  tipReview: 'Delivery tip · up to {amount} {symbol}, paid only if your payment settles',
  tipSection: 'Relaying',
  notification: {
    title: 'You earned a fee',
    body: 'A payment you carried was handed in. The fee is paid once the network has it.',
    bodyAmount: 'A payment you carried was handed in: {amount} {symbol}. The fee is paid once the network has it.',
  },
} as const

/** A bond below this cannot cover a tipping channel. */
export const MIN_TIP_BOND = 32_000_000n
