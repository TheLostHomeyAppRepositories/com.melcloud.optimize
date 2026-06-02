/**
 * Temperature Optimizer Service
 *
 * Extracts temperature calculation logic from the main Optimizer class.
 * Provides methods for calculating optimal temperatures based on:
 * - Price data and normalization
 * - COP (Coefficient of Performance) efficiency
 * - Seasonal mode (summer/winter/transition)
 * - Comfort band constraints
 * - Adaptive parameters learning
 *
 * Features:
 * - Pure calculation logic (no I/O)
 * - Dependency injection for testability
 * - Support for basic and enhanced (real data) optimization
 * - COP-based temperature adjustments
 * - Seasonal mode awareness
 *
 * @module services/temperature-optimizer
 */

import { CopNormalizer } from './cop-normalizer';
import { COPHelper } from './cop-helper';
import { AdaptiveParametersLearner, AdaptiveParameters } from './adaptive-parameters';
import { OptimizationMetrics } from '../types';
import { COP_THRESHOLDS, DEFAULT_WEIGHTS } from '../constants';

/**
 * Temperature Optimizer Constants
 * 
 * These values serve as DEFAULTS for temperature adjustments. The COP-based
 * adjustments can be learned and overridden by AdaptiveParametersLearner.
 * 
 * @remarks
 * Outdoor Temperature Thresholds (not learned - physical constants):
 * - COLD_OUTDOOR_THRESHOLD (5°C): Below this, add comfort bonus to compensate
 *   for increased heat loss and perceived cold. Typical mild winter conditions.
 * 
 * - MILD_OUTDOOR_THRESHOLD (15°C): Above this, reduce heating target as
 *   solar gains and minimal heat loss reduce heating needs.
 * 
 * - COLD_OUTDOOR_BONUS (0.5°C): Temperature boost when outdoor < 5°C.
 *   Maintains comfort perception in cold weather.
 * 
 * - MILD_OUTDOOR_REDUCTION (0.3°C): Temperature reduction when outdoor > 15°C.
 *   Prevents over-heating in mild conditions.
 * 
 * COP Efficiency Adjustments (DEFAULT values - learned by AdaptiveParameters):
 * These serve as fallbacks when adaptive learning hasn't reached confidence.
 * - DEFAULT_COP_ADJUSTMENT_GOOD (-0.1°C): Learned as copAdjustmentGood
 * - DEFAULT_COP_ADJUSTMENT_POOR (-0.5°C): Learned as copAdjustmentPoor  
 * - DEFAULT_COP_ADJUSTMENT_VERY_POOR (-0.8°C): Learned as copAdjustmentVeryPoor
 * 
 * Transition Mode Thresholds:
 * - TRANSITION_EFFICIENCY_HIGH (0.7): Combined COP threshold for bonus.
 * - TRANSITION_EFFICIENCY_LOW (0.4): Combined COP threshold for reduction.
 * - TRANSITION_EFFICIENCY_REDUCTION (-0.4°C): Reduction for low efficiency.
 */
const COLD_OUTDOOR_THRESHOLD = 5;
const MILD_OUTDOOR_THRESHOLD = 15;
const COLD_OUTDOOR_BONUS = 0.5;
const MILD_OUTDOOR_REDUCTION = 0.3;

// Default COP adjustments - overridden by AdaptiveParametersLearner when confidence is high
const DEFAULT_COP_ADJUSTMENT_GOOD = -0.1;
const DEFAULT_COP_ADJUSTMENT_POOR = -0.5;
const DEFAULT_COP_ADJUSTMENT_VERY_POOR = -0.8;

const TRANSITION_EFFICIENCY_HIGH = 0.7;
const TRANSITION_EFFICIENCY_LOW = 0.4;
const TRANSITION_EFFICIENCY_REDUCTION = -0.4;

/**
 * Logger interface for dependency injection
 */
