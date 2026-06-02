import { HotWaterOptimizer } from '../../src/services/hot-water-optimizer';
import { PriceAnalyzer } from '../../src/services/price-analyzer';
import { OptimizationMetrics } from '../../src/types';

// Mock dependencies
jest.mock('../../src/services/price-analyzer');

describe('HotWaterOptimizer', () => {
  let hotWaterOptimizer: HotWaterOptimizer;
  let mockLogger: any;
  let mockPriceAnalyzer: jest.Mocked<PriceAnalyzer>;

  beforeEach(() => {
    mockLogger = { log: jest.fn(), info: jest.fn(), error: jest.fn() };
    mockPriceAnalyzer = new PriceAnalyzer(mockLogger) as jest.Mocked<PriceAnalyzer>;
    // Mock getCheapPercentile
    mockPriceAnalyzer.getCheapPercentile = jest.fn().mockReturnValue(0.25);

    hotWaterOptimizer = new HotWaterOptimizer(mockLogger, mockPriceAnalyzer);
  });

  test('optimizeHotWaterScheduling: excellent COP -> heat_now when cheap', async () => {
    const metrics: OptimizationMetrics = {
      realHotWaterCOP: 4.0,
      realHeatingCOP: 2.0,
      dailyEnergyConsumption: 10,
      heatingEfficiency: 0.5,
      hotWaterEfficiency: 0.9,
      seasonalMode: 'summer',
      optimizationFocus: 'hotwater'
    };

    const lastEnergyData = { TotalHotWaterConsumed: 70 };

    // create priceData with cheapest current price
    const prices = Array.from({ length: 24 }, (_, i) => ({ time: `${i}:00`, price: i === 0 ? 1 : 100 }));
    const priceData = { current: { time: '0:00', price: 1 }, prices };

    const res = await hotWaterOptimizer.optimizeHotWaterScheduling(1, priceData, metrics, lastEnergyData);

    expect(res).toBeDefined();
    expect(['heat_now', 'delay', 'maintain']).toContain(res.action);
    expect(res.action).toBe('heat_now');
  });

  test('optimizeHotWaterScheduling: poor COP -> delay', async () => {
    const metrics: OptimizationMetrics = {
      realHotWaterCOP: 0.5,
      realHeatingCOP: 1.0,
      dailyEnergyConsumption: 8,
      heatingEfficiency: 0.3,
      hotWaterEfficiency: 0.1,
      seasonalMode: 'winter',
      optimizationFocus: 'both'
    };

    const lastEnergyData = { TotalHotWaterConsumed: 70 };

    const prices = Array.from({ length: 24 }, (_, i) => ({ time: `${i}:00`, price: i }));
    const priceData = { current: { time: '5:00', price: 5 }, prices };

    const res = await hotWaterOptimizer.optimizeHotWaterScheduling(5, priceData, metrics, lastEnergyData);

    expect(res).toBeDefined();
    expect(['heat_now', 'delay', 'maintain']).toContain(res.action);
    // poor COP should not choose heat_now for mid price
    expect(res.action).not.toBe('heat_now');
  });

  test('optimizeHotWaterScheduling: uses quarter-hour block for delay target when block is in future hour', async () => {
    const metrics: OptimizationMetrics = {
      realHotWaterCOP: 0.5,
      realHeatingCOP: 1.0,
      dailyEnergyConsumption: 8,
      heatingEfficiency: 0.3,
      hotWaterEfficiency: 0.1,
      seasonalMode: 'winter',
      optimizationFocus: 'both'
    };

    const lastEnergyData = { TotalHotWaterConsumed: 50 };
    const now = new Date('2025-01-01T00:00:00Z');
    const current = { time: now.toISOString(), price: 10 };
    const prices = Array.from({ length: 24 }, (_, i) => ({
      time: new Date(now.getTime() + (i + 1) * 3600000).toISOString(),
      price: i + 1
    }));
    // Place the cheap quarter-hour block in a FUTURE hour (2h from now) so delay is expected
    const quarterHourly = [
      { time: new Date(now.getTime() + 2 * 3600000 + 0 * 60000).toISOString(), price: 0.9 },
      { time: new Date(now.getTime() + 2 * 3600000 + 15 * 60000).toISOString(), price: 0.2 }, // expected start
      { time: new Date(now.getTime() + 2 * 3600000 + 30 * 60000).toISOString(), price: 0.1 },
      { time: new Date(now.getTime() + 2 * 3600000 + 45 * 60000).toISOString(), price: 0.9 }
    ];
    const priceData = { current, prices, quarterHourly };

    const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, metrics, lastEnergyData);

    expect(res.action).toBe('delay');
    expect(res.scheduledTime).toBe(quarterHourly[1].time); // start of cheapest 30m block
  });

  describe('Quarter-hour block decision logic', () => {
    const baseMetrics: OptimizationMetrics = {
      realHotWaterCOP: 2.5,
      realHeatingCOP: 2.0,
      dailyEnergyConsumption: 10,
      heatingEfficiency: 0.5,
      hotWaterEfficiency: 0.5,
      seasonalMode: 'winter',
      optimizationFocus: 'both'
    };
    const lastEnergyData = { TotalHotWaterConsumed: 50 };

    test('heat_now when current hour contains cheapest quarter-hour block', async () => {
      // Current time is 14:00. The cheapest 30-min block is 14:15-14:45 (within current hour).
      // Even though hourly percentile is mid-range, quarter-hour intelligence should drive heat_now.
      const now = new Date('2025-06-15T14:00:00Z');
      const current = { time: now.toISOString(), price: 0.50 };
      // Hourly prices: all mid-range, current hour is not particularly cheap
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: 0.40 + (i % 5) * 0.10 // 0.40 - 0.80 range
      }));
      // Quarter-hourly: current hour (14:xx) has the cheapest 30-min block
      const quarterHourly = Array.from({ length: 96 }, (_, i) => {
        const time = new Date(now.getTime() + i * 15 * 60000).toISOString();
        // Default price: 0.60
        let price = 0.60;
        // Make 14:15 and 14:30 very cheap (within current hour)
        if (i === 1 || i === 2) price = 0.05;
        return { time, price };
      });
      const priceData = { current, prices, quarterHourly };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      expect(res.action).toBe('heat_now');
      expect(res.reason).toContain('quarter-hour');
    });

    test('delay to hour containing cheapest quarter-hour block in future', async () => {
      // Current time is 10:00. Cheapest 30-min block is at 03:00 tomorrow (future hour).
      // Current price is expensive → should delay to the block's hour.
      const now = new Date('2025-06-15T10:00:00Z');
      const current = { time: now.toISOString(), price: 0.90 };
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: 0.80 + (i % 3) * 0.05
      }));
      // Quarter-hourly: a very cheap block at hour+17 (03:00 next day)
      const cheapBlockStartIdx = 17 * 4; // 17 hours * 4 slots = slot 68
      const quarterHourly = Array.from({ length: 96 }, (_, i) => {
        const time = new Date(now.getTime() + i * 15 * 60000).toISOString();
        let price = 0.80;
        if (i === cheapBlockStartIdx || i === cheapBlockStartIdx + 1) price = 0.02;
        return { time, price };
      });
      const priceData = { current, prices, quarterHourly };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      expect(res.action).toBe('delay');
      // scheduledTime should point to the cheap quarter-hour block start
      expect(res.scheduledTime).toBe(quarterHourly[cheapBlockStartIdx].time);
    });

    test('ignores quarter-hour blocks beyond the next 24-hour horizon', async () => {
      const now = new Date('2025-06-15T10:00:00Z');
      const current = { time: now.toISOString(), price: 0.95 };
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: i === 2 ? 0.50 : 0.80
      }));
      const inHorizonStartIdx = 2 * 4;
      const beyondHorizonStartIdx = 26 * 4;
      const quarterHourly = Array.from({ length: 192 }, (_, i) => {
        const time = new Date(now.getTime() + i * 15 * 60000).toISOString();
        let price = 0.80;
        if (i === inHorizonStartIdx || i === inHorizonStartIdx + 1) price = 0.10;
        if (i === beyondHorizonStartIdx || i === beyondHorizonStartIdx + 1) price = 0.01;
        return { time, price };
      });
      const priceData = { current, prices, quarterHourly };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      expect(res.action).toBe('delay');
      expect(res.scheduledTime).toBe(quarterHourly[inHorizonStartIdx].time);
      expect(res.scheduledTime).not.toBe(quarterHourly[beyondHorizonStartIdx].time);
    });

    test('hourly fallback when quarterHourly is undefined (ENTSO-E hourly market)', async () => {
      const now = new Date('2025-06-15T10:00:00Z');
      const current = { time: now.toISOString(), price: 5 };
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: i + 1
      }));
      // No quarterHourly field at all (ENTSO-E hourly market)
      const priceData = { current, prices };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      // Should still produce a valid result using hourly logic
      expect(res).toBeDefined();
      expect(['heat_now', 'delay', 'maintain']).toContain(res.action);
      // Reason should NOT mention quarter-hour
      expect(res.reason).not.toContain('quarter-hour');
    });

    test('hourly fallback when quarterHourly is empty array', async () => {
      const now = new Date('2025-06-15T10:00:00Z');
      const current = { time: now.toISOString(), price: 5 };
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: i + 1
      }));
      const priceData = { current, prices, quarterHourly: [] };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      expect(res).toBeDefined();
      expect(['heat_now', 'delay', 'maintain']).toContain(res.action);
      expect(res.reason).not.toContain('quarter-hour');
    });
  });

  describe('Quarter-hour data validation and fallback', () => {
    const baseMetrics: OptimizationMetrics = {
      realHotWaterCOP: 2.5,
      realHeatingCOP: 2.0,
      dailyEnergyConsumption: 10,
      heatingEfficiency: 0.5,
      hotWaterEfficiency: 0.5,
      seasonalMode: 'winter',
      optimizationFocus: 'both'
    };
    const lastEnergyData = { TotalHotWaterConsumed: 50 };

    test('falls back to hourly when quarterHourly has fewer than 4 points', async () => {
      const now = new Date('2025-06-15T14:00:00Z');
      const current = { time: now.toISOString(), price: 0.50 };
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: 0.50
      }));
      // Only 3 quarter-hourly points — insufficient
      const quarterHourly = [
        { time: new Date(now.getTime() + 15 * 60000).toISOString(), price: 0.01 },
        { time: new Date(now.getTime() + 30 * 60000).toISOString(), price: 0.01 },
        { time: new Date(now.getTime() + 45 * 60000).toISOString(), price: 0.01 }
      ];
      const priceData = { current, prices, quarterHourly };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      // Should NOT use quarter-hour logic since data is insufficient
      expect(res.reason).not.toContain('quarter-hour');
    });

    test('falls back to hourly when quarterHourly has large time gap', async () => {
      const now = new Date('2025-06-15T14:00:00Z');
      const current = { time: now.toISOString(), price: 0.50 };
      const prices = Array.from({ length: 24 }, (_, i) => ({
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: 0.50
      }));
      // 4 points but with a 2-hour gap between points 2 and 3
      const quarterHourly = [
        { time: new Date(now.getTime() + 15 * 60000).toISOString(), price: 0.01 },
        { time: new Date(now.getTime() + 30 * 60000).toISOString(), price: 0.01 },
        { time: new Date(now.getTime() + 150 * 60000).toISOString(), price: 0.01 }, // 2h gap
        { time: new Date(now.getTime() + 165 * 60000).toISOString(), price: 0.01 }
      ];
      const priceData = { current, prices, quarterHourly };

      const res = await hotWaterOptimizer.optimizeHotWaterScheduling(current.price, priceData, baseMetrics, lastEnergyData);

      // Should NOT use quarter-hour logic since data has gaps
      expect(res.reason).not.toContain('quarter-hour');
    });
  });

  describe('Pattern scheduling with quarter-hourly data', () => {
    test('picks hour with cheapest 30-min block when quarterHourly provided', () => {
      // Setup: current hour = 5, peak at 7. Valid heating window: hours 3,4,5,6
      // Hourly prices: hour 3 is cheapest hourly (0.20), hour 4 = 0.60, hour 5 = 0.50, hour 6 = 0.55
      // But quarter-hourly data reveals hour 4 has a 30-min block at 0.05 avg (cheaper than hour 3's hourly avg)
      const now = new Date('2025-06-15T05:00:00Z');
      const priceData = Array.from({ length: 24 }, (_, i) => {
        const hour = (5 + i) % 24;
        let price = 0.50;
        if (hour === 3) price = 0.20; // cheapest hour by hourly avg
        if (hour === 4) price = 0.60; // expensive hourly avg but has cheap quarter-hour block
        if (hour === 6) price = 0.55;
        return {
          hour,
          time: new Date(now.getTime() + i * 3600000).toISOString(),
          price
        };
      });

      // Quarter-hourly data: hour 4 (index offset from now = -1h = not reachable by hourly)
      // Actually we need the quarter-hourly block to be in a valid window hour
      // Peak at 7, valid hours: 3,4,5,6 (4h before)
      // Hour 4 is 2025-06-15T04:00:00Z which is in the past from current hour 5
      // Let's use hour 6 instead — it's in the future and valid
      // Hour 6 = now + 1h
      const quarterHourly = Array.from({ length: 96 }, (_, i) => {
        const time = new Date(now.getTime() + i * 15 * 60000).toISOString();
        let price = 0.50;
        // Hour 6 (slots 4-7, i.e. 1h from now) — first two 15-min slots are very cheap
        if (i === 4 || i === 5) price = 0.03;
        return { time, price };
      });

      const usagePattern = {
        peakHours: [7],
        hourlyDemand: Array(24).fill(0.1).map((v, i) => i === 7 ? 0.8 : v)
      };

      const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
        5,
        priceData,
        3.0,
        usagePattern,
        now.getTime(),
        { quarterHourly: quarterHourly as any }
      );

      // The schedule should pick hour 6 (containing the cheap quarter-hour block)
      // instead of the hour with cheapest hourly average
      expect(result.schedulePoints.length).toBeGreaterThan(0);
      const peakPoint = result.schedulePoints.find(p => p.reason.includes('7'));
      expect(peakPoint).toBeDefined();
      expect(peakPoint!.hour).toBe(6); // Hour with cheap quarter-hour block
    });

    test('falls back to hourly when no quarterHourly provided', () => {
      const now = new Date('2025-06-15T05:00:00Z');
      const priceData = Array.from({ length: 24 }, (_, i) => ({
        hour: (5 + i) % 24,
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: i === 0 ? 0.30 : 0.60 // Current hour (5) is cheapest
      }));

      const usagePattern = {
        peakHours: [7],
        hourlyDemand: Array(24).fill(0.1).map((v, i) => i === 7 ? 0.8 : v)
      };

      // No quarterHourly in options
      const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
        5,
        priceData,
        3.0,
        usagePattern,
        now.getTime(),
        {}
      );

      expect(result.schedulePoints.length).toBeGreaterThan(0);
      // Should use hourly logic — hour 5 is cheapest in the 4-hour window
      const peakPoint = result.schedulePoints.find(p => p.reason.includes('7'));
      expect(peakPoint).toBeDefined();
      expect(peakPoint!.hour).toBe(5);
    });

    test('ignores tomorrow quarter-hour blocks when building today schedule', () => {
      const now = new Date('2025-06-15T05:00:00Z');
      const priceData = Array.from({ length: 24 }, (_, i) => ({
        hour: (5 + i) % 24,
        time: new Date(now.getTime() + i * 3600000).toISOString(),
        price: i === 0 ? 0.30 : 0.60
      }));
      const quarterHourly = Array.from({ length: 192 }, (_, i) => {
        const time = new Date(now.getTime() + i * 15 * 60000).toISOString();
        let price = 0.60;
        if (i === 25 * 4 || i === 25 * 4 + 1) price = 0.01; // Tomorrow 06:00, outside next24h
        return { time, price };
      });
      const usagePattern = {
        peakHours: [7],
        hourlyDemand: Array(24).fill(0.1).map((v, i) => i === 7 ? 0.8 : v)
      };

      const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
        5,
        priceData,
        3.0,
        usagePattern,
        now.getTime(),
        { quarterHourly: quarterHourly as any }
      );

      const peakPoint = result.schedulePoints.find(p => p.reason.includes('7'));
      expect(peakPoint).toBeDefined();
      expect(peakPoint!.hour).toBe(5);
    });

    test('maps quarter-hour blocks back to the local schedule hour', () => {
      // Local time is UTC+2, so 05:00 local is represented by 03:00Z in price timestamps.
      const nowUtc = new Date('2025-06-15T03:00:00Z');
      const priceData = Array.from({ length: 24 }, (_, i) => {
        const localHour = (5 + i) % 24;
        let price = 0.60;
        if (localHour === 5) price = 0.20; // cheapest hourly baseline
        if (localHour === 6) price = 0.55; // quarter-hour block should override this hour
        return {
          hour: localHour,
          time: new Date(nowUtc.getTime() + i * 3600000).toISOString(),
          price
        };
      });
      const quarterHourly = Array.from({ length: 96 }, (_, i) => {
        const time = new Date(nowUtc.getTime() + i * 15 * 60000).toISOString();
        let price = 0.60;
        if (i === 4 || i === 5) price = 0.03; // Local 06:00 hour, but 04:00Z
        return { time, price };
      });
      const usagePattern = {
        peakHours: [7],
        hourlyDemand: Array(24).fill(0.1).map((v, i) => i === 7 ? 0.8 : v)
      };

      const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
        5,
        priceData,
        3.0,
        usagePattern,
        nowUtc.getTime(),
        { quarterHourly: quarterHourly as any }
      );

      const peakPoint = result.schedulePoints.find(p => p.reason.includes('7'));
      expect(peakPoint).toBeDefined();
      expect(peakPoint!.hour).toBe(6);
    });
  });

  describe('Pattern Savings Calculation', () => {
    test('calculatePatternSavings: basic savings calculation', () => {
      const schedulePoints = [
        { hour: 2, priority: 0.8, reason: 'cheap', cop: 3.0, pricePercentile: 0.1 },
        { hour: 14, priority: 0.5, reason: 'moderate', cop: 3.0, pricePercentile: 0.5 }
      ];

      const priceData = [
        { hour: 0, time: '0:00', price: 0.50 },
        { hour: 1, time: '1:00', price: 0.40 },
        { hour: 2, time: '2:00', price: 0.30 }, // ← Scheduled here (cheap)
        { hour: 3, time: '3:00', price: 0.50 },
        { hour: 4, time: '4:00', price: 0.55 },
        { hour: 5, time: '5:00', price: 0.60 },
        { hour: 6, time: '6:00', price: 0.65 },
        { hour: 7, time: '7:00', price: 0.70 },
        { hour: 8, time: '8:00', price: 0.60 },
        { hour: 9, time: '9:00', price: 0.55 },
        { hour: 10, time: '10:00', price: 0.50 },
        { hour: 11, time: '11:00', price: 0.55 },
        { hour: 12, time: '12:00', price: 0.60 },
        { hour: 13, time: '13:00', price: 0.65 },
        { hour: 14, time: '14:00', price: 0.60 }, // ← Scheduled here (mid)
        { hour: 15, time: '15:00', price: 0.70 },
        { hour: 16, time: '16:00', price: 0.75 },
        { hour: 17, time: '17:00', price: 0.80 },
        { hour: 18, time: '18:00', price: 0.75 },
        { hour: 19, time: '19:00', price: 0.70 },
        { hour: 20, time: '20:00', price: 0.65 },
        { hour: 21, time: '21:00', price: 0.60 },
        { hour: 22, time: '22:00', price: 0.55 },
        { hour: 23, time: '23:00', price: 0.50 }
      ];

      const savings = hotWaterOptimizer['calculatePatternSavings'](
        schedulePoints,
        0, // current hour
        priceData,
        { gridFeePerKwh: 0, estimatedDailyHotWaterKwh: 3 }
      );

      // Expected:
      // Total priority = 1.3, estimatedDailyHotWaterKwh = 3
      // Hour 2 allocation: (0.8 / 1.3) * 3 = 1.846 kWh @ 0.30 = 0.554
      // Hour 14 allocation: (0.5 / 1.3) * 3 = 1.154 kWh @ 0.60 = 0.692
      // Scheduled cost = 1.246
      // Avg price ≈ 0.583, total demand 3 kWh => on-demand = 1.749
      // Savings ≈ 0.503

      expect(savings).toBeGreaterThan(0);
      expect(savings).toBeLessThan(1.0); // Reasonable range
      expect(savings).toBeCloseTo(0.535, 2);
    });

    test('calculatePatternSavings: returns 0 for no schedule points', () => {
      const priceData = [
        { hour: 0, time: '0:00', price: 0.50 },
        { hour: 1, time: '1:00', price: 0.60 }
      ];
      const savings = hotWaterOptimizer['calculatePatternSavings']([], 0, priceData, { estimatedDailyHotWaterKwh: 3 });
      expect(savings).toBe(0);
    });

    test('calculatePatternSavings: returns 0 for empty price data', () => {
      const schedulePoints = [
        { hour: 2, priority: 0.8, reason: 'cheap', cop: 3.0, pricePercentile: 0.1 }
      ];
      const savings = hotWaterOptimizer['calculatePatternSavings'](schedulePoints, 0, []);
      expect(savings).toBe(0);
    });

    test('optimizeHotWaterSchedulingByPattern: includes savings in result', () => {
      const priceData = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        time: `${i}:00`,
        price: i === 2 || i === 3 ? 0.30 : 0.60 // Hours 2-3 are cheap
      }));

      const usagePattern = {
        peakHours: [7, 18], // Morning and evening peaks
        hourlyDemand: Array(24).fill(0.1).map((v, i) =>
          i === 7 || i === 18 ? 0.8 : v
        )
      };

      // Use currentHour = 5, so peak at 7 is 2 hours ahead
      // Valid heating window for peak 7: hours 3,4,5,6 (4 hours before)
      // Valid heating window for peak 18: hours 14,15,16,17 (4 hours before)
      const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
        5, // current hour is 5
        priceData,
        3.0, // hot water COP
        usagePattern,
        undefined,
        { currencyCode: 'NOK', estimatedDailyHotWaterKwh: usagePattern.hourlyDemand.reduce((s, v) => s + v, 0) }
      );

      expect(result.estimatedSavings).toBeGreaterThan(0);
      expect(result.reasoning).toContain('saves');
      expect(result.reasoning).toContain('NOK');
    });

    test('reasoning reflects a price-driven delay rather than the generic predictive template (Fix 6)', () => {
      // Expensive current hour, peak far away -> action should be 'delay' with price wording.
      // next24h[0] is the first array element (the "now" price), so make element 0 expensive.
      const priceData = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        time: `${i}:00`,
        price: i === 0 ? 2.0 : 0.6
      }));
      const usagePattern = {
        peakHours: [8], // far from current hour 20
        hourlyDemand: Array(24).fill(0.1).map((v, i) => (i === 8 ? 0.8 : v))
      };

      const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
        20, // current hour: expensive, no peak within 2h
        priceData,
        3.0,
        usagePattern,
        undefined,
        { currencyCode: 'NOK', estimatedDailyHotWaterKwh: 2 }
      );

      expect(result.currentAction).toBe('delay');
      expect(result.reasoning).toMatch(/conserving tank|price high/i);
      expect(result.reasoning).not.toMatch(/Predictive scheduling based on usage pattern/);
    });
  });

  test('optimizeHotWaterSchedulingByPattern keeps late-evening peaks in the next-day planning window', () => {
    const now = new Date('2026-04-17T21:00:00Z');
    const currentHour = 23; // Europe/Stockholm local time in the user log
    const priceData = Array.from({ length: 24 }, (_, i) => ({
      time: new Date(now.getTime() + i * 3600000).toISOString(),
      price: i < 6 ? 1.2 : 0.6 + (i * 0.01)
    }));

    const result = hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
      currentHour,
      priceData,
      2.5,
      {
        peakHours: [20, 19, 18, 22, 16],
        hourlyDemand: Array.from({ length: 24 }, (_, hour) => [16, 18, 19, 20, 22].includes(hour) ? 2 : 0.2)
      },
      now.getTime(),
      {
        estimatedDailyHotWaterKwh: 8
      }
    );

    expect(result.schedulePoints).toHaveLength(5);
    expect(result.schedulePoints.every(point => point.priority > 0)).toBe(true);
    expect(result.estimatedSavings).toBeGreaterThanOrEqual(0);
  });
});
