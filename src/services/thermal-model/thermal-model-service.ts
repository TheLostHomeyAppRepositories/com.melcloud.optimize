/**
 * Thermal Model Service
 *
 * This service integrates the thermal data collection and analysis
 * with the MELCloud optimizer to provide intelligent heating predictions
 * and optimizations based on the home's learned thermal characteristics.
 */

import { DateTime } from 'luxon';
import { ThermalDataCollector, ThermalDataPoint } from './data-collector';
import { ThermalAnalyzer, ThermalCharacteristics, HeatingPrediction } from './thermal-analyzer';
import { HomeyApp, PricePoint, WeatherData } from '../../types';
import { validateNumber, validateBoolean } from '../../util/validation';

export interface OptimizationRecommendation {
  // Recommended target temperature
  recommendedTemperature: number;

  // Recommended start time for heating
  recommendedStartTime: string;

  // Estimated energy savings compared to constant temperature
  estimatedSavings: number;

  // Confidence in the recommendation (0-1)
  confidence: number;

  // Explanation of the recommendation
  explanation: string;
}

export class ThermalModelService {
  private dataCollector: ThermalDataCollector;
  private analyzer: ThermalAnalyzer;
  private dataCollectionInterval: NodeJS.Timeout | null = null;
  private modelUpdateInterval: NodeJS.Timeout | null = null;
  private dataCleanupInterval: NodeJS.Timeout | null = null;

  constructor(private homey: HomeyApp) {
    this.dataCollector = new ThermalDataCollector(homey);
    this.analyzer = new ThermalAnalyzer(homey);

    // Remove the 10-minute data collection interval
    // this.startDataCollection();

    // Keep the model updates schedule
    this.scheduleModelUpdates();
  }

  // Data collection now happens during hourly optimization

  /**
   * Schedule regular updates to the thermal model
   */
  private scheduleModelUpdates(): void {
    // Update model every 6 hours
    this.modelUpdateInterval = setInterval(() => {
      this.updateThermalModel();
    }, 6 * 60 * 60 * 1000);
    // Don't keep the process alive (important for Jest)
    this.modelUpdateInterval.unref?.();

    // Clean up old data once a day
    // Reduced from 24 hours to 12 hours to better manage memory
    this.dataCleanupInterval = setInterval(() => {
      this.cleanupOldData();
    }, 12 * 60 * 60 * 1000);
    this.dataCleanupInterval.unref?.();

    // Initial model update
    const initialUpdate = setTimeout(() => {
      this.updateThermalModel();
    }, 30 * 60 * 1000); // First update after 30 minutes
    initialUpdate.unref?.();

    // Initial data cleanup
    const initialCleanup = setTimeout(() => {
      this.cleanupOldData();
    }, 60 * 60 * 1000); // First cleanup after 1 hour
    initialCleanup.unref?.();

    this.homey.log('Thermal model updates and data cleanup scheduled (cleanup every 12 hours)');
  }

  // Data collection now happens in the collectDataPoint method called during hourly optimization

