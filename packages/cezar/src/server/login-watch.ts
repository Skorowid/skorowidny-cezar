/** Re-probing a provider login after Connect opened it, so the cockpit learns it finished. */

/**
 * When to re-check after Connect opened a login, as offsets from the open. Nothing else re-probes
 * on its own — the cockpit does not poll provider status — so without these a finished login is
 * invisible until someone presses "Check again". Seven probes at most, all within 15 minutes.
 */
export const LOGIN_WATCH_OFFSETS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000];

/**
 * Re-check one login on {@link LOGIN_WATCH_OFFSETS_MS} until it reports connected, then call
 * `onConnected` once. Returns a cancel. A failed check counts as "not yet".
 */
export function watchLogin(
  check: () => Promise<boolean>,
  onConnected: () => void,
  offsets: readonly number[] = LOGIN_WATCH_OFFSETS_MS,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let step = 0;
  let elapsed = 0;
  const schedule = () => {
    if (cancelled || step >= offsets.length) return;
    const offset = offsets[step++]!;
    timer = setTimeout(() => {
      void check().catch(() => false).then((connected) => {
        if (cancelled) return;
        if (connected) {
          cancelled = true;
          onConnected();
          return;
        }
        schedule();
      });
    }, Math.max(0, offset - elapsed));
    elapsed = offset;
    timer.unref?.();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
