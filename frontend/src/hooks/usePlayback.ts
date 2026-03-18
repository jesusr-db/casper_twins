import { useState, useRef, useCallback, useEffect } from "react";
import type {
  OrderEvent,
  PlaybackResponse,
  PlaybackSpeed,
  Order,
  Driver,
  LatestPing,
  RouteBody,
} from "../types";
import { STAGE_MAP } from "../types";

interface PlaybackState {
  events: OrderEvent[];
  currentTime: Date | null;
  timeWindow: { start: Date; end: Date } | null;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  eventsProcessed: number;
  totalEvents: number;
  truncated: boolean;
  /** Derived orders at current playback time */
  orders: Order[];
  /** Derived active drivers at current playback time */
  drivers: Driver[];
  /** Stage counts at current playback time */
  stageCounts: Record<string, number>;
}

interface PlaybackActions {
  loadEvents: (marketId: string, start: string, end: string) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  scrubTo: (time: Date) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  reset: () => void;
}

/**
 * usePlayback — Client-side event replay engine.
 *
 * Fetches historical events for a market/time window and replays them
 * using requestAnimationFrame. Derives order states, driver positions,
 * and stage counts at each point in time.
 */
export function usePlayback(): [PlaybackState, PlaybackActions] {
  const [state, setState] = useState<PlaybackState>({
    events: [],
    currentTime: null,
    timeWindow: null,
    isPlaying: false,
    speed: 1,
    eventsProcessed: 0,
    totalEvents: 0,
    truncated: false,
    orders: [],
    drivers: [],
    stageCounts: {},
  });

  const animFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const eventIndexRef = useRef<number>(0);
  const orderMapRef = useRef<Map<string, Order>>(new Map());

  /** Derive orders and drivers from the current order map */
  const deriveState = useCallback((orderMap: Map<string, Order>) => {
    const orders = Array.from(orderMap.values());
    const drivers: Driver[] = orders
      .filter(
        (o) =>
          (o.current_stage === "driver_picked_up" ||
            o.current_stage === "driver_ping") &&
          !o.delivered_at
      )
      .map((o) => ({
        order_id: o.order_id,
        latest_ping: o.latest_ping,
        route_body: null, // Simplified — route comes from event body
        picked_up_at: o.created_at, // Approximate
      }));

    const stageCounts: Record<string, number> = {};
    for (const order of orders) {
      const stage = STAGE_MAP[order.current_stage] || "New";
      stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    }

    return { orders, drivers, stageCounts };
  }, []);

  /** Process events up to a given timestamp */
  const processEventsUpTo = useCallback(
    (targetTime: Date) => {
      const events = state.events;
      const orderMap = orderMapRef.current;
      let idx = eventIndexRef.current;

      while (idx < events.length) {
        const eventTime = new Date(events[idx].ts.replace(" ", "T") + "Z");
        if (eventTime > targetTime) break;

        const event = events[idx];
        const existing = orderMap.get(event.order_id);

        if (event.event_type === "order_created") {
          const body = event.body as Record<string, unknown> | null;
          orderMap.set(event.order_id, {
            order_id: event.order_id,
            location_id: 0,
            current_stage: event.event_type,
            created_at: event.ts,
            delivered_at: null,
            order_body: body
              ? {
                  customer_lat: (body.customer_lat as number) || 0,
                  customer_lon: (body.customer_lon as number) || 0,
                  address: (body.address as string) || "",
                  items: (body.items as { name: string; price: number; qty: number }[]) || [],
                }
              : null,
            latest_ping: null,
            order_total: 0,
          });
        } else if (existing) {
          existing.current_stage = event.event_type;

          if (event.event_type === "delivered") {
            existing.delivered_at = event.ts;
          }

          if (
            event.event_type === "driver_ping" &&
            event.body
          ) {
            const body = event.body as Record<string, unknown>;
            existing.latest_ping = {
              progress_pct: (body.progress_pct as number) || 0,
              loc_lat: (body.loc_lat as number) || 0,
              loc_lon: (body.loc_lon as number) || 0,
            };
          }
        }

        idx++;
      }

      eventIndexRef.current = idx;
      return deriveState(orderMap);
    },
    [state.events, deriveState]
  );

  /** Animation frame loop */
  const animate = useCallback(
    (timestamp: number) => {
      if (!state.isPlaying || !state.currentTime || !state.timeWindow) return;

      const elapsed = timestamp - lastFrameTimeRef.current;
      lastFrameTimeRef.current = timestamp;

      // Advance playback time based on speed
      const advanceMs = elapsed * state.speed;
      const newTime = new Date(state.currentTime.getTime() + advanceMs);

      // Stop at end of window
      if (newTime >= state.timeWindow.end) {
        setState((prev) => ({ ...prev, isPlaying: false, currentTime: state.timeWindow!.end }));
        return;
      }

      const derived = processEventsUpTo(newTime);

      setState((prev) => ({
        ...prev,
        currentTime: newTime,
        eventsProcessed: eventIndexRef.current,
        ...derived,
      }));

      animFrameRef.current = requestAnimationFrame(animate);
    },
    [state.isPlaying, state.currentTime, state.timeWindow, state.speed, processEventsUpTo]
  );

  // Start/stop animation loop
  useEffect(() => {
    if (state.isPlaying) {
      lastFrameTimeRef.current = performance.now();
      animFrameRef.current = requestAnimationFrame(animate);
    } else if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [state.isPlaying, animate]);

  const actions: PlaybackActions = {
    loadEvents: async (marketId: string, start: string, end: string) => {
      const res = await fetch(
        `/api/playback/${marketId}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      );
      if (!res.ok) throw new Error(`Playback fetch failed: ${res.status}`);
      const data: PlaybackResponse = await res.json();

      const startDate = new Date(start.replace(" ", "T") + "Z");
      const endDate = new Date(end.replace(" ", "T") + "Z");

      // Reset replay state
      eventIndexRef.current = 0;
      orderMapRef.current = new Map();

      setState({
        events: data.events,
        currentTime: startDate,
        timeWindow: { start: startDate, end: endDate },
        isPlaying: false,
        speed: 1,
        eventsProcessed: 0,
        totalEvents: data.total_count,
        truncated: data.truncated,
        orders: [],
        drivers: [],
        stageCounts: {},
      });
    },

    play: () => setState((prev) => ({ ...prev, isPlaying: true })),
    pause: () => setState((prev) => ({ ...prev, isPlaying: false })),
    togglePlayPause: () =>
      setState((prev) => ({ ...prev, isPlaying: !prev.isPlaying })),

    scrubTo: (time: Date) => {
      // Reset and reprocess from beginning to target time
      eventIndexRef.current = 0;
      orderMapRef.current = new Map();

      setState((prev) => {
        if (!prev.timeWindow) return prev;
        const clampedTime = new Date(
          Math.max(prev.timeWindow.start.getTime(), Math.min(time.getTime(), prev.timeWindow.end.getTime()))
        );
        return { ...prev, currentTime: clampedTime, isPlaying: false };
      });

      // Process events up to scrub point on next render
    },

    setSpeed: (speed: PlaybackSpeed) =>
      setState((prev) => ({ ...prev, speed })),

    reset: () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      eventIndexRef.current = 0;
      orderMapRef.current = new Map();
      setState({
        events: [],
        currentTime: null,
        timeWindow: null,
        isPlaying: false,
        speed: 1,
        eventsProcessed: 0,
        totalEvents: 0,
        truncated: false,
        orders: [],
        drivers: [],
        stageCounts: {},
      });
    },
  };

  return [state, actions];
}
