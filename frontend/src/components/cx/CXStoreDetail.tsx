import React, { useState, useEffect } from "react";
import type { CXStoreSummary, CXStoreDetailResponse } from "../../types";
import { CXOverviewTab } from "./CXOverviewTab";
import { CXComplaintsTab } from "./CXComplaintsTab";
import { CXRefundsTab } from "./CXRefundsTab";
import type { CXDays } from "./CXPanel";

type StoreTab = "overview" | "complaints" | "refunds";

interface Props {
  store: CXStoreSummary;
  days: CXDays;
  onBack: () => void;
}

export const CXStoreDetail: React.FC<Props> = ({ store, days, onBack }) => {
  const [tab, setTab] = useState<StoreTab>("overview");
  const [detail, setDetail] = useState<CXStoreDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = days > 0 ? `?days=${days}` : "";
    fetch(`/api/cx/stores/${store.location_id}${params}`)
      .then((r) => r.json())
      .then((d: CXStoreDetailResponse) => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [store.location_id, days]);

  const kpis = detail?.kpis ?? {
    total_complaints: store.complaints,
    complaint_rate: store.complaint_rate,
    refund_exposure: store.refund_exposure,
    avg_refund: 0,
  };

  return (
    <div className="cx-root">
      <div className="cx-top-bar">
        <button onClick={onBack} className="cx-back-btn">← Customer Experience</button>
        <span className="cx-breadcrumb-sep">/</span>
        <h1 className="cx-page-title">{store.name} <span className="cx-code">{store.location_code}</span></h1>
      </div>

      {/* Store KPI Row */}
      <div className="cx-kpi-row">
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Total Complaints</div>
          <div className="cx-kpi-value red">{kpis.total_complaints.toLocaleString()}</div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Complaint Rate</div>
          <div className="cx-kpi-value" style={{ color: kpis.complaint_rate > 10 ? "#E31837" : kpis.complaint_rate >= 7 ? "#FFB800" : "#4CAF50" }}>
            {kpis.complaint_rate}%
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Refund Exposure</div>
          <div className="cx-kpi-value amber">
            ${kpis.refund_exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Avg Refund</div>
          <div className="cx-kpi-value">${kpis.avg_refund.toFixed(2)}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="cx-tabs">
        {(["overview","complaints","refunds"] as StoreTab[]).map((t) => (
          <button
            key={t}
            className={`cx-tab-btn ${tab === t ? "cx-tab-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="cx-content">
        {tab === "overview" && <CXOverviewTab detail={detail} loading={loading} />}
        {tab === "complaints" && <CXComplaintsTab locationId={String(store.location_id)} days={days} />}
        {tab === "refunds" && <CXRefundsTab locationId={String(store.location_id)} days={days} />}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-back-btn {
    background: none; border: none; color: var(--text-secondary);
    cursor: pointer; font-size: 13px; padding: 0;
  }
  .cx-back-btn:hover { color: var(--text-primary); }
  .cx-breadcrumb-sep { color: var(--text-secondary); margin: 0 4px; }
  .cx-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-default);
    padding: 0 24px;
    background: var(--surface-elevated);
  }
  .cx-tab-btn {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-secondary); cursor: pointer;
    padding: 10px 16px; font-size: 13px; font-weight: 500;
  }
  .cx-tab-btn:hover { color: var(--text-primary); }
  .cx-tab-active { color: var(--dpz-red) !important; border-bottom-color: var(--dpz-red) !important; }
`;
document.head.appendChild(style);
