import { useCallback, useState } from "react";
import { usePolling } from "./usePolling";
import type { OperationsDashboard } from "../types";

interface UseOperationsDashboardResult {
  data: OperationsDashboard | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Polls /api/operations/dashboard every 5s using the poll-after-completion
 * pattern in `usePolling`. `storeIds` controls the `?stores=` query param —
 * empty array = all stores.
 *
 * Cohort change aborts in-flight requests and re-fetches immediately.
 */
export function useOperationsDashboard(
  storeIds: string[],
  enabled: boolean = true
): UseOperationsDashboardResult {
  const [data, setData] = useState<OperationsDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cohortKey = storeIds.slice().sort().join(",");

  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const qs = cohortKey ? `?stores=${encodeURIComponent(cohortKey)}` : "";
      const res = await fetch(`/api/operations/dashboard${qs}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: OperationsDashboard = await res.json();
      if (signal.aborted) return;
      setData(body);
      setError(null);
      setIsLoading(false);
    },
    [cohortKey]
  );

  usePolling(
    async (signal) => {
      try {
        await fetcher(signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    },
    5000,
    enabled,
    [cohortKey]
  );

  return { data, isLoading, error };
}
