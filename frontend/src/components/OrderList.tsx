import React from "react";
import type { Order } from "../types";
import { getOrderStage, STAGE_COLORS, type PipelineStage } from "../types";
import { OrderListItem } from "./OrderListItem";

interface OrderListProps {
  stage: PipelineStage;
  orders: Order[];
  onOrderClick: (orderId: string) => void;
  onClose: () => void;
}

export const OrderList: React.FC<OrderListProps> = ({
  stage,
  orders,
  onOrderClick,
  onClose,
}) => {
  const stageOrders = orders.filter(
    (o) => getOrderStage(o) === stage
  );

  const stageColor = STAGE_COLORS[stage];

  return (
    <div className="order-list-panel">
      <div className="order-list-header" style={{ borderLeftColor: stageColor }}>
        <div className="order-list-header-left">
          <span
            className="order-list-stage-dot"
            style={{ background: stageColor }}
          />
          <span className="order-list-stage-name">{stage}</span>
          <span className="order-list-count">{stageOrders.length}</span>
        </div>
        <button className="order-list-close" onClick={onClose} aria-label="Close order list">
          ✕
        </button>
      </div>
      <div className="order-list-body">
        {stageOrders.length === 0 ? (
          <div className="order-list-empty">No orders in {stage}</div>
        ) : (
          stageOrders.map((order) => (
            <OrderListItem
              key={order.order_id}
              order={order}
              onClick={onOrderClick}
            />
          ))
        )}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .order-list-panel {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 300px;
    background: var(--surface-elevated);
    border-right: 1px solid var(--border-default);
    display: flex;
    flex-direction: column;
    z-index: 20;
    animation: slideInLeft 0.2s ease-out;
    box-shadow: 4px 0 16px rgba(0, 0, 0, 0.3);
  }

  @keyframes slideInLeft {
    from { transform: translateX(-300px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .order-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border-default);
    border-left: 3px solid transparent;
    flex-shrink: 0;
  }

  .order-list-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .order-list-stage-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .order-list-stage-name {
    font-size: 13px;
    font-weight: 600;
  }

  .order-list-count {
    background: var(--surface-card);
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    border: 1px solid var(--border-default);
  }

  .order-list-close {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    padding: 4px 6px;
    border-radius: 4px;
    font-family: var(--font-family);
  }

  .order-list-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary);
  }

  .order-list-body {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-default) transparent;
  }

  .order-list-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 12px;
  }
`;
document.head.appendChild(style);
