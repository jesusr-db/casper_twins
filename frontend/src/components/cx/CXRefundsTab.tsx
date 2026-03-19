import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { CXRefundRow } from "../../types";
import type { CXDays } from "./CXPanel";

const REFUND_CLASS_COLORS: Record<string, string> = {
  partial: "#FFB800", full: "#4CAF50", none: "rgba(255,255,255,0.1)", error: "#E31837",
};

type RefundClass = "partial" | "full" | "none" | "error" | null;

interface Props {
  locationId: string;
  days: CXDays;
}

interface RefundsResponse {
  total: number;
  page: number;
  page_size: number;
  last_sync_ts: string | null;
  rows: CXRefundRow[];
}

export const CXRefundsTab: React.FC<Props> = ({ locationId, days }) => {
  const navigate = useNavigate();
  const [refundClass, setRefundClass] = useState<RefundClass>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RefundsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setPage(1);
  }, [refundClass, days]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (days > 0) params.set("days", String(days));
    if (refundClass) params.set("refund_class", refundClass);

    fetch(`/api/cx/stores/${locationId}/refunds?${params}`)
      .then((r) => r.json())
      .then((d: RefundsResponse) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [locationId, page, refundClass, days]);

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0;

  return (
    <div>
      {/* Filter Bar */}
      <div className="cx-tab-filter-bar">
        <select
          className="cx-filter-select"
          value={refundClass ?? ""}
          onChange={(e) => setRefundClass((e.target.value || null) as RefundClass)}
        >
          <option value="">All Classes</option>
          <option value="partial">Partial</option>
          <option value="full">Full</option>
          <option value="none">None</option>
          <option value="error">Error</option>
        </select>
      </div>

      {data?.last_sync_ts && (
        <div className="cx-sync-note">
          Refund data as of {new Date(data.last_sync_ts).toLocaleString()}
        </div>
      )}

      {loading ? (
        <div className="cx-loading">Loading refunds…</div>
      ) : (
        <>
          <div className="cx-table-meta">{data?.total.toLocaleString()} refund records</div>
          <table className="cx-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Class</th>
                <th>Refund $</th>
                <th>AI Reason</th>
                <th>Order Date</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row) => (
                <React.Fragment key={row.order_id}>
                  <tr
                    className="cx-table-row"
                    onClick={() => setExpandedId(expandedId === row.order_id ? null : row.order_id)}
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
                      <span
                        className="cx-badge"
                        style={{ background: REFUND_CLASS_COLORS[row.refund_class] ?? "#888" }}
                      >
                        {row.refund_class}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {row.refund_usd != null ? `$${row.refund_usd.toFixed(2)}` : "—"}
                    </td>
                    <td className="cx-truncated">
                      {row.reason && row.reason.length > 100
                        ? `${row.reason.slice(0, 100)}…`
                        : (row.reason ?? "—")}
                    </td>
                    <td className="cx-muted">{new Date(row.order_ts).toLocaleString()}</td>
                  </tr>
                  {expandedId === row.order_id && (
                    <tr>
                      <td colSpan={5} className="cx-expanded-text">{row.reason}</td>
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
  .cx-sync-note {
    font-size: 11px; color: var(--text-secondary);
    margin-bottom: 8px; font-style: italic;
  }
`;
document.head.appendChild(style);