  /**
   * Update the thermal model with collected data
   * Now uses both detailed and aggregated data for better analysis
   * @returns The updated thermal characteristics or default values if update fails
   */
  private updateThermalModel(): ThermalCharacteristics {
    try {
      // Get combined data (detailed + aggregated) for more comprehensive analysis
      const combinedData = this.dataCollector.getCombinedDataForAnalysis();
      const dataPoints = this.dataCollector.getAllDataPoints();

      // Log data availability
      this.homey.log(`Updating thermal model with ${dataPoints.length} detailed points and ${combinedData.aggregated.length} aggregated data points`);
      this.homey.log(`Total data points represented: ${combinedData.totalDataPoints}`);

      if (dataPoints.length < 24) {
        this.homey.log(`Not enough data for thermal model update. Have ${dataPoints.length} points, need at least 24.`);
        return {
          heatingRate: 0,
          coolingRate: 0,
          outdoorTempImpact: 0,
          windImpact: 0,
          thermalMass: 0,
          modelConfidence: 0,
          lastUpdated: DateTime.now().toISO()
        };
      }

      // Get memory usage before update
      const memoryBefore = this.dataCollector.getMemoryUsage();

      // Update the model with detailed data points
      // Note: In the future, we could enhance the analyzer to also use aggregated data
      const updatedCharacteristics = this.analyzer.updateModel(dataPoints);

      // Get memory usage after update
      const memoryAfter = this.dataCollector.getMemoryUsage();

      // Calculate memory impact of the update
      const memoryImpact = memoryAfter.estimatedMemoryUsageKB - memoryBefore.estimatedMemoryUsageKB;

      this.homey.log('Thermal model updated successfully');
      this.homey.log(`Memory impact of update: ${memoryImpact}KB`);
      this.homey.log('New thermal characteristics:', JSON.stringify(updatedCharacteristics));

      return updatedCharacteristics;
    } catch (error) {
      this.homey.error('Error updating thermal model:', error);
      return {
        heatingRate: 0,
        coolingRate: 0,
        outdoorTempImpact: 0,
        windImpact: 0,
        thermalMass: 0,
        modelConfidence: 0,
        lastUpdated: DateTime.now().toISO()
      };
    }
  }

  /**
   * Force an immediate thermal model update (public method for external triggers)
   * Issue #3 fix: Called after weekly calibration to persist learned confidence
   * @returns The updated thermal characteristics
   */
  public forceModelUpdate(): ThermalCharacteristics {
    this.homey.log('Forcing immediate thermal model update (external trigger)');
    return this.updateThermalModel();
  }

  /**
   * Clean up old data to manage memory usage
   * This method now uses the data collector's aggregation functionality
   * to preserve historical patterns while reducing memory usage
   */
  private cleanupOldData(): void {
    try {
      // Get memory usage statistics before cleanup
      const beforeStats = this.dataCollector.getMemoryUsage();

      // First, trigger data aggregation for older data points
      this.homey.log('Running thermal data cleanup and aggregation...');
      this.dataCollector.runRetentionMaintenance('scheduled-cleanup');

      const dataPoints = this.dataCollector.getAllDataPoints();

      // Get data statistics for reporting
      const dataStats = this.dataCollector.getDataStatistics(30);

      // Log cleanup results
      const afterStats = this.dataCollector.getMemoryUsage();

      this.homey.log(`Thermal data cleanup complete.`);
      this.homey.log(`Data points: ${beforeStats.dataPointCount} → ${afterStats.dataPointCount}`);
      this.homey.log(`Aggregated data points: ${beforeStats.aggregatedDataCount} → ${afterStats.aggregatedDataCount}`);
      this.homey.log(`Estimated memory usage: ${beforeStats.estimatedMemoryUsageKB}KB → ${afterStats.estimatedMemoryUsageKB}KB`);
      this.homey.log(`Data statistics: ${dataStats.dataPointCount} points over last 30 days, avg indoor temp: ${dataStats.avgIndoorTemp}°C`);

      // Update the thermal model with the cleaned data
      this.updateThermalModel();
    } catch (error) {
      this.homey.error('Error cleaning up old thermal data:', error);
    }
  }

