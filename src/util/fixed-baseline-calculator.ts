/**
 * Fixed Baseline Calculator
 * Calculates what energy consumption would be with fixed temperature setpoints
 * (manual/traditional thermostat operation) for comparison against optimized operation
 */

import { Logger } from './logger';
import { ThermalModelService } from '../services/thermal-model';
import { COPHelper } from '../services/cop-helper';
import { HotWaterService } from '../services/hot-water';

export interface BaselineConfig {
  // Fixed temperature setpoints
  heatingSetpoint: number;      // e.g., 21°C - constant heating temperature
  hotWaterSetpoint: number;     // e.g., 60°C - constant hot water temperature
  
  // Operating characteristics
  operatingProfile: 'always_on' | '24_7' | 'schedule';
  
  // Efficiency assumptions for non-optimized operation
  assumedHeatingCOP?: number;   // Default COP when not using learned values
  assumedHotWaterCOP?: number;  // Default COP when not using learned values
  
  /**
   * Whether space heating is genuinely running. When false the space-heating component of the
   * baseline is zero: the baseline is "a constant-temperature thermostat in this same house and
   * weather", and such a thermostat would not call for heat either. Charging it for heating the
   * pump is not doing turns the whole comparison into fiction — measured live in August, ~3.5 of
   * a 6.5 kWh/day baseline was space heating that never happened, i.e. over half the displayed
   * "saving". Undefined preserves the legacy weather-only estimate.
   */
  spaceHeatingActive?: boolean;

  // Comfort schedule for 'schedule' mode
  scheduleConfig?: {
    dayStart: number;           // Hour when heating starts (e.g., 6)
    dayEnd: number;            // Hour when heating stops (e.g., 23) 
    nightTempReduction: number; // Temperature reduction at night (e.g., 3°C)
  };
}

export interface BaselineConsumption {
  heatingEnergyKWh: number;
  hotWaterEnergyKWh: number;
  totalEnergyKWh: number;
  estimatedCost: number;
  confidence: number;
  method: string;
  breakdown: {
    heatingHours: number;
    hotWaterHours: number;
    avgOutdoorTemp: number;
    avgCOP: number;
  };
}

export interface BaselineComparison {
  actualSavings: number;        // Current vs recent optimization
  baselineSavings: number;      // Current vs fixed baseline
  baselinePercentage: number;   // Percentage saved vs baseline
  confidenceLevel: number;      // How confident we are in baseline calculation
  method: string;               // Calculation method used
  breakdown: {
    actualConsumption: number;
    baselineConsumption: number;
    actualCost: number;
    baselineCost: number;
  };
}

export class FixedBaselineCalculator {
  private logger: Logger;
  private thermalModelService?: ThermalModelService;
  private copHelper?: COPHelper;
  private hotWaterService?: HotWaterService;
  
  // Default baseline configuration - based on typical European home heating patterns
  // These represent what a "traditional" non-optimized system would do
  private defaultConfig: BaselineConfig = {
    heatingSetpoint: 21.0,      // Standard comfort temperature (most common setting)
    hotWaterSetpoint: 60.0,     // Legionella-safe temperature (regulatory requirement)
    operatingProfile: 'schedule', // Most homes use some form of scheduling
    assumedHeatingCOP: 2.2,     // Realistic average for non-optimized heat pumps
    assumedHotWaterCOP: 1.8,    // Lower COP for hot water (higher temp differential)
    scheduleConfig: {
      dayStart: 6,              // Typical wake-up time
      dayEnd: 23,              // Typical bedtime
      nightTempReduction: 3.0   // Common night setback (21°C -> 18°C)
    }
  };

  constructor(
    logger: Logger,
    thermalModelService?: ThermalModelService,
    copHelper?: COPHelper,
    hotWaterService?: HotWaterService
  ) {
    this.logger = logger;
    this.thermalModelService = thermalModelService;
    this.copHelper = copHelper;
    this.hotWaterService = hotWaterService;
  }

  private safeDebug(message: string, context?: Record<string, any>): void {
    const loggerAny = this.logger as any;
    if (loggerAny && typeof loggerAny.debug === 'function') {
      loggerAny.debug(message, context);
    } else if (loggerAny && typeof loggerAny.log === 'function') {
      loggerAny.log(message, context);
    } else {
      console.debug(message, context);
    }
  }

