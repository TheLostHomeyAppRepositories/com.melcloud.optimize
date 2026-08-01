import { describe, expect, test } from '@jest/globals';
import { analysePriceSpread } from '../../src/util/price-spread';

const flatDay = [0.48, 0.49, 0.50, 0.485, 0.492, 0.501].map(price => ({ price }));

// Real spot prices observed on the target device, 2026-08-01.
const observedDay = [0.234375, 0.31, 0.42, 0.4351, 0.48, 0.512225].map(price => ({ price }));

describe('analysePriceSpread', () => {
  test('reports the spot spread and the delivered ratio separately', () => {
    const result = analysePriceSpread(observedDay, { fixedAdderPerKwh: 0.85 });

    expect(result.minPrice).toBeCloseTo(0.2344, 4);
    expect(result.maxPrice).toBeCloseTo(0.5122, 4);
    expect(result.absoluteSpread).toBeCloseTo(0.2779, 4);
    // (0.5122 + 0.85) / (0.2344 + 0.85) -- far below the 2.19x the raw spot ratio suggests.
    expect(result.deliveredRatio).toBeCloseTo(1.256, 2);
  });

  test('the observed day is worth retiming and worth spending extra energy on', () => {
    const result = analysePriceSpread(observedDay, { fixedAdderPerKwh: 0.85 });

    expect(result.worthRetiming).toBe(true);
    expect(result.worthSpendingExtraEnergy).toBe(true);
  });

  test('a flat day is not worth acting on despite having a cheapest hour', () => {
    const result = analysePriceSpread(flatDay, { fixedAdderPerKwh: 0.85 });

    expect(result.absoluteSpread).toBeCloseTo(0.021, 3);
    expect(result.worthRetiming).toBe(false);
    expect(result.worthSpendingExtraEnergy).toBe(false);
  });

  // The adder is identical in every hour, so it cannot change the absolute spread -- only the
  // ratio. This is exactly why ranking on raw spot overstates what a spread is worth.
  test('the fixed adder compresses the ratio but leaves the absolute spread untouched', () => {
    const withoutAdder = analysePriceSpread(observedDay, { fixedAdderPerKwh: 0 });
    const withAdder = analysePriceSpread(observedDay, { fixedAdderPerKwh: 0.85 });

    expect(withAdder.absoluteSpread).toBeCloseTo(withoutAdder.absoluteSpread, 6);
    expect(withoutAdder.deliveredRatio).toBeCloseTo(2.185, 2);
    expect(withAdder.deliveredRatio).toBeLessThan(withoutAdder.deliveredRatio);
  });

  test('a spread can clear retiming but fail the extra-energy ratio test', () => {
    // 0.30 -> 0.40: a 0.10 absolute spread, but only 1.09x delivered.
    const prices = [0.30, 0.35, 0.40].map(price => ({ price }));
    const result = analysePriceSpread(prices, { fixedAdderPerKwh: 0.85, minDeliveredRatio: 1.2 });

    expect(result.worthRetiming).toBe(true);
    expect(result.worthSpendingExtraEnergy).toBe(false);
  });

  test('handles an empty series without dividing by zero', () => {
    const result = analysePriceSpread([]);

    expect(result.deliveredRatio).toBe(1);
    expect(result.worthRetiming).toBe(false);
    expect(result.worthSpendingExtraEnergy).toBe(false);
  });

  test('handles negative spot prices without producing a nonsense ratio', () => {
    const prices = [-0.10, 0.05, 0.20].map(price => ({ price }));
    const result = analysePriceSpread(prices, { fixedAdderPerKwh: 0 });

    expect(result.deliveredRatio).toBe(1);
    expect(result.worthRetiming).toBe(true);
    expect(result.worthSpendingExtraEnergy).toBe(false);
  });

  test('ignores non-finite entries rather than poisoning min/max', () => {
    const prices = [{ price: 0.2 }, { price: NaN }, { price: 0.6 }, { price: Infinity }] as { price: number }[];
    const result = analysePriceSpread(prices, { fixedAdderPerKwh: 0 });

    expect(result.minPrice).toBeCloseTo(0.2, 6);
    expect(result.maxPrice).toBeCloseTo(0.6, 6);
  });
});
