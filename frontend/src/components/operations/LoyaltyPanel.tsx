import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["loyalty"] | null;
}

export const LoyaltyPanel: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-label">Loyalty / Rewards</div>
      <div className="ops-stat-row">
        <div className="ops-stat">
          <div className="ops-stat-value">{data.loyalty_order_pct.toFixed(0)}%</div>
          <div className="ops-stat-sub">Loyalty orders</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">
            {data.points_earned_today.toLocaleString()}
          </div>
          <div className="ops-stat-sub">Points earned</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">
            {data.avg_coupon_propensity.toFixed(2)}
          </div>
          <div className="ops-stat-sub">Avg coupon propensity</div>
        </div>
      </div>
      <div className="ops-card-footnote">
        Points formula is v1 synthetic (FLOOR of order_total for loyalty members).
      </div>
    </div>
  );
};
