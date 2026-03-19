import type { PipelineStage } from "../types";

export const STAGE_SLA_MINUTES: Partial<Record<PipelineStage, { yellow: number; red: number }>> = {
  "New":          { yellow: 3,  red: 8  },
  "Kitchen Prep": { yellow: 12, red: 20 },
  "Ready":        { yellow: 5,  red: 10 },
  "In Transit":   { yellow: 25, red: 40 },
} as const;

export type SlaStatus = "green" | "yellow" | "red";

export function getSlaStatus(stage: PipelineStage, minutesInStage: number): SlaStatus {
  const thresholds = STAGE_SLA_MINUTES[stage];
  if (!thresholds) return "green";
  if (minutesInStage >= thresholds.red) return "red";
  if (minutesInStage >= thresholds.yellow) return "yellow";
  return "green";
}

export function getMinutesInStage(
  stage: PipelineStage,
  order: {
    created_at: string;
    kitchen_started_at?: string | null;
    driver_arrived_at?: string | null;
    picked_up_at?: string | null;
  }
): number {
  const now = Date.now();
  let stageStart: Date | null = null;

  switch (stage) {
    case "New":
      stageStart = parseTimestamp(order.created_at);
      break;
    case "Kitchen Prep":
      stageStart = order.kitchen_started_at ? parseTimestamp(order.kitchen_started_at) : parseTimestamp(order.created_at);
      break;
    case "Ready":
      stageStart = order.driver_arrived_at ? parseTimestamp(order.driver_arrived_at) : null;
      break;
    case "In Transit":
      stageStart = order.picked_up_at ? parseTimestamp(order.picked_up_at) : null;
      break;
    default:
      return 0;
  }

  if (!stageStart) return 0;
  return Math.floor((now - stageStart.getTime()) / 60000);
}

function parseTimestamp(ts: string): Date {
  // Handle "YYYY-MM-DD HH:MM:SS" format (no T separator)
  return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}