  /**
   * Get the optimal pre-heating start time to reach target temperature by a specific time
   * @param targetTemp Target temperature to reach
   * @param targetTime Time by which the target temperature should be reached
   * @param currentTemp Current indoor temperature
   * @param outdoorTemp Current outdoor temperature
   * @param weatherForecast Weather forecast for the relevant period
   */
  public getOptimalPreheatingTime(
    targetTemp: number,
    targetTime: string,
    currentTemp: number,
    outdoorTemp: number,
    weatherForecast: WeatherData
  ): string {
    // Prevent unused parameter warnings
    void(outdoorTemp); void(weatherForecast);
    try {
      const targetDateTime = DateTime.fromISO(targetTime);
      const now = DateTime.now();

      if (targetDateTime <= now) {
        return now.toISO(); // Target time is now or in the past
      }

      // Get thermal characteristics
      const characteristics = this.analyzer.getThermalCharacteristics();

      // If model confidence is too low, use a conservative estimate
      if (characteristics.modelConfidence < 0.3) {
        // Default to 2 hours before target time
        const result = targetDateTime.minus({ hours: 2 }).toISO();
        // Ensure we never return null (TypeScript safety)
        return result || now.toISO();
      }

      // Calculate heating rate based on thermal characteristics
      const tempDiff = targetTemp - currentTemp;

      if (tempDiff <= 0) {
        return now.toISO(); // Already at or above target temperature
      }

      // Calculate heating time in hours
      const heatingRatePerHour = characteristics.heatingRate * tempDiff;
      const hoursNeeded = tempDiff / heatingRatePerHour;

      // Add safety margin based on model confidence (less confidence = more margin)
      const safetyMargin = (1 - characteristics.modelConfidence) * 1.5;
      const totalHoursNeeded = hoursNeeded + safetyMargin;

      // Calculate optimal start time
      const optimalStartTime = targetDateTime.minus({ hours: totalHoursNeeded });

      // Don't return a time in the past
      const result = optimalStartTime < now ? now.toISO() : optimalStartTime.toISO();
      // Ensure we never return null (TypeScript safety)
      return result || now.toISO();

    } catch (error) {
      this.homey.error('Error calculating optimal preheating time:', error);
      // Fall back to default preheating time (2 hours)
      // Use current time + 2 hours as a safe default if targetTime is invalid
      return DateTime.now().toISO();
    }
  }

