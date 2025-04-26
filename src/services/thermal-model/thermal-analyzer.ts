/**
 * Thermal Model Analyzer
 *
 * This service analyzes collected thermal data to build a model of the home's
 * thermal characteristics and make predictions about heating behavior.
 */

import { DateTime } from 'luxon';
import { ThermalDataPoint } from './data-collector';

export interface ThermalCharacteristics {
  // How quickly the home heats up (°C per hour per °C difference)
  heatingRate: number;

  // How quickly the home cools down (°C per hour per °C difference)
  coolingRate: number;

  // Impact of outdoor temperature on indoor temperature (°C change per °C outdoor change)
  outdoorTempImpact: number;

  // Impact of wind on heat loss (additional °C loss per m/s wind speed)
  windImpact: number;

  // Thermal mass indicator (0-1, higher means more stable temperature)
  thermalMass: number;

  // Confidence in the model (0-1)
  modelConfidence: number;

  // Last updated timestamp
  lastUpdated: string;
}

export interface HeatingPrediction {
  // Predicted indoor temperature after the specified time
  predictedTemperature: number;

  // Time required to reach target temperature (in minutes)
  timeToTarget: number;

  // Estimated energy usage to reach target (if available)
  estimatedEnergy?: number;

  // Confidence in the prediction (0-1)
  confidence: number;
}

// Settings key for thermal characteristics storage
const THERMAL_CHARACTERISTICS_SETTINGS_KEY = 'thermal_model_characteristics';

export class ThermalAnalyzer {
  private thermalCharacteristics!: ThermalCharacteristics; // Using definite assignment assertion
  private minimumDataPointsRequired: number = 24; // Require at least 24 data points for initial model

  constructor(private homey: any) {
    // Try to load saved characteristics from settings
    const savedCharacteristics = this.homey.settings.get(THERMAL_CHARACTERISTICS_SETTINGS_KEY);

    if (savedCharacteristics) {
      try {
        this.thermalCharacteristics = JSON.parse(savedCharacteristics);
        this.homey.log('Loaded thermal characteristics from settings:', this.thermalCharacteristics);
      } catch (error) {
        this.homey.error('Error parsing saved thermal characteristics, using defaults:', error);
        this.initializeDefaultCharacteristics();
      }
    } else {
      this.homey.log('No saved thermal characteristics found, using defaults');
      this.initializeDefaultCharacteristics();
    }
  }

  /**
   * Initialize default thermal characteristics
   */
  private initializeDefaultCharacteristics(): void {
    this.thermalCharacteristics = {
      heatingRate: 0.5,        // Default: 0.5°C per hour per °C difference
      coolingRate: 0.2,        // Default: 0.2°C per hour per °C difference
      outdoorTempImpact: 0.1,  // Default: 0.1°C indoor change per 1°C outdoor change
      windImpact: 0.05,        // Default: 0.05°C additional loss per m/s wind
      thermalMass: 0.7,        // Default: medium-high thermal mass
      modelConfidence: 0,      // Start with zero confidence
      lastUpdated: DateTime.now().toISO()
    };
  }

