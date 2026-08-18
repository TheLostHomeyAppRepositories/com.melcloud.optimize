/**
 * Savings Service
 *
 * Centralized service for all savings calculations in the MELCloud optimizer.
 * Handles hourly, daily, and enhanced savings calculations with support for:
 * - Real energy metrics integration
 * - Seasonal mode adjustments
 * - Grid fee handling
 * - Baseline comparison calculations
 * - Price-aware projections
 *
 * Extracted from optimizer.ts as part of the refactoring plan (PR 5).
 *
 * @module services/savings-service
 */

import { EnhancedSavingsCalculator, SavingsCalculationResult, OptimizationData } from '../util/enhanced-savings-calculator';
import { PriceAnalyzer } from './price-analyzer';
import { OptimizationMetrics, WeatherData } from '../types';
import { TimeZoneHelper } from '../util/time-zone-helper';

/**
 * Logger interface for dependency injection
 */
export interface SavingsServiceLogger {
  log(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

/**
 * Weather API interface for baseline calculations
 */
export interface WeatherApi {
  getCurrentWeather(): Promise<WeatherData>;
}

/**
 * Settings accessor interface for grid fee and currency
 */
export interface SavingsSettingsAccessor {
  getGridFee(): number;
  getCurrency(): string;
}

/**
 * Optimization metrics accessor interface
 */
export interface MetricsAccessor {
  getOptimizationMetrics(): OptimizationMetrics | null;
}

/**
 * Dependencies for SavingsService
 */
export interface SavingsServiceDeps {
  enhancedSavingsCalculator: EnhancedSavingsCalculator;
  priceAnalyzer: PriceAnalyzer;
  timeZoneHelper: TimeZoneHelper;
  logger: SavingsServiceLogger;
  settingsAccessor: SavingsSettingsAccessor;
  metricsAccessor: MetricsAccessor;
  weatherApi?: WeatherApi;
}

/**
 * Kind of zone for savings calculation adjustments
 */
export type SavingsZoneKind = 'zone1' | 'zone2' | 'tank';

/**
 * Savings Service
 *
 * Provides all savings calculation functionality including:
 * - Simple temperature-based savings
 * - Real energy metrics-based hourly savings
 * - Daily projections with price awareness
 * - Enhanced calculations with baseline comparison
 *
 * @example
 * ```typescript
 * const savingsService = new SavingsService({
 *   enhancedSavingsCalculator,
 *   priceAnalyzer,
 *   timeZoneHelper,
 *   logger,
 *   settingsAccessor,
 *   metricsAccessor,
 *   weatherApi
 * });
 *
 * // Simple savings calculation
 * const savings = savingsService.calculateSavings(22, 20, 0.5);
 *
 * // Real hourly savings with metrics
 * const realSavings = await savingsService.calculateRealHourlySavings(22, 20, 0.5, metrics);
 * ```
 */
export class SavingsService {
  private readonly enhancedSavingsCalculator: EnhancedSavingsCalculator;
  private readonly priceAnalyzer: PriceAnalyzer;
  private readonly timeZoneHelper: TimeZoneHelper;
  private readonly logger: SavingsServiceLogger;
  private readonly settingsAccessor: SavingsSettingsAccessor;
  private readonly metricsAccessor: MetricsAccessor;
  private readonly weatherApi?: WeatherApi;

  constructor(deps: SavingsServiceDeps) {
    this.enhancedSavingsCalculator = deps.enhancedSavingsCalculator;
    this.priceAnalyzer = deps.priceAnalyzer;
    this.timeZoneHelper = deps.timeZoneHelper;
    this.logger = deps.logger;
    this.settingsAccessor = deps.settingsAccessor;
    this.metricsAccessor = deps.metricsAccessor;
    this.weatherApi = deps.weatherApi;
  }

  /**
   * Calculate savings from temperature change
   * @param oldTemp Original temperature
   * @param newTemp New temperature
   * @param currentPrice Current electricity price
   * @param kind Zone kind for adjustment factors
   * @returns Estimated savings
   */
  public calculateSavings(
    oldTemp: number,
    newTemp: number,
    currentPrice: number,
    kind: SavingsZoneKind = 'zone1'
  ): number {
    const tempDiff = Number(oldTemp) - Number(newTemp);
    if (!Number.isFinite(tempDiff) || !Number.isFinite(currentPrice)) return 0;

    const gridFee = this.settingsAccessor.getGridFee();
    const effectivePrice = currentPrice + (Number.isFinite(gridFee) ? gridFee : 0);

    // Use real daily consumption data from metrics when available, fallback to 1.0 kWh/h
    let baseHourlyConsumptionKWh = 1.0;

    try {
      const metrics = this.metricsAccessor.getOptimizationMetrics();
      const dailyFromMetrics = metrics?.dailyEnergyConsumption;
      if (Number.isFinite(dailyFromMetrics) && (dailyFromMetrics || 0) > 0) {
        baseHourlyConsumptionKWh = Math.max(0, (dailyFromMetrics as number) / 24);
      }
    } catch (_) { /* keep default fallback */ }

    const perDegPct = kind === 'tank' ? 2.0 : kind === 'zone2' ? 4.0 : 5.0;
    const kindMultiplier = kind === 'tank' ? 0.8 : kind === 'zone2' ? 0.9 : 1.0;
    const energySavingPercent = tempDiff * perDegPct * kindMultiplier;
    const savings = (energySavingPercent / 100) * baseHourlyConsumptionKWh * effectivePrice;
    return Number.isFinite(savings) ? savings : 0;
  }

  /**
   * Calculate hourly cost savings using real energy metrics (numeric result)
   * Falls back to simple heuristic when metrics are not available
   * @param oldTemp Original temperature
   * @param newTemp New temperature
   * @param currentPrice Current electricity price
   * @param metrics Optional optimization metrics
   * @param kind Zone kind for adjustment factors
   * @returns Promise resolving to hourly savings
   */
  public async calculateRealHourlySavings(
    oldTemp: number,
    newTemp: number,
    currentPrice: number,
    metrics?: OptimizationMetrics,
    kind: SavingsZoneKind = 'zone1'
  ): Promise<number> {
    try {
      const tempDelta = oldTemp - newTemp;
      if (!isFinite(tempDelta) || tempDelta === 0 || !isFinite(currentPrice)) return 0;

      if (!metrics) {
        // Fallback to simple calculation if we don't have metrics
        return this.calculateSavings(oldTemp, newTemp, currentPrice, kind);
      }

      // Base daily consumption (kWh/day)
      const dailyConsumption = metrics.dailyEnergyConsumption;
      if (!isFinite(dailyConsumption) || dailyConsumption <= 0) {
        return this.calculateSavings(oldTemp, newTemp, currentPrice, kind);
      }

      // Seasonal factors
      let perDegFactor: number; // fraction of daily energy per °C
      if (metrics.seasonalMode === 'winter') perDegFactor = 0.15 * (metrics.heatingEfficiency || 0.5);
      else if (metrics.seasonalMode === 'summer') perDegFactor = 0.05;
      else perDegFactor = 0.10;

      // Surface adjustments
      if (kind === 'zone2') perDegFactor *= 0.9;
      if (kind === 'tank') perDegFactor *= 0.5;

      const dailyEnergyImpact = Math.abs(tempDelta) * perDegFactor * dailyConsumption; // kWh
      const gridFee = this.settingsAccessor.getGridFee();
      const effectivePrice = (Number.isFinite(currentPrice) ? currentPrice : 0) + gridFee;
      const dailyCostImpact = dailyEnergyImpact * Math.sign(tempDelta) * effectivePrice;
      const hourlyCostImpact = dailyCostImpact / 24;
      return Number.isFinite(hourlyCostImpact) ? hourlyCostImpact : 0;
    } catch {
      return this.calculateSavings(oldTemp, newTemp, currentPrice, kind);
    }
  }

  /**
   * Estimate cost savings as a formatted string
   * @param newTemp New temperature
   * @param oldTemp Old temperature
   * @param currentPrice Current electricity price
   * @param avgPrice Average price (unused but kept for API compatibility)
   * @param metrics Optional optimization metrics
   * @returns Formatted string describing estimated savings
   */
  public estimateCostSavings(
    newTemp: number,
    oldTemp: number,
    currentPrice: number,
    avgPrice: number,
    metrics?: OptimizationMetrics
  ): string {
    if (!metrics) {
      return 'No real energy data for savings calculation';
    }

    const tempDifference = newTemp - oldTemp;
    const dailyConsumption = metrics.dailyEnergyConsumption;

    // Estimate energy impact based on temperature change and real COP
    let energyImpactFactor = 0;

    if (metrics.seasonalMode === 'summer') {
      // Minimal heating impact in summer, mainly hot water efficiency
      energyImpactFactor = Math.abs(tempDifference) * 0.05; // 5% per degree
    } else if (metrics.seasonalMode === 'winter') {
      // Significant heating impact in winter
      const heatingEfficiency = Math.max(metrics.realHeatingCOP, 1) / 3; // Normalize to 0-1
      energyImpactFactor = Math.abs(tempDifference) * 0.15 * heatingEfficiency; // 15% per degree, adjusted for COP
    } else {
      // Transition season
      energyImpactFactor = Math.abs(tempDifference) * 0.10; // 10% per degree
    }

    const dailyEnergyImpact = dailyConsumption * energyImpactFactor;
    const dailyCostImpact = dailyEnergyImpact * (tempDifference > 0 ? currentPrice : -currentPrice);
    const weeklyCostImpact = dailyCostImpact * 7;

    const currencyCode = this.settingsAccessor.getCurrency();
    return `Estimated ${tempDifference > 0 ? 'cost increase' : 'savings'}: ${Math.abs(weeklyCostImpact).toFixed(2)} ${currencyCode}/week`;
  }

  /**
   * Project daily savings using price data and historical optimizations
   * @param hourlySavings Current hour's savings
   * @param historicalOptimizations Historical optimization data
   * @returns Promise resolving to projected daily savings
   */
  public async calculateDailySavings(
    hourlySavings: number,
    historicalOptimizations: OptimizationData[] = []
  ): Promise<number> {
    try {
      const result = await this.calculateEnhancedDailySavingsUsingPriceProvider(
        hourlySavings,
        historicalOptimizations
      );
      return typeof result?.dailySavings === 'number'
        ? result.dailySavings
        : hourlySavings * 24;
    } catch (error) {
      this.logger.error('Error calculating daily savings projection:', error);
      return hourlySavings * 24;
    }
  }

  /**
   * Calculate enhanced daily savings using historical data and compounding effects
   * @param currentHourSavings Current hour's savings
   * @param historicalOptimizations Historical optimization data
   * @param futurePriceFactors Optional array of future price factors relative to current price
   * @returns Enhanced savings calculation result
   */
  public calculateEnhancedDailySavings(
    currentHourSavings: number,
    historicalOptimizations: OptimizationData[] = [],
    futurePriceFactors?: number[]
  ): SavingsCalculationResult {
    return this.enhancedSavingsCalculator.calculateEnhancedDailySavings(
      currentHourSavings,
      historicalOptimizations,
      this.timeZoneHelper.getLocalTime().hour,
      futurePriceFactors
    );
  }

  /**
   * Calculate enhanced daily savings using the configured price provider (price-aware projection)
   * @param currentHourSavings Current hour's savings
   * @param historicalOptimizations Historical optimization data
   * @returns Promise resolving to enhanced savings calculation result
   */
  public async calculateEnhancedDailySavingsUsingPriceProvider(
    currentHourSavings: number,
    historicalOptimizations: OptimizationData[] = []
  ): Promise<SavingsCalculationResult> {
    try {
      const currentHour = this.timeZoneHelper.getLocalTime().hour;
      const gridFee = this.settingsAccessor.getGridFee();
      if (!this.priceAnalyzer.hasPriceProvider()) {
        throw new Error('Price provider not initialized');
      }
      const pd = await this.priceAnalyzer.getPriceData();
      const now = new Date();
      const currentEffective = (Number(pd.current?.price) || 0) + (Number.isFinite(gridFee) ? gridFee : 0);
      let priceFactors: number[] | undefined = undefined;
      if (currentEffective > 0 && Array.isArray(pd.prices)) {
        const upcoming = pd.prices.filter(p => new Date(p.time) > now);
        priceFactors = upcoming.map(p => {
          const eff = (Number(p.price) || 0) + (Number.isFinite(gridFee) ? gridFee : 0);
          return currentEffective > 0 ? eff / currentEffective : 1;
        });
      }
      return this.enhancedSavingsCalculator.calculateEnhancedDailySavings(
        currentHourSavings,
        historicalOptimizations,
        currentHour,
        priceFactors
      );
    } catch (_) {
      // Fallback to non-price-aware calculation
      return this.calculateEnhancedDailySavings(currentHourSavings, historicalOptimizations);
    }
  }

  /**
   * Calculate enhanced daily savings with fixed baseline comparison
   * @param currentHourSavings Current hour's savings
   * @param historicalOptimizations Historical optimization data
   * @param actualConsumptionKWh Actual energy consumption for baseline comparison
   * @param actualCost Actual cost for baseline comparison
   * @param enableBaseline Whether to enable baseline comparison
   * @returns Promise resolving to enhanced savings calculation result with baseline comparison
   */
  public async calculateEnhancedDailySavingsWithBaseline(
    currentHourSavings: number,
    historicalOptimizations: OptimizationData[] = [],
    actualConsumptionKWh: number = 1.0,
    actualCost: number = currentHourSavings,
    enableBaseline: boolean = true
  ): Promise<SavingsCalculationResult> {
    try {
      // Get current price
      const gridFee = this.settingsAccessor.getGridFee();
      let pricePerKWh = 1.0; // Default fallback
      let priceFactors: number[] | undefined = undefined;

      if (this.priceAnalyzer.hasPriceProvider()) {
        const pd = await this.priceAnalyzer.getPriceData();
        const now = new Date();
        const currentEffective = (Number(pd.current?.price) || 0) + (Number.isFinite(gridFee) ? gridFee : 0);
        if (currentEffective > 0) {
          pricePerKWh = currentEffective;

          // Also get price factors for future projections
          if (Array.isArray(pd.prices)) {
            const upcoming = pd.prices.filter(p => new Date(p.time) > now);
            priceFactors = upcoming.map(p => {
              const eff = (Number(p.price) || 0) + (Number.isFinite(gridFee) ? gridFee : 0);
              return currentEffective > 0 ? eff / currentEffective : 1;
            });
          }
        }
      }

      // Get outdoor temperature data for baseline calculation
      const outdoorTemps: number[] = [];
      if (this.weatherApi && enableBaseline) {
        try {
          const weather = await this.weatherApi.getCurrentWeather();
          if (weather && weather.temperature) {
            outdoorTemps.push(weather.temperature);
          }
        } catch (error) {
          this.logger.error('Error getting weather for baseline calculation:', error);
        }
      }

      // Get intelligent baseline configuration (automatically determined)
      const baselineConfig = this.enhancedSavingsCalculator.getDefaultBaselineConfig();

      // Suppress the space-heating term when the pump is not space heating. The baseline means
      // "the same house and weather under a fixed setpoint", and such a thermostat would not have
      // called for heat either — charging it for heating that never happens is what made the
      // summer savings figure roughly five times the real one.
      const seasonalMode = this.metricsAccessor.getOptimizationMetrics()?.seasonalMode;
      if (seasonalMode === 'summer') {
        baselineConfig.spaceHeatingActive = false;
      }

      return this.enhancedSavingsCalculator.calculateEnhancedDailySavingsWithBaseline(
        currentHourSavings,
        historicalOptimizations,
        this.timeZoneHelper.getLocalTime().hour,
        priceFactors,
        {
          actualConsumptionKWh,
          actualCost,
          pricePerKWh,
          outdoorTemps,
          baselineConfig,
          enableBaseline: enableBaseline && this.enhancedSavingsCalculator.hasBaselineCapability()
        }
      );
    } catch (error) {
      this.logger.error('Error in enhanced daily savings with baseline:', error);
      // Fallback to standard calculation
      return this.calculateEnhancedDailySavings(currentHourSavings, historicalOptimizations);
    }
  }

  /**
   * Get the underlying EnhancedSavingsCalculator for direct access
   * @returns The EnhancedSavingsCalculator instance
   */
  public getEnhancedSavingsCalculator(): EnhancedSavingsCalculator {
    return this.enhancedSavingsCalculator;
  }

  /**
   * Check if baseline comparison capability is available
   * @returns true if baseline calculations can be performed
   */
  public hasBaselineCapability(): boolean {
    return this.enhancedSavingsCalculator.hasBaselineCapability();
  }
}
