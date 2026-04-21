import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["headline"] | null;
}

function fmtDollars(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtMinutes(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)} min`;
}

export const HeadlineKpis: React.FC<Props> = ({ data }) => {
  if (!data) {
    return (
      <div className="hk-grid">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="hk-tile">
            <div className="hk-label">—</div>
            <div className="hk-value">--</div>
          </div>
        ))}
      </div>
    );
  }

  const slaColor =
    data.sla_health_pct >= 90
      ? "var(--success, #4CAF50)"
      : data.sla_health_pct >= 75
      ? "var(--warning, #FFB800)"
      : "var(--dpz-red)";

  const tiles: { label: string; value: string; color?: string }[] = [
    { label: "Revenue Today", value: fmtDollars(data.revenue_today) },
    { label: "Orders Active", value: String(data.orders_active) },
    { label: "Drivers Out", value: String(data.drivers_out), color: "var(--dpz-red)" },
    {
      label: "Kitchens Busy",
      value: `${data.kitchens_busy.n} / ${data.kitchens_busy.of}`,
    },
    { label: "Avg Delivery", value: fmtMinutes(data.avg_delivery_min) },
    {
      label: "SLA Health",
      value: `${data.sla_health_pct.toFixed(0)}%`,
      color: slaColor,
    },
  ];

  return (
    <div className="hk-grid">
      {tiles.map((t) => (
        <div key={t.label} className="hk-tile">
          <div className="hk-label">{t.label}</div>
          <div className="hk-value" style={t.color ? { color: t.color } : undefined}>
            {t.value}
          </div>
        </div>
      ))}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .hk-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 12px;
    padding: 16px;
  }
  .hk-tile {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 12px 14px;
  }
  .hk-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }
  .hk-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }
  @media (max-width: 1100px) {
    .hk-grid { grid-template-columns: repeat(3, 1fr); }
  }
  @media (max-width: 700px) {
    .hk-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;
document.head.appendChild(style);
