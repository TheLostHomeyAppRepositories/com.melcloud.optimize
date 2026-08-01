/**
 * Estimate when hot water is actually *drawn*, from tank temperature dynamics.
 *
 * The obvious signal — the heat pump's own DHW energy production — measures reheat, not draw,
 * and reheat happens when the optimizer permits it rather than when someone runs a tap. That
 * makes it a feedback loop: the optimizer heats in the hours it chose, the learner records those
 * hours as "usage", and the scheduler then pre-heats for them. The learned peaks converge on the
 * optimizer's own footprint instead of the household's behaviour.
 *
 * Tank temperature falling while the pump is idle is the one signal that is caused by the
 * household and not by the controller. It is a proxy, not a measurement: it cannot separate a
 * shower from standing loss precisely, so a modest standing-loss allowance is subtracted and
 * what remains is treated as draw.
 */

export interface DrawSample {
  timestamp: string;
  tankTemperature: number;
  isHeating: boolean;
  hourOfDay: number;
}

export interface DrawEstimateOptions {
  /**
   * Assumed idle tank cooling in °C per hour. Subtracted from each idle interval so ordinary
   * standing loss is not mistaken for draw. Too high and real draws are erased; too low and
   * every hour looks equally "used".
   */
  standingLossCPerHour?: number;
  /**
   * Longest gap between samples still treated as a continuous interval. Longer gaps (restarts,
   * connectivity loss) cannot be attributed to a single hour and are skipped.
   */
  maxIntervalMinutes?: number;
  /** Optional recency weighting, keyed by the sample ending the interval. */
  weightFn?: (sample: DrawSample) => number;
}

export interface DrawEstimate {
  /** Relative draw per hour of day, unnormalised. */
  hourlyDraw: number[];
  /** Number of intervals that could be used, i.e. idle, contiguous and well-formed. */
  usableIntervals: number;
  /** Number of distinct hours of day with at least one usable interval. */
  hoursCovered: number;
}

/** Below this, a computed draw is floating-point residue rather than a real temperature change. */
const DRAW_EPSILON_C = 1e-6;

export const DEFAULT_STANDING_LOSS_C_PER_HOUR = 0.4;
export const DEFAULT_MAX_INTERVAL_MINUTES = 30;

export function estimateHourlyDraw(
  samples: DrawSample[],
  options: DrawEstimateOptions = {}
): DrawEstimate {
  const {
    standingLossCPerHour = DEFAULT_STANDING_LOSS_C_PER_HOUR,
    maxIntervalMinutes = DEFAULT_MAX_INTERVAL_MINUTES,
    weightFn
  } = options;

  const hourlyDraw = new Array(24).fill(0);
  const hourSeen = new Array(24).fill(false);
  let usableIntervals = 0;

  if (!Array.isArray(samples) || samples.length < 2) {
    return { hourlyDraw, usableIntervals: 0, hoursCovered: 0 };
  }

  const ordered = samples
    .filter(s => s && Number.isFinite(s.tankTemperature) && Number.isFinite(Date.parse(s.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];

    // Any reheat during the interval means the tank temperature reflects the pump, not the tap.
    if (prev.isHeating || curr.isHeating) {
      continue;
    }

    const intervalMinutes = (Date.parse(curr.timestamp) - Date.parse(prev.timestamp)) / 60000;
    if (!(intervalMinutes > 0) || intervalMinutes > maxIntervalMinutes) {
      continue;
    }

    usableIntervals++;

    const hour = curr.hourOfDay;
    if (hour >= 0 && hour < 24) {
      hourSeen[hour] = true;

      const drop = prev.tankTemperature - curr.tankTemperature;
      const expectedStandingLoss = (standingLossCPerHour * intervalMinutes) / 60;
      const rawDraw = drop - expectedStandingLoss;
      // Tank temperatures arrive at 0.5 °C resolution at best, so anything at floating-point
      // scale is arithmetic residue rather than a draw.
      const attributableDraw = rawDraw > DRAW_EPSILON_C ? rawDraw : 0;

      if (attributableDraw > 0) {
        const weight = weightFn ? weightFn(curr) : 1;
        hourlyDraw[hour] += attributableDraw * weight;
      }
    }
  }

  return {
    hourlyDraw,
    usableIntervals,
    hoursCovered: hourSeen.filter(Boolean).length
  };
}

/**
 * Normalise a draw profile so its mean is 1, matching the convention the scheduler expects.
 * Returns all zeros when there is no signal, which the caller should treat as "no pattern yet"
 * rather than "no demand".
 */
export function normaliseDrawPattern(hourlyDraw: number[]): number[] {
  const total = hourlyDraw.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) {
    return new Array(24).fill(0);
  }
  const mean = total / hourlyDraw.length;
  return hourlyDraw.map(v => v / mean);
}
