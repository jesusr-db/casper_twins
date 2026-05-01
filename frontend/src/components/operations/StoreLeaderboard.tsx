import React, { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { StoreLeaderboardRow } from "../../types";

interface Props {
  rows: StoreLeaderboardRow[];
}

type SortKey =
  | "name"
  | "active_orders"
  | "drivers_out"
  | "revenue_today"
  | "avg_delivery_min"
  | "in_kitchen"
  | "sla_status";

type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "name", label: "Store" },
  { key: "active_orders", label: "Active", right: true },
  { key: "drivers_out", label: "Drivers", right: true },
  { key: "revenue_today", label: "Rev today", right: true },
  { key: "avg_delivery_min", label: "Avg deliv", right: true },
  { key: "in_kitchen", label: "Kitchen", right: true },
  { key: "sla_status", label: "SLA", right: true },
];

const SLA_DOT: Record<StoreLeaderboardRow["sla_status"], string> = {
  green: "#4CAF50",
  yellow: "#FFB800",
  red: "#E31837",
};

export const StoreLeaderboard: React.FC<Props> = ({ rows }) => {
  const [sortKey, setSortKey] = useState<SortKey>("active_orders");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [, setSearchParams] = useSearchParams();

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = a[sortKey] as string | number | null;
      const vb = b[sortKey] as string | number | null;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const handleHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const handleRowClick = (row: StoreLeaderboardRow) => {
    setSearchParams({ stores: row.location_id }, { replace: false });
  };

  return (
    <div className="lb-card">
      <div className="lb-label">
        Store Leaderboard — click row to filter
      </div>
      <table className="lb-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() => handleHeaderClick(c.key)}
                className={c.right ? "lb-right" : ""}
              >
                {c.label}
                {sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.location_id} onClick={() => handleRowClick(r)}>
              <td>{r.name}</td>
              <td className="lb-right">{r.active_orders}</td>
              <td className="lb-right">{r.drivers_out}</td>
              <td className="lb-right">
                ${Math.round(r.revenue_today).toLocaleString()}
              </td>
              <td className="lb-right">
                {r.avg_delivery_min != null
                  ? `${r.avg_delivery_min.toFixed(0)}m`
                  : "—"}
              </td>
              <td className="lb-right">{r.in_kitchen}</td>
              <td className="lb-right">
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: SLA_DOT[r.sla_status],
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .lb-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
    overflow-x: auto;
  }
  .lb-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .lb-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .lb-table th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-default);
    cursor: pointer;
    user-select: none;
  }
  .lb-table td {
    padding: 8px;
    color: var(--text-primary);
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .lb-right {
    text-align: right;
  }
  .lb-table tbody tr {
    cursor: pointer;
  }
  .lb-table tbody tr:hover {
    background: rgba(255,255,255,0.03);
  }
`;
document.head.appendChild(style);
