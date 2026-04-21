import React from "react";
import { useSearchParams } from "react-router-dom";
import { StoreFilter } from "../components/operations/StoreFilter";
import { HeadlineKpis } from "../components/operations/HeadlineKpis";
import { ChainPipeline } from "../components/operations/ChainPipeline";
import { KitchenPanel } from "../components/operations/KitchenPanel";
import { CustomersPanel } from "../components/operations/CustomersPanel";
import { LoyaltyPanel } from "../components/operations/LoyaltyPanel";
import { StoreLeaderboard } from "../components/operations/StoreLeaderboard";
import { useOperationsDashboard } from "../hooks/useOperationsDashboard";

export const OperationsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const storeIds = (searchParams.get("stores") || "")
    .split(",")
    .filter(Boolean);

  const { data, isLoading, error } = useOperationsDashboard(storeIds);

  return (
    <div className="ops-page">
      <StoreFilter />
      {error && (
        <div className="ops-error-banner">
          Live data unavailable — retrying in 5s. ({error})
        </div>
      )}
      {isLoading && !data ? (
        <div className="ops-skeleton">Loading dashboard…</div>
      ) : data ? (
        <>
          <HeadlineKpis data={data.headline} />
          <div className="ops-grid-2">
            <ChainPipeline data={data.pipeline} />
            <KitchenPanel data={data.kitchen} />
            <CustomersPanel data={data.customers} />
            <LoyaltyPanel data={data.loyalty} />
          </div>
          <div className="ops-leaderboard-wrap">
            <StoreLeaderboard rows={data.leaderboard} />
          </div>
        </>
      ) : null}
    </div>
  );
};

export default OperationsPage;

const style = document.createElement("style");
style.textContent = `
  .ops-page {
    flex: 1;
    overflow-y: auto;
    background: var(--surface-base);
    display: flex;
    flex-direction: column;
  }
  .ops-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 0 16px 16px;
  }
  .ops-leaderboard-wrap {
    padding: 0 16px 24px;
  }
  .ops-error-banner {
    background: rgba(227, 24, 55, 0.15);
    color: var(--dpz-red);
    padding: 10px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border-default);
  }
  .ops-skeleton {
    padding: 40px;
    color: var(--text-secondary);
    font-size: 14px;
    text-align: center;
  }
  @media (max-width: 900px) {
    .ops-grid-2 { grid-template-columns: 1fr; }
  }
`;
document.head.appendChild(style);
