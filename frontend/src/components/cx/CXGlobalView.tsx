import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import type { CXStoreSummary, CXKpis } from "../../types";
import type { CXCategory, CXDays } from "./CXPanel";

// Matches App.tsx CITY_GROUPS — location_code prefix -> city name
const CITY_GROUPS: Record<string, string> = {
  sf: "SF Bay Area", sv: "SF Bay Area", sv2: "SF Bay Area",
  paloalto: "SF Bay Area", "palo-alto": "SF Bay Area", pa: "SF Bay Area",
  seattle: "Pacific Northwest", bellevue: "Pacific Northwest",
  chicago: "Midwest", chi: "Midwest",
};

function getMarketForStore(store: CXStoreSummary): string {
  const code = store.location_code.toLowerCase().replace(/[^a-z0-9-]/g, "");
  for (const [key, city] of Object.entries(CITY_GROUPS)) {
    if (code.startsWith(key) || code.includes(key)) return city;
  }
  return store.name.split(" ")[0];
}

const CATEGORY_LABELS: Record<string, string> = {
  delivery_delay: "Delivery Delay",
  missing_items: "Missing Items",
  food_quality: "Food Quality",
  service_issue: "Service Issue",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  delivery_delay: "#E31837",
  missing_items: "#FF6B35",
  food_quality: "#FFB800",
  service_issue: "#006491",
  other: "#888",
};

function rateColor(rate: number): string {
  if (rate > 10) return "#E31837";
  if (rate >= 7) return "#FFB800";
  return "#4CAF50";
}

interface Props {
  summary: { kpis: CXKpis; stores: CXStoreSummary[] } | null;
  loading: boolean;
  days: CXDays;
  category: CXCategory;
  selectedMarket: string | null;
  onDaysChange: (d: CXDays) => void;
  onCategoryChange: (c: CXCategory) => void;
  onMarketChange: (m: string | null) => void;
  onStoreSelect: (s: CXStoreSummary) => void;
}

export const CXGlobalView: React.FC<Props> = ({
  summary, loading, days, category, selectedMarket,
  onDaysChange, onCategoryChange, onMarketChange, onStoreSelect,
}) => {
  const [sortCol, setSortCol] = React.useState<keyof CXStoreSummary>("complaint_rate");
  const [sortAsc, setSortAsc] = React.useState(false);

  const markets = useMemo(() => {
    if (!summary) return [];
    const seen = new Set<string>();
    for (const s of summary.stores) {
      seen.add(getMarketForStore(s));
    }
    return Array.from(seen).sort();
  }, [summary]);

  const filteredStores = useMemo(() => {
    if (!summary) return [];
    let stores = summary.stores ?? [];
    if (selectedMarket) {
      stores = stores.filter((s) => getMarketForStore(s) === selectedMarket);
    }
    return [...stores].sort((a, b) => {
      const av = a[sortCol] as number;
      const bv = b[sortCol] as number;
      return sortAsc ? av - bv : bv - av;
    });
  }, [summary, selectedMarket, sortCol, sortAsc]);

  const handleSort = (col: keyof CXStoreSummary) => {
    if (col === sortCol) setSortAsc((p) => !p);
    else { setSortCol(col); setSortAsc(false); }
  };

  const kpis = summary?.kpis;

  return (
    <div className="cx-root">
      <div className="cx-top-bar">
        <Link to="/" className="cx-back-link">← Map</Link>
        <h1 className="cx-page-title">Customer Experience</h1>
      </div>

      {/* KPI Row */}
      <div className="cx-kpi-row">
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Total Complaints</div>
          <div className="cx-kpi-value">{kpis?.total_complaints.toLocaleString() ?? "—"}</div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Complaint Rate</div>
          <div className="cx-kpi-value" style={{ color: rateColor(kpis?.complaint_rate ?? 0) }}>
            {kpis ? `${kpis.complaint_rate}%` : "—"}
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Refund Exposure</div>
          <div className="cx-kpi-value amber">
            {kpis ? `$${kpis.refund_exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Avg Refund</div>
          <div className="cx-kpi-value">
            {kpis ? `$${kpis.avg_refund.toFixed(2)}` : "—"}
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="cx-filter-bar">
        <select
          className="cx-filter-select"
          value={selectedMarket ?? ""}
          onChange={(e) => onMarketChange(e.target.value || null)}
        >
          <option value="">All Markets</option>
          {markets.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          className="cx-filter-select"
          value={category ?? ""}
          onChange={(e) => onCategoryChange((e.target.value || null) as CXCategory)}
        >
          <option value="">All Categories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select
          className="cx-filter-select"
          value={days}
          onChange={(e) => onDaysChange(Number(e.target.value) as CXDays)}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={0}>All time</option>
        </select>
      </div>

      {/* Store Table */}
      <div className="cx-content">
        {loading ? (
          <div className="cx-loading">Loading…</div>
        ) : (
          <table className="cx-table">
            <thead>
              <tr>
                <th>Store</th>
                {(["orders","complaints","complaint_rate","refund_exposure"] as const).map((col) => (
                  <th key={col} onClick={() => handleSort(col)} className="cx-th-sortable">
                    {col === "orders" ? "Orders" : col === "complaints" ? "Complaints"
                      : col === "complaint_rate" ? "Rate %" : "Refund $"}
                    {sortCol === col ? (sortAsc ? " ↑" : " ↓") : ""}
                  </th>
                ))}
                <th>Top Issue</th>
              </tr>
            </thead>
            <tbody>
              {filteredStores.map((store) => (
                <tr key={store.location_id} className="cx-table-row" onClick={() => onStoreSelect(store)}>
                  <td>{store.name} <span className="cx-code">{store.location_code}</span></td>
                  <td>{store.orders.toLocaleString()}</td>
                  <td>{store.complaints.toLocaleString()}</td>
                  <td style={{ color: rateColor(store.complaint_rate), fontWeight: 700 }}>
                    {store.complaint_rate}%
                  </td>
                  <td>${store.refund_exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                  <td>
                    {store.top_category ? (
                      <span
                        className="cx-badge"
                        style={{ background: CATEGORY_COLORS[store.top_category] ?? "#888" }}
                      >
                        {CATEGORY_LABELS[store.top_category] ?? store.top_category}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-filter-bar {
    display: flex;
    gap: 10px;
    padding: 12px 24px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
  }
  .cx-filter-select {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .cx-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .cx-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-default);
  }
  .cx-th-sortable { cursor: pointer; user-select: none; }
  .cx-th-sortable:hover { color: var(--text-primary); }
  .cx-table-row { cursor: pointer; transition: background 0.1s; }
  .cx-table-row:hover { background: var(--surface-card); }
  .cx-table td { padding: 10px 12px; border-bottom: 1px solid rgba(30,58,95,0.4); }
  .cx-code { color: var(--text-secondary); font-size: 11px; margin-left: 6px; }
  .cx-badge {
    font-size: 10px; font-weight: 600; padding: 2px 7px;
    border-radius: 4px; color: white;
  }
  .cx-loading { padding: 40px; text-align: center; color: var(--text-secondary); }
`;
document.head.appendChild(style);
