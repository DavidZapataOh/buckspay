import type { Signature } from '@solana/kit'
import type { DeviceKey } from '../../keys'
import { formatSol } from '../../utils/format-sol'
import type { IdentityState, IdentityStep } from './device-identity'
import type { RegistrationQuote } from './register-device'

/** What each onboarding step says, its action, and where it is in the two steps the user sees. */
export const stepCopy: Record<
  Exclude<IdentityStep, 'ready'>,
  { title: string; body: string; action: string; progress?: string }
> = {
  loading: {
    title: 'Check this phone',
    body: 'Buckspay reads your wallet connection and this phone’s registration on Solana.',
    action: 'Try again',
  },
  unreachable: {
    title: 'Can’t reach Solana',
    body: 'Buckspay needs a connection to read this phone’s registration on Solana.',
    action: 'Try again',
  },
  connect: {
    title: 'Connect your wallet',
    body: 'Buckspay pays from and settles to a wallet you already use. Connecting shares its address and charges nothing.',
    action: 'Connect wallet',
    progress: 'Step 1 of 2',
  },
  'create-key': {
    title: 'Create this phone’s key',
    body: 'A key made in this phone’s secure hardware signs your payments. It never leaves the phone.',
    action: 'Create key',
    progress: 'Step 1 of 2',
  },
  register: {
    title: 'Register this phone',
    body: 'This links this phone to your wallet publicly and permanently. Anyone can see the link on Solana, and it can’t be undone.',
    action: 'Register this phone',
    progress: 'Step 2 of 2',
  },
  confirming: {
    title: 'Registering this phone',
    body: 'Your wallet approved the registration.',
    action: 'Check again',
    progress: 'Step 2 of 2',
  },
  'other-wallet': {
    title: 'Registered to another wallet',
    body: 'This phone is permanently linked to the wallet below. Connect that wallet to pay and receive on this phone.',
    action: 'Connect another wallet',
  },
}

export const costNotice = ({ cost }: RegistrationQuote) =>
  `Costs about ${formatSol(cost, 'up')} SOL from your wallet. Not refundable.`

/** What the wallet lacks to register, if anything. */
export const shortfallNotice = ({ balance, cost }: RegistrationQuote) =>
  balance < cost ? `Your wallet has ${formatSol(balance)} SOL. Add SOL to it before you register.` : undefined

export const confirmingNotice = (signature?: Signature) =>
  signature
    ? 'Sent to Solana. Waiting for confirmation, usually under a minute. You can leave this screen; this can’t be cancelled.'
    : 'Your wallet may have sent the registration. Waiting until Solana confirms it or it expires, usually under a minute. You can leave this screen.'

export const keyProtection: Record<DeviceKey['securityLevel'], string> = {
  strongbox: 'Secure chip (StrongBox)',
  tee: 'Secure hardware (TEE)',
  hardware: 'Secure hardware',
  software: 'Software only',
  unknown: 'Unknown',
}

export const SOFTWARE_KEY_WARNING =
  'This phone keeps its key in software, where malware can reach it more easily than in secure hardware.'

/** Home's status card: what it says, and the action that opens onboarding or tries again. */
export type HomeStatus = { testID: string; title: string; body?: string; action?: string; retry?: string }

export function homeStatus({ step, error, device }: IdentityState): HomeStatus {
  switch (step) {
    case 'loading':
      return error
        ? { testID: 'home-unreachable', title: 'Couldn’t check this phone', body: error, retry: 'Try again' }
        : { testID: 'home-loading', title: 'Checking this phone…' }
    case 'unreachable':
      return {
        testID: 'home-unreachable',
        title: 'Can’t reach Solana',
        body: 'Buckspay couldn’t read this phone’s registration. Check your connection.',
        retry: 'Try again',
      }
    case 'ready':
      return { testID: 'device-ready', title: 'This phone is registered to your wallet' }
    case 'confirming':
      return {
        testID: 'home-confirming',
        title: 'Registering this phone',
        body: 'Waiting for Solana to confirm it, usually under a minute.',
        action: 'See progress',
      }
    case 'other-wallet':
      return {
        testID: 'home-other-wallet',
        title: 'Registered to another wallet',
        body: 'Connect the wallet this phone is linked to, to pay and receive.',
        action: 'Connect another wallet',
      }
    default:
      return device
        ? {
            testID: 'home-reconnect',
            title: 'Reconnect your wallet to pay',
            body: 'This phone is registered. Connect the wallet it is linked to.',
            action: 'Reconnect wallet',
          }
        : {
            testID: 'home-setup',
            title: 'Set up payments',
            body: 'Paying and receiving need a wallet and this phone’s key, registered on Solana.',
            action: 'Set up payments',
          }
  }
}