  /**
   * Get heating recommendation based on price forecast and thermal model
   * @param priceForecasts Electricity price forecasts
   * @param targetTemp Target temperature to maintain
   * @param currentTemp Current indoor temperature
   * @param outdoorTemp Current outdoor temperature
   * @param weatherForecast Weather forecast
   * @param comfortProfile User's comfort profile
   */
  public getHeatingRecommendation(
    priceForecasts: PricePoint[],
    targetTemp: number,
    currentTemp: number,
    outdoorTemp: number,
    weatherForecast: WeatherData,
    comfortProfile: {
      dayStart: number;
      dayEnd: number;
      nightTempReduction: number;
      preHeatHours: number;
    }
  ): OptimizationRecommendation {
    // Note: outdoorTemp, weatherForecast, and comfortProfile parameters are currently not used
    // but are included for future enhancements and API consistency

    // Prevent unused parameter warnings by referencing them
    void(outdoorTemp); void(weatherForecast); void(comfortProfile);
    try {
      const characteristics = this.analyzer.getThermalCharacteristics();
      const now = DateTime.now();

      // Default recommendation
      const defaultRecommendation: OptimizationRecommendation = {
        recommendedTemperature: targetTemp,
        recommendedStartTime: now.toISO(),
        estimatedSavings: 0,
        confidence: characteristics.modelConfidence,
        explanation: "Recommendation based on thermal model with limited data."
      };

      // If model confidence is too low, return default recommendation
      if (characteristics.modelConfidence < 0.2) {
        return defaultRecommendation;
      }

      // Find periods of cheap and expensive electricity
      const avgPrice = priceForecasts.reduce((sum, p) => sum + p.price, 0) / priceForecasts.length;
      const cheapPeriods = priceForecasts.filter(p => p.price < avgPrice * 0.8);
      const expensivePeriods = priceForecasts.filter(p => p.price > avgPrice * 1.2);

      // If no price variation, return default
      if (cheapPeriods.length === 0 || expensivePeriods.length === 0) {
        return {
          ...defaultRecommendation,
          explanation: "No significant price variations found for optimization."
        };
      }

      // Calculate thermal inertia (how long the house retains heat)
      // Based on cooling rate and thermal mass
      const thermalInertiaHours = (1 / characteristics.coolingRate) * characteristics.thermalMass;

      // Find if we're approaching an expensive period
      const upcomingExpensivePeriod = expensivePeriods.find(p =>
        DateTime.fromISO(p.time) > now &&
        DateTime.fromISO(p.time).diff(now).as('hours') < 6
      );

      // Find if we're in a cheap period now
      const inCheapPeriod = cheapPeriods.some(p =>
        DateTime.fromISO(p.time) <= now &&
        DateTime.fromISO(p.time).plus({ hours: 1 }) > now
      );

      // Find next cheap period
      const nextCheapPeriod = cheapPeriods.find(p =>
        DateTime.fromISO(p.time) > now
      );

      let recommendation: OptimizationRecommendation;

      if (inCheapPeriod && upcomingExpensivePeriod) {
        // We're in a cheap period before an expensive one - pre-heat
        const preHeatTemp = Math.min(targetTemp + 1.5, targetTemp + (characteristics.thermalMass * 2));

        recommendation = {
          recommendedTemperature: preHeatTemp,
          recommendedStartTime: now.toISO(),
          estimatedSavings: this.calculateSavings(targetTemp, preHeatTemp, upcomingExpensivePeriod.price),
          confidence: characteristics.modelConfidence,
          explanation: `Pre-heating to ${preHeatTemp.toFixed(1)}°C during cheap electricity period to save during upcoming expensive period.`
        };
      } else if (upcomingExpensivePeriod) {
        // Expensive period coming up - prepare by pre-heating if we have time
        const hoursUntilExpensive = DateTime.fromISO(upcomingExpensivePeriod.time).diff(now).as('hours');

        if (hoursUntilExpensive < thermalInertiaHours) {
          // We have time to pre-heat
          const preHeatTemp = Math.min(targetTemp + 1, targetTemp + (characteristics.thermalMass * 1.5));

          recommendation = {
            recommendedTemperature: preHeatTemp,
            recommendedStartTime: now.toISO(),
            estimatedSavings: this.calculateSavings(targetTemp, preHeatTemp, upcomingExpensivePeriod.price),
            confidence: characteristics.modelConfidence * (hoursUntilExpensive / thermalInertiaHours),
            explanation: `Pre-heating to ${preHeatTemp.toFixed(1)}°C to prepare for upcoming expensive electricity period.`
          };
        } else {
          // Too far away to pre-heat now
          // Ensure time is valid before using it
          let preHeatTime: string = now.toISO();

          if (upcomingExpensivePeriod && typeof upcomingExpensivePeriod.time === 'string') {
            try {
              const result = DateTime.fromISO(upcomingExpensivePeriod.time)
                .minus({ hours: thermalInertiaHours })
                .toISO();
              // Ensure we never assign null (TypeScript safety)
              if (result) {
                preHeatTime = result;
              }
            } catch (err) {
              this.homey.error('Error calculating preheat time:', err);
            }
          }

          recommendation = {
            ...defaultRecommendation,
            recommendedStartTime: preHeatTime,
            explanation: "Maintaining normal temperature now, will pre-heat before expensive period."
          };
        }
      } else if (nextCheapPeriod) {
        // Cheap period coming up - consider waiting for heating
        const hoursUntilCheap = DateTime.fromISO(nextCheapPeriod.time).diff(now).as('hours');

        if (hoursUntilCheap < 3 && currentTemp > targetTemp - 1.5) {
          // Close enough to cheap period and temperature is acceptable
          const reducedTemp = Math.max(targetTemp - 1, targetTemp - (characteristics.thermalMass * 1.5));

          // Ensure we have a valid time
          const startTime = typeof nextCheapPeriod.time === 'string' ?
            nextCheapPeriod.time : now.toISO();

          recommendation = {
            recommendedTemperature: reducedTemp,
            recommendedStartTime: startTime,
            estimatedSavings: this.calculateSavings(targetTemp, reducedTemp, avgPrice),
            confidence: characteristics.modelConfidence * 0.8,
            explanation: `Temporarily reducing temperature to ${reducedTemp.toFixed(1)}°C until cheaper electricity period begins.`
          };
        } else {
          // Too long to wait or temperature would drop too much
          recommendation = {
            ...defaultRecommendation,
            explanation: "Maintaining target temperature as waiting for cheaper electricity would impact comfort."
          };
        }
      } else {
        // No special price patterns detected
        recommendation = {
          ...defaultRecommendation,
          explanation: "Maintaining target temperature based on current conditions."
        };
      }

      return recommendation;

    } catch (error) {
      this.homey.error('Error generating heating recommendation:', error);
      return {
        recommendedTemperature: targetTemp,
        recommendedStartTime: DateTime.now().toISO(),
        estimatedSavings: 0,
        confidence: 0,
        explanation: "Error generating recommendation, using default settings."
      };
    }
  }

