import React, { useEffect, useState } from "react";
import { DriverCard } from "./DriverCard";
import type { OrderDetail, OrderItem } from "../types";
import { STAGE_COLORS } from "../types";

interface OrderDrawerProps {
  order: OrderDetail | null;
  isOpen: boolean;
  onClose: () => void;
  onFollowDriver: (orderId: string) => void;
}

// Stage timeline steps in order
const TIMELINE_STEPS = [
  { key: "created_at", label: "Order Placed", stage: "New" as const },
  { key: "kitchen_started_at", label: "Kitchen Started", stage: "Kitchen Prep" as const },
  { key: "kitchen_finished_at", label: "Kitchen Done", stage: "Kitchen Prep" as const },
  { key: "picked_up_at", label: "Picked Up", stage: "Ready" as const },
  { key: "current_stage_transit", label: "In Transit", stage: "In Transit" as const },
  { key: "delivered_at", label: "Delivered", stage: "Delivered" as const },
];

function formatTime(ts: string | null): string {
  if (!ts) return "--";
  try {
    // Treat stored timestamps as-is (no "Z" suffix) so they display in the
    // simulator's own time rather than being shifted by the viewer's UTC offset.
    const date = new Date(ts.replace(" ", "T"));
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "--";
  }
}

function parseSimTs(ts: string): Date {
  return new Date(ts.replace(" ", "T"));
}

function getOrderDuration(createdAt: string, deliveredAt: string | null): string {
  try {
    // Show duration from order placed to delivery (or just the placed time if active).
    if (deliveredAt) {
      const diffMin = Math.round(
        (parseSimTs(deliveredAt).getTime() - parseSimTs(createdAt).getTime()) / 60000
      );
      return `${diffMin} min`;
    }
    return formatTime(createdAt);
  } catch {
    return "";
  }
}

function computeDriverInfo(order: OrderDetail) {
  if (!order.latest_ping) return null;
  const progressPct = order.latest_ping.progress_pct;
  // ETA estimate: elapsed / (progress / 100) - elapsed
  if (order.picked_up_at && progressPct > 0) {
    const pickedUp = parseSimTs(order.picked_up_at);
    const lastPing = order.delivered_at ? parseSimTs(order.delivered_at) : new Date();
    const elapsed = (lastPing.getTime() - pickedUp.getTime()) / 60000;
    const totalEstimate = elapsed / (progressPct / 100);
    const remaining = Math.max(0, totalEstimate - elapsed);
    // Distance estimate: assume ~3 miles avg delivery, scale by remaining pct
    const distanceRemaining = (3 * (100 - progressPct)) / 100;
    return {
      progress_pct: progressPct,
      eta_minutes: Math.round(remaining),
      distance_remaining: distanceRemaining,
    };
  }
  return {
    progress_pct: progressPct,
    eta_minutes: 0,
    distance_remaining: 0,
  };
}

