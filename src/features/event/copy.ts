import { Reason } from '../../payment/reasons'

/** The words of the closed-circuit screens. */
export const eventCopy = {
  title: 'Events',
  settings: 'Events',
  joined: 'Events you joined',
  organised: 'Events you run',
  none: 'No events yet.',
  join: 'Join an event',
  run: 'Run an event',
  ends: 'Ends {date}',
  scanInvite: "Scan the organiser's invite",
  notInvite: "This code isn't an event invite.",
  organiser: 'Organiser',
  accept: 'Accept credit from this event',
  ended: 'This event has ended',
  nowAccepting: 'You can now accept credit from {name}.',
  already: 'You already joined {name}.',
  runTitle: 'Run an event',
  name: 'Event name',
  hours: 'Hours it lasts',
  create: 'Create the event',
  invite: 'Invite attendees',
  pair: 'Pair a point',
  holdToReveal: 'Hold to show the code that pairs a point',
  secretNote: 'This code carries the event secret. Show it only to your own points.',
  creditFor: 'Event credit for {event}',
  onlyAt: 'Only usable at {event}',
  onlyAtShort: 'Only at {event}',
  pointTitle: 'Point mode',
  scanPairing: "Scan the pairing code on the organiser's phone",
  notPairing: "This code isn't a point pairing.",
  pointFor: 'Taking payments for {event}',
  linkHost: 'Link a point: show',
  linkFind: 'Link a point: find',
  leave: 'Leave point mode',
  noPeers: 'No other point is linked.',
  waiting: 'Linked with {count} points, waiting for the first sync.',
  synced: 'Synced with {count} points, {seconds} s ago',
  amount: 'Amount',
  take: 'Ask for payment',
} as const

const POINT_REASONS: Partial<Record<Reason, string>> = {
  [Reason.DoubleSpend]: 'Already spent at another point',
  [Reason.Scope]: "This credit isn't from this event's issuers.",
  [Reason.NotForYou]: 'This credit is for another event.',
}

/** The refusal of a point, or null for a reason that is worded like any receiver's. */
export const pointReasonText = (reason: Reason): string | null => POINT_REASONS[reason] ?? null
