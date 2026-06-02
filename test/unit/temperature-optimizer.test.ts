/**
 * Temperature Optimizer Service Tests
 *
 * Comprehensive test suite covering:
 * - calculateOptimalTemperature with price-based optimization
 * - calculateOptimalTemperatureWithRealData with real energy metrics
 * - COP adjustments (excellent, good, poor, very poor)
 * - Seasonal mode handling (summer, winter, transition)
 * - Comfort band constraints
 * - Adaptive parameters integration
 * - Edge cases and error handling
 */

import {
  TemperatureOptimizer,
  TemperatureOptimizerDeps,
  TemperatureOptimizerLogger,
  ComfortBand,
  PriceStats,
  TemperatureOptimizationResult,
} from '../../src/services/temperature-optimizer';
import { CopNormalizer } from '../../src/services/cop-normalizer';
import { COPHelper } from '../../src/services/cop-helper';
import { AdaptiveParametersLearner } from '../../src/services/adaptive-parameters';
import { OptimizationMetrics } from '../../src/types';

// Mock dependencies
jest.mock('../../src/services/cop-normalizer');
jest.mock('../../src/services/cop-helper');

describe('TemperatureOptimizer', () => {
  let mockCopNormalizer: jest.Mocked<CopNormalizer>;
  let mockCopHelper: jest.Mocked<COPHelper>;
  let mockAdaptiveParametersLearner: jest.Mocked<AdaptiveParametersLearner>;
  let mockLogger: jest.Mocked<TemperatureOptimizerLogger>;
  let optimizer: TemperatureOptimizer;

  const defaultComfortBand: ComfortBand = {
    minTemp: 19,
    maxTemp: 23,
  };

  const defaultPriceStats: PriceStats = {
    currentPrice: 1.0,
    avgPrice: 1.0,
    minPrice: 0.5,
    maxPrice: 2.0,
  };

  const createMockMetrics = (overrides: Partial<OptimizationMetrics> = {}): OptimizationMetrics => ({
    realHeatingCOP: 3.0,
    realHotWaterCOP: 2.5,
    seasonalMode: 'winter',
    optimizationFocus: 'heating',
    dailyEnergyConsumption: 25,
    heatingEfficiency: 75,
    hotWaterEfficiency: 65,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockCopNormalizer = {
      updateRange: jest.fn(),
      normalize: jest.fn((cop: number) => Math.min(cop / 5, 1)),
      getState: jest.fn(() => ({
        minObserved: 1.5,
        maxObserved: 4.5,
        updateCount: 100,
        history: [],
      })),
    } as unknown as jest.Mocked<CopNormalizer>;

    mockCopHelper = {
      isSummerSeason: jest.fn(() => false),
      getSeasonalCOP: jest.fn(async () => 3.0),
    } as unknown as jest.Mocked<COPHelper>;

    mockAdaptiveParametersLearner = {
      getParameters: jest.fn(() => ({
        priceWeightSummer: 0.7,
        priceWeightWinter: 0.4,
        priceWeightTransition: 0.5,
        copEfficiencyBonusHigh: 0.3,
        copEfficiencyBonusMedium: 0.2,
        excellentCOPThreshold: 0.8,
        goodCOPThreshold: 0.5,
        minimumCOPThreshold: 0.2,
        veryCheapMultiplier: 0.8,
        preheatAggressiveness: 2.0,
        coastingReduction: 1.5,
        boostIncrease: 0.5,
        copAdjustmentExcellent: 0.2,
        copAdjustmentGood: 0.3,
        copAdjustmentPoor: 0.8,
        copAdjustmentVeryPoor: 1.2,
        summerModeReduction: 0.5,
        confidence: 0.7,
        lastUpdated: new Date().toISOString(),
        learningCycles: 100,
      })),
      getStrategyThresholds: jest.fn(() => ({
        excellentCOPThreshold: 0.8,
        goodCOPThreshold: 0.5,
        minimumCOPThreshold: 0.2,
        veryCheapMultiplier: 0.8,
        preheatAggressiveness: 2.0,
        coastingReduction: 1.5,
        boostIncrease: 0.5,
        copAdjustmentExcellent: 0.2,
        copAdjustmentGood: 0.3,
        copAdjustmentPoor: 0.8,
        copAdjustmentVeryPoor: 1.2,
        summerModeReduction: 0.5,
      })),
    } as unknown as jest.Mocked<AdaptiveParametersLearner>;

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const deps: TemperatureOptimizerDeps = {
      copNormalizer: mockCopNormalizer,
      copHelper: mockCopHelper,
      adaptiveParametersLearner: mockAdaptiveParametersLearner,
      logger: mockLogger,
      copWeight: 0.5,
      autoSeasonalMode: true,
      summerMode: false,
    };

    optimizer = new TemperatureOptimizer(deps);
  });

  describe('calculateOptimalTemperature', () => {
    it('should return temperature within comfort band for average price', async () => {
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      const result = await optimizer.calculateOptimalTemperature(
        { currentPrice: 1.0, avgPrice: 1.0, minPrice: 0.5, maxPrice: 2.0 },
        21.0,
        defaultComfortBand
      );

      expect(result).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });

    it('should increase temperature for low prices', async () => {
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      const lowPriceResult = await optimizer.calculateOptimalTemperature(
        { currentPrice: 0.5, avgPrice: 1.0, minPrice: 0.5, maxPrice: 2.0 },
        21.0,
        defaultComfortBand
      );

      const avgPriceResult = await optimizer.calculateOptimalTemperature(
        { currentPrice: 1.0, avgPrice: 1.0, minPrice: 0.5, maxPrice: 2.0 },
        21.0,
        defaultComfortBand
      );

      expect(lowPriceResult).toBeGreaterThanOrEqual(avgPriceResult);
    });

    it('should decrease temperature for high prices', async () => {
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      const highPriceResult = await optimizer.calculateOptimalTemperature(
        { currentPrice: 2.0, avgPrice: 1.0, minPrice: 0.5, maxPrice: 2.0 },
        21.0,
        defaultComfortBand
      );

      const avgPriceResult = await optimizer.calculateOptimalTemperature(
        { currentPrice: 1.0, avgPrice: 1.0, minPrice: 0.5, maxPrice: 2.0 },
        21.0,
        defaultComfortBand
      );

      expect(highPriceResult).toBeLessThanOrEqual(avgPriceResult);
    });

    it('should handle equal min and max prices', async () => {
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      const result = await optimizer.calculateOptimalTemperature(
        { currentPrice: 1.0, avgPrice: 1.0, minPrice: 1.0, maxPrice: 1.0 },
        21.0,
        defaultComfortBand
      );

      expect(result).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });

    it('should apply COP adjustment for excellent COP', async () => {
      // Normalize returns 0.9 for COP of 4.5 (> 0.8 threshold)
      mockCopNormalizer.normalize.mockReturnValue(0.9);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(4.5);

      const result = await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(4.5);
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Excellent COP'));
    });

    it('should apply COP adjustment for good COP', async () => {
      mockCopNormalizer.normalize.mockReturnValue(0.6);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Good COP'));
    });

    it('should apply COP adjustment for poor COP', async () => {
      mockCopNormalizer.normalize.mockReturnValue(0.25);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(1.25);

      await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Poor COP'));
    });

    it('should apply COP adjustment for very poor COP', async () => {
      mockCopNormalizer.normalize.mockReturnValue(0.15);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(0.75);

      await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Very poor COP'));
    });

    it('should apply summer mode adjustment', async () => {
      mockCopHelper.isSummerSeason.mockReturnValue(true);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);
      mockCopNormalizer.normalize.mockReturnValue(0.6);

      await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('summer mode adjustment'));
    });

    it('should handle COP helper errors gracefully', async () => {
      mockCopHelper.getSeasonalCOP.mockRejectedValue(new Error('COP fetch failed'));

      const result = await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockLogger.error).toHaveBeenCalledWith('Error applying COP adjustment:', expect.any(Error));
      expect(result).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });

    it('should skip COP adjustment when copWeight is 0', async () => {
      optimizer.updateCOPSettings(0, true, false);

      const result = await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockCopHelper.getSeasonalCOP).not.toHaveBeenCalled();
      expect(result).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });

    it('should use manual summerMode when autoSeasonalMode is false', async () => {
      optimizer.updateCOPSettings(0.5, false, true);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);
      mockCopNormalizer.normalize.mockReturnValue(0.6);

      await optimizer.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(mockCopHelper.isSummerSeason).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('summer mode adjustment'));
    });
  });

  describe('calculateOptimalTemperatureWithRealData', () => {
    it('should fall back to basic optimization when metrics is null', async () => {
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      const result = await optimizer.calculateOptimalTemperatureWithRealData(
        defaultPriceStats,
        21.0,
        10.0,
        defaultComfortBand,
        null
      );

      expect(result.reason).toBe('Using basic optimization (no real energy data available)');
      expect(result.targetTemp).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result.targetTemp).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });

    it('should use custom basicCalculator when provided and metrics is null', async () => {
      const customCalculator = jest.fn(async () => 21.5);

      const result = await optimizer.calculateOptimalTemperatureWithRealData(
        defaultPriceStats,
        21.0,
        10.0,
        defaultComfortBand,
        null,
        customCalculator
      );

      expect(customCalculator).toHaveBeenCalled();
      expect(result.targetTemp).toBe(21.5);
    });

    describe('summer mode', () => {
      it('should optimize for hot water efficiency in summer', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'summer',
          realHotWaterCOP: 3.5,
          realHeatingCOP: 2.0,
        });

        mockCopNormalizer.normalize.mockReturnValue(0.85);

        const result = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          25.0,
          defaultComfortBand,
          metrics
        );

        expect(result.reason).toContain('Summer mode');
        expect(result.reason).toContain('Hot water COP');
        expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(3.5);
      });

      it('should apply efficiency bonus for excellent hot water COP in summer', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'summer',
          realHotWaterCOP: 4.5,
        });

        mockCopNormalizer.normalize.mockReturnValue(0.9);

        const result = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          25.0,
          defaultComfortBand,
          metrics
        );

        expect(result.reason).toContain('Summer mode');
        // Efficiency bonus applied
        expect(mockAdaptiveParametersLearner.getParameters).toHaveBeenCalled();
      });

      it('should apply penalty for poor hot water COP in summer', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'summer',
          realHotWaterCOP: 1.2,
        });

        mockCopNormalizer.normalize.mockReturnValue(0.2);

        const result = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          25.0,
          defaultComfortBand,
          metrics
        );

        expect(result.reason).toContain('Summer mode');
      });
    });

    describe('winter mode', () => {
      it('should optimize for heating efficiency in winter', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'winter',
          realHeatingCOP: 3.0,
        });

        mockCopNormalizer.normalize.mockReturnValue(0.6);

        const result = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          5.0,
          defaultComfortBand,
          metrics
        );

        expect(result.reason).toContain('Winter mode');
        expect(result.reason).toContain('Heating COP');
        expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(3.0);
      });

      it('should add outdoor temperature adjustment for cold weather', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'winter',
          realHeatingCOP: 3.0,
        });

        mockCopNormalizer.normalize.mockReturnValue(0.6);

        const coldResult = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          2.0, // Cold outdoor
          defaultComfortBand,
          metrics
        );

        const warmResult = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          18.0, // Warm outdoor
          defaultComfortBand,
          metrics
        );

        // Cold weather should result in higher target temperature
        expect(coldResult.targetTemp).toBeGreaterThan(warmResult.targetTemp);
      });

      it('should use adaptive COP thresholds in winter', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'winter',
          realHeatingCOP: 3.0,
        });

        await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          5.0,
          defaultComfortBand,
          metrics
        );

        expect(mockAdaptiveParametersLearner.getStrategyThresholds).toHaveBeenCalled();
      });
    });

    describe('transition mode', () => {
      it('should use combined COP efficiency in transition mode', async () => {
        const metrics = createMockMetrics({
          seasonalMode: 'transition',
          realHeatingCOP: 2.8,
          realHotWaterCOP: 2.5,
        });

        mockCopNormalizer.normalize.mockReturnValue(0.55);

        const result = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats,
          21.0,
          12.0,
          defaultComfortBand,
          metrics
        );

        expect(result.reason).toContain('Transition mode');
        expect(result.reason).toContain('Combined COP efficiency');
        expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(2.8);
        expect(mockCopNormalizer.updateRange).toHaveBeenCalledWith(2.5);
      });

      it('should NOT apply the low-efficiency penalty when heating COP is unmeasured (Fix 5)', async () => {
        // Unmeasured: no recent heat output -> realHeatingCOP 0. The -0.4°C penalty must not fire.
        const unmeasured = createMockMetrics({ seasonalMode: 'transition', realHeatingCOP: 0, realHotWaterCOP: 2.5 });
        mockCopNormalizer.normalize.mockReturnValue(0); // efficiency 0, but it's a non-measurement

        const unmeasuredResult = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats, 21.0, 12.0, defaultComfortBand, unmeasured
        );

        // Measured-but-low: real COP present and low -> penalty SHOULD fire.
        const measuredLow = createMockMetrics({ seasonalMode: 'transition', realHeatingCOP: 1.0, realHotWaterCOP: 2.5 });
        mockCopNormalizer.normalize.mockReturnValue(0.2); // < TRANSITION_EFFICIENCY_LOW (0.4)

        const measuredLowResult = await optimizer.calculateOptimalTemperatureWithRealData(
          defaultPriceStats, 21.0, 12.0, defaultComfortBand, measuredLow
        );

        expect(unmeasuredResult.reason).toMatch(/unmeasured/i);
        expect(measuredLowResult.reason).toContain('Combined COP efficiency');
        // The penalty (−0.4°C) only applies to the measured-low case, so it ends up lower.
        expect(unmeasuredResult.targetTemp).toBeGreaterThan(measuredLowResult.targetTemp);
        expect(unmeasuredResult.targetTemp - measuredLowResult.targetTemp).toBeCloseTo(0.4, 5);
      });
    });

    // COP-based fine-tuning tests removed: the redundant fine-tuning block was removed
    // in Bug 3 fix (double COP adjustment). COP adjustments are now only applied once
    // in the per-season blocks (summer/winter/transition), which are tested above.

    it('should always respect comfort band constraints', async () => {
      const metrics = createMockMetrics({
        seasonalMode: 'winter',
        realHeatingCOP: 0.5, // Very poor COP should push temperature down
      });

      mockCopNormalizer.normalize.mockReturnValue(0.1);

      // Even with very poor COP and high prices, should stay above minTemp
      const result = await optimizer.calculateOptimalTemperatureWithRealData(
        { currentPrice: 5.0, avgPrice: 1.0, minPrice: 0.5, maxPrice: 5.0 },
        21.0,
        5.0,
        defaultComfortBand,
        metrics
      );

      expect(result.targetTemp).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result.targetTemp).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });

    it('should include metrics in result', async () => {
      const metrics = createMockMetrics();

      const result = await optimizer.calculateOptimalTemperatureWithRealData(
        defaultPriceStats,
        21.0,
        10.0,
        defaultComfortBand,
        metrics
      );

      expect(result.metrics).toBe(metrics);
    });
  });

  describe('updateCOPSettings', () => {
    it('should update all COP settings', () => {
      optimizer.updateCOPSettings(0.8, false, true);

      expect(optimizer.getCOPWeight()).toBe(0.8);
    });
  });

  describe('without COP helper', () => {
    it('should work without COP helper', async () => {
      const depsNoCopHelper: TemperatureOptimizerDeps = {
        copNormalizer: mockCopNormalizer,
        copHelper: null,
        adaptiveParametersLearner: mockAdaptiveParametersLearner,
        logger: mockLogger,
        copWeight: 0.5,
        autoSeasonalMode: true,
        summerMode: false,
      };

      const optimizerNoCop = new TemperatureOptimizer(depsNoCopHelper);

      const result = await optimizerNoCop.calculateOptimalTemperature(
        defaultPriceStats,
        21.0,
        defaultComfortBand
      );

      expect(result).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });
  });

  describe('without adaptive parameters learner', () => {
    it('should use default weights without learner', async () => {
      const depsNoLearner: TemperatureOptimizerDeps = {
        copNormalizer: mockCopNormalizer,
        copHelper: mockCopHelper,
        adaptiveParametersLearner: null,
        logger: mockLogger,
        copWeight: 0.5,
        autoSeasonalMode: true,
        summerMode: false,
      };

      const optimizerNoLearner = new TemperatureOptimizer(depsNoLearner);
      mockCopHelper.getSeasonalCOP.mockResolvedValue(3.0);

      const metrics = createMockMetrics({ seasonalMode: 'summer' });
      mockCopNormalizer.normalize.mockReturnValue(0.6);

      const result = await optimizerNoLearner.calculateOptimalTemperatureWithRealData(
        defaultPriceStats,
        21.0,
        25.0,
        defaultComfortBand,
        metrics
      );

      expect(result.targetTemp).toBeGreaterThanOrEqual(defaultComfortBand.minTemp);
      expect(result.targetTemp).toBeLessThanOrEqual(defaultComfortBand.maxTemp);
    });
  });
});
