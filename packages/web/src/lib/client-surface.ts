/** `desktop` inside the Tauri shell, `browser` otherwise. The shell's init script stamps
 *  `window.__CEZ_DESKTOP__` and `<html data-cez-desktop>` on every page it shows (packages/desktop
 *  `INIT_SCRIPT`); Tauri's own IPC global is the fallback for a shell that predates the stamp. */
export function clientSurface(): 'desktop' | 'browser' {
  if ('__CEZ_DESKTOP__' in window || document.documentElement.dataset.cezDesktop) return 'desktop'
  return '__TAURI_INTERNALS__' in window ? 'desktop' : 'browser'
}
