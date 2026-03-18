import React, { useCallback, useRef } from "react";
import type { PlaybackSpeed } from "../types";

interface PlaybackControlsProps {
  playbackTime: Date | null;
  timeWindow: { start: Date; end: Date } | null;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  eventDensity: number[];
  eventsProcessed: number;
  totalEvents: number;
  onPlayPause: () => void;
  onScrub: (time: Date) => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onBackToLive: () => void;
}

const SPEED_OPTIONS: PlaybackSpeed[] = [1, 2, 5, 10];

function formatPlaybackTime(date: Date | null): string {
  if (!date) return "--:--:--";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDate(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  playbackTime,
  timeWindow,
  isPlaying,
  speed,
  eventDensity,
  eventsProcessed,
  totalEvents,
  onPlayPause,
  onScrub,
  onSpeedChange,
  onBackToLive,
}) => {
  const scrubberRef = useRef<HTMLDivElement>(null);

  // Calculate scrubber fill percentage
  const fillPercent =
    timeWindow && playbackTime
      ? ((playbackTime.getTime() - timeWindow.start.getTime()) /
          (timeWindow.end.getTime() - timeWindow.start.getTime())) *
        100
      : 0;

  // Handle scrubber click
  const handleScrubberClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!scrubberRef.current || !timeWindow) return;
      const rect = scrubberRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetTime = new Date(
        timeWindow.start.getTime() +
          pct * (timeWindow.end.getTime() - timeWindow.start.getTime())
      );
      onScrub(targetTime);
    },
    [timeWindow, onScrub]
  );

  // Generate time labels for the scrubber
  const timeLabels = timeWindow
    ? [0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const t = new Date(
          timeWindow.start.getTime() +
            pct * (timeWindow.end.getTime() - timeWindow.start.getTime())
        );
        return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      })
    : [];

  const maxDensity = Math.max(...eventDensity, 1);

  return (
    <div className="playback-bar">
      {/* Play/Pause */}
      <button
        className={`play-pause-btn ${isPlaying ? "playing" : ""}`}
        onClick={onPlayPause}
        aria-label={isPlaying ? "Pause playback" : "Play playback"}
      >
        <div className="play-pause-icon" />
      </button>

      {/* Time display */}
      <div className="playback-time-display">
        <div className="playback-time-current">
          {formatPlaybackTime(playbackTime)}
        </div>
        <div className="playback-time-date">{formatDate(playbackTime)}</div>
      </div>

      {/* Scrubber with density */}
      <div className="scrubber-container">
        {/* Event density histogram */}
        <div className="event-density">
          {eventDensity.map((count, idx) => (
            <div key={idx} className="density-bar">
              <div
                className="density-bar-fill"
                style={{ height: `${(count / maxDensity) * 100}%` }}
              />
            </div>
          ))}
        </div>

        {/* Scrubber track */}
        <div
          className="scrubber-track"
          ref={scrubberRef}
          onClick={handleScrubberClick}
        >
          <div className="scrubber-fill" style={{ width: `${fillPercent}%` }}>
            <div className="scrubber-handle" />
          </div>
        </div>

        {/* Time labels */}
        <div className="scrubber-labels">
          {timeLabels.map((label, idx) => (
            <span key={idx}>{label}</span>
          ))}
        </div>
      </div>

      {/* Speed selector */}
      <div className="speed-selector">
        {SPEED_OPTIONS.map((s) => (
          <button
            key={s}
            className={`speed-btn ${speed === s ? "speed-btn-active" : ""}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}x
          </button>
        ))}
      </div>

      {/* Back to Live */}
      <button className="back-to-live-btn" onClick={onBackToLive}>
        Back to Live
      </button>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .playback-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    background: linear-gradient(180deg, #1A1040 0%, var(--surface-elevated) 100%);
    border-bottom: 1px solid #3A2070;
    flex-shrink: 0;
    height: 64px;
  }

  .play-pause-btn {
    width: 40px;
    height: 40px;
    background: var(--playback-primary);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.2s;
  }

  .play-pause-btn:hover { background: #7E4FBD; }

  .play-pause-btn .play-pause-icon {
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 8px 0 8px 14px;
    border-color: transparent transparent transparent white;
    margin-left: 2px;
  }

  .play-pause-btn.playing .play-pause-icon {
    width: 12px;
    height: 16px;
    border: none;
    border-left: 3px solid white;
    border-right: 3px solid white;
    margin-left: 0;
  }

  .playback-time-display {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    min-width: 80px;
  }

  .playback-time-current {
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }

  .playback-time-date {
    font-size: 9px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .scrubber-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .event-density {
    width: 100%;
    height: 16px;
    display: flex;
    gap: 1px;
  }

  .density-bar {
    flex: 1;
    background: var(--border-default);
    border-radius: 1px;
    position: relative;
    overflow: hidden;
  }

  .density-bar-fill {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(107, 63, 160, 0.5);
    border-radius: 1px;
  }

  .scrubber-track {
    width: 100%;
    height: 6px;
    background: var(--border-default);
    border-radius: 3px;
    position: relative;
    cursor: pointer;
  }

  .scrubber-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--playback-primary), var(--playback-secondary));
    border-radius: 3px;
    position: relative;
  }

  .scrubber-handle {
    position: absolute;
    right: -6px;
    top: -4px;
    width: 14px;
    height: 14px;
    background: white;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    cursor: grab;
  }

  .scrubber-labels {
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    color: var(--text-secondary);
  }

  .speed-selector {
    display: flex;
    gap: 2px;
    background: var(--surface-card);
    border-radius: 6px;
    padding: 2px;
    flex-shrink: 0;
  }

  .speed-btn {
    padding: 4px 8px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    cursor: pointer;
    font-family: var(--font-family);
  }

  .speed-btn-active {
    background: var(--playback-primary);
    color: white;
  }

  .speed-btn:hover:not(.speed-btn-active) { color: var(--text-primary); }

  .back-to-live-btn {
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--success);
    color: var(--success);
    border-radius: 6px;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
    flex-shrink: 0;
    font-family: var(--font-family);
  }

  .back-to-live-btn:hover { background: rgba(76, 175, 80, 0.1); }
`;
document.head.appendChild(style);
