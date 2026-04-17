import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { CXComplaintRow } from "../../types";
import type { CXCategory, CXDays } from "./CXPanel";

const CATEGORY_COLORS: Record<string, string> = {
  delivery_delay: "#E31837", missing_items: "#FF6B35",
  food_quality: "#FFB800", service_issue: "#006491", other: "#888",
};
const CATEGORY_LABELS: Record<string, string> = {
  delivery_delay: "Delivery Delay", missing_items: "Missing Items",
  food_quality: "Food Quality", service_issue: "Service Issue", other: "Other",
};
const REFUND_CLASS_COLORS: Record<string, string> = {
  partial: "#FFB800", full: "#4CAF50", none: "rgba(255,255,255,0.1)", error: "#E31837",
};

interface Props {
  locationId: string;
  days: CXDays;
}

interface ComplaintsResponse {
  total: number;
  page: number;
  page_size: number;
  rows: CXComplaintRow[];
}

export const CXComplaintsTab: React.FC<Props> = ({ locationId, days }) => {
  const navigate = useNavigate();
  const [category, setCategory] = useState<CXCategory>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ComplaintsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setPage(1);
  }, [category, days]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (days > 0) params.set("days", String(days));
    if (category) params.set("category", category);

    fetch(`/api/cx/stores/${locationId}/complaints?${params}`)
      .then((r) => r.json())
      .then((d: ComplaintsResponse) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [locationId, page, category, days]);

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0;

  return (
    <div>
      {/* Filter Bar */}
      <div className="cx-tab-filter-bar">
        <select
          className="cx-filter-select"
          value={category ?? ""}
          onChange={(e) => setCategory((e.target.value || null) as CXCategory)}
        >
          <option value="">All Categories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="cx-loading">Loading complaints…</div>
      ) : (
        <>
          <div className="cx-table-meta">{data?.total.toLocaleString()} complaints</div>
          <table className="cx-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Category</th>
                <th>Complaint</th>
                <th>Date</th>
                <th>Refund $</th>
                <th>Class</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row) => (
                <React.Fragment key={row.complaint_id}>
                  <tr
                    className="cx-table-row"
                    onClick={() => setExpandedId(expandedId === row.complaint_id ? null : row.complaint_id)}
                  >
                    <td>
                      <button
                        className="cx-order-link"
                        onClick={(e) => { e.stopPropagation(); navigate(`/?order=${row.order_id}`); }}
                      >
                        #{row.order_id}
                      </button>
                    </td>
                    <td>
                      <span className="cx-badge" style={{ background: CATEGORY_COLORS[row.category] ?? "#888" }}>
                        {CATEGORY_LABELS[row.category] ?? row.category}
                      </span>
                    </td>
                    <td className="cx-truncated">
                      {row.complaint_text.length > 80
                        ? `${row.complaint_text.slice(0, 80)}…`
                        : row.complaint_text}
                    </td>
                    <td className="cx-muted">{new Date(row.ts).toLocaleString()}</td>
                    <td>{row.refund_usd != null ? `$${row.refund_usd.toFixed(2)}` : "—"}</td>
                    <td>
                      {row.refund_class ? (
                        <span className="cx-badge" style={{ background: REFUND_CLASS_COLORS[row.refund_class] ?? "#888" }}>
                          {row.refund_class}
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                  {expandedId === row.complaint_id && (
                    <tr>
                      <td colSpan={6} className="cx-expanded-text">{row.complaint_text}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="cx-pagination">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
              <span>Page {page} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-tab-filter-bar { display: flex; gap: 10px; margin-bottom: 12px; }
  .cx-table-meta { font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; }
  .cx-truncated { max-width: 280px; font-size: 12px; color: var(--text-secondary); }
  .cx-muted { color: var(--text-secondary); font-size: 12px; }
  .cx-expanded-text {
    background: var(--surface-card); font-size: 12px; padding: 10px 16px;
    color: var(--text-secondary); font-style: italic;
  }
  .cx-order-link {
    background: none; border: none; color: var(--dpz-red);
    cursor: pointer; font-size: 13px; font-weight: 600; padding: 0;
    text-decoration: underline;
  }
  .cx-order-link:hover { color: #ff4d66; }
  .cx-pagination {
    display: flex; align-items: center; gap: 12px; padding: 12px 0;
    font-size: 13px; color: var(--text-secondary);
  }
  .cx-pagination button {
    background: var(--surface-card); border: 1px solid var(--border-default);
    color: var(--text-primary); border-radius: 4px; padding: 4px 10px;
    cursor: pointer;
  }
  .cx-pagination button:disabled { opacity: 0.3; cursor: default; }
`;
document.head.appendChild(style);
