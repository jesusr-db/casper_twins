import React from "react";
import type { CXStoreDetailResponse } from "../../types";

const CATEGORY_COLORS: Record<string, string> = {
  delivery_delay: "#E31837", missing_items: "#FF6B35",
  food_quality: "#FFB800", service_issue: "#006491", other: "#888",
};
const CATEGORY_LABELS: Record<string, string> = {
  delivery_delay: "Delivery Delay", missing_items: "Missing Items",
  food_quality: "Food Quality", service_issue: "Service Issue", other: "Other",
};
const REFUND_COLORS: Record<string, string> = {
  partial: "#FFB800", none: "#1e3a5f", full: "#4CAF50", error: "#E31837",
};

interface Props {
  detail: CXStoreDetailResponse | null;
  loading: boolean;
}

export const CXOverviewTab: React.FC<Props> = ({ detail, loading }) => {
  if (loading || !detail) {
    return <div className="cx-loading">Loading overview…</div>;
  }

  const maxTrend = Math.max(...detail.trend.map((t) => t.complaints), 1);
  const maxCat = Math.max(...detail.category_breakdown.map((c) => c.count), 1);
  const totalRefund = detail.refund_class_split.reduce((s, r) => s + r.count, 0) || 1;

  return (
    <div className="cx-overview-grid">
      {/* Complaint Trend */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Complaint Trend (last 30d)</div>
        <div className="cx-bar-chart-horiz" style={{ alignItems: "flex-end", height: 80 }}>
          {detail.trend.map((t) => (
            <div key={t.date} className="cx-trend-bar-wrap" title={`${t.date}: ${t.complaints}`}>
              <div
                className="cx-trend-bar"
                style={{ height: `${(t.complaints / maxTrend) * 100}%` }}
              />
            </div>
          ))}
        </div>
        {detail.trend.length > 0 && (
          <div className="cx-chart-axis">
            <span>{detail.trend[0]?.date?.slice(5)}</span>
            <span>{detail.trend[detail.trend.length - 1]?.date?.slice(5)}</span>
          </div>
        )}
      </div>

      {/* Category Breakdown */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Category Breakdown</div>
        {detail.category_breakdown.map((c) => (
          <div key={c.category} className="cx-hbar-row">
            <div className="cx-hbar-label">{CATEGORY_LABELS[c.category] ?? c.category}</div>
            <div className="cx-hbar-track">
              <div
                className="cx-hbar-fill"
                style={{
                  width: `${(c.count / maxCat) * 100}%`,
                  background: CATEGORY_COLORS[c.category] ?? "#888",
                }}
              />
            </div>
            <div className="cx-hbar-pct">{c.pct}%</div>
          </div>
        ))}
      </div>

      {/* Refund Class Split */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Refund Class Split</div>
        <div className="cx-refund-track">
          {detail.refund_class_split.map((r) => (
            <div
              key={r.refund_class}
              title={`${r.refund_class}: ${r.count}`}
              style={{
                flex: r.count / totalRefund,
                background: REFUND_COLORS[r.refund_class] ?? "#888",
                height: 20,
              }}
            />
          ))}
        </div>
        <div className="cx-refund-legend">
          {detail.refund_class_split.map((r) => (
            <span key={r.refund_class} className="cx-legend-item">
              <span style={{ background: REFUND_COLORS[r.refund_class] ?? "#888" }} className="cx-legend-dot" />
              {r.refund_class} ({Math.round((r.count / totalRefund) * 100)}%)
            </span>
          ))}
        </div>
      </div>

      {/* Top Customers */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Top Impacted Customers</div>
        {detail.top_customers.length === 0 ? (
          <div className="cx-empty">No customer data</div>
        ) : (
          <table className="cx-top-customers-table">
            <tbody>
              {detail.top_customers.map((c) => (
                <tr key={c.customer_id}>
                  <td>{c.name}</td>
                  <td>
                    {c.is_loyalty_member && (
                      <span className="cx-badge" style={{ background: "#B8860B" }}>★ Loyalty</span>
                    )}
                  </td>
                  <td className="cx-complaint-count">{c.complaint_count}x</td>
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
  .cx-overview-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .cx-chart-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    padding: 16px;
  }
  .cx-chart-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--text-secondary); margin-bottom: 12px;
  }
  .cx-bar-chart-horiz { display: flex; gap: 2px; }
  .cx-trend-bar-wrap { flex: 1; display: flex; align-items: flex-end; height: 80px; }
  .cx-trend-bar { width: 100%; background: #E31837; border-radius: 2px 2px 0 0; min-height: 2px; }
  .cx-chart-axis {
    display: flex; justify-content: space-between;
    font-size: 9px; color: var(--text-secondary); margin-top: 4px;
  }
  .cx-hbar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cx-hbar-label { font-size: 11px; width: 110px; flex-shrink: 0; color: var(--text-secondary); }
  .cx-hbar-track { flex: 1; background: rgba(255,255,255,0.05); border-radius: 3px; height: 10px; overflow: hidden; }
  .cx-hbar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .cx-hbar-pct { font-size: 11px; width: 36px; text-align: right; color: var(--text-secondary); }
  .cx-refund-track { display: flex; border-radius: 4px; overflow: hidden; }
  .cx-refund-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .cx-legend-item { font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; }
  .cx-legend-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .cx-top-customers-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cx-top-customers-table td { padding: 6px 0; border-bottom: 1px solid rgba(30,58,95,0.4); }
  .cx-complaint-count { text-align: right; color: var(--text-secondary); font-weight: 600; }
  .cx-empty { color: var(--text-secondary); font-size: 12px; }
`;
document.head.appendChild(style);
