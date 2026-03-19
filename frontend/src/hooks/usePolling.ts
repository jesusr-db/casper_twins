import { useEffect, useRef, useCallback } from "react";

/**
 * usePolling — Configurable interval polling hook with AbortController support.
 *
 * Calls the provided fetcher function at the specified interval (default 3s).
 * Automatically cancels in-flight requests when the component unmounts or
 * when dependencies change (e.g., market switch).
 *
 * @param fetcher - Async function that accepts an AbortSignal
 * @param interval - Polling interval in milliseconds (default 3000)
 * @param enabled - Whether polling is active (disabled in playback mode)
 * @param deps - Additional dependencies that trigger re-fetch and cancel in-flight
 */
export function usePolling(
  fetcher: (signal: AbortSignal) => Promise<void>,
  interval: number = 3000,
  enabled: boolean = true,
  deps: unknown[] = []
) {
  const abortControllerRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<number | null>(null);

  const doFetch = useCallback(async () => {
    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await fetcher(controller.signal);
    } catch (err) {
      // Ignore abort errors — they're expected on cleanup
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      console.error("Polling fetch error:", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, ...deps]);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
        intervalRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      return;
    }

    let cancelled = false;

    // Poll-after-completion: wait for the fetch to finish, THEN schedule
    // the next one. This prevents aborting slow in-flight requests.
    const loop = async () => {
      await doFetch();
      if (!cancelled) {
        intervalRef.current = window.setTimeout(loop, interval);
      }
    };

    loop();

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
        intervalRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [doFetch, interval, enabled]);
}
