import { NativeModule, requireNativeModule } from 'expo'

declare class TouchGuardModule extends NativeModule {
  /**
   * While `enabled`, the activity drops touches made through another window drawn over it and, from
   * Android 14, hides its content from accessibility services that are not accessibility tools.
   */
  protect(enabled: boolean): Promise<void>
}

export default requireNativeModule<TouchGuardModule>('TouchGuard')