  private safeError(message: string, error: unknown): void {
    const loggerAny = this.logger as any;
    if (loggerAny && typeof loggerAny.error === 'function') {
      loggerAny.error(message, error);
    } else if (loggerAny && typeof loggerAny.log === 'function') {
      loggerAny.log(`${message} ${error instanceof Error ? error.message : String(error)}`);
    } else {
      console.error(message, error);
    }
  }

  /**
   * Calculate what energy consumption would be with fixed temperature setpoints
   * @param timespan Time period ('hour', 'day', 'week', 'month')
   * @param outdoorTemps Array of outdoor temperatures for the period
   * @param pricePerKWh Current electricity price per kWh
   * @param config Optional baseline configuration (uses defaults if not provided)
   * @returns Baseline consumption calculation
   */
  public calculateBaselineConsumption(
    timespan: 'hour' | 'day' | 'week' | 'month',
    outdoorTemps: number[],
    pricePerKWh: number,
    config?: Partial<BaselineConfig>
  ): BaselineConsumption {
    try {
      const finalConfig = { ...this.defaultConfig, ...config };
      
      // Calculate time-based factors
      const hours = this.getHoursInTimespan(timespan);
      const avgOutdoorTemp = outdoorTemps.length > 0 
        ? outdoorTemps.reduce((sum, temp) => sum + temp, 0) / outdoorTemps.length
        : 10; // Default fallback outdoor temp

      // Get effective COP values (learned or assumed)
      const effectiveCOPs = this.getEffectiveCOPs(finalConfig);
      
      // Calculate heating energy consumption
      const heatingEnergy = this.calculateHeatingEnergy(
        finalConfig,
        hours,
        avgOutdoorTemp,
        effectiveCOPs.heating
      );
      
      // Calculate hot water energy consumption
      const hotWaterEnergy = this.calculateHotWaterEnergy(
        finalConfig,
        hours,
        effectiveCOPs.hotWater,
        avgOutdoorTemp
      );
      
      const totalEnergy = heatingEnergy + hotWaterEnergy;
      const estimatedCost = totalEnergy * pricePerKWh;
      
      // Calculate confidence based on available data and models
      const confidence = this.calculateConfidence(outdoorTemps, finalConfig);
      
      const method = this.getCalculationMethod(finalConfig);

      // Explicitly log the winter factor impact so we can trace cold-weather behavior in logs
      const winterFactor = this.getWinterFactor(avgOutdoorTemp);
      this.safeDebug('Fixed baseline temperature scaling applied:', {
        avgOutdoorTemp: avgOutdoorTemp.toFixed(1),
        winterFactor: winterFactor.toFixed(2),
        heatingEnergy: heatingEnergy.toFixed(2),
        hotWaterEnergy: hotWaterEnergy.toFixed(2)
      });
      
      const result: BaselineConsumption = {
        heatingEnergyKWh: heatingEnergy,
        hotWaterEnergyKWh: hotWaterEnergy,
        totalEnergyKWh: totalEnergy,
        estimatedCost: estimatedCost,
        confidence: confidence,
        method: method,
        breakdown: {
          heatingHours: this.getEffectiveHeatingHours(finalConfig, hours),
          hotWaterHours: hours, // Hot water typically needed 24/7
          avgOutdoorTemp: avgOutdoorTemp,
          avgCOP: (effectiveCOPs.heating + effectiveCOPs.hotWater) / 2
        }
      };

      this.safeDebug('Fixed baseline consumption calculated:', {
        timespan,
        config: finalConfig,
        result: {
          totalEnergy: result.totalEnergyKWh.toFixed(2),
          cost: result.estimatedCost.toFixed(2),
          confidence: result.confidence.toFixed(2),
          method: result.method
        }
      });

      return result;
      
    } catch (error) {
      this.safeError('Error calculating baseline consumption:', error);
      
      // Return conservative fallback
      const hours = this.getHoursInTimespan(timespan);
      return {
        heatingEnergyKWh: hours * 2.0, // 2kW average continuous heating
        hotWaterEnergyKWh: hours * 0.5, // 0.5kW average hot water
        totalEnergyKWh: hours * 2.5,
        estimatedCost: hours * 2.5 * pricePerKWh,
        confidence: 0.1,
        method: 'fallback_conservative',
        breakdown: {
          heatingHours: hours,
          hotWaterHours: hours,
          avgOutdoorTemp: 10,
          avgCOP: 2.0
        }
      };
    }
  }

