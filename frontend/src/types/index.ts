// =============================================================================
// Data model types for the Digital Twin application
// =============================================================================

/** Market (store location) metadata */
export interface Market {
  location_id: number;
  location_code: string;
  name: string;
  lat: number;
  lon: number;
  active_orders: number;
  drivers_out: number;
}

/** Aggregated KPIs for a market */
export interface MarketKpis {
  active_orders: number;
  drivers_out: number;
  avg_delivery_time: string | null; // "HH:MM:SS" or null if no deliveries today
  todays_revenue: number;
}

/** Order body parsed from JSON */
export interface OrderBody {
  customer_lat: number;
  customer_lon: number;
  address?: string;
  items: OrderItem[];
}

/** Individual order item */
export interface OrderItem {
  name: string;
  price: number;
  qty: number;
}

/** Route body parsed from JSON */
export interface RouteBody {
  route_points: [number, number][];
}

/** Latest driver ping parsed from JSON */
export interface LatestPing {
  progress_pct: number;
  loc_lat: number;
  loc_lon: number;
}

/** Order summary (from list endpoint) */
export interface Order {
  order_id: string;
  location_id: number;
  current_stage: string;
  created_at: string;
  delivered_at: string | null;
  order_body: OrderBody | null;
  latest_ping: LatestPing | null;
  order_total: number;
}

/** Full order detail (from detail endpoint) */
export interface OrderDetail extends Order {
  kitchen_started_at: string | null;
  kitchen_ready_at: string | null;
  kitchen_finished_at: string | null;
  driver_arrived_at: string | null;
  picked_up_at: string | null;
  route_body: RouteBody | null;
  events: OrderEvent[];
}

/** Active driver for map visualization */
export interface Driver {
  order_id: string;
  latest_ping: LatestPing | null;
  route_body: RouteBody | null;
  picked_up_at: string;
}

/** Raw event from the event stream */
export interface OrderEvent {
  event_id: string;
  order_id: string;
  event_type: string;
  body: Record<string, unknown> | null;
  ts: string;
  sequence: string;
}

/** Playback response */
export interface PlaybackResponse {
  events: OrderEvent[];
  total_count: number;
  truncated: boolean;
}

/** Application mode */
export type AppMode = "live" | "playback";

/** Playback speed options */
export type PlaybackSpeed = 1 | 2 | 5 | 10;

/** Pipeline stage groupings */
export type PipelineStage =
  | "New"
  | "Kitchen Prep"
  | "Ready"
  | "In Transit"
  | "Delivered";

/** Map event type to pipeline stage group */
export const STAGE_MAP: Record<string, PipelineStage> = {
  order_created: "New",
  gk_started: "Kitchen Prep",
  gk_ready: "Kitchen Prep",
  gk_finished: "Kitchen Prep",
  driver_arrived: "Ready",
  driver_picked_up: "In Transit",
  driver_ping: "In Transit",
  delivered: "Delivered",
};

/** Stage colors from the domain playbook */
export const STAGE_COLORS: Record<PipelineStage, string> = {
  New: "#FFB800",
  "Kitchen Prep": "#FF6B35",
  Ready: "#006491",
  "In Transit": "#E31837",
  Delivered: "#4CAF50",
};