  /**
   * Calculate estimated savings from thermal optimization
   */
  private calculateSavings(normalTemp: number, optimizedTemp: number, expensivePrice: number): number {
    try {
      const characteristics = this.analyzer.getThermalCharacteristics();

      // Calculate energy difference between heating strategies
      const tempDiff = Math.abs(normalTemp - optimizedTemp);

      // Simplified energy calculation based on temperature difference
      // This is a rough estimate - actual savings would depend on many factors
      const energySavingFactor = 0.1 * tempDiff * characteristics.thermalMass;

      // Calculate monetary savings based on price
      const savings = energySavingFactor * expensivePrice;

      return Math.round(savings * 100) / 100; // Round to 2 decimal places
    } catch (error) {
      this.homey.error('Error calculating savings:', error);
      return 0;
    }
  }

  /**
   * Reset the learned thermal model: characteristics back to defaults with zero confidence,
   * and optionally discard the collected training data that produced them.
   *
   * @param clearCollectedData Also clear raw and aggregated data points. Use when the stored
   *   samples are themselves invalid (e.g. collected while the device was in Flow/Curve mode),
   *   otherwise the next analysis run simply relearns the same bad characteristics.
   */
  public resetModel(clearCollectedData: boolean = true): ThermalCharacteristics {
    const characteristics = this.analyzer.resetCharacteristics();

    if (clearCollectedData) {
      this.dataCollector.clearData(true);
    }

    this.homey.log(`Thermal model reset (collected data ${clearCollectedData ? 'cleared' : 'kept'})`);
    return characteristics;
  }

  /**
   * Get the current thermal characteristics
   */
  public getThermalCharacteristics(): ThermalCharacteristics {
    try {
      return this.analyzer.getThermalCharacteristics();
    } catch (error) {
      this.homey.error('Error getting thermal characteristics:', error);
      return {
        heatingRate: 0,
        coolingRate: 0,
        outdoorTempImpact: 0,
        windImpact: 0,
        thermalMass: 0,
        modelConfidence: 0,
        lastUpdated: DateTime.now().toISO()
      };
    }
  }

  /**
   * Get prediction for how temperature will change
   */
  public getTemperaturePrediction(
    currentTemp: number,
    targetTemp: number,
    outdoorTemp: number,
    heatingActive: boolean,
    weatherConditions: any,
    minutes: number
  ): number {
    return this.analyzer.predictTemperature(
      currentTemp,
      targetTemp,
      outdoorTemp,
      heatingActive,
      weatherConditions,
      minutes
    );
  }

