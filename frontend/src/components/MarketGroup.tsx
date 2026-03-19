import React, { useState } from "react";
import type { MarketGroup as MarketGroupType } from "../types";

interface MarketGroupProps {
  group: MarketGroupType;
  activeMarketId: string;
  onSelect: (marketId: string) => void;
}

/** "Domino's #3 - Marina" → "#3 Marina" */
function shortName(name: string): string {
  const match = name.match(/#(\d+)\s*-\s*(.+)/);
  if (match) return `#${match[1]} ${match[2]}`;
  return name;
}

export const MarketGroup: React.FC<MarketGroupProps> = ({
  group,
  activeMarketId,
  onSelect,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [showIdle, setShowIdle] = useState(false);

  const isActiveInGroup = group.markets.some(
    (m) => String(m.location_id) === String(activeMarketId)
  );

  // Split: active-order stores (sorted desc) vs idle
  const hotMarkets = group.markets
    .filter((m) => m.active_orders > 0)
    .sort((a, b) => b.active_orders - a.active_orders);

  const idleMarkets = group.markets
    .filter((m) => m.active_orders === 0)
    .sort((a, b) => a.location_id - b.location_id);

  // Always show currently selected market even if idle
  const selectedIdle = idleMarkets.find(
    (m) => String(m.location_id) === String(activeMarketId)
  );

  const visibleMarkets = [
    ...hotMarkets,
    ...(showIdle ? idleMarkets : selectedIdle ? [selectedIdle] : []),
  ];

  // Single-market group with no active orders: render as flat tab
  if (group.markets.length === 1) {
    const market = group.markets[0];
    const isActive = String(market.location_id) === String(activeMarketId);
    return (
      <button
        className={`market-tab ${isActive ? "active" : ""}`}
        role="tab"
        aria-selected={isActive}
        onClick={() => onSelect(String(market.location_id))}
      >
        {shortName(market.name)}
        {market.active_orders > 0 && (
          <span className="market-tab-badge">{market.active_orders}</span>
        )}
      </button>
    );
  }

  return (
    <div className="market-group">
      <button
        className={`market-group-header ${isActiveInGroup ? "group-has-active" : ""}`}
        onClick={() => setExpanded((e) => !e)}
        title={`${group.cityName} — ${group.totalActiveOrders} active orders`}
      >
        <span className="market-group-name">{group.cityName}</span>
        {group.totalActiveOrders > 0 && (
          <span className="market-group-badge market-group-badge-active">
            {group.totalActiveOrders}
          </span>
        )}
        <span className={`market-group-chevron ${expanded ? "chevron-up" : ""}`}>▾</span>
      </button>

      {expanded && (
        <div className="market-group-children">
          {visibleMarkets.length === 0 ? (
            <span className="market-group-idle-hint">no active stores</span>
          ) : (
            visibleMarkets.map((market) => {
              const isActive = String(market.location_id) === String(activeMarketId);
              const isHot = market.active_orders > 0;
              return (
                <button
                  key={market.location_id}
                  className={`market-tab market-tab-child ${isActive ? "active" : ""} ${!isHot ? "market-tab-idle" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelect(String(market.location_id))}
                >
                  {shortName(market.name)}
                  {isHot && (
                    <span className="market-tab-badge">{market.active_orders}</span>
                  )}
                </button>
              );
            })
          )}

          {idleMarkets.length > 0 && (
            <button
              className="market-group-idle-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setShowIdle((s) => !s);
              }}
              title={showIdle ? "Hide idle stores" : `Show ${idleMarkets.length} idle stores`}
            >
              {showIdle ? "−" : `+${idleMarkets.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .market-group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .market-group-header {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-family);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .market-group-header:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-primary);
  }

  .group-has-active {
    color: var(--dpz-red);
  }

  .market-group-name {
    flex: 1;
  }

  .market-group-badge {
    background: rgba(255, 255, 255, 0.1);
    padding: 1px 4px;
    border-radius: 6px;
    font-size: 9px;
    font-weight: 700;
  }

  .market-group-badge-active {
    background: rgba(227, 24, 55, 0.25);
    color: #ff6b6b;
  }

  .market-group-chevron {
    font-size: 10px;
    transition: transform 0.15s;
    display: inline-block;
  }

  .chevron-up {
    transform: rotate(180deg);
  }

  .market-group-children {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 2px;
    padding-left: 4px;
    flex-wrap: nowrap;
  }

  .market-tab-child {
    font-size: 10px;
    padding: 4px 8px;
  }

  .market-tab-idle {
    opacity: 0.5;
  }

  .market-tab-idle:hover {
    opacity: 1;
  }

  .market-group-idle-toggle {
    flex-shrink: 0;
    padding: 3px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    border: 1px dashed var(--border-default);
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-family);
    white-space: nowrap;
    transition: all 0.15s;
  }

  .market-group-idle-toggle:hover {
    border-color: var(--border-active);
    color: var(--text-primary);
  }

  .market-group-idle-hint {
    font-size: 10px;
    color: var(--text-secondary);
    padding: 4px 6px;
    opacity: 0.5;
    white-space: nowrap;
  }
`;
document.head.appendChild(style);
