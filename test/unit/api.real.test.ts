/* eslint-disable @typescript-eslint/no-var-requires */
const apiModule: any = require('../../api.js');

describe('api.js — real module tests using __test helpers', () => {
  let homey: any;
  let settingsStore: Record<string, any>;

  beforeEach(() => {
    // Minimal mock Homey object used by the API endpoints
    settingsStore = {};
    homey = {
      app: {
        log: jest.fn(),
        error: jest.fn(),
        flow: { runFlowCardAction: jest.fn() }
      },
      settings: {
        get: jest.fn((key: string) => settingsStore[key]),
        set: jest.fn((key: string, value: any) => { settingsStore[key] = value; })
      },
      notifications: { createNotification: jest.fn() },
      timeline: { createEntry: jest.fn() }
    };

    // Ensure a clean module state
    if (apiModule.__test && typeof apiModule.__test.resetAll === 'function') {
      apiModule.__test.resetAll();
    }

    global.hourlyJob = undefined;
    global.weeklyJob = undefined;
  });

  afterEach(() => {
    if (apiModule.__test && typeof apiModule.__test.resetAll === 'function') {
      apiModule.__test.resetAll();
    }
    global.hourlyJob = undefined;
    global.weeklyJob = undefined;
  });

  test('getDeviceList returns formatted devices from injected melCloud', async () => {
    const melCloudMock = {
      getDevices: jest.fn().mockResolvedValue([
        {
          id: 59132691,
          name: 'Boiler',
          buildingId: 513523,
          type: 1,
          data: {
            SetTemperatureZone1: 19,
            RoomTemperatureZone1: 21.5
          }
        }
      ])
    };

    const tibberMock = { getPrices: jest.fn().mockResolvedValue({ prices: [] }) };
    const optimizerMock = {
      setTemperatureConstraints: jest.fn(),
      setZone2TemperatureConstraints: jest.fn(),
      setTankTemperatureConstraints: jest.fn(),
      setThermalModel: jest.fn(),
      setCOPSettings: jest.fn()
    };

    apiModule.__test.setServices({ melCloud: melCloudMock, tibber: tibberMock, optimizer: optimizerMock, weather: {} });

    const res = await apiModule.getDeviceList({ homey });

    expect(res.success).toBe(true);
    expect(Array.isArray(res.devices)).toBe(true);
    expect(res.devices.length).toBe(1);
    expect(res.devices[0].name).toBe('Boiler');
    expect(melCloudMock.getDevices).toHaveBeenCalled();
  });

  test('getRunHourlyOptimizer calls optimizer.runOptimization and returns result', async () => {
    const fakeResult = {
      action: 'temperature_adjusted',
      fromTemp: 20,
      toTemp: 19,
      reason: 'Test adjustment',
      priceData: { current: 0.5, average: 0.6 }
    };

    const melCloudMock = { getDevices: jest.fn().mockResolvedValue([]) };
    const tibberMock = { getPrices: jest.fn().mockResolvedValue({ prices: [] }) };
    const optimizerMock = {
      runOptimization: jest.fn().mockResolvedValue(fakeResult),
      setTemperatureConstraints: jest.fn(),
      setZone2TemperatureConstraints: jest.fn(),
      setTankTemperatureConstraints: jest.fn(),
      setThermalModel: jest.fn(),
      setCOPSettings: jest.fn(),
      setPriceThresholds: jest.fn(),
      setConstraintSettings: jest.fn(),
      setCurveGateOffset: jest.fn(),
      refreshOccupancyFromSettings: jest.fn(),
      thermalModel: { K: 0.5 },
      thermalModelService: { getMemoryUsage: jest.fn().mockReturnValue({}) },
      getSavingsService: jest.fn().mockReturnValue({
        getEnhancedSavingsCalculator: jest.fn().mockReturnValue({
          hasBaselineCapability: jest.fn().mockReturnValue(false)
        })
      })
    };

    apiModule.__test.setServices({ melCloud: melCloudMock, tibber: tibberMock, optimizer: optimizerMock, weather: {} });

    const res = await apiModule.getRunHourlyOptimizer({ homey });

    expect(res.success).toBe(true);
    expect(optimizerMock.runOptimization).toHaveBeenCalled();
    // The returned wrapper includes the real optimizer result under `result`
    expect(res.result).toEqual(fakeResult);
  });

  test('getRunWeeklyCalibration returns not-enough-data when historicalData is small, and runs calibration when enough', async () => {
    const melCloudMock = { getDevices: jest.fn().mockResolvedValue([]) };
    const tibberMock = { getPrices: jest.fn().mockResolvedValue({ prices: [] }) };
    const optimizerMock = {
      runWeeklyCalibration: jest.fn().mockResolvedValue({ oldK: 0.5, newK: 0.6, analysis: 'ok' }),
      setTemperatureConstraints: jest.fn(),
      setZone2TemperatureConstraints: jest.fn(),
      setTankTemperatureConstraints: jest.fn(),
      setThermalModel: jest.fn(),
      setCOPSettings: jest.fn(),
      setPriceThresholds: jest.fn(),
      setConstraintSettings: jest.fn(),
      setCurveGateOffset: jest.fn(),
      refreshOccupancyFromSettings: jest.fn(),
      thermalModel: { K: 0.5 }
    };

    apiModule.__test.setServices({ melCloud: melCloudMock, tibber: tibberMock, optimizer: optimizerMock, weather: {} });

    // Default historicalData is empty -> should return not enough data
    const res1 = await apiModule.getRunWeeklyCalibration({ homey });
    expect(res1.success).toBe(false);
    expect(res1.historicalDataCount).toBeDefined();

    // Now inject enough historical data and run again
    apiModule.__test.setHistoricalData({ optimizations: new Array(30).fill({}), lastCalibration: null });

    const res2 = await apiModule.getRunWeeklyCalibration({ homey });
    expect(res2.success).toBe(true);
    expect(optimizerMock.runWeeklyCalibration).toHaveBeenCalled();
  });

  test('getRunHourlyOptimizer records real zero-price optimizations in history', async () => {
    const fakeResult = {
      success: true,
      action: 'no_change',
      fromTemp: 20,
      toTemp: 20,
      reason: 'Zero-price hold',
      savings: 0,
      priceData: { current: 0, average: 0.2, min: -0.1, max: 0.4 }
    };

    const optimizerMock = {
      runOptimization: jest.fn().mockResolvedValue(fakeResult),
      setTemperatureConstraints: jest.fn(),
      setZone2TemperatureConstraints: jest.fn(),
      setTankTemperatureConstraints: jest.fn(),
      setThermalModel: jest.fn(),
      setCOPSettings: jest.fn(),
      setPriceThresholds: jest.fn(),
      setConstraintSettings: jest.fn(),
      setCurveGateOffset: jest.fn(),
      refreshOccupancyFromSettings: jest.fn(),
      thermalModel: { K: 0.5 },
      thermalModelService: { getMemoryUsage: jest.fn().mockReturnValue({}) },
      getSavingsService: jest.fn().mockReturnValue({
        getEnhancedSavingsCalculator: jest.fn().mockReturnValue({
          hasBaselineCapability: jest.fn().mockReturnValue(false)
        })
      })
    };

    apiModule.__test.setServices({
      melCloud: { getDevices: jest.fn().mockResolvedValue([]) },
      tibber: { getPrices: jest.fn().mockResolvedValue({ prices: [] }) },
      optimizer: optimizerMock,
      weather: {}
    });

    const res = await apiModule.getRunHourlyOptimizer({ homey });
    const state = apiModule.__test.getState();

    expect(res.success).toBe(true);
    expect(state.historicalData.optimizations).toHaveLength(1);
    expect(state.historicalData.optimizations[0].priceNow).toBe(0);
  });

  test('getRunHourlyOptimizer skips history when price data is unavailable fallback', async () => {
    const fakeResult = {
      success: true,
      action: 'no_change',
      fromTemp: 20,
      toTemp: 20,
      reason: 'Price fetch failed; holding last setpoint',
      savings: 0,
      priceDataUnavailable: true,
      priceData: { current: 0, average: 0, min: 0, max: 0 }
    };

    const optimizerMock = {
      runOptimization: jest.fn().mockResolvedValue(fakeResult),
      setTemperatureConstraints: jest.fn(),
      setZone2TemperatureConstraints: jest.fn(),
      setTankTemperatureConstraints: jest.fn(),
      setThermalModel: jest.fn(),
      setCOPSettings: jest.fn(),
      setPriceThresholds: jest.fn(),
      setConstraintSettings: jest.fn(),
      setCurveGateOffset: jest.fn(),
      refreshOccupancyFromSettings: jest.fn(),
      thermalModel: { K: 0.5 },
      thermalModelService: { getMemoryUsage: jest.fn().mockReturnValue({}) },
      getSavingsService: jest.fn().mockReturnValue({
        getEnhancedSavingsCalculator: jest.fn().mockReturnValue({
          hasBaselineCapability: jest.fn().mockReturnValue(false)
        })
      })
    };

    apiModule.__test.setServices({
      melCloud: { getDevices: jest.fn().mockResolvedValue([]) },
      tibber: { getPrices: jest.fn().mockResolvedValue({ prices: [] }) },
      optimizer: optimizerMock,
      weather: {}
    });

    const res = await apiModule.getRunHourlyOptimizer({ homey });
    const state = apiModule.__test.getState();

    expect(res.success).toBe(true);
    expect(state.historicalData.optimizations).toHaveLength(0);
  });
});
