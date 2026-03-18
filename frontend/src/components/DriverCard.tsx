import React from "react";

interface DriverInfo {
  progress_pct: number;
  eta_minutes: number;
  distance_remaining: number;
}

interface DriverCardProps {
  driver: DriverInfo | null;
  orderId: string;
  onFollowDriver: (orderId: string) => void;
}

export const DriverCard: React.FC<DriverCardProps> = ({
  driver,
  orderId,
  onFollowDriver,
}) => {
  if (!driver) return null;

  return (
    <div className="driver-card">
      <div className="driver-avatar">{orderId.slice(0, 2)}</div>
      <div className="driver-info-content">
        <div className="driver-name">Driver — Order {orderId.slice(0, 6)}</div>
        <div className="driver-stats-row">
          <div className="driver-stat">
            <span className="driver-stat-label">Progress</span>
            <span className="driver-stat-value" style={{ color: "var(--dpz-red)" }}>
              {driver.progress_pct}%
            </span>
          </div>
          <div className="driver-stat">
            <span className="driver-stat-label">ETA</span>
            <span className="driver-stat-value" style={{ color: "var(--stage-new)" }}>
              {driver.eta_minutes} min
            </span>
          </div>
          <div className="driver-stat">
            <span className="driver-stat-label">Distance</span>
            <span className="driver-stat-value" style={{ color: "var(--dpz-blue)" }}>
              {driver.distance_remaining.toFixed(1)} mi
            </span>
          </div>
        </div>
      </div>
      <button
        className="follow-driver-btn"
        onClick={() => onFollowDriver(orderId)}
      >
        Follow Driver
      </button>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .driver-card {
    background: var(--surface-card);
    border-radius: var(--radius-lg);
    padding: 16px;
    border: 1px solid var(--dpz-red);
    display: flex;
    gap: 16px;
    align-items: center;
  }

  .driver-avatar {
    width: 44px;
    height: 44px;
    background: var(--dpz-red);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 16px;
    color: white;
    flex-shrink: 0;
  }

  .driver-info-content {
    flex: 1;
  }

  .driver-name {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 6px;
  }

  .driver-stats-row {
    display: flex;
    gap: 16px;
  }

  .driver-stat {
    display: flex;
    flex-direction: column;
  }

  .driver-stat-label {
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-secondary);
    letter-spacing: 0.5px;
  }

  .driver-stat-value {
    font-size: 16px;
    font-weight: 700;
  }

  .follow-driver-btn {
    padding: 8px 16px;
    background: var(--dpz-red);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-family: var(--font-family);
    align-self: center;
  }

  .follow-driver-btn:hover {
    background: #C71530;
  }
`;
document.head.appendChild(style);
