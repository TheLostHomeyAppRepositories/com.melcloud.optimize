import { describe, expect, test } from '@jest/globals';
import { applySetpointConstraints } from '../../src/util/setpoint-constraints';

describe('applySetpointConstraints', () => {
  const baseInput = {
    currentTargetC: 21,
    minC: 18,
    maxC: 23,
    stepC: 0.5,
    deadbandC: 0.4,
    minChangeMinutes: 30,
    lastChangeMs: null as number | null
  };

  test('clamps to bounds when above maximum', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 23.2
    });
    expect(result.constrainedC).toBe(23);
    expect(result.clampApplied).toBe(true);
    expect(result.changed).toBe(true);
  });

  test('rounds to discrete step size', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 21.73
    });
    expect(result.constrainedC).toBe(21.5);
    expect(result.stepApplied).toBe(true);
  });

  test('deadband suppresses small adjustments', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 21.2
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('below deadband');
  });

  test('lockout prevents change when dwell not met', () => {
    const now = Date.now();
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 22,
      lastChangeMs: now - 5 * 60 * 1000,
      nowMs: now
    });
    expect(result.lockoutActive).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.reason).toContain('lockout');
  });
});

/**
 * Issue #2: Deadband + Step Rounding Stalemate
 * 
 * Bug: Deadband is checked AFTER rounding, causing permanent stalemate
 * when the rounded delta falls below the deadband threshold.
 * 
 * Example:
 * - Proposed: 20.8°C, Current: 21.2°C, Step: 0.5°C, Deadband: 0.3°C
 * - Raw delta: -0.4°C (exceeds deadband ✓)
 * - After rounding: 21.0°C, delta: -0.2°C (below deadband ✗)
 * - Result: NO CHANGE (stalemate)
 */
describe('Issue #2: Deadband + Step Rounding Interaction', () => {
  const baseInput = {
    minC: 18,
    maxC: 23,
    stepC: 0.5,
    deadbandC: 0.3,
    minChangeMinutes: 30,
    lastChangeMs: Date.now() - 60 * 60 * 1000 // 1h ago, no lockout
  };

  test('should apply change when raw delta > deadband (core bug reproduction)', () => {
    // This is the EXACT scenario that creates the stalemate
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 20.8,
      currentTargetC: 21.2
    });

    // Raw delta = -0.4°C > 0.3°C deadband ✓
    // After rounding: 21.0°C, final delta = -0.2°C
    // Should STILL apply because raw delta exceeded deadband
    expect(result.changed).toBe(true);
    expect(result.constrainedC).toBe(21.0);
    expect(Math.abs(result.deltaC)).toBeCloseTo(0.2, 1);
  });

  test('should apply change in opposite direction (increasing)', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 21.3,
      currentTargetC: 20.8
    });

    // Raw delta = +0.5°C > 0.3°C deadband
    expect(result.changed).toBe(true);
    expect(result.constrainedC).toBe(21.5);
  });

  test('should reject when raw delta < deadband', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 21.1,
      currentTargetC: 21.2
    });

    // Raw delta = -0.1°C < 0.3°C deadband
    expect(result.changed).toBe(false);
    expect(result.constrainedC).toBe(21.2); // Stays at current
  });

  test('should handle exact step boundary', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 21.0,
      currentTargetC: 21.5
    });

    // Raw delta = -0.5°C > 0.3°C deadband
    expect(result.changed).toBe(true);
    expect(result.constrainedC).toBe(21.0);
  });

  test('should work with tank-like parameters (1°C step, 0.5°C deadband)', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 44.6,
      currentTargetC: 45.5,
      minC: 40,
      maxC: 50,
      stepC: 1.0,
      deadbandC: 0.5
    });

    // Raw delta = -0.9°C > 0.5°C deadband
    // After rounding: 45.0°C, final delta = -0.5°C
    expect(result.changed).toBe(true);
    expect(result.constrainedC).toBe(45.0);
  });

  test('should provide descriptive reason when deadband blocks change', () => {
    const result = applySetpointConstraints({
      ...baseInput,
      proposedC: 21.15,
      currentTargetC: 21.2
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toContain('deadband');
  });
});

describe('maxDeltaPerChangeC ramp limiting', () => {
  const rampInput = {
    currentTargetC: 20,
    minC: 16,
    maxC: 26,
    stepC: 0.5,
    deadbandC: 0.5,
    minChangeMinutes: 60,
    lastChangeMs: null as number | null,
    maxDeltaPerChangeC: 0.5
  };

  test('limits a large proposal to one ramp step', () => {
    const result = applySetpointConstraints({ ...rampInput, proposedC: 25 });

    expect(result.rampLimited).toBe(true);
    expect(result.constrainedC).toBe(20.5);
    expect(result.changed).toBe(true);
  });

  test('does not ramp-limit a proposal already within the cap', () => {
    const result = applySetpointConstraints({ ...rampInput, proposedC: 20.5 });

    expect(result.rampLimited).toBe(false);
    expect(result.constrainedC).toBe(20.5);
    expect(result.changed).toBe(true);
  });

  // Regression: ramp limiting runs BEFORE the deadband test, so a ramp cap smaller than
  // the deadband clipped every delta below the deadband and froze the setpoint forever.
  // deadband_c allows up to 2.0 while temp_step_max caps at 1.0, so this was reachable
  // from the settings UI (e.g. deadband 0.6 with the default 0.5 step).
  test('does not freeze when the deadband exceeds the ramp cap', () => {
    const result = applySetpointConstraints({
      ...rampInput,
      deadbandC: 0.6,
      maxDeltaPerChangeC: 0.5,
      proposedC: 23
    });

    expect(result.changed).toBe(true);
    expect(result.constrainedC).toBeGreaterThan(20);
  });

  test.each([
    [0.6, 0.5],
    [1.0, 0.5],
    [1.5, 1.0],
    [2.0, 0.5]
  ])('remains unfrozen for deadband %s with ramp cap %s', (deadbandC, maxDeltaPerChangeC) => {
    const result = applySetpointConstraints({
      ...rampInput,
      deadbandC,
      maxDeltaPerChangeC,
      proposedC: 26
    });

    expect(result.changed).toBe(true);
    expect(result.constrainedC).toBeGreaterThan(20);
  });

  test('still blocks changes genuinely below the deadband', () => {
    const result = applySetpointConstraints({
      ...rampInput,
      deadbandC: 0.6,
      maxDeltaPerChangeC: 0.5,
      proposedC: 20.2
    });

    expect(result.changed).toBe(false);
    expect(result.constrainedC).toBe(20);
  });
});