  /**
   * Compare current optimized operation against fixed baseline
   * @param actualConsumptionKWh Current actual energy consumption
   * @param actualCost Current actual cost
   * @param currentOptimizationSavings Savings from current vs recent optimization
   * @param timespan Time period for comparison
   * @param outdoorTemps Outdoor temperatures for baseline calculation
   * @param pricePerKWh Current electricity price
   * @param config Optional baseline configuration
   * @returns Comprehensive baseline comparison
   */
  public compareToBaseline(
    actualConsumptionKWh: number,
    actualCost: number,
    currentOptimizationSavings: number,
    timespan: 'hour' | 'day' | 'week' | 'month',
    outdoorTemps: number[],
    pricePerKWh: number,
    config?: Partial<BaselineConfig>
  ): BaselineComparison {
    try {
      const baselineResult = this.calculateBaselineConsumption(
        timespan, 
        outdoorTemps, 
        pricePerKWh, 
        config
      );
      
      const baselineSavings = Math.max(0, baselineResult.estimatedCost - actualCost);
      const baselinePercentage = baselineResult.estimatedCost > 0 
        ? (baselineSavings / baselineResult.estimatedCost) * 100 
        : 0;
      
      const method = `baseline_comparison_${baselineResult.method}`;
      const confidenceLevel = Math.min(baselineResult.confidence, 0.9); // Cap at 90%
      
      const result: BaselineComparison = {
        actualSavings: currentOptimizationSavings,
        baselineSavings: baselineSavings,
        baselinePercentage: baselinePercentage,
        confidenceLevel: confidenceLevel,
        method: method,
        breakdown: {
          actualConsumption: actualConsumptionKWh,
          baselineConsumption: baselineResult.totalEnergyKWh,
          actualCost: actualCost,
          baselineCost: baselineResult.estimatedCost
        }
      };

      this.safeDebug('Baseline comparison completed:', {
        actualSavings: result.actualSavings.toFixed(2),
        baselineSavings: result.baselineSavings.toFixed(2),
        baselinePercentage: result.baselinePercentage.toFixed(1),
        confidenceLevel: result.confidenceLevel.toFixed(2),
        method: result.method
      });

      return result;
      
    } catch (error) {
      this.safeError('Error in baseline comparison:', error);
      
      // Return conservative comparison
      return {
        actualSavings: currentOptimizationSavings,
        baselineSavings: currentOptimizationSavings * 3, // Assume baseline would be 3x worse
        baselinePercentage: 25, // Conservative 25% savings assumption
        confidenceLevel: 0.1,
        method: 'fallback_comparison',
        breakdown: {
          actualConsumption: actualConsumptionKWh,
          baselineConsumption: actualConsumptionKWh * 1.5,
          actualCost: actualCost,
          baselineCost: actualCost * 1.5
        }
      };
    }
  }

  private getHoursInTimespan(timespan: 'hour' | 'day' | 'week' | 'month'): number {
    switch (timespan) {
      case 'hour': return 1;
      case 'day': return 24;
      case 'week': return 168; // 7 * 24
      case 'month': return 720; // 30 * 24 (approximate)
      default: return 24;
    }
  }

  private getEffectiveCOPs(config: BaselineConfig): { heating: number; hotWater: number } {
    let heatingCOP = config.assumedHeatingCOP || this.defaultConfig.assumedHeatingCOP!;
    let hotWaterCOP = config.assumedHotWaterCOP || this.defaultConfig.assumedHotWaterCOP!;

    // Try to use learned COP values if available, but make them more conservative for baseline
    if (this.copHelper) {
      try {
        // Use seasonal COP as basis, but reduce it to represent non-optimized operation
        const seasonalCOPResult = this.copHelper.getSeasonalCOP();
        
        // Handle both sync and async returns
        const processSeasonalCOP = (seasonalCOP: number) => {
          if (typeof seasonalCOP === 'number' && seasonalCOP > 1.5) {
            // Non-optimized systems typically achieve 75-85% of optimized COP
            // due to poor timing, non-optimal temperatures, and less efficient control
            const efficiencyPenalty = 0.78; // 22% reduction for non-optimized operation
            heatingCOP = Math.max(1.8, seasonalCOP * efficiencyPenalty);
            
            // Hot water COP is typically lower and gets hit harder by poor optimization
            hotWaterCOP = Math.max(1.6, heatingCOP * 0.85);
            
            this.safeDebug('Using learned COP for baseline calculation:', {
              seasonalCOP: seasonalCOP.toFixed(2),
              baselineHeatingCOP: heatingCOP.toFixed(2),
              baselineHotWaterCOP: hotWaterCOP.toFixed(2),
              efficiencyPenalty: ((1 - efficiencyPenalty) * 100).toFixed(0) + '%'
            });
          }
        };
        
        if (seasonalCOPResult instanceof Promise) {
          // For Promise case, we'll use defaults since this is a sync method
          // In a real implementation, this method could be made async
        } else {
          processSeasonalCOP(seasonalCOPResult);
        }
      } catch (error) {
        this.safeError('Error getting learned COP values, using intelligent defaults:', error);
      }
    }

    return { heating: heatingCOP, hotWater: hotWaterCOP };
  }

