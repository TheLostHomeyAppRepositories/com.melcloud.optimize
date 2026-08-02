/**
 * Energy Metrics Service Tests
 *
 * Comprehensive test suite covering:
 * - getRealEnergyMetrics with enhanced COP data
 * - Fallback behavior when enhanced data fails
 * - Seasonal mode detection (summer/winter/transition)
 * - Optimization focus determination
 * - Cache behavior (lastEnergyData, optimizationMetrics)
 * - Edge cases and error handling
 */

import {
  EnergyMetricsService,
  EnergyMetricsServiceDeps,
  EnergyMetricsLogger,
  ENERGY_METRICS_CONFIG,
  SeasonalMode,
  OptimizationFocus,
  COPTrends,
} from '../../src/services/energy-metrics-service';
import { CopNormalizer } from '../../src/services/cop-normalizer';
import { HotWaterUsageLearner } from '../../src/services/hot-water-usage-learner';
import { MelCloudApi } from '../../src/services/melcloud-api';
import { EnhancedCOPData, DailyCOPData } from '../../src/types/enhanced-cop-data';
import { OptimizationMetrics, RealEnergyData } from '../../src/types';

// Mock MelCloudApi
jest.mock('../../src/services/melcloud-api');

describe('EnergyMetricsService', () => {
  let mockMelCloud: jest.Mocked<MelCloudApi>;
  let mockCopNormalizer: jest.Mocked<CopNormalizer>;
  let mockHotWaterUsageLearner: jest.Mocked<HotWaterUsageLearner>;
  let mockLogger: jest.Mocked<EnergyMetricsLogger>;
  let mockGetHotWaterService: jest.Mock;
  let service: EnergyMetricsService;

  const createMockEnhancedCOPData = (overrides: Partial<EnhancedCOPData> = {}): EnhancedCOPData => ({
    current: {
      heating: 3.5,
      hotWater: 2.8,
      outdoor: 5,
      timestamp: new Date(),
      ...overrides.current,
    },
    daily: {
      TotalHeatingConsumed: 15, // > 5 * 2 to trigger winter mode
      TotalHeatingProduced: 52.5,
      TotalHotWaterConsumed: 5,
      TotalHotWaterProduced: 14,
      heatingCOP: 3.5,
      hotWaterCOP: 2.8,
      SampledDays: 7,
      ...overrides.daily,
    } as DailyCOPData,
    historical: {
      heating: 3.2,
      hotWater: 2.5,
      ...overrides.historical,
    },
    trends: {
      heatingTrend: 'stable',
      hotWaterTrend: 'stable',
      averageHeating: 3.2,
      averageHotWater: 2.5,
      ...overrides.trends,
    },
    predictions: {
      nextHourHeating: 3.4,
      nextHourHotWater: 2.7,
      confidenceLevel: 0.8,
      ...overrides.predictions,
    },
  });

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    mockMelCloud = {
      getEnhancedCOPData: jest.fn(),
      getDailyEnergyTotals: jest.fn(),
    } as unknown as jest.Mocked<MelCloudApi>;

    mockCopNormalizer = {
      updateRange: jest.fn(),
      normalize: jest.fn((cop: number) => Math.min(cop / 5, 1)), // Simple normalization for testing
      getState: jest.fn(() => ({
        minObserved: 1.5,
        maxObserved: 4.5,
        updateCount: 100,
        history: [],
      })),
    } as unknown as jest.Mocked<CopNormalizer>;

    mockHotWaterUsageLearner = {
      refreshFromService: jest.fn(),
    } as unknown as jest.Mocked<HotWaterUsageLearner>;

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockGetHotWaterService = jest.fn(() => null);

    const deps: EnergyMetricsServiceDeps = {
      melCloud: mockMelCloud,
      copNormalizer: mockCopNormalizer,
      hotWaterUsageLearner: mockHotWaterUsageLearner,
      logger: mockLogger,
      getHotWaterService: mockGetHotWaterService,
    };

    service = new EnergyMetricsService(deps);
  });

  describe('getRealEnergyMetrics', () => {
    it('should return optimization metrics from enhanced COP data', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      const result = await service.getRealEnergyMetrics('device1', 123);

      expect(result).toBeDefined();
      expect(result!.realHeatingCOP).toBe(3.5);
      expect(result!.realHotWaterCOP).toBe(2.8);
      expect(result!.seasonalMode).toBe('winter'); // heatingConsumed > hotWaterConsumed * 2
      expect(mockMelCloud.getEnhancedCOPData).toHaveBeenCalledWith('device1', 123);
    });

    it('should update COP normalizer with observed COP values', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(3.5);
      expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(2.8);
    });

    it('should calculate daily energy consumption correctly', async () => {
      const enhancedData = createMockEnhancedCOPData({
        daily: {
          TotalHeatingConsumed: 70,
          TotalHotWaterConsumed: 28,
          TotalHeatingProduced: 245,
          TotalHotWaterProduced: 78,
          SampledDays: 7,
        } as DailyCOPData,
      });
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      const result = await service.getRealEnergyMetrics('device1', 123);

      expect(result!.dailyEnergyConsumption).toBe(14); // (70 + 28) / 7
    });

    it('should use fallback COP values when current values are zero', async () => {
      const enhancedData = createMockEnhancedCOPData({
        current: {
          heating: 0,
          hotWater: 0,
          outdoor: 5,
          timestamp: new Date(),
        },
        daily: {
          TotalHeatingConsumed: 10,
          TotalHotWaterConsumed: 5,
          TotalHeatingProduced: 35,
          TotalHotWaterProduced: 14,
          heatingCOP: 3.0,
          hotWaterCOP: 2.5,
        } as DailyCOPData,
        historical: {
          heating: 3.0,
          hotWater: 2.5,
        },
      });
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      const result = await service.getRealEnergyMetrics('device1', 123);

      // Should use derived values from daily/historical
      expect(result!.realHeatingCOP).toBe(3.0);
      expect(result!.realHotWaterCOP).toBe(2.5);
    });

    it('should cache last energy data', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      const lastData = service.getLastEnergyData();
      expect(lastData).toBeDefined();
      expect(lastData!.TotalHeatingConsumed).toBe(15);
      expect(lastData!.TotalHotWaterConsumed).toBe(5);
    });

    it('should cache optimization metrics', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      const metrics = service.getOptimizationMetrics();
      expect(metrics).toBeDefined();
      expect(metrics!.seasonalMode).toBe('winter');
    });

    it('should refresh hot water usage pattern', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      expect(mockHotWaterUsageLearner.refreshFromService).toHaveBeenCalled();
    });

    it('should fallback to basic metrics when enhanced data fails', async () => {
      mockMelCloud.getEnhancedCOPData.mockRejectedValue(new Error('API Error'));
      mockMelCloud.getDailyEnergyTotals.mockResolvedValue({
        TotalHeatingConsumed: 20,
        TotalHotWaterConsumed: 8,
        TotalHeatingProduced: 60,
        TotalHotWaterProduced: 20,
        heatingCOP: 3.0,
        SampledDays: 7,
      } as DailyCOPData);

      const result = await service.getRealEnergyMetrics('device1', 123);

      expect(result).toBeDefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error getting enhanced energy metrics:',
        expect.any(Error)
      );
      expect(mockLogger.log).toHaveBeenCalledWith('Using fallback energy metrics calculation');
    });

    it('should return null when both enhanced and fallback fail', async () => {
      mockMelCloud.getEnhancedCOPData.mockRejectedValue(new Error('API Error'));
      mockMelCloud.getDailyEnergyTotals.mockRejectedValue(new Error('Fallback Error'));

      const result = await service.getRealEnergyMetrics('device1', 123);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error with fallback energy metrics:',
        expect.any(Error)
      );
    });
  });

  describe('determineSeason', () => {
    it('should return summer when heating consumption is very low', () => {
      const result = service.determineSeason(0.5, 5);
      expect(result).toBe('summer');
    });

    it('should return winter when heating is dominant', () => {
      const result = service.determineSeason(20, 5);
      expect(result).toBe('winter');
    });

    it('should return transition when heating and hot water are balanced', () => {
      const result = service.determineSeason(8, 5);
      expect(result).toBe('transition');
    });

    it('should use configured thresholds', () => {
      // Test with exact threshold values
      const atThreshold = service.determineSeason(
        ENERGY_METRICS_CONFIG.MIN_HEATING_FOR_WINTER,
        5
      );
      expect(atThreshold).not.toBe('summer'); // At threshold, should be winter or transition

      const belowThreshold = service.determineSeason(
        ENERGY_METRICS_CONFIG.MIN_HEATING_FOR_WINTER - 0.1,
        5
      );
      expect(belowThreshold).toBe('summer');
    });

    it('should return summer when no heat is produced even if standby keeps consumption above threshold', () => {
      // Live June case: 1.527 kWh consumed (standby), 0 produced, 1.794 hot water -> was stuck "transition".
      const result = service.determineSeason(1.527, 1.794, 0);
      expect(result).toBe('summer');
    });

    it('should preserve legacy classification when heatingProduced is omitted', () => {
      // Same consumed/hotwater as above but no produced arg -> old behavior (transition).
      expect(service.determineSeason(1.527, 1.794)).toBe('transition');
    });

    it('should NOT force summer in a genuine shoulder period with real heat output', () => {
      // Real heating happening -> classifier unaffected by either summer guard.
      // 24 kWh produced from 8 kWh consumed is COP 3.0, typical for an air-to-water unit in
      // shoulder conditions. The original fixture used 6 kWh produced from 8 consumed, i.e.
      // COP 0.75 - a pump delivering less heat than the electricity it draws, which is not a
      // shoulder period but the parasitic-standby signature the COP guard exists to catch.
      const result = service.determineSeason(8, 5, 24);
      expect(result).toBe('transition');
    });

    it('should classify sub-unity heating COP as summer even when kWh look substantial', () => {
      // Live 2026-08-01 values, scaled: the pump drew 1.766 kWh and produced 1.221 kWh at 17 C
      // outdoor. That cleared the 0.5 kWh produced floor and was classified 'transition' all
      // summer, which is the bug this guard closes.
      expect(service.determineSeason(1.766, 1.467, 1.221)).toBe('summer');
    });
  });

  describe('determineOptimizationFocus', () => {
    const createTrends = (
      heatingTrend: 'improving' | 'stable' | 'declining',
      hotWaterTrend: 'improving' | 'stable' | 'declining'
    ): COPTrends => ({
      heatingTrend,
      hotWaterTrend,
    });

    it('should focus on hotwater in summer', () => {
      const result = service.determineOptimizationFocus(
        createTrends('stable', 'stable'),
        'summer',
        0.5,
        5
      );
      expect(result).toBe('hotwater');
    });

    it('should focus on heating in winter when heating trend is not declining', () => {
      const result = service.determineOptimizationFocus(
        createTrends('stable', 'stable'),
        'winter',
        20,
        5
      );
      expect(result).toBe('heating');
    });

    it('should focus on both in winter when heating trend is declining', () => {
      const result = service.determineOptimizationFocus(
        createTrends('declining', 'stable'),
        'winter',
        20,
        5
      );
      expect(result).toBe('both');
    });

    it('should focus on heating in transition when heating is improving and hotwater is stable', () => {
      const result = service.determineOptimizationFocus(
        createTrends('improving', 'stable'),
        'transition',
        8,
        5
      );
      expect(result).toBe('heating');
    });

    it('should focus on hotwater in transition when hotwater is improving and heating is stable', () => {
      const result = service.determineOptimizationFocus(
        createTrends('stable', 'improving'),
        'transition',
        8,
        5
      );
      expect(result).toBe('hotwater');
    });

    it('should focus on both in transition when both are stable', () => {
      const result = service.determineOptimizationFocus(
        createTrends('stable', 'stable'),
        'transition',
        8,
        5
      );
      expect(result).toBe('both');
    });

    it('should focus on both in transition when both are declining', () => {
      const result = service.determineOptimizationFocus(
        createTrends('declining', 'declining'),
        'transition',
        8,
        5
      );
      expect(result).toBe('both');
    });
  });

  describe('cache management', () => {
    it('should return null for lastEnergyData before any metrics are retrieved', () => {
      expect(service.getLastEnergyData()).toBeNull();
    });

    it('should return null for optimizationMetrics before any metrics are retrieved', () => {
      expect(service.getOptimizationMetrics()).toBeNull();
    });

    it('should clear cache when clearCache is called', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);
      expect(service.getLastEnergyData()).not.toBeNull();
      expect(service.getOptimizationMetrics()).not.toBeNull();

      service.clearCache();

      expect(service.getLastEnergyData()).toBeNull();
      expect(service.getOptimizationMetrics()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle zero sampled days gracefully', async () => {
      const enhancedData = createMockEnhancedCOPData({
        daily: {
          TotalHeatingConsumed: 10,
          TotalHotWaterConsumed: 5,
          TotalHeatingProduced: 35,
          TotalHotWaterProduced: 14,
          SampledDays: 0,
        } as DailyCOPData,
      });
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      const result = await service.getRealEnergyMetrics('device1', 123);

      // Should use 1 as minimum sampled days
      expect(result!.dailyEnergyConsumption).toBe(15); // (10 + 5) / 1
    });

    it('should handle undefined sampled days', async () => {
      const enhancedData = createMockEnhancedCOPData({
        daily: {
          TotalHeatingConsumed: 10,
          TotalHotWaterConsumed: 5,
          TotalHeatingProduced: 35,
          TotalHotWaterProduced: 14,
          SampledDays: undefined,
        } as DailyCOPData,
      });
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      const result = await service.getRealEnergyMetrics('device1', 123);

      expect(result!.dailyEnergyConsumption).toBe(15); // (10 + 5) / 1
    });

    it('should not update COP range when COP values are zero', async () => {
      const enhancedData = createMockEnhancedCOPData({
        current: {
          heating: 0,
          hotWater: 0,
          outdoor: 5,
          timestamp: new Date(),
        },
        daily: {
          TotalHeatingConsumed: 10,
          TotalHotWaterConsumed: 5,
          TotalHeatingProduced: 0,
          TotalHotWaterProduced: 0,
          heatingCOP: 0,
          hotWaterCOP: 0,
        } as DailyCOPData,
        historical: {
          heating: 0,
          hotWater: 0,
        },
      });
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      expect(mockCopNormalizer.updateRange).not.toHaveBeenCalled();
    });

    it('should handle CoP array with mixed formats', async () => {
      const enhancedData = createMockEnhancedCOPData({
        daily: {
          TotalHeatingConsumed: 10,
          TotalHotWaterConsumed: 5,
          TotalHeatingProduced: 35,
          TotalHotWaterProduced: 14,
          CoP: [3.0, { hour: 1, value: 3.2 }, null, 'invalid', 3.5] as any,
        } as DailyCOPData,
      });
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      const lastData = service.getLastEnergyData();
      expect(lastData!.CoP).toEqual([3.0, 3.2, 3.5]); // Only valid numbers
    });
  });

  describe('logging', () => {
    it('should log enhanced energy metrics with all relevant data', async () => {
      const enhancedData = createMockEnhancedCOPData();
      mockMelCloud.getEnhancedCOPData.mockResolvedValue(enhancedData);

      await service.getRealEnergyMetrics('device1', 123);

      expect(mockLogger.log).toHaveBeenCalledWith(
        'Enhanced energy metrics calculated:',
        expect.objectContaining({
          heatingCOP: expect.any(String),
          hotWaterCOP: expect.any(String),
          seasonalMode: 'winter',
          optimizationFocus: expect.any(String),
        })
      );
    });
  });
});