  /**
   * Calculate time needed to reach target temperature
   * @param currentTemp Current indoor temperature
   * @param targetTemp Target temperature to reach
   * @param outdoorTemp Current outdoor temperature
   * @param weatherConditions Weather conditions
   * @returns Heating prediction with time to target and confidence
   * @throws Error if validation fails
   */
  public getTimeToTarget(
    currentTemp: number,
    targetTemp: number,
    outdoorTemp: number,
    weatherConditions: any
  ): HeatingPrediction {
    // Default value for validated current temp in case of error
    let validatedCurrentTemp: number = 20; // Default to room temperature

    try {
      // Validate inputs
      validatedCurrentTemp = validateNumber(currentTemp, 'currentTemp', { min: -10, max: 40 });
      const validatedTargetTemp = validateNumber(targetTemp, 'targetTemp', { min: 5, max: 30 });
      const validatedOutdoorTemp = validateNumber(outdoorTemp, 'outdoorTemp', { min: -50, max: 50 });

      // Validate or create default weather conditions
      let validatedWeatherConditions = {
        windSpeed: 0,
        humidity: 50,
        cloudCover: 50,
        precipitation: 0
      };

      if (weatherConditions) {
        validatedWeatherConditions = {
          windSpeed: validateNumber(weatherConditions.windSpeed || 0, 'windSpeed', { min: 0, max: 200 }),
          humidity: validateNumber(weatherConditions.humidity || 50, 'humidity', { min: 0, max: 100 }),
          cloudCover: validateNumber(weatherConditions.cloudCover || 50, 'cloudCover', { min: 0, max: 100 }),
          precipitation: validateNumber(weatherConditions.precipitation || 0, 'precipitation', { min: 0, max: 500 })
        };
      }

      return this.analyzer.calculateTimeToTarget(
        validatedCurrentTemp,
        validatedTargetTemp,
        validatedOutdoorTemp,
        validatedWeatherConditions
      );
    } catch (error) {
      this.homey.error('Error calculating time to target:', error);
      // If we couldn't validate the current temp, use a safe default
      if (typeof validatedCurrentTemp === 'undefined') {
        validatedCurrentTemp = 20; // Default room temperature
      }
      // Return a default prediction with zero confidence
      return {
        timeToTarget: 60, // Default 60 minutes
        confidence: 0,
        predictedTemperature: validatedCurrentTemp // Use current temperature as prediction
      };
    }
  }

  /**
   * Stop all data collection and model updates
   * Ensures proper cleanup of resources
   */
  public stop(): void {
    try {
      // Run final data cleanup to ensure data is properly saved
      try {
        this.cleanupOldData();
      } catch (cleanupError) {
        this.homey.error('Error during final data cleanup:', cleanupError);
      }

      // Clear all intervals
      if (this.dataCollectionInterval) {
        clearInterval(this.dataCollectionInterval);
        this.dataCollectionInterval = null;
        this.homey.log('Thermal model data collection interval stopped');
      }

      if (this.modelUpdateInterval) {
        clearInterval(this.modelUpdateInterval);
        this.modelUpdateInterval = null;
        this.homey.log('Thermal model update interval stopped');
      }

      if (this.dataCleanupInterval) {
        clearInterval(this.dataCleanupInterval);
        this.dataCleanupInterval = null;
        this.homey.log('Thermal model data cleanup interval stopped');
      }

      // Log memory usage statistics before stopping
      try {
        const memoryStats = this.dataCollector.getMemoryUsage();
        this.homey.log(`Final memory stats - Data points: ${memoryStats.dataPointCount}, Aggregated: ${memoryStats.aggregatedDataCount}, Memory: ${memoryStats.estimatedMemoryUsageKB}KB`);
      } catch (statsError) {
        this.homey.error('Error getting final memory statistics:', statsError);
      }

      this.homey.log('Thermal model service stopped and resources cleaned up');
    } catch (error) {
      this.homey.error('Error stopping thermal model service:', error);
    }
  }

  /**
   * Collect a data point from the optimizer
   * @param dataPoint The thermal data point to collect
   * @throws Error if validation fails
   */
  public collectDataPoint(dataPoint: ThermalDataPoint): void {
    try {
      // Validate data point
      if (!dataPoint) {
        throw new Error('Invalid data point: data point is null or undefined');
      }

      // Validate required fields
      const timestamp = dataPoint.timestamp || DateTime.now().toISO();
      const indoorTemperature = validateNumber(dataPoint.indoorTemperature, 'indoorTemperature', { min: -10, max: 40 });
      const outdoorTemperature = validateNumber(dataPoint.outdoorTemperature, 'outdoorTemperature', { min: -50, max: 50 });
      const targetTemperature = validateNumber(dataPoint.targetTemperature, 'targetTemperature', { min: 5, max: 30 });
      const heatingActive = validateBoolean(dataPoint.heatingActive, 'heatingActive');

      // Validate weather conditions if present
      let weatherConditions = dataPoint.weatherConditions || {
        windSpeed: 0,
        humidity: 50,
        cloudCover: 50,
        precipitation: 0
      };

      if (dataPoint.weatherConditions) {
        weatherConditions = {
          windSpeed: validateNumber(dataPoint.weatherConditions.windSpeed, 'windSpeed', { min: 0, max: 200 }),
          humidity: validateNumber(dataPoint.weatherConditions.humidity, 'humidity', { min: 0, max: 100 }),
          cloudCover: validateNumber(dataPoint.weatherConditions.cloudCover, 'cloudCover', { min: 0, max: 100 }),
          precipitation: validateNumber(dataPoint.weatherConditions.precipitation, 'precipitation', { min: 0, max: 500 })
        };
      }

      // Create validated data point
      const validatedDataPoint: ThermalDataPoint = {
        timestamp,
        indoorTemperature,
        outdoorTemperature,
        targetTemperature,
        heatingActive,
        weatherConditions
      };

      // Add to collector
      this.dataCollector.addDataPoint(validatedDataPoint);
      this.homey.log('Thermal data point collected during hourly optimization');
    } catch (error) {
      this.homey.error('Error collecting thermal data point:', error);
      throw error; // Re-throw to propagate the error
    }
  }

