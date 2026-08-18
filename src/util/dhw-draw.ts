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
  /** Fall rate (°C/h) above which a drop is treated as an unambiguous draw. */
  rapidDrawCPerHour?: number;
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
  /** Standing-loss rate actually used, either calibrated from the data or the supplied default. */
  standingLossCPerHourUsed: number;
  /** Intervals attributed as an unambiguous rapid draw, including any mid-reheat. */
  rapidDrawIntervals: number;
}

/** Below this, a computed draw is floating-point residue rather than a real temperature change. */
const DRAW_EPSILON_C = 1e-6;

export const DEFAULT_STANDING_LOSS_C_PER_HOUR = 0.4;
export const DEFAULT_MAX_INTERVAL_MINUTES = 30;

/**
 * Fall rate above which a temperature drop is unambiguously a draw rather than standing loss.
 *
 * A well-insulated tank loses well under 1 °C/h standing. Anything falling faster than this is
 * water leaving the tank, so it is counted even when the pump has already started reheating —
 * which matters, because a real draw *triggers* reheat, and excluding all heating intervals
 * therefore filtered out precisely the events worth learning from.
 */
export const DEFAULT_RAPID_DRAW_C_PER_HOUR = 3.0;

/**
 * Percentile of observed idle fall rates used as the standing-loss baseline. A low percentile
 * approximates "cooling with nobody using hot water"; the excess above it is draw. Measuring
 * this beats assuming it, because tanks differ and a wrong fixed allowance turns ordinary
 * overnight cooling into phantom night-time "usage".
 */
export const STANDING_LOSS_PERCENTILE = 0.4;

export function estimateHourlyDraw(
  samples: DrawSample[],
  options: DrawEstimateOptions = {}
): DrawEstimate {
  const {
    standingLossCPerHour = DEFAULT_STANDING_LOSS_C_PER_HOUR,
    maxIntervalMinutes = DEFAULT_MAX_INTERVAL_MINUTES,
    rapidDrawCPerHour = DEFAULT_RAPID_DRAW_C_PER_HOUR,
    weightFn
  } = options;

  const hourlyDraw = new Array(24).fill(0);
  const hourSeen = new Array(24).fill(false);
  let usableIntervals = 0;

  if (!Array.isArray(samples) || samples.length < 2) {
    return {
      hourlyDraw,
      usableIntervals: 0,
      hoursCovered: 0,
      standingLossCPerHourUsed: standingLossCPerHour,
      rapidDrawIntervals: 0
    };
  }

  const ordered = samples
    .filter(s => s && Number.isFinite(s.tankTemperature) && Number.isFinite(Date.parse(s.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  interface Interval {
    hour: number;
    minutes: number;
    fallRate: number;
    idle: boolean;
    sample: DrawSample;
  }

  const intervals: Interval[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];

    const minutes = (Date.parse(curr.timestamp) - Date.parse(prev.timestamp)) / 60000;
    if (!(minutes > 0) || minutes > maxIntervalMinutes) {
      continue;
    }
    if (!(curr.hourOfDay >= 0 && curr.hourOfDay < 24)) {
      continue;
    }

    intervals.push({
      hour: curr.hourOfDay,
      minutes,
      fallRate: ((prev.tankTemperature - curr.tankTemperature) / minutes) * 60,
      idle: !prev.isHeating && !curr.isHeating,
      sample: curr
    });
  }

  // Calibrate the standing-loss baseline from the tank's own idle behaviour rather than trusting
  // the default. Only gentle falls are considered, so genuine draws do not inflate the baseline.
  const idleFallRates = intervals
    .filter(iv => iv.idle && iv.fallRate > 0 && iv.fallRate < rapidDrawCPerHour)
    .map(iv => iv.fallRate)
    .sort((a, b) => a - b);

  const standingLoss = idleFallRates.length >= 20
    ? idleFallRates[Math.min(idleFallRates.length - 1, Math.floor(idleFallRates.length * STANDING_LOSS_PERCENTILE))]
    : standingLossCPerHour;

  let rapidDrawIntervals = 0;

  for (const iv of intervals) {
    // A fall this fast is water leaving the tank. Count it even mid-reheat: the draw is what
    // caused the reheat, and skipping those intervals discards the strongest evidence there is.
    const isRapidDraw = iv.fallRate > rapidDrawCPerHour;

    if (!iv.idle && !isRapidDraw) {
      continue;
    }

    usableIntervals++;
    hourSeen[iv.hour] = true;

    const excessRate = isRapidDraw ? iv.fallRate : iv.fallRate - standingLoss;
    const attributableDraw = (excessRate * iv.minutes) / 60;

    if (attributableDraw > DRAW_EPSILON_C) {
      if (isRapidDraw) rapidDrawIntervals++;
      const weight = weightFn ? weightFn(iv.sample) : 1;
      hourlyDraw[iv.hour] += attributableDraw * weight;
    }
  }

  return {
    hourlyDraw,
    usableIntervals,
    hoursCovered: hourSeen.filter(Boolean).length,
    standingLossCPerHourUsed: standingLoss,
    rapidDrawIntervals
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
