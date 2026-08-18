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
  test('ignores gentle changes while the pump was heating', () => {
    const samples = [sample(120, 44, true), sample(125, 48, true), sample(130, 50, true)];

    const { hourlyDraw, usableIntervals } = estimateHourlyDraw(samples);

    expect(usableIntervals).toBe(0);
    expect(hourlyDraw.every(v => v === 0)).toBe(true);
  });

  // A real draw triggers reheat, so excluding every heating interval discarded the strongest
  // evidence available. A fall this fast cannot be standing loss whatever the pump is doing.
  test('counts a rapid fall even while the pump is reheating', () => {
    // 4 C in 5 minutes = 48 C/h, far beyond any standing loss.
    const samples = [sample(420, 50, true), sample(425, 46, true)];

    const { hourlyDraw, rapidDrawIntervals } = estimateHourlyDraw(samples);

    expect(rapidDrawIntervals).toBe(1);
    expect(hourlyDraw[7]).toBeCloseTo(4, 3);
  });

  test('a gentle idle fall is still treated as standing loss, not draw', () => {
    const samples = [sample(180, 50), sample(185, 49.95)];

    const { rapidDrawIntervals } = estimateHourlyDraw(samples);

    expect(rapidDrawIntervals).toBe(0);
  });

  // The failure seen live: a fixed 0.4 C/h allowance under-estimated this tank's real standing
  // loss, so ordinary overnight cooling was attributed as night-time "usage".
  test('calibrates the standing-loss baseline from the tank itself', () => {
    // 40 idle intervals all cooling at ~1.2 C/h - well above the 0.4 default.
    const samples = [];
    let temp = 55;
    for (let i = 0; i <= 40; i++) {
      samples.push(sample(120 + i * 5, temp));
      temp -= 0.1; // 0.1 C per 5 min = 1.2 C/h
    }

    const { standingLossCPerHourUsed, hourlyDraw } = estimateHourlyDraw(samples);

    expect(standingLossCPerHourUsed).toBeGreaterThan(1.0);
    // With the baseline measured rather than assumed, steady cooling yields no phantom draw.
    const total = hourlyDraw.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(0.5);
  });

  test('falls back to the supplied default when there is too little idle data to calibrate', () => {
    const samples = [sample(420, 50), sample(425, 49.9)];

    const { standingLossCPerHourUsed } = estimateHourlyDraw(samples, { standingLossCPerHour: 0.4 });

    expect(standingLossCPerHourUsed).toBe(0.4);
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