  /**
   * Update the thermal model based on collected data
   */
  public updateModel(dataPoints: ThermalDataPoint[]): ThermalCharacteristics {
    if (dataPoints.length < this.minimumDataPointsRequired) {
      this.homey.log(`Not enough data points to update thermal model. Have ${dataPoints.length}, need ${this.minimumDataPointsRequired}`);
      return this.thermalCharacteristics;
    }

    this.homey.log(`Updating thermal model with ${dataPoints.length} data points`);

    // Sort data points by timestamp
    const sortedData = [...dataPoints].sort((a, b) =>
      DateTime.fromISO(a.timestamp).toMillis() - DateTime.fromISO(b.timestamp).toMillis()
    );

    // Calculate heating and cooling rates
    const heatingRates: number[] = [];
    const coolingRates: number[] = [];
    const outdoorImpacts: number[] = [];
    const windImpacts: number[] = [];

    for (let i = 1; i < sortedData.length; i++) {
      const current = sortedData[i];
      const previous = sortedData[i-1];

      // Calculate time difference in hours
      const timeDiff = (DateTime.fromISO(current.timestamp).toMillis() -
                        DateTime.fromISO(previous.timestamp).toMillis()) / (1000 * 60 * 60);

      if (timeDiff < 0.1) continue; // Skip if less than 6 minutes apart

      // Temperature change
      const tempChange = current.indoorTemperature - previous.indoorTemperature;

      // Outdoor temperature difference
      const outdoorTempDiff = current.outdoorTemperature - previous.outdoorTemperature;

      // Target-indoor temperature difference
      const targetDiff = previous.targetTemperature - previous.indoorTemperature;

      // Calculate rates
      if (previous.heatingActive && targetDiff > 0) {
        // Heating rate calculation
        const rate = (tempChange / timeDiff) / targetDiff;
        if (!isNaN(rate) && isFinite(rate)) {
          heatingRates.push(rate);
        }
      } else if (!previous.heatingActive && tempChange < 0) {
        // Cooling rate calculation
        const indoorOutdoorDiff = previous.indoorTemperature - previous.outdoorTemperature;
        if (indoorOutdoorDiff > 0) {
          const rate = (Math.abs(tempChange) / timeDiff) / indoorOutdoorDiff;
          if (!isNaN(rate) && isFinite(rate)) {
            coolingRates.push(rate);
          }
        }
      }

      // Calculate outdoor temperature impact
      if (Math.abs(outdoorTempDiff) > 0.5) {
        const impact = tempChange / outdoorTempDiff;
        if (!isNaN(impact) && isFinite(impact)) {
          outdoorImpacts.push(impact);
        }
      }

      // Calculate wind impact
      if (previous.weatherConditions.windSpeed > 2) {
        const expectedCooling = this.thermalCharacteristics.coolingRate *
                               (previous.indoorTemperature - previous.outdoorTemperature) *
                               timeDiff;
        const actualCooling = Math.max(0, -tempChange);
        const extraCooling = actualCooling - expectedCooling;

        if (extraCooling > 0) {
          const windImpact = extraCooling / previous.weatherConditions.windSpeed;
          if (!isNaN(windImpact) && isFinite(windImpact)) {
            windImpacts.push(windImpact);
          }
        }
      }
    }

    // Update the model with new calculated values
    if (heatingRates.length > 0) {
      const avgHeatingRate = heatingRates.reduce((sum, rate) => sum + rate, 0) / heatingRates.length;
      // Blend new value with existing (80% new, 20% old for stability)
      this.thermalCharacteristics.heatingRate = 0.8 * avgHeatingRate + 0.2 * this.thermalCharacteristics.heatingRate;
    }

    if (coolingRates.length > 0) {
      const avgCoolingRate = coolingRates.reduce((sum, rate) => sum + rate, 0) / coolingRates.length;
      this.thermalCharacteristics.coolingRate = 0.8 * avgCoolingRate + 0.2 * this.thermalCharacteristics.coolingRate;
    }

    if (outdoorImpacts.length > 0) {
      const avgOutdoorImpact = outdoorImpacts.reduce((sum, impact) => sum + impact, 0) / outdoorImpacts.length;
      this.thermalCharacteristics.outdoorTempImpact = 0.8 * avgOutdoorImpact + 0.2 * this.thermalCharacteristics.outdoorTempImpact;
    }

    if (windImpacts.length > 0) {
      const avgWindImpact = windImpacts.reduce((sum, impact) => sum + impact, 0) / windImpacts.length;
      this.thermalCharacteristics.windImpact = 0.8 * avgWindImpact + 0.2 * this.thermalCharacteristics.windImpact;
    }

    // Calculate thermal mass based on temperature stability
    const tempVariations: number[] = [];
    for (let i = 1; i < sortedData.length; i++) {
      const tempChange = Math.abs(sortedData[i].indoorTemperature - sortedData[i-1].indoorTemperature);
      const timeDiff = (DateTime.fromISO(sortedData[i].timestamp).toMillis() -
                       DateTime.fromISO(sortedData[i-1].timestamp).toMillis()) / (1000 * 60 * 60);

      if (timeDiff > 0) {
        tempVariations.push(tempChange / timeDiff);
      }
    }

    if (tempVariations.length > 0) {
      const avgVariation = tempVariations.reduce((sum, var_) => sum + var_, 0) / tempVariations.length;
      // Convert to thermal mass indicator (0-1)
      // Lower variation = higher thermal mass
      const newThermalMass = Math.max(0, Math.min(1, 1 - (avgVariation / 0.5)));
      this.thermalCharacteristics.thermalMass = 0.8 * newThermalMass + 0.2 * this.thermalCharacteristics.thermalMass;
    }

    // Update confidence based on amount of data
    const maxConfidencePoints = 168; // 1 week of hourly data
    this.thermalCharacteristics.modelConfidence = Math.min(1, dataPoints.length / maxConfidencePoints);

    // Update timestamp
    this.thermalCharacteristics.lastUpdated = DateTime.now().toISO();

    // Save updated characteristics to settings for persistence across app reinstalls
    try {
      this.homey.settings.set(THERMAL_CHARACTERISTICS_SETTINGS_KEY, JSON.stringify(this.thermalCharacteristics));
      this.homey.log('Saved thermal characteristics to settings storage');
    } catch (error) {
      this.homey.error('Error saving thermal characteristics to settings:', error);
    }

    this.homey.log('Thermal model updated:', this.thermalCharacteristics);

    return this.thermalCharacteristics;
  }

