import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Market } from "../../types";

export const StoreFilter: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [markets, setMarkets] = useState<Market[]>([]);

  useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json())
      .then((data: Market[]) => {
        if (Array.isArray(data)) setMarkets(data);
      })
      .catch(() => {});
  }, []);

  const raw = searchParams.get("stores") || "";
  const selected = new Set(raw.split(",").filter(Boolean));

  const setSelected = (next: Set<string>) => {
    const params = new URLSearchParams(searchParams);
    if (next.size === 0) {
      params.delete("stores");
    } else {
      params.set("stores", Array.from(next).join(","));
    }
    setSearchParams(params, { replace: true });
  };

  const togglePill = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearAll = () => setSelected(new Set());

  return (
    <div className="store-filter">
      <button
        className={`store-filter-pill ${selected.size === 0 ? "active" : ""}`}
        onClick={clearAll}
      >
        All stores ({markets.length})
      </button>
      {markets.map((m) => (
        <button
          key={m.location_id}
          className={`store-filter-pill ${
            selected.has(String(m.location_id)) ? "active" : ""
          }`}
          onClick={() => togglePill(String(m.location_id))}
        >
          {m.name}
        </button>
      ))}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .store-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 16px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
  }
  .store-filter-pill {
    padding: 6px 12px;
    border: 1px solid var(--border-default);
    border-radius: 14px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    font-family: var(--font-family);
  }
  .store-filter-pill.active {
    background: var(--dpz-red);
    color: white;
    border-color: var(--dpz-red);
  }
`;
document.head.appendChild(style);
