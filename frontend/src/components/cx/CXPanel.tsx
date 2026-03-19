import React, { useState, useEffect } from "react";
import { CXGlobalView } from "./CXGlobalView";
import { CXStoreDetail } from "./CXStoreDetail";
import type { CXStoreSummary, CXKpis } from "../../types";

export type CXCategory =
  | "delivery_delay" | "missing_items" | "food_quality"
  | "service_issue" | "other" | null;

export type CXDays = 7 | 30 | 90 | 0; // 0 = all time (no filter)

interface SummaryResponse {
  kpis: CXKpis;
  stores: CXStoreSummary[];
}

export const CXPanel: React.FC = () => {
  const [days, setDays] = useState<CXDays>(30);
  const [category, setCategory] = useState<CXCategory>(null);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [selectedStore, setSelectedStore] = useState<CXStoreSummary | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (days > 0) params.set("days", String(days));
    if (category) params.set("category", category);

    fetch(`/api/cx/summary?${params}`)
      .then((r) => r.json())
      .then((data: SummaryResponse) => { setSummary(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [days, category]);

  if (selectedStore) {
    return (
      <CXStoreDetail
        store={selectedStore}
        days={days}
        onBack={() => setSelectedStore(null)}
      />
    );
  }

  return (
    <CXGlobalView
      summary={summary}
      loading={loading}
      days={days}
      category={category}
      selectedMarket={selectedMarket}
      onDaysChange={setDays}
      onCategoryChange={setCategory}
      onMarketChange={setSelectedMarket}
      onStoreSelect={setSelectedStore}
    />
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-root {
    min-height: 100vh;
    background: var(--surface-bg, #0a1628);
    color: var(--text-primary, #e8f0fe);
    font-family: 'DM Sans', sans-serif;
  }
  .cx-top-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 24px;
    background: var(--surface-elevated, #0d1f33);
    border-bottom: 2px solid var(--dpz-red, #E31837);
  }
  .cx-back-link {
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 13px;
  }
  .cx-back-link:hover { color: var(--text-primary); }
  .cx-page-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0;
  }
  .cx-kpi-row {
    display: flex;
    gap: 12px;
    padding: 16px 24px;
    background: var(--surface-elevated);
  }
  .cx-kpi-card {
    flex: 1;
    background: var(--surface-card, #112240);
    border: 1px solid var(--border-default, #1e3a5f);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .cx-kpi-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }
  .cx-kpi-value {
    font-size: 24px;
    font-weight: 700;
  }
  .cx-kpi-value.red { color: #E31837; }
  .cx-kpi-value.amber { color: #FFB800; }
  .cx-kpi-value.green { color: #4CAF50; }
  .cx-content { padding: 16px 24px; }
`;
document.head.appendChild(style);
