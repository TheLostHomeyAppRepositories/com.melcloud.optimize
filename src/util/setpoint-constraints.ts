/** Helper for enforcing heat pump setpoint constraints in one place. */

export interface SetpointConstraintsInput {
  /** Proposed setpoint in °C before constraints. */
  proposedC: number;
  /** Current device target in °C (may be null when unavailable). */
  currentTargetC?: number | null;
  /** Lower bound allowed by device/user. */
  minC: number;
  /** Upper bound allowed by device/user. */
  maxC: number;
  /** Smallest discrete step the device accepts. */
  stepC: number;
  /** Minimum delta before a change should be sent. */
  deadbandC: number;
  /** Minimum minutes between consecutive changes. */
  minChangeMinutes: number;
  /** Timestamp (ms) of last successful change for this channel. */
  lastChangeMs?: number | null;
  /** Optional override for the current timestamp (ms). */
  nowMs?: number;
  /**
   * Optional maximum absolute delta allowed for a single change.
   * If omitted, the helper will not enforce a ramp limit beyond min/max.
   */
  maxDeltaPerChangeC?: number;
}

export interface SetpointConstraintsResult {
  /** Final setpoint after applying all constraints. */
  constrainedC: number;
  /** Raw delta vs currentTargetC after constraints. */
  deltaC: number;
  /** True when |delta| exceeds the deadband. */
  changed: boolean;
  /** True when the dwell timer blocks sending right now. */
  lockoutActive: boolean;
  /** True if min/max clamping was applied. */
  clampApplied: boolean;
  /** True if rounding to step adjusted the value. */
  stepApplied: boolean;
  /** True if the change was limited by maxDeltaPerChangeC. */
  rampLimited: boolean;
  /** Human-readable summary of why constraints were applied. */
  reason: string;
  /** Timestamp used for evaluating lockout. */
  evaluatedAtMs: number;
}

const EPS = 1e-6;

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) {
    return value;
  }
  const rounded = Math.round(value / step) * step;
  // Limit floating point artefacts (0.30000000000004)
  return Number(Number(rounded).toFixed(4));
}

export function applySetpointConstraints(input: SetpointConstraintsInput): SetpointConstraintsResult {
  const {
    proposedC,
    currentTargetC,
    minC,
    maxC,
    stepC,
    deadbandC,
    minChangeMinutes,
    lastChangeMs,
    nowMs,
    maxDeltaPerChangeC
  } = input;

  const evaluatedAtMs = typeof nowMs === 'number' ? nowMs : Date.now();
  const current = Number.isFinite(currentTargetC as number)
    ? (currentTargetC as number)
    : clamp(proposedC, minC, maxC);

  const notes: string[] = [];

  let constrained = proposedC;
  let clampApplied = false;
  if (constrained < minC) {
    constrained = minC;
    clampApplied = true;
    notes.push(`clamped to min ${minC}°C`);
  } else if (constrained > maxC) {
    constrained = maxC;
    clampApplied = true;
    notes.push(`clamped to max ${maxC}°C`);
  }

  let rampLimited = false;
  if (typeof maxDeltaPerChangeC === 'number' && maxDeltaPerChangeC > 0) {
    // Deadlock guard: ramp-limiting runs before the deadband test below, so a ramp cap
    // smaller than the deadband would clip every delta to a value that can never satisfy
    // the deadband — freezing the setpoint permanently. Never ramp below the deadband.
    const effectiveMaxDelta = Math.max(maxDeltaPerChangeC, Math.max(deadbandC, 0));
    if (effectiveMaxDelta > maxDeltaPerChangeC + EPS) {
      notes.push(`ramp raised from ${maxDeltaPerChangeC}°C to deadband ${deadbandC}°C to avoid freeze`);
    }
    const delta = constrained - current;
    const limitedDelta = Math.max(-effectiveMaxDelta, Math.min(effectiveMaxDelta, delta));
    if (Math.abs(limitedDelta - delta) > EPS) {
      rampLimited = true;
      constrained = current + limitedDelta;
      notes.push(`limited to ±${effectiveMaxDelta}°C ramp`);
    }
  }

  // Issue #2 fix: Check deadband BEFORE rounding to avoid stalemate
  // where raw delta exceeds threshold but rounded delta doesn't
  const rawDeltaC = constrained - current;
  const changedBeforeRounding = Math.abs(rawDeltaC) >= Math.max(deadbandC, 0);
  
  if (!changedBeforeRounding) {
    // Reject early if raw delta is below deadband - don't bother rounding
    notes.push(`raw delta ${rawDeltaC.toFixed(2)}°C below deadband ${deadbandC}°C`);
    const reason = notes.length > 0 ? notes.join(', ') : 'within constraints';
    return {
      constrainedC: current,
      deltaC: 0,
      changed: false,
      lockoutActive: false,
      clampApplied,
      stepApplied: false,
      rampLimited,
      reason,
      evaluatedAtMs
    };
  }

  const stepped = roundToStep(constrained, stepC);
  const stepApplied = Math.abs(stepped - constrained) > EPS;
  if (stepApplied) {
    notes.push(`rounded to ${stepC}°C step`);
  }

  const deltaC = stepped - current;
  // Changed flag is already determined above (before rounding)
  const changed = changedBeforeRounding;

  let lockoutActive = false;
  if (changed && typeof lastChangeMs === 'number' && lastChangeMs > 0 && minChangeMinutes > 0) {
    const sinceMinutes = (evaluatedAtMs - lastChangeMs) / 60000;
    lockoutActive = sinceMinutes < minChangeMinutes;
    if (lockoutActive) {
      const remaining = Math.max(0, minChangeMinutes - sinceMinutes);
      notes.push(`lockout ${remaining.toFixed(1)}m remaining`);
    }
  }

  if (!changed) {
    notes.push(`delta ${deltaC.toFixed(2)}°C below deadband ${deadbandC}°C`);
  }

  const reason = notes.length > 0 ? notes.join(', ') : 'within constraints';

  return {
    constrainedC: stepped,
    deltaC,
    changed,
    lockoutActive,
    clampApplied,
    stepApplied,
    rampLimited,
    reason,
    evaluatedAtMs
  };
}
