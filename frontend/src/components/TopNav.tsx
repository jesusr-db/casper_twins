import React from "react";
import { NavLink } from "react-router-dom";

interface TopNavProps {
  storeCount?: number;
  simTime?: string;
}

export const TopNav: React.FC<TopNavProps> = ({ storeCount, simTime }) => {
  return (
    <div className="top-nav">
      <div className="top-nav-brand">
        <div className="app-logo">D</div>
        <span className="app-title">Delivery Digital Twin</span>
      </div>
      <div className="top-nav-pills">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `top-nav-pill ${isActive ? "top-nav-pill-active" : ""}`
          }
        >
          Map
        </NavLink>
        <NavLink
          to="/operations"
          className={({ isActive }) =>
            `top-nav-pill ${isActive ? "top-nav-pill-active" : ""}`
          }
        >
          Operations
        </NavLink>
      </div>
      <div className="top-nav-meta">
        {simTime && <span>sim-time {simTime}</span>}
        {storeCount != null && <span>· {storeCount} stores</span>}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .top-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 44px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .top-nav-brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .top-nav-pills {
    display: flex;
    gap: 4px;
  }
  .top-nav-pill {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--text-secondary);
    text-decoration: none;
    text-transform: uppercase;
  }
  .top-nav-pill-active {
    background: var(--dpz-red);
    color: white;
  }
  .top-nav-meta {
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    gap: 6px;
  }
`;
document.head.appendChild(style);
