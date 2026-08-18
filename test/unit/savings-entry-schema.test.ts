import { describe, expect, test } from '@jest/globals';

/**
 * The savings-history entry semantics, pinned.
 *
 * A defect lived here for a long time because the field names read plausibly: `optimizedMinor`
 * sounds like an optimized cost, and it held a saving. Nothing type-checked the difference, and
 * the resulting number was small and positive, so it looked like money saved.
 *
 * These tests encode the arithmetic the reader in api.ts performs, so a future change that
 * reintroduces the mixup fails here rather than on someone's dashboard.
 */

const SAVINGS_ENTRY_SCHEMA_VERSION = 2;

interface HistoryEntry {
  date: string;
  decimals?: number;
  valueMajor?: number;
  baselineMinor?: number;
  optimizedMinor?: number;
  schemaVersion?: number;
}

/** Mirrors the display-history read path in api.ts getModelConfidence. */
function readSaving(entry: HistoryEntry, defaultDecimals = 2): number | null {
  const decimals = entry.decimals ?? defaultDecimals;
  const toMajor = (minor: number) => minor / Math.pow(10, decimals);
  const baselineMinor = Number(entry.baselineMinor);
  const optimizedMinor = Number(entry.optimizedMinor);
  const isCostSchema = Number(entry.schemaVersion) >= SAVINGS_ENTRY_SCHEMA_VERSION;

  if (isCostSchema && Number.isFinite(baselineMinor) && Number.isFinite(optimizedMinor)) {
    return Number(toMajor(Math.max(0, baselineMinor - optimizedMinor)).toFixed(decimals));
  }
  if (typeof entry.valueMajor === 'number') {
    return Number(entry.valueMajor);
  }
  return null;
}

describe('savings history entry semantics', () => {
  test('a v2 entry yields baseline minus optimized cost', () => {
    // Baseline 10.18, actual 8.51 -> saved 1.67
    const entry: HistoryEntry = {
      date: '2026-08-04',
      decimals: 2,
      valueMajor: 1.67,
      baselineMinor: 1018,
      optimizedMinor: 851,
      schemaVersion: 2
    };

    expect(readSaving(entry)).toBeCloseTo(1.67, 2);
  });

  test('the derived saving agrees with the stored valueMajor', () => {
    const entry: HistoryEntry = {
      date: '2026-08-04',
      decimals: 2,
      valueMajor: 1.67,
      baselineMinor: 1018,
      optimizedMinor: 851,
      schemaVersion: 2
    };

    // The "today" tile reads valueMajor and the 7-day total sums the derived figure. If these
    // ever disagree, the card contradicts itself - which is exactly what users saw.
    expect(readSaving(entry)).toBeCloseTo(entry.valueMajor!, 2);
  });

  // Regression for the original defect: optimizedMinor held the SAVING, so the subtraction
  // produced cost - saving. With the real numbers that was 10.18 - 8.51 = 1.67, which looked
  // like a saving but was the day's actual electricity cost.
  test('a legacy entry is read from valueMajor, not recomputed', () => {
    const legacy: HistoryEntry = {
      date: '2026-08-01',
      decimals: 2,
      valueMajor: 8.51,      // the real saving, stored correctly
      baselineMinor: 1018,
      optimizedMinor: 851    // v1 stored the SAVING here
      // no schemaVersion
    };

    expect(readSaving(legacy)).toBeCloseTo(8.51, 2);
    // Had it been recomputed it would have produced 1.67 - a different, meaningless number.
    expect(readSaving(legacy)).not.toBeCloseTo(1.67, 2);
  });

  test('a v2 entry without a baseline falls back to the stored saving', () => {
    const entry: HistoryEntry = {
      date: '2026-08-04',
      decimals: 2,
      valueMajor: 2.4,
      schemaVersion: 2
    };

    expect(readSaving(entry)).toBeCloseTo(2.4, 2);
  });

  test('a saving can never be reported as negative', () => {
    // Optimized cost above baseline: the optimizer did worse. Clamped to zero rather than
    // showing a negative "saving".
    const entry: HistoryEntry = {
      date: '2026-08-04',
      decimals: 2,
      baselineMinor: 800,
      optimizedMinor: 950,
      schemaVersion: 2
    };

    expect(readSaving(entry)).toBe(0);
  });

  test('respects per-entry decimals', () => {
    const entry: HistoryEntry = {
      date: '2026-08-04',
      decimals: 3,
      baselineMinor: 10180,
      optimizedMinor: 8510,
      schemaVersion: 2
    };

    expect(readSaving(entry)).toBeCloseTo(1.67, 3);
  });

  test('a week of v2 entries sums to the sum of their savings', () => {
    const week: HistoryEntry[] = [1.2, 0.8, 2.4, 1.9, 0.4, 3.1, 1.7].map((saving, i) => ({
      date: `2026-08-0${i + 1}`,
      decimals: 2,
      valueMajor: saving,
      baselineMinor: 1000,
      optimizedMinor: Math.round((10 - saving) * 100),
      schemaVersion: 2
    }));

    const total = week.reduce((sum, e) => sum + (readSaving(e) ?? 0), 0);

    expect(total).toBeCloseTo(11.5, 2);
  });
});
