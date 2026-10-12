import type { Signature } from '@solana/kit'
import type { DeviceKey } from '../../keys'
import { i18n, translateIfKnown } from '../../i18n'
import { formatSol } from '../../utils/format-sol'
import type { IdentityState, IdentityStep, Sponsorship } from './device-identity'
import type { Activation } from './activation'

/** What each onboarding step says, its action, and where it is in the two steps the user sees. */
export const stepCopy = (step: Exclude<IdentityStep, 'ready'>) => ({
  title: i18n.t(`identity:step.${step}.title`),
  body: i18n.t(`identity:step.${step}.body`),
  action: i18n.t(`identity:step.${step}.action`),
  line: translateIfKnown(`identity:step.${step}.line`),
})

/** What the wallet lacks in SOL to pay the network costs itself, if anything; nothing while Buckspay pays. */
export const shortfallNotice = ({ sol }: Activation, sponsored: boolean) =>
  !sponsored && sol.balance < sol.cost ? i18n.t('identity:shortfall', { sol: formatSol(sol.balance) }) : undefined

/** Why the wallet pays in a build where Buckspay pays for activations. */
export const sponsorshipNotice = (sponsorship?: Sponsorship) =>
  sponsorship === 'unavailable' ? i18n.t('identity:sponsorshipUnavailable') : undefined

export const confirmingNotice = (signature?: Signature) =>
  i18n.t(signature ? 'identity:confirmingNotice.sent' : 'identity:confirmingNotice.unknown')

export const keyProtection = (level: DeviceKey['securityLevel']) => i18n.t(`identity:keyProtection.${level}`)

/** Home's status card: what it says, and the action that opens onboarding or tries again. */
export type HomeStatus = { testID: string; title: string; body?: string; action?: string; retry?: string }

export function homeStatus({ step, error, device }: IdentityState): HomeStatus {
  switch (step) {
    case 'loading':
      return error
        ? {
            testID: 'home-unreachable',
            title: i18n.t('identity:home.checkFailed.title'),
            body: error,
            retry: i18n.t('identity:home.checkFailed.retry'),
          }
        : { testID: 'home-loading', title: i18n.t('identity:home.loading.title') }
    case 'unreachable':
      return {
        testID: 'home-unreachable',
        title: i18n.t('identity:home.unreachable.title'),
        body: i18n.t('identity:home.unreachable.body'),
        retry: i18n.t('identity:home.unreachable.retry'),
      }
    case 'ready':
      return { testID: 'device-ready', title: i18n.t('identity:home.ready.title') }
    case 'confirming':
      return {
        testID: 'home-confirming',
        title: i18n.t('identity:home.confirming.title'),
        body: i18n.t('identity:home.confirming.body'),
        action: i18n.t('identity:home.confirming.action'),
      }
    case 'other-wallet':
      return {
        testID: 'home-other-wallet',
        title: i18n.t('identity:home.otherWallet.title'),
        body: i18n.t('identity:home.otherWallet.body'),
        action: i18n.t('identity:home.otherWallet.action'),
      }
    default:
      return device
        ? {
            testID: 'home-reconnect',
            title: i18n.t('identity:home.reconnect.title'),
            body: i18n.t('identity:home.reconnect.body'),
            action: i18n.t('identity:home.reconnect.action'),
          }
        : {
            testID: 'home-setup',
            title: i18n.t('identity:home.setup.title'),
            body: i18n.t('identity:home.setup.body'),
            action: i18n.t('identity:home.setup.action'),
          }
  }
}
