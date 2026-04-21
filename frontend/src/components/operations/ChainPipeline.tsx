import React from "react";
import type { OperationsDashboard } from "../../types";
import { STAGE_COLORS } from "../../types";

interface Props {
  data: OperationsDashboard["pipeline"] | null;
}

export const ChainPipeline: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  const segments: { label: string; count: number; color: string }[] = [
    { label: "New", count: data.new, color: STAGE_COLORS.New },
    { label: "Kitchen", count: data.kitchen, color: STAGE_COLORS["Kitchen Prep"] },
    { label: "Ready", count: data.ready, color: STAGE_COLORS.Ready },
    { label: "Transit", count: data.transit, color: STAGE_COLORS["In Transit"] },
  ];
  const total = Math.max(
    1,
    segments.reduce((s, x) => s + x.count, 0)
  );

  return (
    <div className="cp-card">
      <div className="cp-label">Chain Pipeline</div>
      <div className="cp-bar">
        {segments.map((s) => (
          <div
            key={s.label}
            className="cp-seg"
            style={{
              flex: s.count / total,
              background: s.color,
              minWidth: s.count > 0 ? 40 : 0,
            }}
          >
            <span className="cp-seg-label">
              {s.label} {s.count}
            </span>
          </div>
        ))}
      </div>
      <div className="cp-footnote">Delivered today: {data.delivered_today}</div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cp-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
  }
  .cp-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .cp-bar {
    display: flex;
    gap: 3px;
    height: 36px;
    border-radius: 4px;
    overflow: hidden;
  }
  .cp-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 11px;
    font-weight: 600;
    transition: flex 0.3s ease;
  }
  .cp-seg-label {
    white-space: nowrap;
    padding: 0 8px;
  }
  .cp-footnote {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-secondary);
  }
`;
document.head.appendChild(style);