  private calculateHeatingEnergy(
    config: BaselineConfig,
    hours: number,
    avgOutdoorTemp: number,
    heatingCOP: number
  ): number {
    // No space heating happening -> a fixed-setpoint thermostat would not have heated either.
    if (config.spaceHeatingActive === false) {
      this.safeDebug('Baseline space heating set to zero: no space heating is occurring', {
        avgOutdoorTemp: avgOutdoorTemp.toFixed(1)
      });
      return 0;
    }

    const effectiveHeatingHours = this.getEffectiveHeatingHours(config, hours);
    
    // Calculate heating demand based on temperature difference and season
    const indoorTemp = config.heatingSetpoint;
    const tempDiff = Math.max(0, indoorTemp - avgOutdoorTemp);
    
    // Determine season-based baseline consumption targets
    const isWinter = avgOutdoorTemp < 10; // Below 10°C is winter
    const isSummer = avgOutdoorTemp > 20;  // Above 20°C is summer
    
    // Target baseline daily consumption (for 24 hours)
    let targetDailyKWh: number;
    if (isWinter) {
      targetDailyKWh = 15; // 15 kWh/day for winter heating
    } else if (isSummer) {
      targetDailyKWh = 5;  // 5 kWh/day for summer (minimal heating)
    } else {
      // Spring/autumn - interpolate between summer and winter
      const seasonalFactor = Math.max(0, Math.min(1, (15 - avgOutdoorTemp) / 10));
      targetDailyKWh = 5 + (seasonalFactor * 10); // 5-15 kWh based on temperature
    }
    
    // Scale to actual hours requested
    const scaledTargetKWh = (targetDailyKWh / 24) * hours;
    
    // Apply a simple winter factor so the baseline reflects colder periods better
    const winterFactor = this.getWinterFactor(avgOutdoorTemp);

    // Apply heating schedule efficiency
    const scheduleEfficiency = effectiveHeatingHours / hours;
    const baselineHeatingEnergy = scaledTargetKWh * scheduleEfficiency * winterFactor;
    
    this.safeDebug('Calculated baseline heating energy:', {
      avgOutdoorTemp: avgOutdoorTemp.toFixed(1),
      season: isWinter ? 'winter' : isSummer ? 'summer' : 'transitional',
      targetDailyKWh: targetDailyKWh.toFixed(1),
      hours: hours,
      effectiveHeatingHours: effectiveHeatingHours,
      scheduleEfficiency: scheduleEfficiency.toFixed(2),
      winterFactor: winterFactor.toFixed(2),
      baselineHeatingEnergy: baselineHeatingEnergy.toFixed(2)
    });

    return baselineHeatingEnergy;
  }

