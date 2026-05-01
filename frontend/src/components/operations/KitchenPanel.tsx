import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["kitchen"] | null;
}

export const KitchenPanel: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-label">Kitchen Status</div>
      <div className="ops-stat-row">
        <div className="ops-stat">
          <div className="ops-stat-value">{data.in_kitchen}</div>
          <div className="ops-stat-sub">In Kitchen</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">{data.ready_waiting}</div>
          <div className="ops-stat-sub">Ready / Waiting</div>
        </div>
        <div className="ops-stat">
          <div
            className="ops-stat-value"
            style={{
              color:
                data.backlogged_stores > 0 ? "var(--warning, #FFB800)" : undefined,
            }}
          >
            {data.backlogged_stores}
          </div>
          <div className="ops-stat-sub">Backlogged Stores</div>
        </div>
      </div>
      <div className="ops-card-footnote">
        Avg kitchen time:{" "}
        {data.avg_kitchen_min != null ? `${data.avg_kitchen_min.toFixed(1)} min` : "—"}
      </div>
    </div>
  );
};

// Shared styles (.ops-card etc.) are registered once by the first component
// that uses them. Define them here — subsequent Customers/Loyalty panels reuse
// the same classes.
const style = document.createElement("style");
style.textContent = `
  .ops-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
  }
  .ops-card-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .ops-stat-row {
    display: flex;
    gap: 20px;
    margin-bottom: 8px;
  }
  .ops-stat-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .ops-stat-sub {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    margin-top: 2px;
  }
  .ops-card-footnote {
    font-size: 11px;
    color: var(--text-secondary);
  }
`;
document.head.appendChild(style);
