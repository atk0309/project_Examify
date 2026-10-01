/** Reload the server-rendered app after the cookie changes; avoid stale router caches. */
export function openSoloHome(): void {
  window.location.replace('/');
}