  /**
   * Get memory usage statistics for the thermal model service
   * @returns Object with memory usage information
   */
  public getMemoryUsage(): {
    dataPointCount: number;
    aggregatedDataCount: number;
    estimatedMemoryUsageKB: number;
    dataPointsPerDay: number;
    modelCharacteristics: {
      heatingRate: number;
      coolingRate: number;
      outdoorTempImpact: number;
      windImpact: number;
      thermalMass: number;
      modelConfidence: number;
      lastUpdated: string;
    };
  } {
    try {
      // Get memory usage from data collector
      const collectorStats = this.dataCollector.getMemoryUsage();

      // Get model characteristics
      const characteristics = this.analyzer.getThermalCharacteristics();

      return {
        ...collectorStats,
        modelCharacteristics: characteristics
      };
    } catch (error) {
      this.homey.error('Error getting memory usage statistics:', error);
      return {
        dataPointCount: 0,
        aggregatedDataCount: 0,
        estimatedMemoryUsageKB: 0,
        dataPointsPerDay: 0,
        modelCharacteristics: {
          heatingRate: 0,
          coolingRate: 0,
          outdoorTempImpact: 0,
          windImpact: 0,
          thermalMass: 0,
          modelConfidence: 0,
          lastUpdated: DateTime.now().toISO()
        }
      };
    }
  }

  /**
   * Force data cleanup and aggregation
   * This can be called from the app to manually trigger cleanup
   * @returns Object with cleanup results
   */
  public forceDataCleanup(): {
    success: boolean;
    dataPointsBefore: number;
    dataPointsAfter: number;
    aggregatedPointsBefore: number;
    aggregatedPointsAfter: number;
    memoryUsageBefore: number;
    memoryUsageAfter: number;
    message: string;
  } {
    try {
      // Get memory usage before cleanup
      const beforeStats = this.dataCollector.getMemoryUsage();

      // Run cleanup
      this.cleanupOldData();

      // Get memory usage after cleanup
      const afterStats = this.dataCollector.getMemoryUsage();

      return {
        success: true,
        dataPointsBefore: beforeStats.dataPointCount,
        dataPointsAfter: afterStats.dataPointCount,
        aggregatedPointsBefore: beforeStats.aggregatedDataCount,
        aggregatedPointsAfter: afterStats.aggregatedDataCount,
        memoryUsageBefore: beforeStats.estimatedMemoryUsageKB,
        memoryUsageAfter: afterStats.estimatedMemoryUsageKB,
        message: `Cleanup successful. Reduced memory usage by ${beforeStats.estimatedMemoryUsageKB - afterStats.estimatedMemoryUsageKB}KB.`
      };
    } catch (error) {
      this.homey.error('Error forcing data cleanup:', error);
      return {
        success: false,
        dataPointsBefore: 0,
        dataPointsAfter: 0,
        aggregatedPointsBefore: 0,
        aggregatedPointsAfter: 0,
        memoryUsageBefore: 0,
        memoryUsageAfter: 0,
        message: `Error during cleanup: ${error}`
      };
    }
  }
}
