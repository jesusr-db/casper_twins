import React from "react";
import type { MarketKpis } from "../types";

interface KpiBarProps {
  kpis: MarketKpis | null;
  isLoading?: boolean;
}

const KpiCard: React.FC<{
  label: string;
  value: string | number;
  color?: string;
  ariaLabel: string;
}> = ({ label, value, color, ariaLabel }) => (
  <div className="kpi-card" aria-label={ariaLabel}>
    <div className="kpi-label">{label}</div>
    <div className="kpi-value" style={color ? { color } : undefined}>
      {value}
    </div>
  </div>
);

export const KpiBar: React.FC<KpiBarProps> = ({ kpis, isLoading }) => {
  if (isLoading || !kpis) {
    return (
      <div className="kpi-bar" aria-live="polite">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="kpi-card kpi-skeleton">
            <div className="kpi-label">Loading...</div>
            <div className="kpi-value">--</div>
          </div>
        ))}
      </div>
    );
  }

  const formattedRevenue = kpis.todays_revenue != null
    ? `$${kpis.todays_revenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : "--";

  return (
    <div className="kpi-bar" aria-live="polite">
      <KpiCard
        label="Active Orders"
        value={kpis.active_orders}
        ariaLabel={`Active Orders: ${kpis.active_orders}`}
      />
      <KpiCard
        label="Drivers Out"
        value={kpis.drivers_out}
        color="var(--dpz-red)"
        ariaLabel={`Drivers Out: ${kpis.drivers_out}`}
      />
      <KpiCard
        label="Avg Delivery Time"
        value={kpis.avg_delivery_time || "--"}
        ariaLabel={`Average Delivery Time: ${kpis.avg_delivery_time || "no data"}`}
      />
      <KpiCard
        label="Today's Revenue"
        value={formattedRevenue}
        ariaLabel={`Today's Revenue: ${formattedRevenue}`}
      />
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .kpi-bar {
    display: flex;
    gap: 12px;
    padding: 10px 16px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
    flex-shrink: 0;
  }

  .kpi-card {
    flex: 1;
    background: var(--surface-card);
    border-radius: var(--radius-md);
    padding: 10px 14px;
    border: 1px solid var(--border-default);
  }

  .kpi-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .kpi-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .kpi-skeleton .kpi-value {
    color: var(--text-muted);
  }
`;
document.head.appendChild(style);
