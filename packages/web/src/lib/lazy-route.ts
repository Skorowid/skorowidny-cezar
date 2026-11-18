import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

import { reloadForStaleBuild } from '@/lib/stale-build'

/** `React.lazy` that reloads a stale shell after an update instead of failing on a missing
 *  chunk; any other failure reaches React unchanged. `name` labels the page for debugging. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint
export function lazyRoute<T extends ComponentType<any>>(
  _name: string,
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch((error: unknown) => {
      // Stale shell after an update: keep the Suspense fallback up while the page reloads.
      if (reloadForStaleBuild()) return new Promise<never>(() => {})
      throw error
    }),
  )
}
