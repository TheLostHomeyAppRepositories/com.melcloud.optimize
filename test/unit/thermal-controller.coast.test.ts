import { ThermalController } from '../../src/services/thermal-controller';
import { CopNormalizer } from '../../src/services/cop-normalizer';
import { PricePoint } from '../../src/types';

/**
 * Coasting through expensive hours, pinned on the live case that motivated the change:
 * 2026-10-14 07:00, room 21.5 °C, target 22 °C, comfort band 21-23 °C, price 2.33 SEK/kWh.
 * The old rule required `room > target - 0.5` (21.5 > 21.5 is false) and a top-20 % price, so
 * the pump heated flat out through the morning peak.
 */

const HOUR_MS = 60 * 60 * 1000;
const BAND = { minTemp: 21, maxTemp: 23 };
const COP = { heating: 2.7, hotWater: 2.4, outdoor: 11 };

const makeLogger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }) as any;

function series(reference: number, current: number, rest: number[]): PricePoint[] {
  return [current, ...rest].map((price, idx) => ({
    time: new Date(reference + idx * HOUR_MS).toISOString(),
    price
  }));
}

/** Current hour at exactly the 75th percentile of the next 24 h: expensive, but not top 20 %. */
function morningPeak(reference: number): PricePoint[] {
  return series(reference, 2.33, [
    ...new Array(11).fill(1.0),
    ...new Array(6).fill(0.2),
    ...new Array(6).fill(3.5)
  ]);
}

function strategyFor(
  roomC: number,
  targetC: number,
  prices: PricePoint[],
  reference: number,
  band = BAND,
  roomTargetMode?: boolean,
  curveGateOffsetC?: number
) {
  const controller = new ThermalController(makeLogger(), undefined, undefined, new CopNormalizer());
  if (curveGateOffsetC !== undefined) {
    controller.setCurveGateOffset(curveGateOffsetC);
  }
  return controller.calculateThermalMassStrategy(
    roomC,
    targetC,
    prices[0].price,
    prices,
    COP,
    {} as any,
    0.25,
    band,
    reference,
    undefined,
    'EXPENSIVE',
    undefined,
    roomTargetMode
  );
}

describe('ThermalController coasting', () => {
  const reference = Date.now();

  it('coasts in the morning-peak case and puts the setpoint below the room', () => {
    const strategy = strategyFor(21.5, 22, morningPeak(reference), reference);

    expect(strategy.action).toBe('coast');
    // Below the room so the room-sensor gate actually stops heating...
    expect(strategy.targetTemp).toBeLessThan(21.5);
    // ...but never below the comfort minimum.
    expect(strategy.targetTemp).toBeGreaterThanOrEqual(BAND.minTemp);
  });

  it('does not coast when the room is already at the comfort minimum', () => {
    const strategy = strategyFor(21, 22, morningPeak(reference), reference);

    expect(strategy.action).not.toBe('coast');
    expect(strategy.targetTemp).toBeGreaterThanOrEqual(BAND.minTemp);
  });

  it('never coasts below a higher comfort minimum', () => {
    const strategy = strategyFor(22.5, 23, morningPeak(reference), reference, { minTemp: 22, maxTemp: 24 });

    expect(strategy.action).toBe('coast');
    expect(strategy.targetTemp).toBe(22);
  });

  it('does not coast at an ordinary price', () => {
    // Current hour in the middle of the day's range.
    const prices = series(reference, 1.0, [
      ...new Array(11).fill(0.5),
      ...new Array(12).fill(2.0)
    ]);
    const strategy = strategyFor(21.5, 22, prices, reference);

    expect(strategy.action).not.toBe('coast');
  });

  describe('Curve mode (setpoint is the unit room thermostat)', () => {
    // Live 2026-11-09: room 21.5, the coast target was 21.0 (0.5 below the room) and the pump ran
    // through the whole 8-9.4 SEK/kWh peak. The unit stops only about 1 °C above the setpoint.
    const WIDE_BAND = { minTemp: 19, maxTemp: 24 };

    it('puts the coasting target the default 1 °C stop margin below the room', () => {
      // Room 1 °C under the target, so the room offset (not the coasting reduction) decides.
      const strategy = strategyFor(21, 22, morningPeak(reference), reference, WIDE_BAND, false);

      expect(strategy.action).toBe('coast');
      expect(strategy.targetTemp).toBeLessThanOrEqual(20);
      expect(strategy.targetTemp).toBeGreaterThanOrEqual(WIDE_BAND.minTemp);
    });

    it('follows the user stop margin but never goes below the comfort minimum', () => {
      const strategy = strategyFor(21, 22, morningPeak(reference), reference, WIDE_BAND, false, 2.0);

      expect(strategy.action).toBe('coast');
      expect(strategy.targetTemp).toBe(WIDE_BAND.minTemp);
    });

    it('Room mode keeps the 0.5 °C quantisation offset', () => {
      const curveTarget = strategyFor(21, 22, morningPeak(reference), reference, WIDE_BAND, false, 1.0).targetTemp;
      const roomTarget = strategyFor(21, 22, morningPeak(reference), reference, WIDE_BAND, true, 1.0).targetTemp;

      expect(roomTarget).toBeGreaterThan(curveTarget);
      expect(roomTarget).toBeLessThan(21);
    });
  });
});
