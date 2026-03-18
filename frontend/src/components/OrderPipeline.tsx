import React from "react";
import { STAGE_COLORS, type PipelineStage } from "../types";

interface OrderPipelineProps {
  stageCounts: Record<string, number>;
  selectedStage: string | null;
  onStageClick: (stageName: string | null) => void;
}

const STAGES: PipelineStage[] = [
  "New",
  "Kitchen Prep",
  "Ready",
  "In Transit",
  "Delivered",
];

export const OrderPipeline: React.FC<OrderPipelineProps> = ({
  stageCounts,
  selectedStage,
  onStageClick,
}) => {
  const handleClick = (stage: string) => {
    if (selectedStage === stage) {
      onStageClick(null); // Toggle off
    } else {
      onStageClick(stage);
    }
  };

  return (
    <div className="pipeline-bar">
      <div className="pipeline-label">PIPELINE</div>
      {STAGES.map((stage, idx) => (
        <React.Fragment key={stage}>
          {idx > 0 && <div className="pipeline-connector">&rarr;</div>}
          <button
            className={`pipeline-stage ${selectedStage === stage ? "pipeline-stage-active" : ""}`}
            onClick={() => handleClick(stage)}
            title={`${stageCounts[stage] || 0} orders in ${stage}`}
            aria-label={`${stage}: ${stageCounts[stage] || 0} orders`}
            style={
              selectedStage === stage
                ? {
                    borderColor: STAGE_COLORS[stage],
                    boxShadow: `0 0 12px ${STAGE_COLORS[stage]}33`,
                  }
                : undefined
            }
          >
            <div
              className="pipeline-stage-count"
              style={{ color: STAGE_COLORS[stage] }}
            >
              {stageCounts[stage] || 0}
            </div>
            <div className="pipeline-stage-name">{stage}</div>
            <div
              className="pipeline-stage-indicator"
              style={{ background: STAGE_COLORS[stage] }}
            />
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .pipeline-bar {
    height: 130px;
    background: var(--surface-elevated);
    border-top: 1px solid var(--border-default);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 8px;
    flex-shrink: 0;
  }

  .pipeline-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    margin-right: 8px;
  }

  .pipeline-stage {
    flex: 1;
    background: var(--surface-card);
    border-radius: var(--radius-lg);
    padding: 14px;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid var(--border-default);
    text-align: center;
    font-family: var(--font-family);
    color: var(--text-primary);
  }

  .pipeline-stage:hover {
    border-color: var(--border-active);
    transform: translateY(-2px);
  }

  .pipeline-stage-active {
    transform: translateY(-2px);
  }

  .pipeline-stage-count {
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 4px;
  }

  .pipeline-stage-name {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }

  .pipeline-stage-indicator {
    width: 100%;
    height: 3px;
    border-radius: 2px;
    opacity: 0.6;
  }

  .pipeline-connector {
    color: var(--border-default);
    font-size: 16px;
    flex-shrink: 0;
  }
`;
document.head.appendChild(style);
