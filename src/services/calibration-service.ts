/**
 * Calibration Service
 * 
 * Handles thermal model calibration and optimization outcome learning.
 * Extracted from optimizer.ts as part of PR 6 refactoring.
 */

import { HomeyLogger } from '../util/logger';
import { ThermalController } from './thermal-controller';
import { ThermalModelService } from './thermal-model';
import { AdaptiveParametersLearner } from './adaptive-parameters';

/**
 * Result of a weekly calibration run
 */
export interface CalibrationResult {
  oldK: number;
  newK: number;
  oldS?: number;
  newS: number;
  timestamp: string;
  thermalCharacteristics?: any;
  method?: string;
  analysis?: string;
  success?: boolean;
}

/**
 * Logger interface for calibration service
 */
export interface CalibrationLogger {
  log(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}

/**
 * CalibrationService handles thermal model calibration and learning from optimization outcomes.
 * 
 * Responsibilities:
 * - Run weekly thermal model calibration
 * - Learn from optimization outcomes to adjust adaptive parameters
 * - Integrate with ThermalController and ThermalModelService for model updates
 */
export class CalibrationService {
  private readonly DEFAULT_S = 0.7;

  constructor(
    private readonly logger: CalibrationLogger,
    private readonly thermalController: ThermalController,
    private readonly thermalModelService: ThermalModelService | null,
    private readonly adaptiveParametersLearner: AdaptiveParametersLearner | null,
    private readonly useThermalLearning: boolean
  ) { }

  /**
   * Clamp K-factor to valid range
   */
  private clampK(value: number): number {
    return Math.min(10, Math.max(0.1, value));
  }

  /**
   * Clamp S (thermal mass) to valid range
   */
  private clampS(value: number): number {
    return Math.min(1, Math.max(0.01, value));
  }

  /**
   * Ensure thermal mass values are finite and fall back to defaults when missing
   */
  private sanitizeThermalMass(value: unknown, fallback: number): number {
    const safeFallback = Number.isFinite(fallback) ? fallback : this.DEFAULT_S;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    return safeFallback;
  }

  /**
   * Run weekly calibration of the thermal model
   * 
   * This method:
   * 1. Gets the current thermal model from ThermalController
   * 2. If thermal learning is enabled, uses ThermalModelService to get learned characteristics
   * 3. Updates K-factor based on heating rate and confidence
   * 4. Falls back to basic calibration if learning data is unavailable
   * 
   * @returns Promise resolving to calibration result
   */
  async runWeeklyCalibration(): Promise<CalibrationResult> {
    this.logger.log('Starting weekly calibration');

    // Get current thermal model
    const thermalModel = this.thermalController.getThermalModel();
    if (!thermalModel) {
      return {
        oldK: 0,
        newK: 0,
        newS: 0,
        timestamp: new Date().toISOString(),
        success: false,
        analysis: 'No thermal model available'
      };
    }

    try {
      const oldK = thermalModel.K;
      const baseS = this.sanitizeThermalMass(thermalModel.S, 0);
      let oldS = baseS;
      let characteristics: ReturnType<ThermalModelService['getThermalCharacteristics']> | null = null;

      if (this.useThermalLearning && this.thermalModelService) {
        try {
          characteristics = this.thermalModelService.getThermalCharacteristics();
          const persistedThermalMass = characteristics?.thermalMass;
          oldS = this.sanitizeThermalMass(persistedThermalMass, baseS);
        } catch (modelError) {
          this.logger.error('Error updating thermal model from learning data:', modelError);
        }
      }

      if (this.useThermalLearning && this.thermalModelService && characteristics) {
        const confidence = typeof characteristics.modelConfidence === 'number'
          ? characteristics.modelConfidence
          : 0;

        const heatingRate = typeof characteristics.heatingRate === 'number' && Number.isFinite(characteristics.heatingRate)
          ? characteristics.heatingRate
          : NaN;
        const coolingRate = typeof characteristics.coolingRate === 'number' && Number.isFinite(characteristics.coolingRate)
          ? characteristics.coolingRate
          : NaN;

        // Update our simple K-factor based on the thermal model's characteristics
        // This maintains compatibility with the existing system
        const baseK = oldK;
        const rawK = confidence > 0.3 && Number.isFinite(heatingRate)
          ? (heatingRate / 0.5) * baseK
          : baseK;
        const newK = this.clampK(rawK);

        const thermalMass = this.sanitizeThermalMass(characteristics.thermalMass, oldS);
        const newS = this.clampS(thermalMass);

        // Update thermal model
        this.thermalController.setThermalModel(newK, newS);

        this.logger.log(`Calibrated thermal model using learning data: K=${newK.toFixed(2)}, S=${newS.toFixed(2)}`);
        this.logger.log(
          `Thermal characteristics: Heating rate=${Number.isFinite(heatingRate) ? heatingRate.toFixed(3) : 'n/a'}, ` +
          `Cooling rate=${Number.isFinite(coolingRate) ? coolingRate.toFixed(3) : 'n/a'}, ` +
          `Thermal mass=${Number.isFinite(thermalMass) ? thermalMass.toFixed(2) : 'n/a'}`
        );

        // Issue #3 fix: Force thermal model update to persist learned confidence
        // Without this, confidence was read but not saved back to settings
        // causing it to reset to 0 on next run (chicken-egg loop)
        try {
          this.thermalModelService.forceModelUpdate();
          this.logger.log('Thermal model confidence persisted after calibration');
        } catch (persistErr) {
          this.logger.error('Failed to persist thermal model confidence', persistErr);
        }

        // Perform history cleanup as part of weekly maintenance (PR #10)
        this.cleanupOptimizationHistory();

        // Return result
        return {
          oldK: oldK,
          newK,
          oldS: oldS,
          newS,
          timestamp: new Date().toISOString(),
          thermalCharacteristics: characteristics,
          analysis: `Learning-based calibration (confidence ${(confidence * 100).toFixed(0)}%)`,
          success: true
        };
      }

      // Basic calibration (used as fallback or when thermal learning is disabled)
      const result = this.calibrateBasic(oldK, oldS, thermalModel);

      // Perform history cleanup as part of weekly maintenance (PR #10)
      this.cleanupOptimizationHistory();

      return result;
    } catch (error) {
      this.logger.error('Error in weekly calibration', error);
      const thermalModel = this.thermalController.getThermalModel();
      return {
        oldK: thermalModel.K,
        newK: thermalModel.K,
        oldS: thermalModel.S || 0,
        newS: thermalModel.S || 0,
        timestamp: new Date().toISOString(),
        success: false,
        analysis: `Calibration failed: ${(error as Error).message}`
      };
    }
  }

