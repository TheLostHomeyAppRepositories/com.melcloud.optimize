import { describe, expect, test } from '@jest/globals';
import { estimateHourlyDraw, normaliseDrawPattern } from '../../src/util/dhw-draw';

const BASE = Date.parse('2026-08-01T00:00:00.000Z');

function sample(minutesFromBase: number, tankTemperature: number, isHeating = false) {
  const ts = BASE + minutesFromBase * 60000;
  return {
    timestamp: new Date(ts).toISOString(),
    tankTemperature,
    isHeating,
    hourOfDay: new Date(ts).getUTCHours()
  };
}

describe('estimateHourlyDraw', () => {
  test('attributes a temperature drop while idle to that hour', () => {
    // 07:00-07:10, tank falls 6C with the pump idle: a shower.
    const samples = [sample(420, 50), sample(425, 47), sample(430, 44)];

    const { hourlyDraw, usableIntervals } = estimateHourlyDraw(samples);

    expect(usableIntervals).toBe(2);
    expect(hourlyDraw[7]).toBeGreaterThan(5);
    expect(hourlyDraw[3]).toBe(0);
  });

  // The whole point of the change: reheat is caused by the controller, not the household.
  test('ignores intervals where the pump was heating', () => {
    const samples = [sample(120, 44, true), sample(125, 48, true), sample(130, 50, true)];

    const { hourlyDraw, usableIntervals } = estimateHourlyDraw(samples);

    expect(usableIntervals).toBe(0);
    expect(hourlyDraw.every(v => v === 0)).toBe(true);
  });

  test('a rising tank while idle contributes no draw', () => {
    const samples = [sample(420, 44), sample(425, 46)];

    const { hourlyDraw } = estimateHourlyDraw(samples);

    expect(hourlyDraw[7]).toBe(0);
  });

  test('ordinary standing loss is not counted as draw', () => {
    // 0.4C/h over 30 minutes is 0.2C - exactly the allowance, so nothing should be attributed.
    const samples = [sample(180, 50), sample(210, 49.8)];

    const { hourlyDraw, usableIntervals } = estimateHourlyDraw(samples, {
      standingLossCPerHour: 0.4
    });

    expect(usableIntervals).toBe(1);
    expect(hourlyDraw[3]).toBe(0);
  });

  test('skips gaps too long to attribute to one hour', () => {
    const samples = [sample(0, 50), sample(200, 40)];

    const { usableIntervals } = estimateHourlyDraw(samples, { maxIntervalMinutes: 30 });

    expect(usableIntervals).toBe(0);
  });

  test('applies recency weighting when supplied', () => {
    const samples = [sample(420, 50), sample(425, 45)];

    const unweighted = estimateHourlyDraw(samples);
    const weighted = estimateHourlyDraw(samples, { weightFn: () => 0.5 });

    expect(weighted.hourlyDraw[7]).toBeCloseTo(unweighted.hourlyDraw[7] * 0.5, 6);
  });

  test('reports how many hours of the day have been covered', () => {
    const samples = [sample(420, 50), sample(425, 48), sample(480, 47), sample(485, 45)];

    const { hoursCovered } = estimateHourlyDraw(samples);

    expect(hoursCovered).toBe(2);
  });

  test('handles unordered input and degenerate series', () => {
    const unordered = [sample(425, 45), sample(420, 50)];
    expect(estimateHourlyDraw(unordered).hourlyDraw[7]).toBeGreaterThan(0);

    expect(estimateHourlyDraw([]).usableIntervals).toBe(0);
    expect(estimateHourlyDraw([sample(0, 50)]).usableIntervals).toBe(0);
  });
});

describe('normaliseDrawPattern', () => {
  test('scales the profile to a mean of 1', () => {
    const pattern = new Array(24).fill(0);
    pattern[7] = 10;
    pattern[20] = 14;

    const normalised = normaliseDrawPattern(pattern);
    const mean = normalised.reduce((s, v) => s + v, 0) / 24;

    expect(mean).toBeCloseTo(1, 6);
    expect(normalised[20]).toBeGreaterThan(normalised[7]);
    expect(normalised[3]).toBe(0);
  });

  test('an empty profile stays empty rather than becoming flat demand', () => {
    expect(normaliseDrawPattern(new Array(24).fill(0)).every(v => v === 0)).toBe(true);
  });
});
