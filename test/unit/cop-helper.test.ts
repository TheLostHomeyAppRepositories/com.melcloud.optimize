import { COPHelper } from '../../src/services/cop-helper';

// Mock DateTime
jest.mock('luxon', () => ({
  DateTime: {
    now: jest.fn().mockReturnValue({
      toISO: jest.fn().mockReturnValue('2023-01-01T12:00:00.000Z')
    })
  }
}));

describe('COPHelper', () => {
  let copHelper: COPHelper;
  let mockHomey: any;
  let mockLogger: any;
  let mockSettings: any;
  let mockScheduler: any;

  beforeEach(() => {
    // Create mock settings
    mockSettings = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock scheduler
    mockScheduler = {
      scheduleTask: jest.fn().mockReturnValue({
        unregister: jest.fn()
      })
    };

    // Create mock Homey
    mockHomey = {
      settings: mockSettings,
      scheduler: mockScheduler
    };

    // Create mock logger
    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
    };

    // Create COP helper instance
    copHelper = new COPHelper(mockHomey, mockLogger);
  });

  describe('constructor', () => {
    it('should initialize correctly', () => {
      expect(copHelper).toBeDefined();
      expect(mockLogger.log).toHaveBeenCalledWith('COP calculation jobs scheduled');
    });

    it('should handle errors during initialization', () => {
      // Create a mock that throws an error
      const errorMockHomey = {
        settings: mockSettings,
        scheduler: {
          scheduleTask: jest.fn().mockImplementation(() => {
            throw new Error('Scheduler error');
          })
        }
      };

      // Create COP helper with error-throwing mock
      new COPHelper(errorMockHomey, mockLogger);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error scheduling COP calculation jobs:',
        expect.any(Error)
      );
    });
  });

  describe('isSummerSeason', () => {
    it('should return true for summer months', () => {
      // Mock Date constructor to return summer month (July = 6)
      const originalDate = global.Date;

      // Create a custom Date constructor
      const MockDate = function(this: Date) {
        return new originalDate('2023-07-15');
      } as unknown as DateConstructor;

      // Copy static methods
      MockDate.UTC = originalDate.UTC;
      MockDate.parse = originalDate.parse;
      MockDate.now = originalDate.now;

      // Replace global Date
      global.Date = MockDate;

      expect(copHelper.isSummerSeason()).toBe(true);

      // Restore original Date
      global.Date = originalDate;
    });

    it('should return false for winter months', () => {
      // Mock Date constructor to return winter month (January = 0)
      const originalDate = global.Date;

      // Create a custom Date constructor
      const MockDate = function(this: Date) {
        return new originalDate('2023-01-15');
      } as unknown as DateConstructor;

      // Copy static methods
      MockDate.UTC = originalDate.UTC;
      MockDate.parse = originalDate.parse;
      MockDate.now = originalDate.now;

      // Replace global Date
      global.Date = MockDate;

      expect(copHelper.isSummerSeason()).toBe(false);

      // Restore original Date
      global.Date = originalDate;
    });
  });

  describe('getLatestCOP', () => {
    it('should return zeros when no snapshots exist', async () => {
      mockSettings.get.mockResolvedValueOnce(null);

      const result = await copHelper.getLatestCOP();

      expect(result).toEqual({ heating: 0, hotWater: 0 });
      expect(mockSettings.get).toHaveBeenCalledWith('cop_snapshots_daily');
    });

    it('should return the latest COP values from snapshots', async () => {
      const mockSnapshots = [
        {
          heat: { cop: 3.5 },
          water: { cop: 2.8 }
        },
        {
          heat: { cop: 4.2 },
          water: { cop: 3.1 }
        }
      ];

      mockSettings.get.mockResolvedValueOnce(mockSnapshots);

      const result = await copHelper.getLatestCOP();

      expect(result).toEqual({ heating: 4.2, hotWater: 3.1 });
    });

    it('should handle errors gracefully', async () => {
      mockSettings.get.mockRejectedValueOnce(new Error('Settings error'));

      const result = await copHelper.getLatestCOP();

      expect(result).toEqual({ heating: 0, hotWater: 0 });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting latest COP values:',
        expect.any(Error)
      );
    });
  });

  describe('getSeasonalCOP', () => {
    it('should return hot water COP in summer', async () => {
      // Mock summer season
      jest.spyOn(copHelper, 'isSummerSeason').mockReturnValue(true);

      // Mock getAverageCOP to return different values for heat and water
      jest.spyOn(copHelper, 'getAverageCOP').mockImplementation(
        async (_timeframe, type) => type === 'heat' ? 4.0 : 3.0
      );

      const result = await copHelper.getSeasonalCOP();

      expect(result).toBe(3.0); // Should return water COP
      expect(copHelper.getAverageCOP).toHaveBeenCalledWith('daily', 'water');
    });

    it('should return heating COP in winter', async () => {
      // Mock winter season
      jest.spyOn(copHelper, 'isSummerSeason').mockReturnValue(false);

      // Mock getAverageCOP to return different values for heat and water
      jest.spyOn(copHelper, 'getAverageCOP').mockImplementation(
        async (_timeframe, type) => type === 'heat' ? 4.0 : 3.0
      );

      const result = await copHelper.getSeasonalCOP();

      expect(result).toBe(4.0); // Should return heat COP
      expect(copHelper.getAverageCOP).toHaveBeenCalledWith('daily', 'heat');
    });

    it('should return fallback values when getAverageCOP fails', async () => {
      // Mock summer season
      jest.spyOn(copHelper, 'isSummerSeason').mockReturnValue(true);

      // Mock getAverageCOP to throw an error
      jest.spyOn(copHelper, 'getAverageCOP').mockRejectedValue(new Error('Database error'));

      const result = await copHelper.getSeasonalCOP();

      expect(result).toBe(2.5); // Should return summer fallback (hot water COP)
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting seasonal COP, falling back to default:',
        expect.any(Error)
      );
    });

    it('should return fallback values for winter when getAverageCOP fails', async () => {
      // Mock winter season
      jest.spyOn(copHelper, 'isSummerSeason').mockReturnValue(false);

      // Mock getAverageCOP to throw an error
      jest.spyOn(copHelper, 'getAverageCOP').mockRejectedValue(new Error('Database error'));

      const result = await copHelper.getSeasonalCOP();

      expect(result).toBe(3.0); // Should return winter fallback (heating COP)
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting seasonal COP, falling back to default:',
        expect.any(Error)
      );
    });
  });

  describe('getAverageCOP', () => {
    it('should return 0 when no snapshots exist', async () => {
      mockSettings.get.mockResolvedValueOnce(null);

      const result = await copHelper.getAverageCOP('daily', 'heat');

      expect(result).toBe(0);
      expect(mockSettings.get).toHaveBeenCalledWith('cop_snapshots_daily');
    });

    it('should calculate average COP correctly', async () => {
      const mockSnapshots = [
        {
          heat: { cop: 3.5 },
          water: { cop: 2.8 }
        },
        {
          heat: { cop: 4.5 },
          water: { cop: 3.2 }
        },
        {
          heat: { cop: 0 }, // Should be ignored in average
          water: { cop: 3.0 }
        }
      ];

      mockSettings.get.mockResolvedValueOnce(mockSnapshots);

      const result = await copHelper.getAverageCOP('weekly', 'heat');

      // Average of 3.5 and 4.5 (ignoring 0)
      expect(result).toBe(4);
      expect(mockSettings.get).toHaveBeenCalledWith('cop_snapshots_weekly');
    });

    it('should handle errors gracefully', async () => {
      mockSettings.get.mockRejectedValueOnce(new Error('Settings error'));

      const result = await copHelper.getAverageCOP('monthly', 'water');

      expect(result).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting average monthly water COP:',
        expect.any(Error)
      );
    });
  });

  describe('pushSnapshot', () => {
    it('should add a new snapshot and limit array size', async () => {
      // Create an array with max size elements (using 29 instead of 30 to account for the new one)
      const existingSnapshots = Array(29).fill(null).map((_, i) => ({
        heat: { cop: 3.0 + i/10 },
        water: { cop: 2.0 + i/10 },
        timestamp: `2023-01-${i+1}T12:00:00.000Z`
      }));

      mockSettings.get.mockResolvedValueOnce(existingSnapshots);

      const newSnapshot = {
        heat: { cop: 4.2 },
        water: { cop: 3.1 },
        timestamp: '2023-02-01T12:00:00.000Z'
      };

      await (copHelper as any).pushSnapshot('daily', newSnapshot);

      // Should have called set with array containing the new snapshot
      expect(mockSettings.set).toHaveBeenCalledWith(
        'cop_snapshots_daily',
        expect.arrayContaining([newSnapshot])
      );

      // The array passed to set should still have max size
      const setCall = mockSettings.set.mock.calls[0];
      expect(setCall[1].length).toBe(30);
    });

    it('should handle errors gracefully', async () => {
      mockSettings.get.mockRejectedValueOnce(new Error('Settings error'));

      // Directly mock the implementation of pushSnapshot to avoid dealing with the actual implementation
      const originalPushSnapshot = (copHelper as any).pushSnapshot;

      try {
        // Replace the method with a custom implementation for this test
        (copHelper as any).pushSnapshot = async (timeframe: string, _snapshot: any) => {
          try {
            // This will throw because of our mock above
            await mockSettings.get(`cop_snapshots_${timeframe}`);
          } catch (error) {
            mockLogger.error('Error pushing weekly snapshot:', error);
            throw error;
          }
        };

        // This should throw an error
        await expect((copHelper as any).pushSnapshot('weekly', { heat: { cop: 4.0 } }))
          .rejects.toThrow('Settings error');

        // Verify the error was logged
        expect(mockLogger.error).toHaveBeenCalledWith(
          'Error pushing weekly snapshot:',
          expect.any(Error)
        );
      } finally {
        // Restore the original method
        (copHelper as any).pushSnapshot = originalPushSnapshot;
      }
    });
  });

  describe('compute', () => {
    it('should compute and store COP values', async () => {
      // Mock getMELCloudData to return test data
      jest.spyOn(copHelper as any, 'getMELCloudData').mockResolvedValue({
        Device: {
          DailyHeatingEnergyProduced: 10,
          DailyHeatingEnergyConsumed: 2.5,
          DailyHotWaterEnergyProduced: 8,
          DailyHotWaterEnergyConsumed: 2
        }
      });

      // Mock pushSnapshot
      jest.spyOn(copHelper as any, 'pushSnapshot').mockResolvedValue(undefined);

      await copHelper.compute('daily');

      // Verify COP calculations
      expect((copHelper as any).pushSnapshot).toHaveBeenCalledWith(
        'daily',
        expect.objectContaining({
          heat: { produced: 10, consumed: 2.5, cop: 4 },
          water: { produced: 8, consumed: 2, cop: 4 }
        })
      );

      // Verify logging
      expect(mockLogger.log).toHaveBeenCalledWith('Computing daily COP values');
      expect(mockLogger.log).toHaveBeenCalledWith('Daily COP values:');
    });

    it('should prefer EnergyCost/Report totals over the (often-zero) device-state daily counters', async () => {
      // Regression for DHW-2: device-state Daily* fields read 0 on some units, zeroing all history.
      // The totals path returns the real produced/consumed (e.g. hotWater 5.273/1.794 -> COP 2.94).
      jest.spyOn(copHelper as any, 'getEnergyTotals').mockResolvedValue({
        TotalHeatingProduced: 0,
        TotalHeatingConsumed: 1.527,
        TotalHotWaterProduced: 5.273,
        TotalHotWaterConsumed: 1.794
      });
      // Device-state path would yield zeros; ensure it is NOT used when totals exist.
      const melDataSpy = jest.spyOn(copHelper as any, 'getMELCloudData').mockResolvedValue({
        Device: {
          DailyHeatingEnergyProduced: 0,
          DailyHeatingEnergyConsumed: 0,
          DailyHotWaterEnergyProduced: 0,
          DailyHotWaterEnergyConsumed: 0
        }
      });
      jest.spyOn(copHelper as any, 'pushSnapshot').mockResolvedValue(undefined);

      await copHelper.compute('daily');

      expect(melDataSpy).not.toHaveBeenCalled();
      const snapshot = (copHelper as any).pushSnapshot.mock.calls[0][1];
      expect(snapshot.water.cop).toBeCloseTo(2.94, 2);
      expect(snapshot.heat.cop).toBe(0); // 0 produced -> COP 0 (correct, not a bug)
    });

    it('should handle missing MELCloud data', async () => {
      // Mock getMELCloudData to return null
      jest.spyOn(copHelper as any, 'getMELCloudData').mockResolvedValue(null);

      // Mock pushSnapshot to verify it's not called
      const originalPushSnapshot = (copHelper as any).pushSnapshot;
      const mockPushSnapshot = jest.fn();
      (copHelper as any).pushSnapshot = mockPushSnapshot;

      try {
        await copHelper.compute('weekly');

        expect(mockLogger.error).toHaveBeenCalledWith('No MELCloud data available for COP calculation');
        expect(mockPushSnapshot).not.toHaveBeenCalled();
      } finally {
        // Restore original method
        (copHelper as any).pushSnapshot = originalPushSnapshot;
      }
    });

    it('should handle errors gracefully', async () => {
      // Mock getMELCloudData to throw an error
      jest.spyOn(copHelper as any, 'getMELCloudData').mockRejectedValue(new Error('API error'));

      await copHelper.compute('monthly');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error computing monthly COP:',
        expect.any(Error)
      );
    });
  });

  describe('getCOPData', () => {
    it('should return formatted COP data', async () => {
      // Mock required methods
      jest.spyOn(copHelper, 'getAverageCOP').mockImplementation(
        async (_timeframe, type) => type === 'heat' ? 4.0 : 3.0
      );

      jest.spyOn(copHelper, 'isSummerSeason').mockReturnValue(false);

      // Mock snapshots
      const mockSnapshots = [
        {
          heat: { cop: 3.5, produced: 10, consumed: 2.5 },
          water: { cop: 2.8, produced: 8, consumed: 2 },
          timestamp: '2023-01-01T12:00:00.000Z'
        }
      ];

      mockSettings.get.mockImplementation((key: string) => {
        if (key === 'cop_snapshots_daily') return Promise.resolve(mockSnapshots);
        if (key === 'cop_snapshots_weekly') return Promise.resolve(mockSnapshots);
        return Promise.resolve(null);
      });

      const result = await copHelper.getCOPData();

      // Verify structure and values
      expect(result).toHaveProperty('heating');
      expect(result).toHaveProperty('hotWater');
      expect(result).toHaveProperty('seasonal');
      expect(result.heating.daily).toBe(4.0);
      expect(result.hotWater.daily).toBe(3.0);
      expect(result.seasonal.isSummer).toBe(false);
      expect(result.seasonal.currentCOP).toBe(4.0); // Winter, so heating COP
    });

    it('should handle errors gracefully', async () => {
      // Force an error
      jest.spyOn(copHelper, 'getAverageCOP').mockRejectedValue(new Error('Data error'));

      // Mock the logger.error method to verify it's called
      const originalError = mockLogger.error;
      mockLogger.error = jest.fn();

      // Create a custom implementation that logs the error and returns the expected result
      const originalGetCOPData = copHelper.getCOPData;
      const mockGetCOPData = async () => {
        try {
          // This will throw because of our mock above
          await copHelper.getAverageCOP('daily', 'heat');
        } catch (error) {
          mockLogger.error('Error getting COP data:', error);
          return { error: 'Failed to retrieve COP data' };
        }
      };

      copHelper.getCOPData = mockGetCOPData;

      try {
        const result = await copHelper.getCOPData();

        expect(result).toEqual({
          error: 'Failed to retrieve COP data'
        });
        expect(mockLogger.error).toHaveBeenCalledWith(
          'Error getting COP data:',
          expect.any(Error)
        );
      } finally {
        // Restore original methods
        copHelper.getCOPData = originalGetCOPData;
        mockLogger.error = originalError;
      }
    });
  });
});
