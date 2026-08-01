/**
 * Hot Water Usage Analyzer
 *
 * This service analyzes hot water usage data to identify patterns and make predictions
 * about future hot water usage. It uses the collected data to build a model of the home's
 * hot water usage patterns based on time of day and day of week.
 */

import { DateTime } from 'luxon';
import { estimateHourlyDraw, normaliseDrawPattern } from '../../util/dhw-draw';
import { HotWaterDataCollector, HotWaterUsageDataPoint, AggregatedHotWaterDataPoint } from './hot-water-data-collector';

// Settings key for hot water usage patterns
const HOT_WATER_PATTERNS_SETTINGS_KEY = 'hot_water_usage_patterns';

// Minimum number of data points required for pattern analysis
const MIN_DATA_POINTS_FOR_ANALYSIS = 12; // 12 hours at hourly intervals (reduced for quicker learning)

// Number of data points for full confidence
const FULL_CONFIDENCE_DATA_POINTS = 168; // 7 days at hourly intervals
const RECENCY_HALF_LIFE_DAYS = 7;

export interface HotWaterUsagePatterns {
  // Usage patterns by hour of day (0-23)
  hourlyUsagePattern: number[];
  // Usage patterns by day of week (0-6, 0 = Sunday)
  dailyUsagePattern: number[];
  // Usage patterns by hour for each day of week (7 arrays of 24 hours each)
  hourlyByDayUsagePattern: number[][];
  // Confidence in the model (0-100)
  confidence: number;
  // Last updated timestamp
  lastUpdated: string;
}

export class HotWaterAnalyzer {
  private patterns: HotWaterUsagePatterns;
  private dataCollector: HotWaterDataCollector;

  constructor(private homey: any, dataCollector: HotWaterDataCollector) {
    this.dataCollector = dataCollector;
    this.patterns = this.loadStoredPatterns() || this.createDefaultPatterns();
  }

  /**
   * Load previously stored hot water usage patterns from Homey settings
   * @returns Hot water usage patterns or null if not found
   */
  private loadStoredPatterns(): HotWaterUsagePatterns | null {
    try {
      const patternsData = this.homey.settings.get(HOT_WATER_PATTERNS_SETTINGS_KEY);
      if (patternsData) {
        const patterns = JSON.parse(patternsData);
        this.homey.log('Loaded hot water usage patterns from settings');
        return patterns;
      }
      return null;
    } catch (error) {
      this.homey.error(`Error loading hot water usage patterns: ${error}`);
      return null;
    }
  }

