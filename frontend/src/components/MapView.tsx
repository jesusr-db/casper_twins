import React, { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import type { Market, Driver, Order } from "../types";
import { getOrderStage } from "../types";

/** Return true only when both values are finite numbers (not NaN, not Infinity). */
function isValidLngLat(lng: unknown, lat: unknown): boolean {
  return typeof lng === "number" && typeof lat === "number" && isFinite(lng) && isFinite(lat);
}

interface MapViewProps {
  market: Market | null;
  drivers: Driver[];
  orders: Order[];
  selectedOrderId: string | null;
  stageFilter: string | null;
  isFollowingDriver: boolean;
  onDriverClick: (orderId: string) => void;
  onMapClick: () => void;
  onStoreClick?: () => void;
}

const TILE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// Stage colors for driver markers
const DRIVER_COLOR_TRANSIT = "#E31837";   // red  — heading to customer
const DRIVER_COLOR_CLOSE   = "#FF8C00";   // orange — almost at customer (≥80%)
const DRIVER_COLOR_DELIVERED = "#4CAF50"; // green — delivered pin
const STORE_COLOR = "#E31837";
const CUSTOMER_COLOR = "#FFB800"; // kept for legend CSS reference

/** Color a driver dot by how far along the delivery route they are. */
function driverColor(progress_pct: number | null | undefined): string {
  if (progress_pct != null && progress_pct >= 80) return DRIVER_COLOR_CLOSE;
  return DRIVER_COLOR_TRANSIT;
}

export const MapView: React.FC<MapViewProps> = ({
  market,
  drivers,
  orders,
  selectedOrderId,
  stageFilter,
  isFollowingDriver,
  onDriverClick,
  onMapClick,
  onStoreClick,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const storeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const customerMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [updatedLabel, setUpdatedLabel] = useState("just now");

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: TILE_STYLE,
      center: [-122.4194, 37.7749], // Default to SF
      zoom: 12,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("click", (e) => {
      // Only fire if clicking the map background (not a marker)
      const features = map.queryRenderedFeatures(e.point);
      if (features.length === 0) {
        onMapClick();
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track "updated X ago" label — reset on every drivers poll
  useEffect(() => {
    setLastUpdated(new Date());
  }, [drivers]);

  useEffect(() => {
    const interval = setInterval(() => {
      const secs = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
      if (secs < 10) setUpdatedLabel("just now");
      else if (secs < 60) setUpdatedLabel(`${secs}s ago`);
      else setUpdatedLabel(`${Math.floor(secs / 60)}m ago`);
    }, 5000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Fly to market when it changes — use location_id to detect real changes
  const prevMarketIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!mapRef.current || !market) return;
    if (prevMarketIdRef.current === market.location_id) return;
    if (!isValidLngLat(market.lon, market.lat)) return;

    prevMarketIdRef.current = market.location_id;

    mapRef.current.flyTo({
      center: [market.lon, market.lat],
      zoom: 13,
      duration: 1000,
    });

    // Update store marker
    if (storeMarkerRef.current) {
      storeMarkerRef.current.remove();
    }

    const storeEl = document.createElement("div");
    storeEl.className = "store-marker-pin";
    storeEl.innerHTML = "<span>D</span>";
    storeEl.style.cursor = "pointer";
    storeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      onStoreClick?.();
    });

    storeMarkerRef.current = new maplibregl.Marker({ element: storeEl })
      .setLngLat([market.lon, market.lat])
      .addTo(mapRef.current);
  }, [market]);

  // Update driver markers
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    // Track which drivers are still active
    const activeDriverIds = new Set<string>();

    for (const driver of drivers) {
      if (!driver.latest_ping) continue;
      const { loc_lon, loc_lat } = driver.latest_ping;
      if (!isValidLngLat(loc_lon, loc_lat)) continue;

      // Skip if the order has been delivered (backend sync lag safety net)
      const order = orders.find((o) => o.order_id === driver.order_id);
      if (order && getOrderStage(order) === "Delivered") continue;

      activeDriverIds.add(driver.order_id);
      const existing = markersRef.current.get(driver.order_id);
      const color = driverColor(driver.latest_ping.progress_pct);

      if (existing) {
        // Update position and color as progress changes
        existing.setLngLat([loc_lon, loc_lat]);
        const dot = existing.getElement().querySelector(".driver-marker-dot") as HTMLElement | null;
        if (dot) dot.style.background = color;
      } else {
        // Create new marker
        const el = document.createElement("div");
        el.className = "driver-marker-dot";
        el.style.background = color;
        el.title = `Order ${driver.order_id.slice(0, 6)}`;

        const label = document.createElement("div");
        label.className = "driver-marker-label";
        label.textContent = driver.order_id.slice(0, 6);

        const container = document.createElement("div");
        container.className = "driver-marker-container";
        container.appendChild(el);
        container.appendChild(label);

        container.addEventListener("click", (e) => {
          e.stopPropagation();
          onDriverClick(driver.order_id);
        });

        const marker = new maplibregl.Marker({ element: container })
          .setLngLat([loc_lon, loc_lat])
          .addTo(map);

        markersRef.current.set(driver.order_id, marker);
      }
    }

    // Remove markers for drivers no longer active
    for (const [id, marker] of markersRef.current.entries()) {
      if (!activeDriverIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [drivers, onDriverClick]);

  // Apply stage filter: show/hide driver markers based on selected stage
  useEffect(() => {
    for (const [id, marker] of markersRef.current.entries()) {
      const el = marker.getElement();
      if (!stageFilter) {
        el.style.display = "";
      } else {
        const driver = drivers.find((d) => d.order_id === id);
        // Drivers are always "In Transit" — hide them if a different stage is selected
        const driverStage = "In Transit";
        el.style.display = stageFilter === driverStage ? "" : "none";
      }
    }

    for (const [id, marker] of customerMarkersRef.current.entries()) {
      const el = marker.getElement();
      if (!stageFilter) {
        el.style.display = "";
      } else {
        const order = orders.find((o) => o.order_id === id);
        const orderStage = order ? getOrderStage(order) : "New";
        el.style.display = stageFilter === orderStage ? "" : "none";
      }
    }
  }, [stageFilter, drivers, orders]);

  // Green delivered pins — show customer drop locations for recently-delivered orders.
  // Count matches the "Delivered" pipeline stage badge.
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    const deliveredIds = new Set<string>();

    for (const order of orders) {
      if (getOrderStage(order) !== "Delivered") continue;
      if (!order.order_body) continue;
      const { customer_lon, customer_lat } = order.order_body;
      if (!isValidLngLat(customer_lon, customer_lat)) continue;
      deliveredIds.add(order.order_id);

      if (!customerMarkersRef.current.has(order.order_id)) {
        const el = document.createElement("div");
        el.className = "delivered-pin";

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([customer_lon, customer_lat])
          .addTo(map);

        customerMarkersRef.current.set(order.order_id, marker);
      }
    }

    // Remove pins for orders that aged out of the 60-min window
    for (const [id, marker] of customerMarkersRef.current.entries()) {
      if (!deliveredIds.has(id)) {
        marker.remove();
        customerMarkersRef.current.delete(id);
      }
    }
  }, [orders]);

  // Follow selected driver
  useEffect(() => {
    if (!mapRef.current || !isFollowingDriver || !selectedOrderId) return;

    const driver = drivers.find((d) => d.order_id === selectedOrderId);
    if (driver?.latest_ping && isValidLngLat(driver.latest_ping.loc_lon, driver.latest_ping.loc_lat)) {
      mapRef.current.easeTo({
        center: [driver.latest_ping.loc_lon, driver.latest_ping.loc_lat],
        duration: 500,
      });
    }
  }, [drivers, isFollowingDriver, selectedOrderId]);

  // Highlight selected driver
  useEffect(() => {
    for (const [id, marker] of markersRef.current.entries()) {
      const el = marker.getElement();
      if (id === selectedOrderId) {
        el.classList.add("driver-selected");
      } else {
        el.classList.remove("driver-selected");
      }
    }
  }, [selectedOrderId]);

  return (
    <div className="map-view-container">
      <div ref={mapContainerRef} className="map-canvas" aria-label={`Delivery operations map for ${market?.name || "loading"}`} />
      <div className="map-info-overlay">
        <span className="map-badge">
          <span className="pulse-dot-sm" /> Updated {updatedLabel}
        </span>
        {market && (
          <span className="map-badge">
            {market.name} — {market.lat.toFixed(4)}, {market.lon.toFixed(4)}
          </span>
        )}
      </div>
      <div className="map-legend">
        <div className="map-legend-item">
          <span className="legend-store-pin">D</span>
          <span>Store</span>
        </div>
        <div className="map-legend-item">
          <span className="legend-driver-dot legend-driver-heading" />
          <span>Heading out</span>
        </div>
        <div className="map-legend-item">
          <span className="legend-driver-dot legend-driver-close" />
          <span>Almost there</span>
        </div>
        <div className="map-legend-item">
          <span className="legend-delivered-pin" />
          <span>Delivered</span>
        </div>
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .map-view-container {
    flex: 1;
    position: relative;
    min-height: 0;
  }

  .map-canvas {
    width: 100%;
    height: 100%;
  }

  .store-marker-pin {
    width: 32px;
    height: 32px;
    background: ${STORE_COLOR};
    border: 2px solid #FFFFFF;
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(227, 24, 55, 0.5);
    cursor: pointer;
  }

  .store-marker-pin span {
    transform: rotate(45deg);
    font-size: 12px;
    font-weight: 700;
    color: white;
  }

  .driver-marker-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
  }

  .driver-marker-dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid #FFFFFF;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4);
    transition: transform 0.2s;
  }

  .driver-marker-container:hover .driver-marker-dot {
    transform: scale(1.2);
  }

  .driver-selected .driver-marker-dot {
    transform: scale(1.3);
    box-shadow: 0 0 12px rgba(227, 24, 55, 0.6);
  }

  .driver-marker-label {
    margin-top: 2px;
    font-size: 9px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 1px 4px;
    border-radius: 3px;
    white-space: nowrap;
    font-family: var(--font-family);
  }

  .delivered-pin {
    width: 14px;
    height: 14px;
    background: ${DRIVER_COLOR_DELIVERED};
    border: 2px solid #FFFFFF;
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    box-shadow: 0 1px 4px rgba(76, 175, 80, 0.5);
  }

  .map-info-overlay {
    position: absolute;
    bottom: 12px;
    left: 12px;
    display: flex;
    gap: 8px;
    z-index: 10;
  }

  .map-badge {
    background: rgba(0, 0, 0, 0.7);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 10px;
    color: var(--text-secondary);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .pulse-dot-sm {
    width: 6px;
    height: 6px;
    background: var(--success);
    border-radius: 50%;
    animation: pulse 2s infinite;
    display: inline-block;
  }

  .map-legend {
    position: absolute;
    top: 12px;
    left: 12px;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 10;
  }

  .map-legend-item {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .legend-store-pin {
    width: 18px;
    height: 18px;
    background: ${STORE_COLOR};
    border: 2px solid #fff;
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 7px;
    font-weight: 700;
    color: white;
    flex-shrink: 0;
  }

  .legend-driver-dot {
    width: 14px;
    height: 14px;
    border: 2px solid #fff;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .legend-driver-heading {
    background: ${DRIVER_COLOR_TRANSIT};
  }

  .legend-driver-close {
    background: ${DRIVER_COLOR_CLOSE};
  }

  .legend-delivered-pin {
    width: 14px;
    height: 14px;
    background: ${DRIVER_COLOR_DELIVERED};
    border: 2px solid #fff;
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    flex-shrink: 0;
    box-shadow: 0 1px 4px rgba(76, 175, 80, 0.5);
  }
`;
document.head.appendChild(style);