export interface TemperatureOptimizerLogger {
  log(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

/**
 * Comfort band configuration
 */
export interface ComfortBand {
  minTemp: number;
  maxTemp: number;
}

/**
 * Result of temperature optimization with reasoning
 */
export interface TemperatureOptimizationResult {
  targetTemp: number;
  reason: string;
  metrics?: OptimizationMetrics;
}

/**
 * Price statistics for temperature calculation
 */
export interface PriceStats {
  currentPrice: number;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  /** Optional pre-calculated price level for accurate logging */
  priceLevel?: string;
}

/**
 * Dependencies for TemperatureOptimizer
 */
export interface TemperatureOptimizerDeps {
  copNormalizer: CopNormalizer;
  /** Dedicated hot water COP normalizer. Falls back to copNormalizer if not provided. */
  copNormalizerHotWater?: CopNormalizer;
  copHelper: COPHelper | null;
  adaptiveParametersLearner: AdaptiveParametersLearner | null;
  logger: TemperatureOptimizerLogger;
  /** COP weight setting (0-1) */
  copWeight: number;
  /** Auto seasonal mode enabled */
  autoSeasonalMode: boolean;
  /** Manual summer mode setting */
  summerMode: boolean;
}

/**
 * Temperature Optimizer Service
 *
 * Calculates optimal temperatures based on price, COP, and seasonal data.
 * Supports both basic price-based optimization and enhanced optimization
 * using real energy metrics from MELCloud.
 *
 * @example
 * ```typescript
 * const optimizer = new TemperatureOptimizer({
 *   copNormalizer,
 *   copHelper,
 *   adaptiveParametersLearner,
 *   logger,
 *   copWeight: 0.5,
 *   autoSeasonalMode: true,
 *   summerMode: false
 * });
 *
 * const result = await optimizer.calculateOptimalTemperature(
 *   { currentPrice: 1.2, avgPrice: 1.0, minPrice: 0.5, maxPrice: 2.0 },
 *   21.0,
 *   { minTemp: 19, maxTemp: 23 }
 * );
 * ```
 */
export class TemperatureOptimizer {
  private readonly copNormalizer: CopNormalizer;
  private readonly copNormalizerHotWater: CopNormalizer;
  private readonly copHelper: COPHelper | null;
  private readonly adaptiveParametersLearner: AdaptiveParametersLearner | null;
  private readonly logger: TemperatureOptimizerLogger;

  // Settings that can be updated
  private copWeight: number;
  private autoSeasonalMode: boolean;
  private summerMode: boolean;

  constructor(deps: TemperatureOptimizerDeps) {
    this.copNormalizer = deps.copNormalizer;
    this.copNormalizerHotWater = deps.copNormalizerHotWater || deps.copNormalizer;
    this.copHelper = deps.copHelper;
    this.adaptiveParametersLearner = deps.adaptiveParametersLearner;
    this.logger = deps.logger;
    this.copWeight = deps.copWeight;
    this.autoSeasonalMode = deps.autoSeasonalMode;
    this.summerMode = deps.summerMode;
  }

  /**
   * Update COP settings
   */
  updateCOPSettings(copWeight: number, autoSeasonalMode: boolean, summerMode: boolean): void {
    this.copWeight = copWeight;
    this.autoSeasonalMode = autoSeasonalMode;
    this.summerMode = summerMode;
  }

  /**
   * Get current COP weight
   */
  getCOPWeight(): number {
    return this.copWeight;
  }

  /**
   * Get price description based on pre-calculated price level
   * The priceLevel is already calculated using learned thresholds from AdaptiveParametersLearner
   * @param priceLevel Pre-calculated price level (VERY_CHEAP, CHEAP, NORMAL, EXPENSIVE, VERY_EXPENSIVE)
   * @returns Human-readable price description: 'low', 'moderate', or 'high'
   */
  private getPriceDescription(priceLevel: string | undefined): string {
    // priceLevel is calculated by price-classifier using learned veryCheapMultiplier thresholds
    if (priceLevel === 'VERY_CHEAP' || priceLevel === 'CHEAP') {
      return 'low';
    } else if (priceLevel === 'VERY_EXPENSIVE' || priceLevel === 'EXPENSIVE') {
      return 'high';
    }
    return 'moderate';
  }

  /**
   * Calculate optimal temperature based on price
   * @param priceStats Price statistics (current, avg, min, max)
   * @param currentTemp Current room temperature
   * @param comfortBand Comfort band constraints (min/max)
   * @returns Optimal target temperature
   */
  async calculateOptimalTemperature(
    priceStats: PriceStats,
    currentTemp: number,
    comfortBand: ComfortBand
  ): Promise<number> {
    const { currentPrice, avgPrice, minPrice, maxPrice } = priceStats;
    const tempRange = comfortBand.maxTemp - comfortBand.minTemp;
    const midTemp = (comfortBand.maxTemp + comfortBand.minTemp) / 2;

    // Normalize price between 0 and 1 more efficiently
    const normalizedPrice = maxPrice === minPrice
      ? 0.5 // Handle edge case of equal prices
      : (currentPrice - minPrice) / (maxPrice - minPrice);

    // Invert (lower price = higher temperature)
    const invertedPrice = 1 - normalizedPrice;

    // Calculate base target based on price
    let targetTemp = midTemp + (invertedPrice - 0.5) * tempRange;

    // Apply COP adjustment if helper is available
    if (this.copHelper && this.copWeight > 0) {
      try {
        // Determine if we're in summer mode (cached calculation)
        const isSummerMode = this.autoSeasonalMode
          ? this.copHelper.isSummerSeason()
          : this.summerMode;

        // Get the appropriate COP value based on season
        const seasonalCOP = await this.copHelper.getSeasonalCOP();

        // Log the COP data (using log level to reduce log volume)
        this.logger.log(`Using COP data for optimization - Seasonal COP: ${seasonalCOP.toFixed(2)}, Summer Mode: ${isSummerMode}`);

        if (seasonalCOP > 0) {
          // FIXED: Correct COP optimization logic
          // Use high COP periods for efficient operation at comfort temperatures
          // Use low COP periods with reduced comfort expectations

          // Update COP range tracking for adaptive normalization
          this.copNormalizer.updateRange(seasonalCOP);

          // Use adaptive COP normalization based on observed range
          const normalizedCOP = this.copNormalizer.normalize(seasonalCOP);

          // Stale-range guard: if learned range excludes a physically valid COP, fall back to roughNormalize
          const copEfficiencyFactor = (normalizedCOP <= 0 && seasonalCOP > 1.0)
            ? CopNormalizer.roughNormalize(seasonalCOP)
            : normalizedCOP;

          let copAdjustment = 0;

          // Get adaptive COP adjustment magnitudes (falls back to defaults if learner unavailable)
          const adaptiveThresholds = this.adaptiveParametersLearner?.getStrategyThresholds() || {
            copAdjustmentExcellent: 0.2,
            copAdjustmentGood: 0.3,
            copAdjustmentPoor: 0.8,
            copAdjustmentVeryPoor: 1.2,
            summerModeReduction: 0.5
          };

          if (copEfficiencyFactor > COP_THRESHOLDS.EXCELLENT) {
            // Excellent COP (>80th percentile): Maintain comfort, allow normal price response
            copAdjustment = adaptiveThresholds.copAdjustmentExcellent;
            this.logger.log(`Excellent COP: Maintaining comfort with small bonus (+${adaptiveThresholds.copAdjustmentExcellent.toFixed(2)}°C)`);
          } else if (copEfficiencyFactor > COP_THRESHOLDS.GOOD) {
            // Good COP: Slight comfort reduction during expensive periods
            copAdjustment = -adaptiveThresholds.copAdjustmentGood * Math.abs(targetTemp - midTemp);
            this.logger.log(`Good COP: Reducing temperature adjustment by ${(adaptiveThresholds.copAdjustmentGood * 100).toFixed(0)}%`);
          } else if (copEfficiencyFactor > COP_THRESHOLDS.POOR) {
            // Poor COP: Significant comfort reduction to save energy
            copAdjustment = -adaptiveThresholds.copAdjustmentPoor * this.copWeight;
            this.logger.log(`Poor COP: Reducing temperature for efficiency (-${adaptiveThresholds.copAdjustmentPoor.toFixed(2)}°C)`);
          } else {
            // Very poor COP: Maximum energy conservation
            copAdjustment = -adaptiveThresholds.copAdjustmentVeryPoor * this.copWeight;
            this.logger.log(`Very poor COP: Maximum energy conservation (-${adaptiveThresholds.copAdjustmentVeryPoor.toFixed(2)}°C)`);
          }

          // Apply the corrected adjustment
          targetTemp += copAdjustment;

          this.logger.log(`Applied COP adjustment: ${copAdjustment.toFixed(2)}°C (COP: ${seasonalCOP.toFixed(2)}, Efficiency: ${(copEfficiencyFactor * 100).toFixed(0)}%, Weight: ${this.copWeight})`);

          // In summer mode, further reduce heating temperature
          if (isSummerMode) {
            const summerModeReduction = adaptiveThresholds.summerModeReduction ?? 0.5;
            const summerAdjustment = -summerModeReduction * this.copWeight;
            targetTemp += summerAdjustment;
            this.logger.log(`Applied summer mode adjustment: ${summerAdjustment.toFixed(2)}°C (learned reduction: ${summerModeReduction.toFixed(2)})`);
          }
        }
      } catch (error) {
        this.logger.error('Error applying COP adjustment:', error);
      }
    }

    // Apply final comfort band constraints
    targetTemp = Math.max(comfortBand.minTemp, Math.min(comfortBand.maxTemp, targetTemp));

    return targetTemp;
  }

  /**
   * Calculate enhanced temperature optimization using real energy data
   * @param priceStats Price statistics (current, avg, min, max)
   * @param currentTemp Current room temperature
   * @param outdoorTemp Outdoor temperature
   * @param comfortBand Comfort band constraints
   * @param metrics Real energy metrics from MELCloud
   * @param basicCalculator Fallback function for basic calculation
   * @returns Optimal target temperature with reasoning
   */
  async calculateOptimalTemperatureWithRealData(
    priceStats: PriceStats,
    currentTemp: number,
    outdoorTemp: number,
    comfortBand: ComfortBand,
    metrics: OptimizationMetrics | null,
    basicCalculator?: () => Promise<number>
  ): Promise<TemperatureOptimizationResult> {
    const { currentPrice, avgPrice, minPrice, maxPrice } = priceStats;

    if (!metrics) {
      // Fall back to basic optimization if no real data available
      let basicTarget: number;
      if (basicCalculator) {
        basicTarget = await basicCalculator();
      } else {
        basicTarget = await this.calculateOptimalTemperature(priceStats, currentTemp, comfortBand);
      }
      return {
        targetTemp: basicTarget,
        reason: 'Using basic optimization (no real energy data available)'
      };
    }

    // Cache frequently used values - use user-configurable comfort bands
    const tempRange = comfortBand.maxTemp - comfortBand.minTemp;
    const midTemp = (comfortBand.maxTemp + comfortBand.minTemp) / 2;

    // Normalize price between 0 and 1
    const normalizedPrice = maxPrice === minPrice
      ? 0.5
      : (currentPrice - minPrice) / (maxPrice - minPrice);

    // Calculate base target based on seasonal mode and real performance
    let targetTemp: number;
    let reason: string;

    const adaptiveParams = this.adaptiveParametersLearner?.getParameters();

    if (metrics.seasonalMode === 'summer') {
      // Summer optimization: Focus on hot water efficiency and minimal heating
      const priceWeight = adaptiveParams?.priceWeightSummer || DEFAULT_WEIGHTS.PRICE_SUMMER;

      // Update COP range and normalize (use dedicated hot water normalizer)
      this.copNormalizerHotWater.updateRange(metrics.realHotWaterCOP);
      const hotWaterEfficiency = this.copNormalizerHotWater.normalize(metrics.realHotWaterCOP);

      // Price adjustment (inverted: low price = higher temp)
      const priceAdjustment = (0.5 - normalizedPrice) * tempRange * priceWeight;

      // Efficiency bonus for excellent hot water COP
      let efficiencyAdjustment = 0;
      if (hotWaterEfficiency > COP_THRESHOLDS.EXCELLENT) {
        efficiencyAdjustment = adaptiveParams?.copEfficiencyBonusHigh || DEFAULT_WEIGHTS.COP_EFFICIENCY_BONUS_HIGH;
      } else if (hotWaterEfficiency < 0.3) {
        efficiencyAdjustment = -0.5; // Penalty for poor COP
      }

      targetTemp = midTemp + priceAdjustment + efficiencyAdjustment;
      // Use pre-calculated price level (based on learned thresholds) for accurate description
      const displayHotWaterEfficiency = (hotWaterEfficiency > 0)
          ? hotWaterEfficiency
          : (metrics.realHotWaterCOP > 1.0 ? CopNormalizer.roughNormalize(metrics.realHotWaterCOP) : 0);
      reason = `Summer mode: Hot water COP ${metrics.realHotWaterCOP.toFixed(2)} (${(displayHotWaterEfficiency * 100).toFixed(0)}% efficiency), price ${this.getPriceDescription(priceStats.priceLevel)} `;

    } else if (metrics.seasonalMode === 'winter') {
      // Winter optimization: Balance heating efficiency with comfort and prices
      const priceWeight = adaptiveParams?.priceWeightWinter || DEFAULT_WEIGHTS.PRICE_WINTER;

      // Update COP range and normalize
      this.copNormalizer.updateRange(metrics.realHeatingCOP);
      const heatingEfficiencyRaw = this.copNormalizer.normalize(metrics.realHeatingCOP);
      // Stale-range guard: if learned range excludes a physically valid COP, fall back to roughNormalize
      const heatingEfficiency = (heatingEfficiencyRaw <= 0 && metrics.realHeatingCOP > 1.0)
        ? CopNormalizer.roughNormalize(metrics.realHeatingCOP)
        : heatingEfficiencyRaw;

      // Price adjustment (inverted: low price = higher temp)
      const priceAdjustment = (0.5 - normalizedPrice) * tempRange * priceWeight;

      // Get adaptive COP thresholds
      const adaptiveThresholds = this.adaptiveParametersLearner?.getStrategyThresholds() || {
        excellentCOPThreshold: COP_THRESHOLDS.EXCELLENT,
        goodCOPThreshold: COP_THRESHOLDS.GOOD,
        minimumCOPThreshold: COP_THRESHOLDS.POOR
      };

      // Efficiency-based comfort adjustment using adaptive thresholds
      // Use learned adjustment magnitudes when available, fall back to defaults
      let efficiencyAdjustment = 0;
      if (heatingEfficiency > adaptiveThresholds.excellentCOPThreshold) {
        // Excellent heating COP: maintain comfort
        efficiencyAdjustment = adaptiveParams?.copEfficiencyBonusMedium || DEFAULT_WEIGHTS.COP_EFFICIENCY_BONUS_MEDIUM;
      } else if (heatingEfficiency > adaptiveThresholds.goodCOPThreshold) {
        // Good heating COP: slight reduction (learned or default)
        efficiencyAdjustment = adaptiveParams?.copAdjustmentGood ? -adaptiveParams.copAdjustmentGood : DEFAULT_COP_ADJUSTMENT_GOOD;
      } else if (heatingEfficiency > adaptiveThresholds.minimumCOPThreshold) {
        // Poor heating COP: significant reduction (learned or default)
        efficiencyAdjustment = adaptiveParams?.copAdjustmentPoor ? -adaptiveParams.copAdjustmentPoor : DEFAULT_COP_ADJUSTMENT_POOR;
      } else {
        // Very poor heating COP: maximum conservation (learned or default)
        efficiencyAdjustment = adaptiveParams?.copAdjustmentVeryPoor ? -adaptiveParams.copAdjustmentVeryPoor : DEFAULT_COP_ADJUSTMENT_VERY_POOR;
      }

      // Outdoor temperature adjustment: colder outside = need higher inside for comfort
      // Use learned values from adaptive parameters when available, fall back to defaults
      const coldBonus = adaptiveParams?.coldOutdoorBonus ?? COLD_OUTDOOR_BONUS;
      const mildReduction = adaptiveParams?.mildOutdoorReduction ?? MILD_OUTDOOR_REDUCTION;
      const outdoorAdjustment = outdoorTemp < COLD_OUTDOOR_THRESHOLD ? coldBonus : outdoorTemp > MILD_OUTDOOR_THRESHOLD ? -mildReduction : 0;

      targetTemp = midTemp + priceAdjustment + efficiencyAdjustment + outdoorAdjustment;
      // Use pre-calculated price level (based on learned thresholds) for accurate description
      const displayHeatingEfficiency = (heatingEfficiency > 0)
          ? heatingEfficiency
          : (metrics.realHeatingCOP > 1.0 ? CopNormalizer.roughNormalize(metrics.realHeatingCOP) : 0);
      reason = `Winter mode: Heating COP ${metrics.realHeatingCOP.toFixed(2)} (${(displayHeatingEfficiency * 100).toFixed(0)}% efficiency), outdoor ${outdoorTemp}°C, price ${this.getPriceDescription(priceStats.priceLevel)} `;

    } else {
      // Transition mode: Balanced approach using both COPs
      const priceWeight = adaptiveParams?.priceWeightTransition || DEFAULT_WEIGHTS.PRICE_TRANSITION;

      // Update COP ranges for both systems (separate normalizers)
      this.copNormalizer.updateRange(metrics.realHeatingCOP);
      this.copNormalizerHotWater.updateRange(metrics.realHotWaterCOP);

      const heatingEfficiencyRawT = this.copNormalizer.normalize(metrics.realHeatingCOP);
      // Stale-range guard: fall back to roughNormalize when learned range excludes a valid COP
      const heatingEfficiency = (heatingEfficiencyRawT <= 0 && metrics.realHeatingCOP > 1.0)
        ? CopNormalizer.roughNormalize(metrics.realHeatingCOP)
        : heatingEfficiencyRawT;
      const hotWaterEfficiencyRawT = this.copNormalizerHotWater.normalize(metrics.realHotWaterCOP);
      const hotWaterEfficiency = (hotWaterEfficiencyRawT <= 0 && metrics.realHotWaterCOP > 1.0)
        ? CopNormalizer.roughNormalize(metrics.realHotWaterCOP)
        : hotWaterEfficiencyRawT;
      // P2-2: zone1 target depends on heating COP only — hot-water COP is a different domain
      const combinedEfficiency = heatingEfficiency;

      const priceAdjustment = (0.5 - normalizedPrice) * tempRange * priceWeight;

      // Combined efficiency adjustment
      // Only penalize on low efficiency when the COP is actually measured. When heatingProduced=0
      // (e.g. no space heating in summer), realHeatingCOP is 0 — that is a non-measurement, not poor
      // performance, so applying the −0.4°C reduction would bias the setpoint down for no reason.
      const copMeasured = metrics.realHeatingCOP > 0;
      let efficiencyAdjustment = 0;
      if (combinedEfficiency > TRANSITION_EFFICIENCY_HIGH) {
        efficiencyAdjustment = adaptiveParams?.copEfficiencyBonusMedium || DEFAULT_WEIGHTS.COP_EFFICIENCY_BONUS_MEDIUM;
      } else if (combinedEfficiency < TRANSITION_EFFICIENCY_LOW && copMeasured) {
        efficiencyAdjustment = TRANSITION_EFFICIENCY_REDUCTION;
      }

      targetTemp = midTemp + priceAdjustment + efficiencyAdjustment;
      reason = copMeasured
        ? `Transition mode: Combined COP efficiency ${(combinedEfficiency * 100).toFixed(0)}%, adapting to both heating and hot water needs`
        : `Transition mode: heating COP unmeasured (no recent heat output), price-driven only`;
    }

    // COP-based fine-tuning removed: the per-season blocks above (summer/winter/transition)
    // already apply comprehensive COP adjustments. The previous fine-tuning block caused
    // double COP penalties (e.g., -0.5 in winter block + -0.5 here = -1.0°C for poor COP).

    // Apply final comfort band constraints
    targetTemp = Math.max(comfortBand.minTemp, Math.min(comfortBand.maxTemp, targetTemp));

    return { targetTemp, reason, metrics };
  }
}
