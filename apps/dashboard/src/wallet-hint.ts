// A wallet call that never settles must not look like a dead button. Pure timing, so it is tested without a DOM.

/**
 * Waits on `call`. If it is still pending after `ms`, runs `onSlow` once; the cleanup `onSlow` returns runs when the
 * call settles. The call itself is never cancelled and its result or error passes through unchanged.
 */
export function whenSlow<T>(call: Promise<T>, ms: number, onSlow: () => (() => void) | void): Promise<T> {
  let cleanup: (() => void) | void;
  const timer = setTimeout(() => {
    cleanup = onSlow();
  }, ms);
  return call.finally(() => {
    clearTimeout(timer);
    cleanup?.();
  });
}
