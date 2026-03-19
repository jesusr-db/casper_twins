import React, { useRef } from "react";
import type { Market, MarketGroup as MarketGroupType } from "../types";
import { MarketGroup } from "./MarketGroup";

interface MarketTabsProps {
  markets: Market[];
  groups?: MarketGroupType[];
  activeMarketId: string;
  onSelect: (marketId: string) => void;
}

/** "Domino's #3 - Marina" → "#3 Marina" */
function shortName(name: string): string {
  const match = name.match(/#(\d+)\s*-\s*(.+)/);
  if (match) return `#${match[1]} ${match[2]}`;
  return name;
}

export const MarketTabs: React.FC<MarketTabsProps> = ({
  markets,
  groups,
  activeMarketId,
  onSelect,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="market-tabs-wrapper">
      <div className="market-tabs-fade-left" />
      <div
        className="market-tabs"
        role="tablist"
        aria-label="Market selector"
        ref={scrollRef}
      >
        {groups && groups.length > 0
          ? groups.map((group) => (
              <MarketGroup
                key={group.cityName}
                group={group}
                activeMarketId={activeMarketId}
                onSelect={onSelect}
              />
            ))
          : markets.map((market) => (
              <button
                key={market.location_id}
                className={`market-tab ${String(market.location_id) === String(activeMarketId) ? "active" : ""}`}
                role="tab"
                aria-selected={String(market.location_id) === String(activeMarketId)}
                onClick={() => onSelect(String(market.location_id))}
              >
                {shortName(market.name)}
                <span className="market-tab-badge">{market.active_orders}</span>
              </button>
            ))}
      </div>
      <div className="market-tabs-fade-right" />
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .market-tabs-wrapper {
    flex: 1;
    min-width: 0;
    position: relative;
    display: flex;
    align-items: center;
  }

  .market-tabs {
    display: flex;
    gap: 4px;
    background: var(--surface-card);
    border-radius: var(--radius-md);
    padding: 3px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    align-items: flex-start;
  }

  .market-tabs::-webkit-scrollbar {
    display: none;
  }

  .market-tabs-fade-left,
  .market-tabs-fade-right {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 24px;
    pointer-events: none;
    z-index: 2;
  }

  .market-tabs-fade-left {
    left: 0;
    background: linear-gradient(to right, var(--surface-elevated), transparent);
  }

  .market-tabs-fade-right {
    right: 0;
    background: linear-gradient(to left, var(--surface-elevated), transparent);
  }

  .market-tab {
    flex-shrink: 0;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    font-family: var(--font-family);
    white-space: nowrap;
  }

  .market-tab:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.05);
  }

  .market-tab.active {
    background: var(--dpz-red);
    color: var(--dpz-white);
  }

  .market-tab-badge {
    background: rgba(255, 255, 255, 0.15);
    padding: 1px 5px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
  }

  .market-tab.active .market-tab-badge {
    background: rgba(255, 255, 255, 0.3);
  }
`;
document.head.appendChild(style);