  /**
   * Clean up old optimization history to prevent unbounded memory growth
   * Part of PR #10: Periodic Optimization History Cleanup
   */
  private cleanupOptimizationHistory(): void {
    try {
      if (this.thermalModelService) {
        this.logger.log('Running periodic optimization history cleanup...');
        const result = this.thermalModelService.forceDataCleanup?.();

        if (result && typeof result.success === 'boolean') {
          if (result.success) {
            this.logger.log(`History cleanup successful: ${result.message}`);
          } else {
            this.logger.error(`History cleanup failed: ${result.message}`);
          }
        } else {
          this.logger.log('History cleanup skipped: no cleanup result from thermal model service');
        }
      }
    } catch (error) {
      this.logger.error('Error during optimization history cleanup:', error);
    }
  }

  /**
   * Basic calibration when thermal learning is disabled or unavailable
   * 
   * @param oldK Previous K-factor
   * @param oldS Previous S (thermal mass)
   * @param thermalModel Current thermal model
   * @returns Calibration result
   */
  private calibrateBasic(oldK: number, oldS: number, thermalModel: { K: number; S?: number }): CalibrationResult {
    const baseK = oldK;
    const newK = this.clampK(baseK * (0.9 + Math.random() * 0.2));
    const rawS = typeof oldS === 'number'
      ? oldS
      : (typeof thermalModel.S === 'number' ? thermalModel.S : this.DEFAULT_S);
    const newS = this.clampS(rawS);

    // Update thermal model
    this.thermalController.setThermalModel(newK, newS);
    this.logger.log(`Weekly calibration updated K-factor: ${oldK.toFixed(2)} -> ${newK.toFixed(2)}`);

    // Return result
    return {
      oldK: oldK,
      newK,
      oldS: oldS,
      newS,
      timestamp: new Date().toISOString(),
      method: 'basic',
      analysis: 'Basic calibration applied (learning data unavailable)',
      success: true
    };
  }

  /**
   * Learn from optimization outcome (called after each optimization cycle)
   * 
   * @param actualSavings Energy savings achieved
   * @param comfortViolations Number of comfort violations
   * @param currentCOP Current COP performance
   */
  public learnFromOptimizationOutcome(
    actualSavings: number,
    comfortViolations: number,
    currentCOP?: number,
    controlSeason?: 'summer' | 'winter' | 'transition'
  ): void {
    if (!this.adaptiveParametersLearner) return;

    // Prefer the season the controller is actually using. The calendar fallback below disagrees
    // with it — in August the calendar says 'summer' while the energy-based detector can report
    // 'transition' — which meant the learner updated priceWeightSummer while the control path
    // read priceWeightTransition. The weight being trained was not the weight being used.
    const season = controlSeason ?? this.deriveCalendarSeason();

    if (controlSeason && controlSeason !== this.deriveCalendarSeason()) {
      this.logger.log(`Learning against control season '${controlSeason}' (calendar would have said '${this.deriveCalendarSeason()}')`);
    }

    this.adaptiveParametersLearner.learnFromOutcome(season, actualSavings, comfortViolations, currentCOP);
  }

  /** Fallback season when the controller has not reported one (e.g. energy metrics unavailable). */
  private deriveCalendarSeason(): 'summer' | 'winter' | 'transition' {
    const month = new Date().getMonth();
    if (month >= 5 && month <= 8) return 'summer';
    if (month >= 11 || month <= 2) return 'winter';
    return 'transition';
  }
}
