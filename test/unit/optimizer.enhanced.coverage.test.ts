import { Optimizer } from '../../src/services/optimizer';
import { createMockLogger } from '../mocks';

const mockMel: any = {
  getEnhancedCOPData: jest.fn(),
  getDailyEnergyTotals: jest.fn(),
  getDeviceState: jest.fn(),
  setDeviceTemperature: jest.fn(),
  setZoneTemperature: jest.fn(),
  setTankTemperature: jest.fn()
};

const mockTibber: any = {
  getPrices: jest.fn()
};

describe('Optimizer hotwater & enhanced edge cases', () => {
  let optimizer: Optimizer;
  let logger = createMockLogger();

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createMockLogger();
    mockMel.getEnhancedCOPData.mockResolvedValue({
      current: { heating: 1.2, hotWater: 0.8, outdoor: 5 },
      daily: { TotalHeatingConsumed: 0, TotalHotWaterConsumed: 0, CoP: [], AverageHeatingCOP: 0, AverageHotWaterCOP: 0 },
      trends: { heatingTrend: 'stable', hotWaterTrend: 'stable' },
      historical: { heating: 0, hotWater: 0 }
    });

    mockMel.getDeviceState.mockResolvedValue({
      RoomTemperature: 20,
      SetTemperature: 20,
      OutdoorTemperature: 5
    });
    mockMel.setZoneTemperature.mockResolvedValue(true);
    mockMel.setTankTemperature.mockResolvedValue(true);

    const nowIso = new Date().toISOString();
    mockTibber.getPrices.mockResolvedValue({
      current: { price: 0.5, time: nowIso },
      prices: new Array(24).fill(0).map((_, i) => ({ price: 0.5, time: new Date(Date.now() + i * 3600000).toISOString() })),
      priceLevel: 'CHEAP'
    });

    optimizer = new Optimizer(mockMel, mockTibber, 'device-1', 1, logger as any);
  });

  test('optimizeHotWaterScheduling handles missing metrics and returns maintain', async () => {
    // Access through the hotWaterOptimizer service
    const res = await (optimizer as any).hotWaterOptimizer.optimizeHotWaterScheduling(
      0.5,
      { current: { price: 0.5, time: new Date().toISOString() }, prices: new Array(24).fill({ price: 0.5, time: new Date().toISOString() }) },
      null, // No metrics
      null  // No last energy data
    );
    expect(res).toBeDefined();
    expect(['maintain', 'heat_now', 'delay']).toContain(res.action);
    expect(res.action).toBe('maintain'); // Should return maintain when no metrics
  });

  test('runOptimization returns no_change when difference below deadband', async () => {
    // Last energy data will be zeros -> metrics indicate summer -> small diff
    const result = await optimizer.runOptimization();
    expect(result).toBeDefined();
    expect(result.action).toMatch(/no_change|temperature_adjusted/);
  });

  test('runOptimization includes zone2 data when zone2 enabled', async () => {
    optimizer.setZone2TemperatureConstraints(true, 18, 22, 0.5);
    mockMel.getDeviceState.mockResolvedValue({
      RoomTemperature: 20,
      RoomTemperatureZone1: 20,
      SetTemperature: 20,
      SetTemperatureZone1: 20,
      OutdoorTemperature: 5,
      RoomTemperatureZone2: 19,
      SetTemperatureZone2: 21
    });

    const result = await optimizer.runOptimization();
    expect(result.zone2Data).toBeDefined();
  });

  test('Zone2 honors its own temperature step when rounding', async () => {
    optimizer.setZone2TemperatureConstraints(true, 18, 25, 0.5); // Zone2 step = 0.5
    // Set Zone 1 deadband to a value that won't block our step-limited changes
    (optimizer as any).constraintManager.setZone1Deadband(0.3);

    const inputs: any = {
      deviceState: {
        SetTemperatureZone2: 20,
        RoomTemperatureZone2: 20,
        RoomTemperature: 20,
        SetTemperature: 20,
        OutdoorTemperature: 5
      },
      currentTemp: 20,
      currentTarget: 20,
      outdoorTemp: 5,
      priceData: { current: { price: 0.5, time: new Date().toISOString() }, prices: [] },
      priceStats: { priceLevel: 'CHEAP' },
      priceClassification: { thresholds: {} },
      priceForecast: null,
      planningReferenceTime: new Date(),
      planningReferenceTimeMs: Date.now(),
      thermalResponse: 1,
      previousIndoorTemp: null,
      previousIndoorTempTs: null,
      constraintsBand: { minTemp: 18, maxTemp: 22 },
      safeCurrentTarget: 20
    };

    const zone1Result: any = {
      targetTemp: 21.44, // Zone2 will ramp-limit to +0.5°C per change, rounded to step
      weatherInfo: null,
      thermalStrategy: null,
      metrics: null
    };

    const result = await (optimizer as any).optimizeZone2(inputs, zone1Result, jest.fn());

    // With maxDeltaPerChangeC = 0.5 (step size), change is limited from 20 -> 20.5
    const [, , issuedTarget] = mockMel.setZoneTemperature.mock.calls[0];
    expect(issuedTarget).toBeCloseTo(20.5, 2);
    expect(result.toTemp).toBeCloseTo(20.5, 2);
  });

  test('runOptimization includes tank data when tank control enabled', async () => {
    optimizer.setTankTemperatureConstraints(true, 40, 50, 1);
    mockMel.getDeviceState.mockResolvedValue({
      RoomTemperature: 20,
      RoomTemperatureZone1: 20,
      SetTemperature: 20,
      SetTemperatureZone1: 20,
      OutdoorTemperature: 5,
      SetTankWaterTemperature: 48
    });

    const result = await optimizer.runOptimization();
    expect(result.tankData).toBeDefined();
  });

  describe('heat-demand gate (Fix 4)', () => {
    // Prices that want a preheat: current hour cheapest, rest expensive -> target rises to band max.
    const preheatPrices = () => {
      const nowIso = new Date().toISOString();
      return {
        current: { price: 0.1, time: nowIso },
        prices: new Array(24).fill(0).map((_, i) => ({
          price: i === 0 ? 0.1 : 1.5,
          time: new Date(Date.now() + i * 3600000).toISOString()
        })),
        priceLevel: 'CHEAP'
      };
    };

    test('holds zone1 write when room is above the comfort band (no heat possible)', async () => {
      optimizer.setTemperatureConstraints(18, 22, 0.5);
      mockTibber.getPrices.mockResolvedValue(preheatPrices());
      mockMel.getDeviceState.mockResolvedValue({
        RoomTemperature: 26,           // well above band max 22 (solar gain)
        RoomTemperatureZone1: 26,
        SetTemperature: 20,
        SetTemperatureZone1: 20,
        OutdoorTemperature: 24,
        IdleZone1: true
      });

      const result = await optimizer.runOptimization();

      expect(mockMel.setDeviceTemperature).not.toHaveBeenCalled();
      expect(result.reason).toMatch(/above comfort band/i);
    });

    test('control: same price scenario DOES apply when room is within the band', async () => {
      optimizer.setTemperatureConstraints(18, 22, 0.5);
      mockTibber.getPrices.mockResolvedValue(preheatPrices());
      mockMel.getDeviceState.mockResolvedValue({
        RoomTemperature: 20,           // within band -> gate inert, heating possible
        RoomTemperatureZone1: 20,
        SetTemperature: 20,
        SetTemperatureZone1: 20,
        OutdoorTemperature: 5,
        IdleZone1: false
      });

      await optimizer.runOptimization();

      expect(mockMel.setDeviceTemperature).toHaveBeenCalled();
    });
  });

  test('persists tank lockout timestamp on a tank-only apply (zone1 not applied)', async () => {
    // Regression for DHW-3: in summer zone1 never applies, so the tank change must still be
    // persisted to settings or the anti-cycling lockout is lost on restart.
    const homey: any = {
      settings: {
        get: jest.fn().mockReturnValue(undefined),
        set: jest.fn()
      }
    };
    optimizer = new Optimizer(mockMel, mockTibber, 'device-1', 1, logger as any, undefined, homey);

    const zone1Result: any = {
      needsApply: false,        // zone1 holds (summer: room above band / no demand)
      lockoutActive: false,
      duplicateTarget: false,
      changed: false,
      targetTemp: 20,
      safeCurrentTarget: 20,
      tempDifference: 0
    };
    const tankResult: any = {
      needsApply: true,
      fromTemp: 48,
      toTemp: 46,
      evaluatedAtMs: 1700000000000
    };

    const changes = await (optimizer as any).applySetpointChanges(zone1Result, null, tankResult, jest.fn());

    expect(changes.tankApplied).toBe(true);
    expect(changes.zone1Applied).toBe(false);
    expect(mockMel.setTankTemperature).toHaveBeenCalledWith('device-1', 1, 46);
    // The fix: timestamp persisted even though zone1 did not apply.
    expect(homey.settings.set).toHaveBeenCalledWith('last_tank_setpoint_change_ms', 1700000000000);
  });

  test('runOptimization forwards device state to the hot water service collector', async () => {
    const collectData = jest.fn().mockResolvedValue(true);
    const getUsageStatistics = jest.fn().mockReturnValue({
      statistics: {
        usageByHourOfDay: new Array(24).fill(0),
        dataPointCount: 0
      }
    });
    const homey: any = {
      settings: {
        get: jest.fn(),
        set: jest.fn()
      },
      hotWaterService: {
        collectData,
        getUsageStatistics
      }
    };
    optimizer = new Optimizer(mockMel, mockTibber, 'device-1', 1, logger as any, undefined, homey);

    await optimizer.runOptimization();

    expect(collectData).toHaveBeenCalledWith(expect.objectContaining({
      RoomTemperature: 20,
      SetTemperature: 20,
      OutdoorTemperature: 5
    }));
  });

  test('optimizeTank does not pin maintain actions to the previous tank setpoint', async () => {
    const homey: any = {
      settings: {
        get: jest.fn(),
        set: jest.fn()
      },
      hotWaterService: {
        getUsageStatistics: jest.fn().mockReturnValue({
          statistics: {
            usageByHourOfDay: new Array(24).fill(0.5),
            dataPointCount: 24
          }
        }),
        getOptimalTankTemperature: jest.fn().mockReturnValue(48)
      }
    };
    optimizer = new Optimizer(mockMel, mockTibber, 'device-1', 1, logger as any, undefined, homey);
    optimizer.setTankTemperatureConstraints(true, 42, 53, 2);

    const result = await (optimizer as any).optimizeTank(
      {
        deviceState: { SetTankWaterTemperature: 52 },
        priceStats: {
          currentPrice: 1.12,
          priceLevel: 'NORMAL',
          pricePercentile: 84.6
        },
        priceClassification: {
          thresholds: {}
        }
      },
      {
        hotWaterAction: {
          action: 'maintain',
          reason: 'Predictive scheduling found no immediate action'
        }
      },
      jest.fn()
    );

    expect(homey.hotWaterService.getOptimalTankTemperature).toHaveBeenCalledWith(42, 53, 1.12, 'NORMAL');
    // 52 -> 48 in one move. The adaptive target has drifted 4°C from the current setpoint, which
    // clears the maintain hysteresis, and the tank ramp cap (4°C) is wide enough to arrive in a
    // single write rather than stepping there over several hours.
    expect(result.toTemp).toBe(48);
    expect(result.needsApply).toBe(true);
  });

  test('optimizeTank holds the current setpoint when the maintain target is within hysteresis', async () => {
    const homey: any = {
      settings: {
        get: jest.fn(),
        set: jest.fn()
      },
      hotWaterService: {
        getUsageStatistics: jest.fn().mockReturnValue({
          statistics: {
            usageByHourOfDay: new Array(24).fill(0.5),
            dataPointCount: 24
          }
        }),
        // Only 1°C away from the current 52°C setpoint — no strong signal.
        getOptimalTankTemperature: jest.fn().mockReturnValue(51)
      }
    };
    optimizer = new Optimizer(mockMel, mockTibber, 'device-1', 1, logger as any, undefined, homey);
    optimizer.setTankTemperatureConstraints(true, 42, 53, 2);

    const result = await (optimizer as any).optimizeTank(
      {
        deviceState: { SetTankWaterTemperature: 52 },
        priceStats: {
          currentPrice: 1.12,
          priceLevel: 'NORMAL',
          pricePercentile: 84.6
        },
        priceClassification: { thresholds: {} }
      },
      {
        hotWaterAction: {
          action: 'maintain',
          reason: 'Predictive scheduling found no immediate action'
        }
      },
      jest.fn()
    );

    // 'maintain' means no strong signal. Chasing a 1°C drift would write a new setpoint every
    // hour as the price level wanders across band-fraction boundaries, for no economic gain.
    expect(result.toTemp).toBe(52);
    expect(result.needsApply).toBe(false);
  });

  test('runOptimization prefers MELCloud daily hot water total over learner daily history', async () => {
    mockMel.getEnhancedCOPData.mockResolvedValue({
      current: { heating: 3.09, hotWater: 2.52, outdoor: 8 },
      daily: {
        TotalHeatingConsumed: 9.05,
        TotalHeatingProduced: 28.0,
        TotalHotWaterConsumed: 2.29,
        TotalHotWaterProduced: 5.78,
        CoP: [],
        AverageHeatingCOP: 3.09,
        AverageHotWaterCOP: 2.52
      },
      trends: { heatingTrend: 'stable', hotWaterTrend: 'stable' },
      historical: { heating: 3.09, hotWater: 2.52 }
    });

    const homey: any = {
      settings: {
        get: jest.fn(),
        set: jest.fn()
      },
      hotWaterService: {
        collectData: jest.fn().mockResolvedValue(true),
        getUsageStatistics: jest.fn().mockReturnValue({
          statistics: {
            avgDailyHotWaterEnergyProduced: 46.5,
            usageByHourOfDay: new Array(24).fill(0.5),
            dataPointCount: 24
          },
          patterns: {
            hourlyUsagePattern: new Array(24).fill(1),
            lastUpdated: new Date().toISOString(),
            confidence: 100
          }
        }),
        getOptimalTankTemperature: jest.fn().mockReturnValue(45)
      }
    };
    optimizer = new Optimizer(mockMel, mockTibber, 'device-1', 1, logger as any, undefined, homey);

    await optimizer.runOptimization();

    const learnerStateCall = (logger.log as jest.Mock).mock.calls.find(([message]) => message === 'Hot water learner state');
    expect(learnerStateCall).toBeDefined();
    expect(learnerStateCall[1]).toEqual(expect.objectContaining({
      estimatedDailyHotWaterKwh: 5.78,
      estimatedDailyHotWaterKwhSource: 'melcloud_daily_total',
      measuredDailyHotWaterKwh: 5.78,
      learnedDailyHotWaterKwh: 5.78,
      learnedDailyHotWaterKwhBeforeReconcile: 46.5,
      learnerReconciledToMeasured: true
    }));
  });

  test('calculateDailySavings falls back to non-price-aware calculation on Tibber error', async () => {
    mockTibber.getPrices.mockRejectedValueOnce(new Error('boom'));
    const projection = await optimizer.getSavingsService().calculateDailySavings(1);
    // On error, it falls back to the enhanced savings calculator which calculates based on
    // remaining hours in the day and applies clamping. The result should still be a positive number.
    expect(projection).toBeGreaterThan(0);
    expect(projection).toBeLessThanOrEqual(24); // Max possible with hourly savings of 1
  });

  test('thermal model cleanup helper returns safe defaults when service unavailable', () => {
    expect(optimizer.forceThermalDataCleanup()).toEqual({ success: false, message: 'Thermal model service not initialized' });
  });
});