  /**
   * Create default hot water usage patterns
   * @returns Default hot water usage patterns
   */
  private createDefaultPatterns(): HotWaterUsagePatterns {
    // Create default patterns with higher usage in morning and evening
    const hourlyUsagePattern = new Array(24).fill(1);
    // Increase usage during typical morning hours (6-9 AM)
    hourlyUsagePattern[6] = 2;
    hourlyUsagePattern[7] = 3;
    hourlyUsagePattern[8] = 2;
    // Increase usage during typical evening hours (6-10 PM)
    hourlyUsagePattern[18] = 2;
    hourlyUsagePattern[19] = 3;
    hourlyUsagePattern[20] = 2;
    hourlyUsagePattern[21] = 1.5;

    // Create default daily pattern with higher usage on weekends
    const dailyUsagePattern = new Array(7).fill(1);
    // Increase usage on weekends (Saturday and Sunday)
    dailyUsagePattern[0] = 1.2; // Sunday
    dailyUsagePattern[6] = 1.2; // Saturday

    // Create default hourly by day pattern
    const hourlyByDayUsagePattern = [];
    for (let day = 0; day < 7; day++) {
      hourlyByDayUsagePattern.push([...hourlyUsagePattern]);
    }

    // Return default patterns with 0 confidence
    return {
      hourlyUsagePattern,
      dailyUsagePattern,
      hourlyByDayUsagePattern,
      confidence: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Save hot water usage patterns to Homey settings
   */
  private savePatterns(): void {
    try {
      this.homey.settings.set(HOT_WATER_PATTERNS_SETTINGS_KEY, JSON.stringify(this.patterns));
      this.homey.log('Saved hot water usage patterns to settings');
    } catch (error) {
      this.homey.error(`Error saving hot water usage patterns: ${error}`);
    }
  }

  /**
   * Update hot water usage patterns based on collected data
   * @returns True if patterns were updated, false otherwise
   */
  public async updatePatterns(): Promise<boolean> {
    try {
      // Get combined data for analysis
      const { detailed, aggregated } = this.dataCollector.getCombinedDataForAnalysis();
      const analysisNow = DateTime.now();

      // Check if we have enough data for analysis
      if (detailed.length < MIN_DATA_POINTS_FOR_ANALYSIS) {
        this.homey.log(`Not enough data for hot water usage pattern analysis (${detailed.length}/${MIN_DATA_POINTS_FOR_ANALYSIS} data points)`);
        return false;
      }

      this.homey.log(`Analyzing ${detailed.length} hot water usage data points for pattern detection`);

      // Hourly usage is derived from tank temperature falling while the pump is idle, not from
      // the pump's own DHW production. Production measures reheat, which happens when the
      // optimizer permits it rather than when someone runs a tap — learning from it makes the
      // optimizer's own heating hours reappear as tomorrow's "usage peaks".
      const drawEstimate = estimateHourlyDraw(
        detailed.map(dp => ({
          timestamp: dp.timestamp,
          tankTemperature: dp.tankTemperature,
          isHeating: dp.isHeating,
          hourOfDay: dp.hourOfDay
        })),
        { weightFn: dp => this.getRecencyWeight(dp as any, analysisNow) }
      );

      const normalizedHourlyUsage = normaliseDrawPattern(drawEstimate.hourlyDraw);

      this.homey.log('Hot water draw pattern derived from tank temperature', {
        usableIntervals: drawEstimate.usableIntervals,
        hoursCovered: drawEstimate.hoursCovered,
        hasSignal: normalizedHourlyUsage.some(v => v > 0)
      });

      // Calculate daily usage pattern
      const dailyUsage = new Array(7).fill(0);
      const dailyWeight = new Array(7).fill(0);

      detailed.forEach(dp => {
        const weight = this.getRecencyWeight(dp, analysisNow);
        dailyUsage[dp.dayOfWeek] += Math.max(dp.hotWaterEnergyProduced, 0) * weight;
        dailyWeight[dp.dayOfWeek] += weight;
      });

      // Calculate average usage per day
      const dailyUsagePattern = dailyUsage.map((usage, day) => {
        return dailyWeight[day] > 0 ? usage / dailyWeight[day] : 0;
      });

      // Normalize daily usage pattern (average = 1)
      const dailyAvg = dailyUsagePattern.reduce((sum, val) => sum + val, 0) / 7;
      const normalizedDailyUsage = dailyUsagePattern.map(val => {
        return dailyAvg > 0 ? val / dailyAvg : 0;
      });

      // Calculate hourly by day usage pattern
      const hourlyByDayUsage = Array(7).fill(0).map(() => Array(24).fill(0));
      const hourlyByDayWeight = Array(7).fill(0).map(() => Array(24).fill(0));

      detailed.forEach(dp => {
        const weight = this.getRecencyWeight(dp, analysisNow);
        hourlyByDayUsage[dp.dayOfWeek][dp.hourOfDay] += Math.max(dp.hotWaterEnergyProduced, 0) * weight;
        hourlyByDayWeight[dp.dayOfWeek][dp.hourOfDay] += weight;
      });

      // Calculate average usage per hour per day
      const hourlyByDayUsagePattern = hourlyByDayUsage.map((dayUsage, day) => {
        return dayUsage.map((usage, hour) => {
          return hourlyByDayWeight[day][hour] > 0 ? usage / hourlyByDayWeight[day][hour] : 0;
        });
      });

      // Normalize hourly by day usage pattern (average = 1 for each day)
      const hourlyByDayNormalized = hourlyByDayUsagePattern.map(dayUsage => {
        const dayAvg = dayUsage.reduce((sum, val) => sum + val, 0) / 24;
        return dayUsage.map(val => {
          return dayAvg > 0 ? val / dayAvg : 0;
        });
      });

      // Confidence is based on how many intervals actually carry a draw signal, not on how many
      // samples were stored. Sampling is every 5 minutes, so counting raw samples against a
      // denominator meant for hourly data reached "100% confidence" in about 14 hours — and
      // counted reheat intervals, which carry no information about draw, towards it.
      const confidence = Math.min(
        100,
        (drawEstimate.usableIntervals / FULL_CONFIDENCE_DATA_POINTS) * 100
      );

      // Adaptive blend factor: increases with confidence to reduce anchor bias
      // At low confidence (0%): 60% new, 40% old (stable but allows learning)
      // At high confidence (100%): 95% new, 5% old (trusts measured data)
      // This matches the thermal model's adaptive blending pattern (PR-2)
      const adaptiveBlendFactor = Math.min(0.95, 0.6 + (confidence / 100) * 0.35);

      // Update patterns with blended values
      const updatedPatterns: HotWaterUsagePatterns = {
        hourlyUsagePattern: this.blendArrays(normalizedHourlyUsage, this.patterns.hourlyUsagePattern, adaptiveBlendFactor),
        dailyUsagePattern: this.blendArrays(normalizedDailyUsage, this.patterns.dailyUsagePattern, adaptiveBlendFactor),
        hourlyByDayUsagePattern: hourlyByDayNormalized.map((dayUsage, day) => {
          return this.blendArrays(dayUsage, this.patterns.hourlyByDayUsagePattern[day] || new Array(24).fill(1), adaptiveBlendFactor);
        }),
        confidence,
        lastUpdated: new Date().toISOString()
      };

      // Update patterns
      this.patterns = updatedPatterns;

      // Save updated patterns
      this.savePatterns();

      // Enhanced logging with pattern details
      const peakHours = this.patterns.hourlyUsagePattern
        .map((usage, hour) => ({ hour, usage }))
        .filter(h => h.usage > 1.2) // Above average usage
        .map(h => h.hour)
        .slice(0, 5); // Top 5 peak hours
        
      this.homey.log(`[HotWater] Updated usage patterns with ${confidence.toFixed(1)}% confidence`);
      this.homey.log(`[HotWater] Peak usage hours: ${peakHours.length > 0 ? peakHours.join(', ') : 'No clear peaks yet'}`);
      this.homey.log(`[HotWater] Weekend usage factor: ${(this.patterns.dailyUsagePattern[0] + this.patterns.dailyUsagePattern[6]) / 2 || 1.0}`);
      return true;
    } catch (error) {
      this.homey.error(`Error updating hot water usage patterns: ${error}`);
      return false;
    }
  }

  /**
   * Blend two arrays using a blend factor
   * @param newArray New array
   * @param oldArray Old array
   * @param blendFactor Blend factor (0-1, 0 = all old, 1 = all new)
   * @returns Blended array
   */
  private blendArrays(newArray: number[], oldArray: number[], blendFactor: number): number[] {
    return newArray.map((val, i) => {
      const oldVal = i < oldArray.length ? oldArray[i] : val;
      return (val * blendFactor) + (oldVal * (1 - blendFactor));
    });
  }

  private getRecencyWeight(dataPoint: HotWaterUsageDataPoint, referenceNow: DateTime): number {
    const pointTime = DateTime.fromISO(dataPoint.timestamp);
    if (!pointTime.isValid) {
      return 1;
    }

    const ageDays = Math.max(0, referenceNow.diff(pointTime, 'days').days);
    return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  }

  /**
   * Convert Luxon weekday (Monday=1..Sunday=7) into Monday=0..Sunday=6 indexing.
   */
  private toMondayZero(weekday: number): number {
    return (weekday + 6) % 7;
  }

  /**
   * Get hot water usage patterns
   * @returns Hot water usage patterns
   */
  public getPatterns(): HotWaterUsagePatterns {
    return this.patterns;
  }

  /**
   * Predict hot water usage for a specific hour and day
   * @param hour Hour of day (0-23)
   * @param dayOfWeek Day of week (0-6, 0 = Monday)
   * @returns Predicted usage factor (relative to average)
   */
  public predictUsage(hour: number, dayOfWeek: number): number {
    try {
      // Get usage patterns
      const { hourlyUsagePattern, dailyUsagePattern, hourlyByDayUsagePattern, confidence } = this.patterns;

      // If confidence is very low, use default patterns
      if (confidence < 10) {
        // Use hourly pattern only
        return hourlyUsagePattern[hour] || 1;
      }

      // Use a weighted combination of patterns based on confidence
      // As confidence increases, rely more on the hourly by day pattern
      const hourlyByDayWeight = confidence / 100;
      const hourlyWeight = (1 - hourlyByDayWeight) * 0.7;
      const dailyWeight = (1 - hourlyByDayWeight) * 0.3;

      // Get values from patterns
      const hourlyFactor = hourlyUsagePattern[hour] || 1;
      const dailyFactor = dailyUsagePattern[dayOfWeek] || 1;
      const hourlyByDayFactor = hourlyByDayUsagePattern[dayOfWeek]?.[hour] || 1;

      // Calculate weighted usage factor
      const usageFactor = (hourlyFactor * hourlyWeight) + 
                         (dailyFactor * dailyWeight) + 
                         (hourlyByDayFactor * hourlyByDayWeight);

      return usageFactor;
    } catch (error) {
      this.homey.error(`Error predicting hot water usage: ${error}`);
      return 1; // Default to average usage
    }
  }

  /**
   * Predict hot water usage for the next 24 hours
   * @returns Array of 24 predicted usage factors
   */
  public predictNext24Hours(): number[] {
    try {
      const now = DateTime.now();
      const predictions: number[] = [];

      for (let i = 0; i < 24; i++) {
        const futureTime = now.plus({ hours: i });
        const hour = futureTime.hour;
        const dayOfWeek = this.toMondayZero(futureTime.weekday);

        predictions.push(this.predictUsage(hour, dayOfWeek));
      }

      return predictions;
    } catch (error) {
      this.homey.error(`Error predicting next 24 hours of hot water usage: ${error}`);
      return new Array(24).fill(1); // Default to average usage
    }
  }

  /**
   * Get the optimal tank temperature based on predicted usage
   * @param minTemp Minimum allowed tank temperature
   * @param maxTemp Maximum allowed tank temperature
   * @param currentPrice Current electricity price (for logging)
   * @param priceLevel Tibber price level (VERY_CHEAP, CHEAP, NORMAL, EXPENSIVE, VERY_EXPENSIVE)
   * @returns Optimal tank temperature
   */
  public getOptimalTankTemperature(minTemp: number, maxTemp: number, currentPrice: number, priceLevel: string): number {
    try {
      // Get usage predictions for the next 24 hours
      const predictions = this.predictNext24Hours();

      // Calculate the maximum predicted usage in the next 24 hours
      const maxPredictedUsage = Math.max(...predictions);

      // Calculate the average predicted usage in the next 24 hours
      const avgPredictedUsage = predictions.reduce((sum, val) => sum + val, 0) / predictions.length;

      // Calculate the current hour's predicted usage
      const now = DateTime.now();
      const currentHour = now.hour;
      const currentDayOfWeek = this.toMondayZero(now.weekday);
      const currentPredictedUsage = this.predictUsage(currentHour, currentDayOfWeek);

      // Calculate the next 6 hours' average predicted usage
      const next6HoursUsage = [];
      for (let i = 1; i <= 6; i++) {
        const futureTime = now.plus({ hours: i });
        const hour = futureTime.hour;
        const dayOfWeek = this.toMondayZero(futureTime.weekday);
        next6HoursUsage.push(this.predictUsage(hour, dayOfWeek));
      }
      const avgNext6HoursUsage = next6HoursUsage.reduce((sum, val) => sum + val, 0) / next6HoursUsage.length;
      const nearTermPeakUsage = Math.max(currentPredictedUsage, ...next6HoursUsage);

      // Decision logic for optimal temperature using Tibber price levels
      let optimalTemp;

      // Use Tibber's sophisticated price level analysis
      if (priceLevel === 'VERY_CHEAP' || priceLevel === 'CHEAP') {
        // Cheap electricity: Heat more based on predicted usage
        if (nearTermPeakUsage > 1.8 || maxPredictedUsage > 2.2) {
          optimalTemp = maxTemp; // Maximum temperature for high usage
        }
        else if (avgNext6HoursUsage > 1.0 || nearTermPeakUsage > 1.3) {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.8); // 80% of range for moderate usage
        }
        else {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.6); // 60% of range for low usage
        }
      }
      else if (priceLevel === 'EXPENSIVE' || priceLevel === 'VERY_EXPENSIVE') {
        // Expensive electricity: Conservative approach based on immediate usage
        if (currentPredictedUsage > 1.8 || nearTermPeakUsage > 2.2) {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.6); // 60% of range when usage is urgent despite high prices
        }
        else if (currentPredictedUsage > 1.0 || nearTermPeakUsage > 1.4) {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.4); // 40% of range for moderate immediate usage
        }
        else {
          optimalTemp = minTemp; // Minimum temperature for low usage
        }
      }
      else {
        // NORMAL price level: Balanced approach, but immediate DHW demand should still lift the target.
        if (currentPredictedUsage > 1.8 || nearTermPeakUsage > 2.2) {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.7); // 70% of range for strong near-term demand
        }
        else if (avgNext6HoursUsage > 1.0 || nearTermPeakUsage > 1.4) {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.55); // 55% of range for moderate demand
        }
        else {
          optimalTemp = minTemp + ((maxTemp - minTemp) * 0.4); // 40% of range for low demand
        }
      }

      // Round to nearest 1°C (MELCloud hot water systems only support full degrees)
      optimalTemp = Math.round(optimalTemp);

      this.homey.log(`Calculated optimal tank temperature: ${optimalTemp}°C (min: ${minTemp}°C, max: ${maxTemp}°C)`);
      this.homey.log(`Tibber price level: ${priceLevel}, Current price: ${currentPrice}`);
      this.homey.log(`Current predicted usage: ${currentPredictedUsage.toFixed(2)}, Next 6h avg: ${avgNext6HoursUsage.toFixed(2)}, Near-term peak: ${nearTermPeakUsage.toFixed(2)}, Max 24h: ${maxPredictedUsage.toFixed(2)}`);

      return optimalTemp;
    } catch (error) {
      this.homey.error(`Error calculating optimal tank temperature: ${error}`);
      // Return middle temperature as fallback
      return minTemp + ((maxTemp - minTemp) / 2);
    }
  }

  /**
   * Get peak usage hours based on learned patterns
   * @param percentile Top percentile to consider as peak (default 0.2 for top 20%)
   * @returns Array of hour indices (0-23) sorted by usage (highest first)
   */
  public getPeakHours(percentile: number = 0.2): number[] {
    const hourlyUsage = this.patterns.hourlyUsagePattern;
    const ranked = hourlyUsage
      .map((usage, hour) => ({ usage, hour }))
      .filter(({ usage }) => usage > 0)
      .sort((a, b) => b.usage - a.usage);

    if (ranked.length === 0) {
      return [6, 7, 8]; // Default morning peak
    }

    const topCount = Math.max(1, Math.round(ranked.length * percentile));
    return ranked.slice(0, topCount).map(item => item.hour);
  }

  /**
   * Reset hot water usage patterns to defaults
   */
  public resetPatterns(): void {
    try {
      this.patterns = this.createDefaultPatterns();
      this.savePatterns();
      this.homey.log('Reset hot water usage patterns to defaults');
    } catch (error) {
      this.homey.error(`Error resetting hot water usage patterns: ${error}`);
    }
  }
}
