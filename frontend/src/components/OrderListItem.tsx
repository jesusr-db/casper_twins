import React from "react";
import type { Order } from "../types";
import { getOrderStage } from "../types";
import { getSlaStatus, getMinutesInStage } from "../constants/sla";

interface OrderListItemProps {
  order: Order;
  onClick: (orderId: string) => void;
}

export const OrderListItem: React.FC<OrderListItemProps> = ({ order, onClick }) => {
  const stage = getOrderStage(order);
  const minutes = getMinutesInStage(stage, order);
  const status = getSlaStatus(stage, minutes);

  const statusColors = { green: "#4CAF50", yellow: "#FFB800", red: "#E31837" };
  const statusColor = statusColors[status];

  const timeLabel =
    minutes < 1 ? "< 1 min" : minutes === 1 ? "1 min" : `${minutes} min`;

  return (
    <button className="order-list-item" onClick={() => onClick(order.order_id)}>
      <span
        className="order-list-status-dot"
        style={{ background: statusColor }}
        title={`SLA: ${status}`}
      />
      <span className="order-list-id">#{order.order_id.toUpperCase()}</span>
      <span className="order-list-time">{timeLabel} in {stage}</span>
      <span className="order-list-total">${order.order_total.toFixed(2)}</span>
    </button>
  );
};

const style = document.createElement("style");
style.textContent = `
  .order-list-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    background: var(--surface-card);
    color: var(--text-primary);
    font-family: var(--font-family);
    width: 100%;
    text-align: left;
    transition: background 0.15s;
    border-bottom: 1px solid var(--border-default);
  }

  .order-list-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .order-list-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .order-list-id {
    font-size: 12px;
    font-weight: 600;
    font-family: monospace;
    flex-shrink: 0;
  }

  .order-list-time {
    font-size: 11px;
    color: var(--text-secondary);
    flex: 1;
  }

  .order-list-total {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-primary);
    flex-shrink: 0;
  }
`;
document.head.appendChild(style);