export const OrderDrawer: React.FC<OrderDrawerProps> = ({
  order,
  isOpen,
  onClose,
  onFollowDriver,
}) => {
  // Handle Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen || !order) return null;

  const items: OrderItem[] = order.order_body?.items || [];
  const driverInfo = computeDriverInfo(order);
  const isInTransit =
    order.current_stage === "driver_picked_up" ||
    order.current_stage === "driver_ping";

  // Type-safe lookup for order timestamp fields
  const getOrderTimestamp = (key: string): string | null => {
    const tsMap: Record<string, string | null> = {
      created_at: order.created_at,
      kitchen_started_at: order.kitchen_started_at,
      kitchen_ready_at: order.kitchen_ready_at,
      kitchen_finished_at: order.kitchen_finished_at,
      driver_arrived_at: order.driver_arrived_at,
      picked_up_at: order.picked_up_at,
      delivered_at: order.delivered_at,
    };
    return tsMap[key] ?? null;
  };

  // Determine which timeline steps are completed
  const getStepStatus = (step: typeof TIMELINE_STEPS[0]) => {
    if (step.key === "current_stage_transit") {
      return isInTransit ? "active" : order.delivered_at ? "completed" : "pending";
    }
    const value = getOrderTimestamp(step.key);
    if (value) return "completed";
    return "pending";
  };

  return (
    <div className="order-drawer" role="dialog" aria-labelledby="order-drawer-title">
      <div className="drawer-handle" />
      <div className="drawer-header">
        <div className="drawer-header-left">
          <h2 className="drawer-order-id" id="order-drawer-title">
            <span className="drawer-hash">#</span>
            {order.order_id.slice(0, 6)}
          </h2>
          <span className="drawer-order-price">
            ${order.order_total.toFixed(2)}
          </span>
          <span className="drawer-order-time">
            {order.delivered_at ? `${getOrderDuration(order.created_at, order.delivered_at)} to deliver` : formatTime(order.created_at)}
          </span>
        </div>
        <button className="drawer-close-btn" onClick={onClose} aria-label="Close drawer">
          &times;
        </button>
      </div>

      <div className="drawer-body">
        {/* Lifecycle Timeline */}
        <div className="drawer-section">
          <div className="drawer-section-title">Order Lifecycle</div>
          <div className="lifecycle-timeline">
            {TIMELINE_STEPS.map((step, idx) => {
              const status = getStepStatus(step);
              const color = STAGE_COLORS[step.stage];
              const tsValue =
                step.key === "current_stage_transit"
                  ? isInTransit
                    ? `${order.latest_ping?.progress_pct || 0}%`
                    : ""
                  : formatTime(getOrderTimestamp(step.key));

              return (
                <div key={step.key} className="timeline-step">
                  <div
                    className={`timeline-dot timeline-dot-${status}`}
                    style={
                      status !== "pending"
                        ? ({ "--dot-color": color } as React.CSSProperties)
                        : undefined
                    }
                  >
                    {status === "completed" && "\u2713"}
                  </div>
                  <div className={`timeline-step-label ${status === "pending" ? "text-muted" : ""}`}>
                    {step.label}
                  </div>
                  <div className="timeline-step-time">{tsValue}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Item List */}
        <div className="drawer-section">
          <div className="drawer-section-title">Order Items</div>
          <table className="items-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th style={{ textAlign: "right" }}>Price</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={idx}>
                  <td>{item.name}</td>
                  <td className="text-muted">{item.qty}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>
                    ${(item.price * item.qty).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="items-total-row">
            <span>Total</span>
            <span>${order.order_total.toFixed(2)}</span>
          </div>
        </div>

        {/* Driver Card */}
        {isInTransit && (
          <DriverCard
            driver={driverInfo}
            orderId={order.order_id}
            onFollowDriver={onFollowDriver}
          />
        )}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .order-drawer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 55%;
    background: var(--surface-elevated);
    border-top: 2px solid var(--dpz-red);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    display: flex;
    flex-direction: column;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.5);
    z-index: 100;
    animation: slideUp 0.3s ease-out;
  }

  .drawer-handle {
    width: 40px;
    height: 4px;
    background: var(--border-default);
    border-radius: 2px;
    margin: 8px auto;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px 12px 20px;
    border-bottom: 1px solid var(--border-default);
  }

  .drawer-header-left {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  .drawer-order-id {
    font-size: 18px;
    font-weight: 700;
  }

  .drawer-hash { color: var(--text-secondary); }

  .drawer-order-price {
    font-size: 20px;
    font-weight: 700;
    color: var(--success);
  }

  .drawer-order-time {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .drawer-close-btn {
    width: 28px;
    height: 28px;
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .drawer-close-btn:hover {
    color: var(--text-primary);
    border-color: var(--dpz-red);
  }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .drawer-section {
    background: var(--surface-card);
    border-radius: var(--radius-lg);
    padding: 16px;
    border: 1px solid var(--border-default);
  }

  .drawer-section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 12px;
  }

  /* Timeline */
  .lifecycle-timeline {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    position: relative;
    padding: 0 8px;
  }

  .lifecycle-timeline::before {
    content: '';
    position: absolute;
    top: 10px;
    left: 24px;
    right: 24px;
    height: 2px;
    background: var(--border-default);
  }

  .timeline-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    z-index: 1;
    width: 80px;
  }

  .timeline-dot {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--border-default);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: white;
    background: transparent;
  }

  .timeline-dot-completed {
    background: var(--dot-color);
    border-color: var(--dot-color);
  }

  .timeline-dot-active {
    border-color: var(--dot-color);
    animation: dot-pulse 1.5s infinite;
  }

  .timeline-dot-pending {
    border-color: var(--border-default);
  }

  .timeline-step-label {
    font-size: 10px;
    font-weight: 500;
    text-align: center;
    color: var(--text-primary);
  }

  .timeline-step-time {
    font-size: 9px;
    color: var(--text-secondary);
    text-align: center;
  }

  /* Items table */
  .items-table {
    width: 100%;
    border-collapse: collapse;
  }

  .items-table th {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    text-align: left;
    padding: 0 0 8px 0;
    border-bottom: 1px solid var(--border-default);
  }

  .items-table td {
    padding: 8px 0;
    font-size: 13px;
    border-bottom: 1px solid rgba(30, 58, 95, 0.4);
    color: var(--text-primary);
  }

  .items-total-row {
    display: flex;
    justify-content: space-between;
    padding: 10px 0 0 0;
    font-weight: 700;
    font-size: 14px;
  }
`;
document.head.appendChild(style);
