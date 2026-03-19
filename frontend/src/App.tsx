import React, { useState, useCallback, useEffect } from "react";
import { MarketTabs } from "./components/MarketTabs";
import { KpiBar } from "./components/KpiBar";
import { MapView } from "./components/MapView";
import { OrderPipeline } from "./components/OrderPipeline";
import { OrderDrawer } from "./components/OrderDrawer";
import { PlaybackControls } from "./components/PlaybackControls";
import { usePolling } from "./hooks/usePolling";
import { usePlayback } from "./hooks/usePlayback";
import type {
  Market,
  MarketGroup,
  MarketKpis,
  Order,
  Driver,
  OrderDetail,
  AppMode,
} from "./types";
import { STAGE_MAP, getOrderStage } from "./types";
import { OrderList } from "./components/OrderList";
import { StoreDetailPanel } from "./components/StoreDetailPanel";
import type { PipelineStage } from "./types";

const CITY_GROUPS: Record<string, string> = {
  sf: "SF Bay Area",
  sv: "SF Bay Area",
  sv2: "SF Bay Area",
  paloalto: "SF Bay Area",
  "palo-alto": "SF Bay Area",
  pa: "SF Bay Area",
  seattle: "Pacific Northwest",
  bellevue: "Pacific Northwest",
  chicago: "Midwest",
  chi: "Midwest",
};

function groupMarketsByCity(markets: Market[]): MarketGroup[] {
  const groupMap = new Map<string, Market[]>();

  for (const market of markets) {
    const code = market.location_code.toLowerCase().replace(/[^a-z0-9-]/g, "");
    // Try to match by prefix or known codes
    let cityName = "Other";
    for (const [key, city] of Object.entries(CITY_GROUPS)) {
      if (code.startsWith(key) || code.includes(key)) {
        cityName = city;
        break;
      }
    }
    // Fallback: use first word of market name
    if (cityName === "Other") {
      cityName = market.name.split(" ")[0];
    }

    if (!groupMap.has(cityName)) groupMap.set(cityName, []);
    groupMap.get(cityName)!.push(market);
  }

  return Array.from(groupMap.entries()).map(([cityName, mks]) => ({
    cityName,
    markets: mks,
    totalActiveOrders: mks.reduce((sum, m) => sum + m.active_orders, 0),
  }));
}