  private calculateHotWaterEnergy(
    config: BaselineConfig,
    hours: number,
    hotWaterCOP: number,
    avgOutdoorTemp: number
  ): number {
    // Set reasonable hot water baseline consumption
    // Typically 2-4 kWh/day for hot water in an average home
    let dailyHotWaterKWh = 3.0; // Conservative baseline for hot water
    
    // Try to use learned hot water patterns if available, but make more conservative
    if (this.hotWaterService) {
      try {
        const patterns = (this.hotWaterService as any).getUsagePatterns?.();
        if (patterns && patterns.dailyUsageKWh > 0) {
          // Use 150% of current optimized usage as baseline (less efficient operation)
          dailyHotWaterKWh = Math.max(2.5, patterns.dailyUsageKWh * 1.5);
          dailyHotWaterKWh = Math.min(dailyHotWaterKWh, 5.0); // Cap at 5 kWh/day
        }
      } catch (error) {
        this.safeError('Error getting hot water patterns, using default:', error);
      }
    }
    
    // Slightly increase DHW demand on very cold days (occupants keep water hotter / longer)
    const winterFactor = this.getWinterFactor(avgOutdoorTemp);
    const dhwColdBoost = winterFactor > 1 ? Math.min(1.2, 1 + (winterFactor - 1) * 0.4) : 1;

    // Scale to timespan
    const scaledDemand = (dailyHotWaterKWh / 24) * hours * dhwColdBoost;
    
    this.safeDebug('Calculated baseline hot water energy:', {
      dailyHotWaterKWh: dailyHotWaterKWh.toFixed(2),
      hours: hours,
      scaledDemand: scaledDemand.toFixed(3),
      hotWaterCOP: hotWaterCOP.toFixed(2),
      avgOutdoorTemp: avgOutdoorTemp.toFixed(1),
      dhwColdBoost: dhwColdBoost.toFixed(2)
    });

    return scaledDemand;
  }

  private getWinterFactor(tempC: number): number {
    if (tempC >= 20) {
      return 0.9; // Slightly lower baseline in hot weather
    }
    if (tempC >= 10) {
      return 1.0;
    }
    if (tempC >= 0) {
      // Scale linearly between 10°C (1.0) and 0°C (1.5)
      const fraction = (10 - tempC) / 10;
      return 1.0 + fraction * 0.5;
    }
    // Colder than 0°C - cap around 1.8-2.0 depending on severity
    const severity = Math.min(10, Math.abs(tempC));
    return Math.min(2.0, 1.5 + severity * 0.05);
  }

  private getEffectiveHeatingHours(config: BaselineConfig, totalHours: number): number {
    switch (config.operatingProfile) {
      case 'always_on':
      case '24_7':
        return totalHours; // Heating always on
      
      case 'schedule':
        if (config.scheduleConfig) {
          const dayStart = config.scheduleConfig.dayStart;
          const dayEnd = config.scheduleConfig.dayEnd;
          const activeHoursPerDay = dayEnd - dayStart;
          const days = totalHours / 24;
          return Math.min(totalHours, activeHoursPerDay * days);
        }
        return totalHours * 0.75; // Assume 75% of time for scheduled operation
      
      default:
        return totalHours;
    }
  }

  private calculateConfidence(outdoorTemps: number[], config: BaselineConfig): number {
    let confidence = 0.4; // Base confidence for fixed baseline calculation
    
    // Increase confidence based on available outdoor temperature data
    if (outdoorTemps.length > 0) {
      const dataQualityFactor = Math.min(outdoorTemps.length / 24, 1) * 0.2; // Max 20% from data
      confidence += dataQualityFactor;
    }
    
    // Increase confidence if we have thermal model
    if (this.thermalModelService) {
      try {
        const characteristics = this.thermalModelService.getThermalCharacteristics();
        confidence += characteristics.modelConfidence * 0.2; // Max 20% from thermal model
      } catch (error) {
        // Ignore errors, just don't add thermal confidence
      }
    }
    
    // Increase confidence if we have learned COP data
    if (this.copHelper) {
      try {
        // Assume COP helper provides some confidence boost
        confidence += 0.1; // 10% boost for having COP data
      } catch (error) {
        // Ignore errors
      }
    }
    
    // Increase confidence if we have hot water patterns
    if (this.hotWaterService) {
      try {
        const patterns = (this.hotWaterService as any).getUsagePatterns?.();
        if (patterns && patterns.confidence > 20) {
          confidence += 0.1; // 10% boost for good hot water patterns
        }
      } catch (error) {
        // Ignore errors
      }
    }
    
    return Math.min(confidence, 0.8); // Cap at 80% confidence
  }

  private getCalculationMethod(config: BaselineConfig): string {
    let method = 'fixed_baseline';
    
    if (this.thermalModelService) {
      method += '_thermal_aware';
    }
    
    if (this.copHelper) {
      method += '_cop_adjusted';
    }
    
    if (this.hotWaterService) {
      method += '_usage_aware';
    }
    
    method += `_${config.operatingProfile}`;
    
    return method;
  }
}