  /**
   * Predict future indoor temperature
   * @param currentTemp Current indoor temperature
   * @param targetTemp Target temperature
   * @param outdoorTemp Current outdoor temperature
   * @param heatingActive Whether heating is currently active
   * @param weatherConditions Current weather conditions
   * @param minutes Minutes into the future to predict
   */
  public predictTemperature(
    currentTemp: number,
    targetTemp: number,
    outdoorTemp: number,
    heatingActive: boolean,
    weatherConditions: { windSpeed: number; humidity: number; cloudCover: number },
    minutes: number
  ): number {
    const hours = minutes / 60;
    let predictedTemp = currentTemp;

    if (heatingActive && targetTemp > currentTemp) {
      // Heating scenario
      const tempDiff = targetTemp - currentTemp;
      const heatingEffect = this.thermalCharacteristics.heatingRate * tempDiff * hours;
      predictedTemp += heatingEffect;
    } else {
      // Cooling scenario
      const tempDiff = currentTemp - outdoorTemp;
      const baseCooling = this.thermalCharacteristics.coolingRate * tempDiff * hours;

      // Additional cooling from wind
      const windCooling = this.thermalCharacteristics.windImpact * weatherConditions.windSpeed * hours;

      predictedTemp -= (baseCooling + windCooling);
    }

    // Account for outdoor temperature changes
    const outdoorEffect = this.thermalCharacteristics.outdoorTempImpact * (outdoorTemp - currentTemp) * hours;
    predictedTemp += outdoorEffect;

    return predictedTemp;
  }

  /**
   * Calculate time needed to reach target temperature
   */
  public calculateTimeToTarget(
    currentTemp: number,
    targetTemp: number,
    outdoorTemp: number,
    weatherConditions: { windSpeed: number; humidity: number; cloudCover: number }
  ): HeatingPrediction {
    if (Math.abs(currentTemp - targetTemp) < 0.1) {
      // Already at target temperature
      return {
        predictedTemperature: currentTemp,
        timeToTarget: 0,
        confidence: 1
      };
    }

    const isHeating = targetTemp > currentTemp;

    if (isHeating) {
      // Calculate time to heat up
      const tempDiff = targetTemp - currentTemp;
      const heatingRatePerHour = this.thermalCharacteristics.heatingRate * tempDiff;

      if (heatingRatePerHour <= 0) {
        return {
          predictedTemperature: currentTemp,
          timeToTarget: Infinity,
          confidence: 0
        };
      }

      const hoursToTarget = tempDiff / heatingRatePerHour;
      const minutesToTarget = Math.ceil(hoursToTarget * 60);

      return {
        predictedTemperature: targetTemp,
        timeToTarget: minutesToTarget,
        confidence: this.thermalCharacteristics.modelConfidence
      };
    } else {
      // Calculate time to cool down
      const tempDiff = currentTemp - targetTemp;
      const outdoorDiff = currentTemp - outdoorTemp;

      // If outdoor temp is higher than target, natural cooling won't reach target
      if (outdoorTemp >= targetTemp) {
        return {
          predictedTemperature: outdoorTemp,
          timeToTarget: Infinity,
          confidence: this.thermalCharacteristics.modelConfidence
        };
      }

      const coolingRatePerHour = this.thermalCharacteristics.coolingRate * outdoorDiff +
                                this.thermalCharacteristics.windImpact * weatherConditions.windSpeed;

      if (coolingRatePerHour <= 0) {
        return {
          predictedTemperature: currentTemp,
          timeToTarget: Infinity,
          confidence: 0
        };
      }

      const hoursToTarget = tempDiff / coolingRatePerHour;
      const minutesToTarget = Math.ceil(hoursToTarget * 60);

      return {
        predictedTemperature: targetTemp,
        timeToTarget: minutesToTarget,
        confidence: this.thermalCharacteristics.modelConfidence
      };
    }
  }

  /**
   * Get the current thermal characteristics
   */
  public getThermalCharacteristics(): ThermalCharacteristics {
    return this.thermalCharacteristics;
  }
}