const App: React.FC = () => {
  // === State ===
  const [markets, setMarkets] = useState<Market[]>([]);
  const [activeMarketId, setActiveMarketId] = useState<string>("");
  const [mode, setMode] = useState<AppMode>("live");

  // Live mode data
  const [orders, setOrders] = useState<Order[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [kpis, setKpis] = useState<MarketKpis | null>(null);

  // UI state
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<OrderDetail | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [isFollowingDriver, setIsFollowingDriver] = useState(false);
  const [rightRailMode, setRightRailMode] = useState<null | "order" | "store">(null);

  // Playback
  const [playbackState, playbackActions] = usePlayback();

  // === Fetch markets on mount ===
  useEffect(() => {
    fetch("/api/markets")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Market[]) => {
        if (!Array.isArray(data)) return;
        setMarkets(data);
        if (data.length > 0 && !activeMarketId) {
          setActiveMarketId(String(data[0].location_id));
        }
      })
      .catch((err) => console.error("Failed to fetch markets:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === Polling for live data ===
  const fetchLiveData = useCallback(
    async (signal: AbortSignal) => {
      if (!activeMarketId) return;

      const [ordersRes, driversRes, kpisRes] = await Promise.all([
        fetch(`/api/markets/${activeMarketId}/orders`, { signal }),
        fetch(`/api/markets/${activeMarketId}/drivers`, { signal }),
        fetch(`/api/markets/${activeMarketId}/kpis`, { signal }),
      ]);

      if (signal.aborted) return;

      const [ordersData, driversData, kpisData] = await Promise.all([
        ordersRes.json(),
        driversRes.json(),
        kpisRes.json(),
      ]);

      if (Array.isArray(ordersData)) setOrders(ordersData);
      if (Array.isArray(driversData)) setDrivers(driversData);
      if (kpisData && typeof kpisData.active_orders === "number") setKpis(kpisData);

      // Also refresh market badges
      fetch("/api/markets", { signal })
        .then((r) => r.json())
        .then(setMarkets)
        .catch(() => {}); // Non-critical, ignore failures
    },
    [activeMarketId]
  );

  usePolling(fetchLiveData, 3000, mode === "live" && !!activeMarketId, [
    activeMarketId,
  ]);

  // === Computed: stage counts ===
  const currentOrders = mode === "live" ? orders : playbackState.orders;
  const currentDrivers = mode === "live" ? drivers : playbackState.drivers;

  const stageCounts =
    mode === "playback"
      ? playbackState.stageCounts
      : currentOrders.reduce(
          (acc, order) => {
            const stage = getOrderStage(order);
            acc[stage] = (acc[stage] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

  // Derive count KPIs from the orders array so they always match the pipeline.
  // avg_delivery_time and todays_revenue still come from the backend.
  const derivedKpis = kpis
    ? {
        ...kpis,
        active_orders: currentOrders.filter((o) => getOrderStage(o) !== "Delivered").length,
        drivers_out: currentOrders.filter((o) => getOrderStage(o) === "In Transit").length,
      }
    : null;

  // === Handlers ===
  const handleMarketSelect = useCallback(
    (marketId: string) => {
      setActiveMarketId(marketId);
      setSelectedOrderId(null);
      setIsDrawerOpen(false);
      setSelectedStage(null);
      setIsFollowingDriver(false);
      setOrders([]);
      setDrivers([]);
      setKpis(null);
    },
    []
  );

  const handleDriverClick = useCallback(
    async (orderId: string) => {
      setSelectedOrderId(orderId);
      setIsDrawerOpen(true);
      setRightRailMode("order");
      setIsFollowingDriver(false);

      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (res.ok) {
          const detail: OrderDetail = await res.json();
          setOrderDetail(detail);
        }
      } catch (err) {
        console.error("Failed to fetch order detail:", err);
      }
    },
    []
  );

  const handleDrawerClose = useCallback(() => {
    setIsDrawerOpen(false);
    setSelectedOrderId(null);
    setOrderDetail(null);
    setIsFollowingDriver(false);
    setRightRailMode(null);
  }, []);

  const handleFollowDriver = useCallback((orderId: string) => {
    setIsFollowingDriver(true);
  }, []);

  const handleStageClick = useCallback((stage: string | null) => {
    setSelectedStage(stage);
  }, []);

  const handleMapClick = useCallback(() => {
    if (isDrawerOpen) {
      handleDrawerClose();
    }
  }, [isDrawerOpen, handleDrawerClose]);

  const handleStoreClick = useCallback(() => {
    setRightRailMode((prev) => (prev === "store" ? null : "store"));
    setIsDrawerOpen(false);
    setSelectedOrderId(null);
    setOrderDetail(null);
  }, []);

  const handleModeToggle = useCallback(
    (newMode: AppMode) => {
      if (newMode === mode) return;
      setMode(newMode);

      if (newMode === "playback") {
        // Load playback events — use a 2-hour window ending "now"
        const end = new Date();
        const start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
        const fmt = (d: Date) =>
          d.toISOString().replace("T", " ").substring(0, 19);
        playbackActions.loadEvents(activeMarketId, fmt(start), fmt(end));
      } else {
        playbackActions.reset();
      }
    },
    [mode, activeMarketId, playbackActions]
  );

  // Event density for playback (split events into 20 buckets)
  const eventDensity: number[] =
    playbackState.timeWindow && playbackState.events.length > 0
      ? (() => {
          const buckets = new Array(20).fill(0);
          const { start, end } = playbackState.timeWindow;
          const range = end.getTime() - start.getTime();
          for (const event of playbackState.events) {
            const t = new Date(event.ts.replace(" ", "T") + "Z").getTime();
            const idx = Math.min(
              19,
              Math.floor(((t - start.getTime()) / range) * 20)
            );
            if (idx >= 0) buckets[idx]++;
          }
          return buckets;
        })()
      : new Array(20).fill(0);

  const activeMarket = markets.find(
    (m) => String(m.location_id) === String(activeMarketId)
  ) || null;

  const marketGroups = groupMarketsByCity(markets);

  return (
    <div className="app-root">
      {/* Top Bar */}
      <div className="top-bar">
        <div className="logo-area">
          <div className="app-logo">D</div>
          <span className="app-title">Delivery Digital Twin</span>
          {mode === "playback" && (
            <span className="playback-badge-indicator">PLAYBACK</span>
          )}
        </div>

        <MarketTabs
          markets={markets}
          groups={marketGroups}
          activeMarketId={activeMarketId}
          onSelect={handleMarketSelect}
        />

        <div className="mode-toggle">
          {mode === "live" && <span className="live-pulse-dot" />}
          <button
            className={`mode-toggle-btn ${mode === "live" ? "mode-active" : ""}`}
            onClick={() => handleModeToggle("live")}
          >
            Live
          </button>
          <button
            className={`mode-toggle-btn ${mode === "playback" ? "mode-active-playback" : ""}`}
            onClick={() => handleModeToggle("playback")}
          >
            Playback
          </button>
        </div>
      </div>

      {/* KPI Bar or Playback Controls */}
      {mode === "live" ? (
        <KpiBar kpis={derivedKpis} isLoading={!kpis && !!activeMarketId} />
      ) : (
        <PlaybackControls
          playbackTime={playbackState.currentTime}
          timeWindow={playbackState.timeWindow}
          isPlaying={playbackState.isPlaying}
          speed={playbackState.speed}
          eventDensity={eventDensity}
          eventsProcessed={playbackState.eventsProcessed}
          totalEvents={playbackState.totalEvents}
          onPlayPause={playbackActions.togglePlayPause}
          onScrub={playbackActions.scrubTo}
          onSpeedChange={playbackActions.setSpeed}
          onBackToLive={() => handleModeToggle("live")}
        />
      )}

      {/* Map + Stage Drill-Down */}
      <div className="map-and-list-container">
        {selectedStage && selectedStage !== "Delivered" && (
          <OrderList
            stage={selectedStage as PipelineStage}
            orders={currentOrders}
            onOrderClick={handleDriverClick}
            onClose={() => setSelectedStage(null)}
          />
        )}
        <MapView
          market={activeMarket || null}
          drivers={currentDrivers}
          orders={currentOrders}
          selectedOrderId={selectedOrderId}
          stageFilter={selectedStage}
          isFollowingDriver={isFollowingDriver}
          onDriverClick={handleDriverClick}
          onMapClick={handleMapClick}
          onStoreClick={handleStoreClick}
        />
        {rightRailMode === "store" && activeMarket && (
          <StoreDetailPanel
            market={activeMarket}
            kpis={kpis}
            orders={currentOrders}
            onClose={() => setRightRailMode(null)}
            onStageClick={(stage) => {
              setSelectedStage(stage);
              setRightRailMode(null);
            }}
          />
        )}
      </div>

      {/* Pipeline */}
      <OrderPipeline
        stageCounts={stageCounts}
        selectedStage={selectedStage}
        onStageClick={handleStageClick}
      />

      {/* Order Drawer */}
      <OrderDrawer
        order={orderDetail}
        isOpen={isDrawerOpen && rightRailMode === "order"}
        onClose={handleDrawerClose}
        onFollowDriver={handleFollowDriver}
      />
    </div>
  );
};

// App-level styles
const style = document.createElement("style");
style.textContent = `
  .app-root {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 56px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
    flex-shrink: 0;
  }

  .logo-area {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .app-logo {
    width: 28px;
    height: 28px;
    background: var(--dpz-red);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
    color: white;
  }

  .app-title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }

  .playback-badge-indicator {
    background: var(--playback-primary);
    color: white;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .live-pulse-dot {
    width: 6px;
    height: 6px;
    background: var(--success);
    border-radius: 50%;
    animation: pulse 2s infinite;
  }

  .mode-toggle-btn {
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border-default);
    background: transparent;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-family: var(--font-family);
  }

  .mode-active {
    background: var(--dpz-blue);
    color: white;
    border-color: var(--dpz-blue);
  }

  .mode-active-playback {
    background: var(--playback-primary);
    color: white;
    border-color: var(--playback-primary);
  }

  .map-and-list-container {
    flex: 1;
    position: relative;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
`;
document.head.appendChild(style);

export default App;
