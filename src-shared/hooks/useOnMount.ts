import { useRef, useEffect, type EffectCallback } from "react";

/**
 * Runs `callback` once per component instance, on mount (StrictMode's extra
 * mount included: it runs once). If the callback returns a cleanup, that
 * runs on unmount, and a remount (StrictMode's, or a real one) runs the
 * callback again, like any effect with its cleanup.
 */
export const useOnMount = (callback: EffectCallback) => {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const cleanup = callback();
    if (!cleanup) return;
    return () => {
      initialized.current = false;
      cleanup();
    };
    // the mount's callback, not each render's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
