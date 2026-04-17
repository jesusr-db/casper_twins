import React, { useMemo } from "react";
import type { Market, MarketKpis, Order, PipelineStage } from "../types";
import { getOrderStage, STAGE_COLORS } from "../types";
import { getSlaStatus, getMinutesInStage, STAGE_SLA_MINUTES } from "../constants/sla";

const PIPELINE_STAGES: PipelineStage[] = ["New", "Kitchen Prep", "Ready", "In Transit", "Delivered"];

interface StoreDetailPanelProps {
  market: Market;
  kpis: MarketKpis | null;
  orders: Order[];
  onClose: () => void;
  onStageClick: (stage: string | null) => void;
}

export const StoreDetailPanel: React.FC<StoreDetailPanelProps> = ({
  market,
  kpis,
  orders,
  onClose,
  onStageClick,
}) => {
  // Stage breakdown
  const stageCounts = useMemo(() => {
    return orders.reduce(
      (acc, o) => {
        const s = getOrderStage(o);
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      },
      {} as Partial<Record<PipelineStage, number>>
    );
  }, [orders]);

  // SLA alerts: orders exceeding red threshold in their current stage
  const slaAlerts = useMemo(() => {
    return orders
      .filter((o) => {
        const stage = getOrderStage(o);
        if (stage === "Delivered") return false;
        const mins = getMinutesInStage(stage, o);
        return getSlaStatus(stage, mins) === "red";
      })
      .map((o) => {
        const stage = getOrderStage(o);
        const mins = getMinutesInStage(stage, o);
        const red = STAGE_SLA_MINUTES[stage]?.red ?? 0;
        return { order: o, stage, mins, over: mins - red };
      })
      .sort((a, b) => b.over - a.over);
  }, [orders]);

  // Recent deliveries (last 5 delivered orders)
  const recentDeliveries = useMemo(() => {
    return orders
      .filter((o) => o.delivered_at)
      .sort((a, b) => {
        const ta = new Date(a.delivered_at!.replace(" ", "T") + "Z").getTime();
        const tb = new Date(b.delivered_at!.replace(" ", "T") + "Z").getTime();
        return tb - ta;
      })
      .slice(0, 5);
  }, [orders]);

  const avgDeliveryDisplay = kpis?.avg_delivery_time
    ? kpis.avg_delivery_time.substring(0, 5) // "HH:MM"
    : "—";

  return (
    <div className="store-detail-panel">
      {/* Header */}
      <div className="store-detail-header">
        <div className="store-detail-title-row">
          <div className="store-detail-name-block">
            <span className="store-detail-name">{market.name}</span>
            <span className="store-detail-code">{market.location_code}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="store-detail-live-pill">
              <span className="store-live-dot" /> Live
            </span>
            <button className="store-detail-close" onClick={onClose} aria-label="Close store detail">
              ✕
            </button>
          </div>
        </div>
      </div>

      <div className="store-detail-body">
        {/* KPI Grid */}
        <div className="store-kpi-grid">
          <div className="store-kpi-card">
            <div className="store-kpi-value">{kpis?.active_orders ?? "—"}</div>
            <div className="store-kpi-label">Active Orders</div>
          </div>
          <div className="store-kpi-card">
            <div className="store-kpi-value">{kpis?.drivers_out ?? "—"}</div>
            <div className="store-kpi-label">Drivers Out</div>
          </div>
          <div className="store-kpi-card">
            <div className="store-kpi-value">{avgDeliveryDisplay}</div>
            <div className="store-kpi-label">Avg Delivery</div>
          </div>
          <div className="store-kpi-card">
            <div className="store-kpi-value">
              ${kpis ? kpis.todays_revenue.toFixed(0) : "—"}
            </div>
            <div className="store-kpi-label">Today's Revenue</div>
          </div>
        </div>

        {/* Mini Pipeline */}
        <div className="store-section">
          <div className="store-section-title">Pipeline</div>
          <div className="store-mini-pipeline">
            {PIPELINE_STAGES.map((stage) => (
              <button
                key={stage}
                className="store-mini-stage"
                onClick={() => onStageClick(stage)}
                title={`${stageCounts[stage] ?? 0} in ${stage}`}
              >
                <span
                  className="store-mini-stage-dot"
                  style={{ background: STAGE_COLORS[stage] }}
                />
                <span className="store-mini-stage-count" style={{ color: STAGE_COLORS[stage] }}>
                  {stageCounts[stage] ?? 0}
                </span>
                <span className="store-mini-stage-name">{stage}</span>
              </button>
            ))}
          </div>
        </div>

        {/* SLA Alerts */}
        <div className="store-section">
          <div className="store-section-title">
            {slaAlerts.length > 0 ? (
              <span style={{ color: "#FFB800" }}>⚠ {slaAlerts.length} need attention</span>
            ) : (
              <span style={{ color: "#4CAF50" }}>✓ All on track</span>
            )}
          </div>
          {slaAlerts.length > 0 && (
            <div className="store-alert-list">
              {slaAlerts.map(({ order, stage, mins, over }) => (
                <div key={order.order_id} className="store-alert-row">
                  <span className="store-alert-dot" />
                  <span className="store-alert-id">#{order.order_id.toUpperCase()}</span>
                  <span className="store-alert-stage">{stage}</span>
                  <span className="store-alert-over">+{over}m over</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Deliveries */}
        <div className="store-section">
          <div className="store-section-title">Recent Deliveries</div>
          {recentDeliveries.length === 0 ? (
            <div className="store-empty">No deliveries yet today</div>
          ) : (
            <div className="store-delivery-list">
              {recentDeliveries.map((o) => {
                const deliveredAt = new Date(o.delivered_at!.replace(" ", "T") + "Z");
                const createdAt = new Date(o.created_at.replace(" ", "T") + "Z");
                const durationMin = Math.round(
                  (deliveredAt.getTime() - createdAt.getTime()) / 60000
                );
                const timeStr = deliveredAt.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return (
                  <div key={o.order_id} className="store-delivery-row">
                    <span className="store-delivery-time">{timeStr}</span>
                    <span className="store-delivery-duration">{durationMin} min</span>
                    <span className="store-delivery-total">${o.order_total.toFixed(2)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .store-detail-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 320px;
    background: var(--surface-elevated);
    border-left: 1px solid var(--border-default);
    display: flex;
    flex-direction: column;
    z-index: 20;
    animation: slideInRight 0.2s ease-out;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.3);
  }

  @keyframes slideInRight {
    from { transform: translateX(320px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .store-detail-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border-default);
    flex-shrink: 0;
  }

  .store-detail-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .store-detail-name-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .store-detail-name {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .store-detail-code {
    font-size: 11px;
    color: var(--text-secondary);
    font-family: monospace;
  }

  .store-detail-live-pill {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-weight: 600;
    color: #4CAF50;
    background: rgba(76, 175, 80, 0.1);
    padding: 3px 8px;
    border-radius: 10px;
    border: 1px solid rgba(76, 175, 80, 0.3);
  }

  .store-live-dot {
    width: 6px;
    height: 6px;
    background: #4CAF50;
    border-radius: 50%;
    animation: pulse 2s infinite;
  }

  .store-detail-close {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    padding: 4px 6px;
    border-radius: 4px;
    font-family: var(--font-family);
  }

  .store-detail-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary);
  }

  .store-detail-body {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-default) transparent;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .store-kpi-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--border-default);
    border-bottom: 1px solid var(--border-default);
  }

  .store-kpi-card {
    background: var(--surface-card);
    padding: 14px 16px;
    text-align: center;
  }

  .store-kpi-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .store-kpi-label {
    font-size: 10px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .store-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-default);
  }

  .store-section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }

  .store-mini-pipeline {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .store-mini-stage {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-family: var(--font-family);
    color: var(--text-primary);
    width: 100%;
    text-align: left;
  }

  .store-mini-stage:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .store-mini-stage-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .store-mini-stage-count {
    font-size: 16px;
    font-weight: 700;
    width: 28px;
    text-align: right;
    flex-shrink: 0;
  }

  .store-mini-stage-name {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .store-alert-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }

  .store-alert-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid var(--border-default);
  }

  .store-alert-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #E31837;
    flex-shrink: 0;
  }

  .store-alert-id {
    font-size: 11px;
    font-weight: 600;
    font-family: monospace;
    flex-shrink: 0;
  }

  .store-alert-stage {
    font-size: 11px;
    color: var(--text-secondary);
    flex: 1;
  }

  .store-alert-over {
    font-size: 11px;
    color: #E31837;
    font-weight: 600;
    flex-shrink: 0;
  }

  .store-delivery-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .store-delivery-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    border-bottom: 1px solid var(--border-default);
  }

  .store-delivery-time {
    font-size: 11px;
    color: var(--text-secondary);
    width: 50px;
    flex-shrink: 0;
  }

  .store-delivery-duration {
    font-size: 12px;
    font-weight: 500;
    flex: 1;
  }

  .store-delivery-total {
    font-size: 12px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .store-empty {
    font-size: 12px;
    color: var(--text-secondary);
    padding: 8px 0;
  }
`;
document.head.appendChild(style);
