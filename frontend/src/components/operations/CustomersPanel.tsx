import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["customers"] | null;
}

function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

export const CustomersPanel: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-label">Customers (Today)</div>
      <div className="ops-stat-row">
        <div className="ops-stat">
          <div className="ops-stat-value">{data.unique_today}</div>
          <div className="ops-stat-sub">Unique matched</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">{fmtDollars(data.avg_order_value)}</div>
          <div className="ops-stat-sub">Avg order</div>
        </div>
      </div>
      <div className="ops-persona-list">
        {data.top_personas.length === 0 ? (
          <div className="ops-card-footnote">No persona data yet.</div>
        ) : (
          data.top_personas.map((p) => (
            <div key={p.name} className="ops-persona-row">
              <span>{p.name}</span>
              <span style={{ color: "var(--text-secondary)" }}>
                {p.pct.toFixed(1)}%
              </span>
            </div>
          ))
        )}
      </div>
      <div className="ops-card-footnote">
        Matched via rounded customer lat/lon — not all orders match.
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .ops-persona-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .ops-persona-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-primary);
  }
`;
document.head.appendChild(style);
