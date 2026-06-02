/**
 * Energy Metrics Service
 *
 * Extracts and calculates optimization metrics from real energy data.
 * Provides seasonal mode detection, optimization focus determination,
 * and COP efficiency calculations using MELCloud API data.
 *
 * Features:
 * - Enhanced COP data processing with trend analysis
 * - Seasonal mode detection (summer/winter/transition)
 * - Optimization focus determination (heating/hotwater/both)
 * - Efficiency score normalization using COP Normalizer
 * - Fallback handling for API failures
 *
 * @module services/energy-metrics-service
 */

import { MelCloudApi } from './melcloud-api';
import { CopNormalizer } from './cop-normalizer';
import { HotWaterUsageLearner } from './hot-water-usage-learner';
import { OptimizationMetrics, RealEnergyData, HotWaterService } from '../types';
import { EnhancedCOPData, DailyCOPData, getCOPValue } from '../types/enhanced-cop-data';

/**
 * Logger interface for dependency injection
 */
export interface EnergyMetricsLogger {
  log(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

/**
 * Configuration for energy metrics thresholds
 */
export const ENERGY_METRICS_CONFIG = {
  /** Minimum heating consumption (kWh) to consider winter mode */
  MIN_HEATING_FOR_WINTER: 1.0,
  /**
   * Minimum heating energy PRODUCED (kWh) for the unit to be considered heating at all.
   * Below this the pump produces ~no useful heat (only standby/parasitic draw), so the season
   * is summer regardless of consumed electricity. Prevents being stuck in "transition" all summer.
   */
  MIN_HEATING_PRODUCED_FOR_SEASON: 0.5,
  /** Ratio of heating to hot water for winter classification */
  HEATING_DOMINANT_RATIO: 2.0,
  /** Default efficiency fallback divisor for basic normalization */
  BASIC_EFFICIENCY_DIVISOR: 3.0,
  /** Default min sampled days if not provided */
  DEFAULT_SAMPLED_DAYS: 1,
} as const;

/**
 * Seasonal mode type
 */
export type SeasonalMode = 'summer' | 'winter' | 'transition';

/**
 * Optimization focus type
 */
export type OptimizationFocus = 'heating' | 'hotwater' | 'both';

/**
 * Trend type from enhanced COP data
 */
export type TrendDirection = 'improving' | 'stable' | 'declining';

/**
 * Trends interface for optimization focus determination
 */
export interface COPTrends {
  heatingTrend: TrendDirection;
  hotWaterTrend: TrendDirection;
}

/**
 * Dependencies for EnergyMetricsService
 */
export interface EnergyMetricsServiceDeps {
  melCloud: MelCloudApi;
  copNormalizer: CopNormalizer;
  /** Dedicated hot water COP normalizer. Falls back to copNormalizer if not provided. */
  copNormalizerHotWater?: CopNormalizer;
  hotWaterUsageLearner: HotWaterUsageLearner;
  logger: EnergyMetricsLogger;
  getHotWaterService?: () => HotWaterService | null | undefined;
}

/**
 * Energy Metrics Service
 *
 * Calculates optimization metrics from real energy data obtained from MELCloud API.
 * Provides methods for:
 * - Getting real energy metrics with enhanced COP data
 * - Determining seasonal mode based on energy consumption patterns
 * - Determining optimization focus based on trends
 * - Tracking last energy data for reuse
 *
 * @example
 * ```typescript
 * const service = new EnergyMetricsService({
 *   melCloud,
 *   copNormalizer,
 *   hotWaterUsageLearner,
 *   logger
 * });
 *
 * const metrics = await service.getRealEnergyMetrics(deviceId, buildingId);
 * if (metrics) {
 *   console.log(`Seasonal Mode: ${metrics.seasonalMode}`);
 *   console.log(`Focus: ${metrics.optimizationFocus}`);
 * }
 * ```
 */
export class EnergyMetricsService {
  private readonly melCloud: MelCloudApi;
  private readonly copNormalizer: CopNormalizer;
  private readonly copNormalizerHotWater: CopNormalizer;
  private readonly hotWaterUsageLearner: HotWaterUsageLearner;
  private readonly logger: EnergyMetricsLogger;
  private readonly getHotWaterService?: () => HotWaterService | null | undefined;

  /** Cache of last energy data for reuse */
  private lastEnergyData: RealEnergyData | null = null;

  /** Cache of last optimization metrics */
  private optimizationMetrics: OptimizationMetrics | null = null;

  constructor(deps: EnergyMetricsServiceDeps) {
    this.melCloud = deps.melCloud;
    this.copNormalizer = deps.copNormalizer;
    this.copNormalizerHotWater = deps.copNormalizerHotWater || deps.copNormalizer;
    this.hotWaterUsageLearner = deps.hotWaterUsageLearner;
    this.logger = deps.logger;
    this.getHotWaterService = deps.getHotWaterService;
  }

  /**
   * Get real energy data from MELCloud API and calculate optimization metrics
   * Uses enhanced COP data with real-time calculations and predictions
   * @param deviceId Device ID
   * @param buildingId Building ID
   * @returns Promise resolving to optimization metrics, or null on failure
   */
  async getRealEnergyMetrics(
    deviceId: string,
    buildingId: number
  ): Promise<OptimizationMetrics | null> {
    try {
      // Use enhanced COP data for more accurate optimization
      const enhancedCOPData = await this.melCloud.getEnhancedCOPData(deviceId, buildingId);

      // Extract enhanced COP values with sensible fallbacks when the live value is missing
      const derivedHeatingCOP = getCOPValue(
        enhancedCOPData.daily,
        'heating',
        enhancedCOPData.historical.heating || 0
      );
      const derivedHotWaterCOP = getCOPValue(
        enhancedCOPData.daily,
        'hotWater',
        enhancedCOPData.historical.hotWater || 0
      );

      const realHeatingCOP = enhancedCOPData.current.heating > 0
        ? enhancedCOPData.current.heating
        : derivedHeatingCOP;
      const realHotWaterCOP = enhancedCOPData.current.hotWater > 0
        ? enhancedCOPData.current.hotWater
        : derivedHotWaterCOP;

      // Update COP ranges with current values (separate normalizers for accurate ranges)
      if (realHeatingCOP > 0) this.copNormalizer.updateRange(realHeatingCOP);
      if (realHotWaterCOP > 0) this.copNormalizerHotWater.updateRange(realHotWaterCOP);

      // Get daily energy totals
      const energyData = enhancedCOPData.daily;

      // Extract energy consumption data
      const heatingConsumed = energyData.TotalHeatingConsumed || 0;
      const heatingProduced = energyData.TotalHeatingProduced || 0;
      const hotWaterConsumed = energyData.TotalHotWaterConsumed || 0;
      const hotWaterProduced = energyData.TotalHotWaterProduced || 0;

      // Create type-safe energy data object
      const safeEnergyData = this.createSafeEnergyData(
        energyData,
        heatingConsumed,
        heatingProduced,
        hotWaterConsumed,
        hotWaterProduced,
        derivedHeatingCOP,
        derivedHotWaterCOP,
        enhancedCOPData.historical
      );

      this.lastEnergyData = safeEnergyData;
      this.refreshHotWaterUsagePattern();

      // Calculate daily energy consumption (kWh/day averaged over the period)
      const sampledDays = Math.max(
        1,
        Number(energyData.SampledDays ?? ENERGY_METRICS_CONFIG.DEFAULT_SAMPLED_DAYS) || 1
      );
      const dailyEnergyConsumption = (heatingConsumed + hotWaterConsumed) / sampledDays;

      // Calculate efficiency scores using adaptive COP normalization (separate ranges)
      // Stale range protection: if the learned range minimum equals the current COP,
      // normalize() returns 0. Fall back to rough normalization to match thermal-controller behaviour.
      const heatingEfficiencyRaw = this.copNormalizer.normalize(realHeatingCOP);
      const heatingEfficiency = (heatingEfficiencyRaw <= 0 && realHeatingCOP > 1.0)
        ? CopNormalizer.roughNormalize(realHeatingCOP)
        : heatingEfficiencyRaw;
      const hotWaterEfficiencyRaw = this.copNormalizerHotWater.normalize(realHotWaterCOP);
      const hotWaterEfficiency = (hotWaterEfficiencyRaw <= 0 && realHotWaterCOP > 1.0)
        ? CopNormalizer.roughNormalize(realHotWaterCOP, 4.0)
        : hotWaterEfficiencyRaw;

      // Determine seasonal mode and optimization focus
      const seasonalMode = this.determineSeason(heatingConsumed, hotWaterConsumed, heatingProduced);
      const optimizationFocus = this.determineOptimizationFocus(
        enhancedCOPData.trends,
        seasonalMode,
        heatingConsumed,
        hotWaterConsumed
      );

      const metrics: OptimizationMetrics = {
        realHeatingCOP,
        realHotWaterCOP,
        dailyEnergyConsumption,
        heatingEfficiency,
        hotWaterEfficiency,
        seasonalMode,
        optimizationFocus
      };

      this.optimizationMetrics = metrics;

      this.logMetrics(
        realHeatingCOP,
        realHotWaterCOP,
        heatingEfficiency,
        hotWaterEfficiency,
        dailyEnergyConsumption,
        seasonalMode,
        optimizationFocus,
        enhancedCOPData.trends
      );

      return metrics;
    } catch (error) {
      this.logger.error('Error getting enhanced energy metrics:', error);

      // Fallback to basic energy data if enhanced version fails
      return this.getFallbackMetrics(deviceId, buildingId);
    }
  }

  /**
   * Get the last energy data retrieved
   * @returns Last energy data or null if none available
   */
  getLastEnergyData(): RealEnergyData | null {
    return this.lastEnergyData;
  }

  /**
   * Get the last calculated optimization metrics
   * @returns Last optimization metrics or null if none calculated
   */
  getOptimizationMetrics(): OptimizationMetrics | null {
    return this.optimizationMetrics;
  }

  /**
   * Determine seasonal mode based on energy consumption patterns
   * @param heatingConsumed Total heating energy consumed (kWh)
   * @param hotWaterConsumed Total hot water energy consumed (kWh)
   * @returns Seasonal mode (summer/winter/transition)
   */
  determineSeason(
    heatingConsumed: number,
    hotWaterConsumed: number,
    heatingProduced?: number
  ): SeasonalMode {
    // Root-cause guard: if the pump produces ~no heat, it's summer even when standby/parasitic
    // electricity keeps heatingConsumed above the winter threshold. Skipped when heatingProduced
    // is unknown (undefined) to preserve legacy behavior.
    if (
      heatingProduced !== undefined &&
      heatingProduced < ENERGY_METRICS_CONFIG.MIN_HEATING_PRODUCED_FOR_SEASON
    ) {
      return 'summer';
    }
    if (heatingConsumed < ENERGY_METRICS_CONFIG.MIN_HEATING_FOR_WINTER) {
      // Less than 1 kWh heating in 7 days = summer
      return 'summer';
    } else if (heatingConsumed > hotWaterConsumed * ENERGY_METRICS_CONFIG.HEATING_DOMINANT_RATIO) {
      // Heating more than 2x hot water = winter
      return 'winter';
    } else {
      return 'transition';
    }
  }

  /**
   * Determine optimization focus based on trends and seasonal mode
   * @param trends COP trends from enhanced data
   * @param seasonalMode Current seasonal mode
   * @param heatingConsumed Total heating energy consumed
   * @param hotWaterConsumed Total hot water energy consumed
   * @returns Optimization focus (heating/hotwater/both)
   */
  determineOptimizationFocus(
    trends: COPTrends,
    seasonalMode: SeasonalMode,
    heatingConsumed: number,
    hotWaterConsumed: number
  ): OptimizationFocus {
    if (seasonalMode === 'summer') {
      return 'hotwater';
    }

    if (seasonalMode === 'winter') {
      return trends.heatingTrend === 'declining' ? 'both' : 'heating';
    }

    // Transition season - use trend analysis to determine focus
    if (trends.heatingTrend === 'improving' && trends.hotWaterTrend === 'stable') {
      return 'heating';
    } else if (trends.hotWaterTrend === 'improving' && trends.heatingTrend === 'stable') {
      return 'hotwater';
    } else {
      return 'both';
    }
  }

  /**
   * Create a type-safe RealEnergyData object from raw energy data
   */
  private createSafeEnergyData(
    energyData: DailyCOPData,
    heatingConsumed: number,
    heatingProduced: number,
    hotWaterConsumed: number,
    hotWaterProduced: number,
    derivedHeatingCOP: number,
    derivedHotWaterCOP: number,
    historical: { heating: number; hotWater: number }
  ): RealEnergyData {
    return {
      TotalHeatingConsumed: heatingConsumed,
      TotalHeatingProduced: heatingProduced,
      TotalHotWaterConsumed: hotWaterConsumed,
      TotalHotWaterProduced: hotWaterProduced,
      TotalCoolingConsumed: 0,
      TotalCoolingProduced: 0,
      CoP: Array.isArray(energyData.CoP)
        ? energyData.CoP
            .map((value): number | null => {
              // Plain number - use as-is
              if (typeof value === 'number') {
                return value;
              }
              // Object with value property - extract it
              if (value && typeof value === 'object' && 'value' in value) {
                const copValue = (value as { value: unknown }).value;
                return typeof copValue === 'number' ? copValue : null;
              }
              // Invalid format - skip
              return null;
            })
            .filter((value): value is number => value !== null && Number.isFinite(value))
        : [],
      // Prefer explicit COP fields when present in the daily report
      heatingCOP: derivedHeatingCOP,
      hotWaterCOP: derivedHotWaterCOP,
      averageCOP: energyData.averageCOP ?? null,
      AverageHeatingCOP: historical.heating,
      AverageHotWaterCOP: historical.hotWater
    };
  }

  /**
   * Refresh hot water usage pattern from the dedicated hot water service
   */
  private refreshHotWaterUsagePattern(): void {
    if (this.getHotWaterService) {
      const service = this.getHotWaterService();
      // Convert null to undefined for compatibility with refreshFromService signature
      this.hotWaterUsageLearner.refreshFromService(service ?? undefined);
    }
  }

  /**
   * Get fallback metrics using basic energy data when enhanced version fails
   */
  private async getFallbackMetrics(
    deviceId: string,
    buildingId: number
  ): Promise<OptimizationMetrics | null> {
    try {
      const energyData = await this.melCloud.getDailyEnergyTotals(deviceId, buildingId);

      const heatingConsumed = energyData.TotalHeatingConsumed || 0;
      const heatingProduced = energyData.TotalHeatingProduced || 0;
      const hotWaterConsumed = energyData.TotalHotWaterConsumed || 0;

      // Prefer explicit fields if present, then averageCOP, then legacy Average* fields
      const realHeatingCOP = Number(
        energyData.heatingCOP ?? energyData.averageCOP ?? energyData.AverageHeatingCOP ?? 0
      ) || 0;
      const realHotWaterCOP = Number(
        energyData.hotWaterCOP ?? energyData.averageCOP ?? energyData.AverageHotWaterCOP ?? 0
      ) || 0;
      
      const fallbackSampledDays = Math.max(
        1,
        Number(energyData.SampledDays ?? ENERGY_METRICS_CONFIG.DEFAULT_SAMPLED_DAYS) || 1
      );

      this.logger.log('Using fallback energy metrics calculation');

      const seasonalMode = this.determineSeason(heatingConsumed, hotWaterConsumed, heatingProduced);

      return {
        realHeatingCOP,
        realHotWaterCOP,
        dailyEnergyConsumption: (heatingConsumed + hotWaterConsumed) / fallbackSampledDays,
        heatingEfficiency: Math.min(realHeatingCOP / ENERGY_METRICS_CONFIG.BASIC_EFFICIENCY_DIVISOR, 1),
        hotWaterEfficiency: Math.min(realHotWaterCOP / ENERGY_METRICS_CONFIG.BASIC_EFFICIENCY_DIVISOR, 1),
        seasonalMode,
        optimizationFocus: 'both'
      };
    } catch (fallbackError) {
      this.logger.error('Error with fallback energy metrics:', fallbackError);
      return null;
    }
  }

  /**
   * Log calculated metrics for diagnostics
   */
  private logMetrics(
    realHeatingCOP: number,
    realHotWaterCOP: number,
    heatingEfficiency: number,
    hotWaterEfficiency: number,
    dailyEnergyConsumption: number,
    seasonalMode: SeasonalMode,
    optimizationFocus: OptimizationFocus,
    trends: COPTrends
  ): void {
    const heatingCOPDisplay = realHeatingCOP > 0 ? realHeatingCOP.toFixed(2) : 'n/a';
    const hotWaterCOPDisplay = realHotWaterCOP > 0 ? realHotWaterCOP.toFixed(2) : 'n/a';
    const heatingEfficiencyDisplay = realHeatingCOP > 0 ? (heatingEfficiency * 100).toFixed(0) + '%' : 'n/a';
    const hotWaterEfficiencyDisplay = realHotWaterCOP > 0 ? (hotWaterEfficiency * 100).toFixed(0) + '%' : 'n/a';

    // Get COP normalizer state for diagnostics
    const copState = this.copNormalizer.getState();

    this.logger.log('Enhanced energy metrics calculated:', {
      heatingCOP: heatingCOPDisplay,
      hotWaterCOP: hotWaterCOPDisplay,
      heatingEfficiency: heatingEfficiencyDisplay,
      hotWaterEfficiency: hotWaterEfficiencyDisplay,
      dailyConsumption: dailyEnergyConsumption.toFixed(1) + ' kWh/day',
      seasonalMode,
      optimizationFocus,
      heatingTrend: trends.heatingTrend,
      hotWaterTrend: trends.hotWaterTrend,
      copRange: `${copState.minObserved.toFixed(1)} - ${copState.maxObserved.toFixed(1)} (${copState.updateCount} obs)`
    });
  }

  /**
   * Clear cached data (useful for testing or reset scenarios)
   */
  clearCache(): void {
    this.lastEnergyData = null;
    this.optimizationMetrics = null;
  }
}
