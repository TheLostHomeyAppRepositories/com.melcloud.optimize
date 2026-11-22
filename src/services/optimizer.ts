import { randomUUID } from 'crypto';
import { HomeyLogger } from '../util/logger';
import { MelCloudApi } from './melcloud-api';
import { PriceAnalyzer } from './price-analyzer';
import { ThermalController } from './thermal-controller';
import { COPHelper } from './cop-helper';
import { ThermalModelService, ThermalCharacteristics } from './thermal-model';
import { predictCurveWarming } from './thermal-model/thermal-analyzer';
import { EnhancedSavingsCalculator, SavingsCalculationResult, OptimizationData } from '../util/enhanced-savings-calculator';
import { HotWaterOptimizer } from './hot-water-optimizer';
import { ZoneOptimizer } from './zone-optimizer';
import { ConstraintManager } from './constraint-manager';
import { StateManager } from './state-manager';
import { SettingsLoader, getZone2Settings, gridFeeOnTopOfPrices } from './settings-loader';
import { CurrencyDetector } from '../util/currency-detector';
import { TimeZoneHelper } from '../util/time-zone-helper';
import { CopNormalizer } from './cop-normalizer';
import { HotWaterUsageLearner, HotWaterLearnerLogger } from './hot-water-usage-learner';
import { EnergyMetricsService } from './energy-metrics-service';
import { TemperatureOptimizer, PriceStats, ComfortBand } from './temperature-optimizer';
import { SavingsService } from './savings-service';
import { CalibrationService, CalibrationResult } from './calibration-service';
import { ComfortViolationTracker } from './comfort-violation-tracker';
import {
  OptimizationMetrics,
  TankOptimizationResult,
  SecondaryZoneResult,
  EnhancedOptimizationResult,
  PriceProvider,
  TibberPriceInfo,
  WeatherData,
  HomeyApp,
  RealEnergyData,
  ThermalModel,
  ThermalMassModel,
  MelCloudDevice,
  HotWaterService,
  hasHotWaterService
} from '../types';
import type { AbsolutePriceLevel } from '../types/index';
import { validateNumber, validateBoolean } from '../util/validation';
import { computePlanningBias, updateThermalResponse } from './planning-utils';
import { applySetpointConstraints } from '../util/setpoint-constraints';
import { SettingsAccessor } from '../util/settings-accessor';
import { isNightHour } from '../util/night-setback';
import { AdaptiveParametersLearner, LearnedControlParameters } from './adaptive-parameters';
import { COMFORT_CONSTANTS } from '../constants';
import { resolvePriceThresholds } from './price-classifier';
import { isRoomTargetMode, describeZoneMode, isThermostatChangeInert } from '../util/zone-mode';

// Removed: DEFAULT_HOT_WATER_PEAK_HOURS now comes from HotWaterUsageLearner
const MIN_SAVINGS_FOR_LEARNING = 0.05; // Minimum savings (SEK-equivalent) to trigger learning on no-change path

/**
 * Dead zone applied to the tank target on a 'maintain' signal, in °C.
 *
 * 'maintain' means no strong price or usage signal, but the targets it resolves to are
 * memoryless band fractions of the current price level. Without hysteresis the tank chases
 * every price-level boundary crossing, producing an hourly setpoint write and continuous
 * compressor churn for a saving that does not cover the cycling.
 */
const MAINTAIN_TANK_HYSTERESIS_C = 2.0;

/** Settings key holding the epoch ms of a committed tank reheat, if one is pending. */
const SCHEDULED_TANK_REHEAT_SETTING = 'dhw_scheduled_reheat_ms';

/**
 * How late a scheduled reheat may be honoured. The optimizer runs hourly, so a commitment
 * should be picked up on the next run; anything older is stale and reheating then would land in
 * an hour that was never chosen for its price.
 */
const SCHEDULED_TANK_REHEAT_GRACE_MINUTES = 90;

type DecisionLogger = (event: string, payload: Record<string, unknown>) => void;
type ConstraintResult = ReturnType<typeof applySetpointConstraints>;

interface ForecastCapableWeatherApi {
  getCurrentWeather(): Promise<WeatherData>;
  getForecast?(): Promise<unknown>;
  calculateWeatherBasedAdjustment?(
    forecast: unknown,
    currentTemp: number | null,
    targetTemp: number | null,
    currentPrice: number | null,
    avgPrice: number | null
  ): WeatherAdjustmentInfo;
  getWeatherTrend?(forecast: unknown): unknown;
}

interface WeatherAdjustmentInfo {
  adjustment: number;
  reason: string;
}

interface WeatherTrendInfo {
  trend: string;
  details: string;
}

interface WeatherInfo {
  current?: Partial<WeatherData>;
  adjustment?: WeatherAdjustmentInfo;
  trend?: WeatherTrendInfo;
  tempAdjustment?: number;
  condition?: string;
}

interface OptimizationInputs {
  deviceState: MelCloudDevice;
  currentTemp: number | undefined;
  currentTarget: number | undefined;
  outdoorTemp: number;
  priceData: TibberPriceInfo;
  priceStats: {
    currentPrice: number;
    avgPrice: number;
    minPrice: number;
    maxPrice: number;
    pricePercentile: number;
    priceLevel: string;
    nextHourPrice?: number;
  };
  priceClassification: ReturnType<PriceAnalyzer['analyzePrice']>;
  priceForecast: any;
  planningReferenceTime: Date;
  planningReferenceTimeMs: number;
  thermalResponse: number;
  previousIndoorTemp: number | null;
  previousIndoorTempTs: number | null;
  constraintsBand: { minTemp: number; maxTemp: number };
  safeCurrentTarget: number;
  /** ATW zone-1 control mode reported by the device: 0 = Room, 1 = Flow, 2 = Curve. */
  operationModeZone1: number | undefined;
  /**
   * True when the device's zone-1 setpoint is genuinely a room-temperature target.
   * In Flow/Curve mode the setpoint is a water/curve reference, so it must not be
   * interpreted as, or learned from as, a room target.
   */
  roomTargetIsRoomTemp: boolean;
}

interface Zone1OptimizationResult {
  targetTemp: number;
  reason: string;
  metrics?: OptimizationMetrics;
  thermalStrategy: any | null;
  hotWaterAction: any;
  constraints: ConstraintResult;
  expectedDelta: number;
  tempDifference: number;
  duplicateTarget: boolean;
  lockoutActive: boolean;
  changed: boolean;
  needsApply: boolean;
  /** True when the write was suppressed because the room is above the comfort band (no heat possible). */
  heatDemandHold?: boolean;
  /** True when the write was suppressed because the zone thermostat would stay on (or off) either way. */
  thermostatHold?: boolean;
  priceNormalized: number;
  weatherInfo?: WeatherInfo | null;
  planningBias?: number;
  safeCurrentTarget: number;
  indoorTemp: number | undefined;
  outdoorTemp: number;
}

interface AppliedChanges {
  zone1Applied: boolean;
  zone1Error?: string;
  zone1HoldReason?: string;
  lockoutActive?: boolean;
  duplicateTarget?: boolean;
  zone2Applied: boolean;
  zone2Error?: string;
  tankApplied: boolean;
  tankError?: string;
}

interface CombinedSavings {
  zone1: number;
  zone2: number;
  tank: number;
  total: number;
}

interface TankOptimizationPlan extends TankOptimizationResult {
  needsApply?: boolean;
  lockoutActive?: boolean;
  duplicateTarget?: boolean;
  evaluatedAtMs?: number;
  holdReason?: string;
  /** Hot water mode to set: 'forced' starts a reheat now, 'auto' ends a forced run the app began. */
  hotWaterMode?: 'forced' | 'auto';
  /** The tank is below the user's minimum (for remembering when a raise was tried). */
  tankBelowMin?: boolean;
  /** Forced hot water the app requested earlier has lapsed (the unit no longer reports it). */
  clearForcedRecord?: boolean;
  /** Forced hot water was requested, yet the tank is still below the minimum and not reheating. */
  forcedNotStarted?: ForcedHotWaterNotStarted;
}

/** Unit state when an earlier forced hot water request has not started a reheat. */
interface ForcedHotWaterNotStarted {
  requestedAtMs: number;
  tankC: number;
  minC: number;
  forcedFlag: boolean;
  unitMode: number | null;
  roomC: number | null;
  zoneTargetC: number | null;
  zoneIdle: boolean | null;
  /** Forced hot water is requested again in this run. */
  retrying: boolean;
}

class OptimizationAbort extends Error {
  constructor(public readonly result: EnhancedOptimizationResult) {
    super(result.reason ?? 'Optimization aborted');
    this.name = 'OptimizationAbort';
  }
}

/**
 * Optimizer Service
 * Handles the optimization logic for MELCloud devices based on electricity prices
 * and thermal characteristics of the home
 */
export class Optimizer {
  private priceAnalyzer: PriceAnalyzer;
  private thermalController: ThermalController;
  private hotWaterOptimizer: HotWaterOptimizer;
  private zoneOptimizer: ZoneOptimizer;
  private comfortTracker = new ComfortViolationTracker();

  // New service-based architecture
  private constraintManager: ConstraintManager;
  private stateManager: StateManager;
  private settingsLoader?: SettingsLoader;
  private settingsAccessor?: SettingsAccessor;

  private minSetpointChangeMinutes: number = COMFORT_CONSTANTS.DEFAULT_MIN_SETPOINT_CHANGE_MINUTES;

  private thermalModelService: ThermalModelService | null = null;
  private useThermalLearning: boolean = false;
  private copHelper: COPHelper | null = null;
  private copWeight: number = 0.3;
  private autoSeasonalMode: boolean = true;
  private summerMode: boolean = false;
  private enhancedSavingsCalculator: EnhancedSavingsCalculator;
  private savingsService!: SavingsService;
  // lastEnergyData and optimizationMetrics are now provided via getters from energyMetricsService
  private timeZoneHelper!: TimeZoneHelper;

  // Home/Away state management
  private occupied: boolean = true;

  /** Hot water usage learning service - replaces inline hotWaterUsagePattern */
  private hotWaterUsageLearner: HotWaterUsageLearner;

  private adaptiveParametersLearner?: AdaptiveParametersLearner;

  /** Temperature optimizer service - handles temperature calculations */
  private temperatureOptimizer!: TemperatureOptimizer;

  /** Calibration service - handles thermal model calibration and learning */
  private calibrationService!: CalibrationService;

  // Initialization state tracking
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    private readonly melCloud: MelCloudApi,
    priceProvider: PriceProvider | null,
    private readonly deviceId: string,
    private readonly buildingId: number,
    private readonly logger: HomeyLogger,
    private readonly weatherApi?: ForecastCapableWeatherApi,
    private readonly homey?: HomeyApp
  ) {
    // Initialize COP Normalizers (separate ranges for heating and hot water)
    this.copNormalizer = new CopNormalizer(homey, this.logger);
    this.copNormalizerHotWater = new CopNormalizer(homey, this.logger, 'cop_guards_hw_v1');

    // Initialize Hot Water Usage Learner (provides pattern learning for hot water optimization)
    const learnerLogger: HotWaterLearnerLogger = {
      log: (msg, data) => this.logger.log(`[HotWaterLearner] ${msg}`, data),
      warn: (msg, data) => this.logger.warn(`[HotWaterLearner] ${msg}`, data),
      error: (msg, err) => this.logger.error(`[HotWaterLearner] ${msg}`, err)
    };
    this.hotWaterUsageLearner = new HotWaterUsageLearner(learnerLogger);

    // Initialize Energy Metrics Service (provides real energy data and optimization metrics)
    const metricsLogger = {
      log: (msg: string, data?: Record<string, unknown>) => this.logger.log(`[EnergyMetrics] ${msg}`, data),
      warn: (msg: string, data?: Record<string, unknown>) => this.logger.warn(`[EnergyMetrics] ${msg}`, data),
      error: (msg: string, err?: unknown) => this.logger.error(`[EnergyMetrics] ${msg}`, err)
    };
    this.energyMetricsService = new EnergyMetricsService({
      melCloud: this.melCloud,
      copNormalizer: this.copNormalizer,
      copNormalizerHotWater: this.copNormalizerHotWater,
      hotWaterUsageLearner: this.hotWaterUsageLearner,
      logger: metricsLogger,
      getHotWaterService: () => this.getHotWaterService()
    });

    // Initialize services first
    this.constraintManager = new ConstraintManager(this.logger);
    this.stateManager = new StateManager(this.logger);

    // Initialize adaptive parameters learner first
    if (homey) {
      this.settingsAccessor = new SettingsAccessor(homey, this.logger);
      this.adaptiveParametersLearner = new AdaptiveParametersLearner(homey);
      this.logger.log('Adaptive parameters learner initialized');

      // Initialize settings loader
      this.settingsLoader = new SettingsLoader(homey, this.logger);
    }

    // Initialize services (SYNCHRONOUS ONLY)
    this.priceAnalyzer = new PriceAnalyzer(this.logger, this.adaptiveParametersLearner);
    this.priceAnalyzer.setPriceProvider(priceProvider);

    // Initialize thermal learning model if homey instance is provided
    if (homey) {
      try {
        this.thermalModelService = new ThermalModelService(homey);
        this.useThermalLearning = true;
        this.logger.log('Thermal learning model initialized');
      } catch (error) {
        this.logger.error('Failed to initialize thermal learning model:', error);
        this.useThermalLearning = false;
      }
    } else {
      this.useThermalLearning = false;
    }

    // Initialize ThermalController first (needed by ZoneOptimizer)
    this.thermalController = new ThermalController(
      this.logger,
      this.thermalModelService || undefined,
      this.adaptiveParametersLearner,
      this.copNormalizer
    );

    this.hotWaterOptimizer = new HotWaterOptimizer(this.logger, this.priceAnalyzer);
    this.zoneOptimizer = new ZoneOptimizer(this.logger, this.melCloud, this.priceAnalyzer, this.thermalController, this.copNormalizer);

    // Initialize COP helper (SYNCHRONOUS ONLY)
    if (homey) {
      try {
        this.copHelper = new COPHelper(homey, this.logger);
        this.logger.log('COP helper initialized');

        // Load settings (SYNCHRONOUS) using SettingsLoader
        this.loadSettings();

        // Initialize TimeZoneHelper with settings from SettingsLoader
        const tzSettings = this.settingsLoader!.loadTimezoneSettings();
        this.timeZoneHelper = new TimeZoneHelper(
          this.logger,
          tzSettings.offset,
          tzSettings.useDST,
          tzSettings.name
        );
        this.logger.log('TimeZoneHelper initialized for Optimizer');

      } catch (error) {
        this.logger.error('Failed to initialize COP helper:', error);
        this.copHelper = null;
      }
    } else {
      // Initialize TimeZoneHelper with defaults when no homey instance
      this.timeZoneHelper = new TimeZoneHelper(this.logger, 2, false);
      this.logger.log('TimeZoneHelper initialized with defaults (no homey instance)');
    }

    // Initialize enhanced savings calculator after all services are set up
    // Get references to hot water service if available
    const hotWaterService = this.getHotWaterService();

    // Initialize enhanced savings calculator with available services
    this.enhancedSavingsCalculator = new EnhancedSavingsCalculator(
      this.logger,
      this.thermalModelService || undefined,
      hotWaterService,
      this.copHelper || undefined
    );

    // Initialize Savings Service (wraps EnhancedSavingsCalculator with optimizer context)
    const savingsLogger = {
      log: (msg: string, data?: Record<string, unknown>) => this.logger.log(`[SavingsService] ${msg}`, data),
      warn: (msg: string, data?: Record<string, unknown>) => this.logger.warn(`[SavingsService] ${msg}`, data),
      error: (msg: string, err?: unknown) => this.logger.error(`[SavingsService] ${msg}`, err)
    };
    this.savingsService = new SavingsService({
      enhancedSavingsCalculator: this.enhancedSavingsCalculator,
      priceAnalyzer: this.priceAnalyzer,
      timeZoneHelper: this.timeZoneHelper,
      logger: savingsLogger,
      settingsAccessor: {
        getGridFee: () => this.getGridFee(),
        getCurrency: () => this.getCurrency()
      },
      metricsAccessor: {
        getOptimizationMetrics: () => this.optimizationMetrics
      },
      weatherApi: this.weatherApi
    });
    this.logger.log('Savings service initialized');

    // Initialize Temperature Optimizer service
    const tempOptimizerLogger = {
      log: (msg: string, data?: Record<string, unknown>) => this.logger.log(`[TempOptimizer] ${msg}`, data),
      warn: (msg: string, data?: Record<string, unknown>) => this.logger.warn(`[TempOptimizer] ${msg}`, data),
      error: (msg: string, err?: unknown) => this.logger.error(`[TempOptimizer] ${msg}`, err)
    };
    this.temperatureOptimizer = new TemperatureOptimizer({
      copNormalizer: this.copNormalizer,
      copNormalizerHotWater: this.copNormalizerHotWater,
      copHelper: this.copHelper,
      adaptiveParametersLearner: this.adaptiveParametersLearner || null,
      logger: tempOptimizerLogger,
      copWeight: this.copWeight,
      autoSeasonalMode: this.autoSeasonalMode,
      summerMode: this.summerMode
    });
    this.logger.log('Temperature optimizer initialized');

    // Initialize Calibration Service
    const calibrationLogger = {
      log: (msg: string, data?: Record<string, unknown>) => this.logger.log(`[Calibration] ${msg}`, data),
      error: (msg: string, err?: unknown) => this.logger.error(`[Calibration] ${msg}`, err)
    };
    this.calibrationService = new CalibrationService(
      calibrationLogger,
      this.thermalController,
      this.thermalModelService,
      this.adaptiveParametersLearner || null,
      this.useThermalLearning
    );
    this.logger.log('Calibration service initialized');

    this.logger.log('Optimizer constructed (call initialize() for async setup)');
    this.logger.log('Enhanced savings calculator initialized with services:', {
      thermalService: !!this.thermalModelService,
      hotWaterService: !!hotWaterService,
      copHelper: !!this.copHelper,
      baselineCapability: this.enhancedSavingsCalculator.hasBaselineCapability()
    });
  }

  /**
   * Load settings from Homey instance
   * Extracted from constructor for clarity
   */
  private loadSettings(): void {
    if (!this.homey || !this.settingsLoader) return;

    // Load all settings using SettingsLoader
    const settings = this.settingsLoader.loadAllSettings();

    // Apply COP settings
    this.copWeight = settings.cop.weight;
    this.autoSeasonalMode = settings.cop.autoSeasonalMode;
    this.summerMode = settings.cop.summerMode;

    // Load price threshold settings
    this.priceAnalyzer.setThresholds(settings.price.cheapPercentile);

    // Apply constraint settings
    this.setConstraintSettings(
      settings.constraints.minSetpointChangeMinutes,
      settings.constraints.deadband
    );
    this.thermalController.setCurveGateOffset(settings.constraints.curveGateOffset);

    // Load and apply Zone 1 constraints (using current values as basis)
    const zone1Min = this.settingsLoader.getNumber('min_temp', COMFORT_CONSTANTS.DEFAULT_MIN_TEMP, { min: 10, max: 30 });
    const zone1Max = this.settingsLoader.getNumber('max_temp', COMFORT_CONSTANTS.DEFAULT_MAX_TEMP, { min: 10, max: 30 });
    this.constraintManager.setZone1Constraints(zone1Min, zone1Max, settings.constraints.tempStepMax);

    // Load and apply Zone 2 constraints
    const zone2 = getZone2Settings(this.homey.settings);
    const enableZone2 = zone2.enabled;
    const zone2Min = Math.min(Math.max(zone2.min, 10), 30);
    const zone2Max = Math.min(Math.max(zone2.max, 10), 30);
    const zone2Step = this.settingsLoader.getNumber('temp_step_zone2', COMFORT_CONSTANTS.DEFAULT_TEMP_STEP_ZONE2, { min: 0.1, max: 2 });
    this.constraintManager.setZone2Constraints(enableZone2, zone2Min, zone2Max, zone2Step);

    // Load and apply tank constraints
    const enableTank = this.settingsLoader.getBoolean('enable_tank_control', false);
    const tankMin = this.settingsLoader.getNumber('min_tank_temp', COMFORT_CONSTANTS.DEFAULT_MIN_TANK_TEMP, { min: 30, max: 70 });
    const tankMax = this.settingsLoader.getNumber('max_tank_temp', COMFORT_CONSTANTS.DEFAULT_MAX_TANK_TEMP, { min: 30, max: 70 });
    const tankStep = this.settingsLoader.getNumber('tank_temp_step', COMFORT_CONSTANTS.DEFAULT_TANK_TEMP_STEP, { min: 0.5, max: 5 });
    this.constraintManager.setTankConstraints(enableTank, tankMin, tankMax, tankStep);

    // Load state from settings
    this.stateManager.loadFromSettings(this.homey);

    // COP guards are now handled by CopNormalizer (initialized in constructor)
    // which automatically restores from settings

    // Load home/away state
    this.occupied = settings.occupancy.occupied;
  }

  /**
   * Update timezone settings for the optimizer
   * @param timeZoneOffset Timezone offset in hours
   * @param useDST Whether to use daylight saving time
   * @param timeZoneName IANA timezone name (optional)
   */
  public updateTimeZoneSettings(timeZoneOffset: number, useDST: boolean, timeZoneName?: string): void {
    if (this.timeZoneHelper) {
      this.timeZoneHelper.updateSettings(timeZoneOffset, useDST, timeZoneName);
      this.logger.log(`Optimizer timezone settings updated: offset=${timeZoneOffset}, DST=${useDST}, name=${timeZoneName || 'n/a'}`);
    }
  }

  /**
   * Async initialization - must be called after construction
   * @returns Promise that resolves when initialization is complete
   */
  initialize(): Promise<void> {
    // Prevent multiple simultaneous initializations
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // If already initialized, return immediately
    if (this.initialized) {
      return Promise.resolve();
    }

    // Create initialization promise
    this.initializationPromise = (async () => {
      try {
        await this.performAsyncInitialization();
        this.initialized = true;
        this.logger.log('Optimizer initialization complete');
      } catch (error) {
        this.logger.error('Optimizer initialization failed:', error);
        // Don't set initialized = true, allow retry on next ensureInitialized()
        throw error;
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Perform async initialization tasks
   */
  private async performAsyncInitialization(): Promise<void> {
    try {
      await this.initializeThermalMassFromHistory();
    } catch (error) {
      this.logger.log('Failed to initialize thermal mass from history (this is normal during initial setup):', error);
      // Non-fatal - optimizer can work without historical thermal data using defaults
    }
  }

  /**
   * Check if optimizer is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Ensure optimizer is initialized before critical operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('Optimizer not initialized, initializing now...');
      await this.initialize();
    }
  }

  /**
   * Get initialization status for debugging
   */
  public getInitializationStatus(): {
    initialized: boolean;
    thermalMassInitialized: boolean;
    copHelperInitialized: boolean;
    servicesInitialized: boolean;
  } {
    return {
      initialized: this.initialized,
      thermalMassInitialized: this.thermalController.getThermalMassModel().thermalCapacity > 0,
      copHelperInitialized: this.copHelper !== null,
      servicesInitialized: true // Always true after constructor
    };
  }

  /**
   * Type-safe accessor for hot water service
   * @returns HotWaterService instance if available, undefined otherwise
   */
  private getHotWaterService(): HotWaterService | undefined {
    if (hasHotWaterService(this.homey)) {
      return this.homey.hotWaterService;
    }
    return undefined;
  }

  // Helper methods for cleaner service access throughout the class

  private getZone1Constraints() {
    return this.constraintManager.getZone1Constraints();
  }

  private getZone2Constraints() {
    return this.constraintManager.getZone2Constraints();
  }

  private getTankConstraints() {
    return this.constraintManager.getTankConstraints();
  }

  private getZone1State() {
    return this.stateManager.getZone1LastChange();
  }

  private getZone2State() {
    return this.stateManager.getZone2LastChange();
  }

  private getTankState() {
    return this.stateManager.getTankLastChange();
  }

  /**
   * Type-safe accessor for currency setting
   * @returns Currency code (defaults to 'EUR' if not set)
   */
  private getCurrency(): string {
    if (this.settingsLoader) {
      return this.settingsLoader.getCurrency();
    }
    if (!this.homey) {
      return 'EUR';
    }

    return CurrencyDetector.getCurrencyWithFallback(this.homey as any);
  }

  /**
   * Type-safe accessor for grid fee setting
   * @returns Grid fee per kWh (defaults to 0 if not set or invalid)
   */
  private getGridFee(): number {
    if (this.settingsLoader) {
      return this.settingsLoader.getGridFee();
    }
    if (!this.homey) {
      return 0;
    }

    return gridFeeOnTopOfPrices(this.homey.settings);
  }

  /**
   * Initialize thermal mass model from historical data
   * (Now private, only called via initialize())
   */
  private async initializeThermalMassFromHistory(): Promise<void> {
    try {
      if (!this.homey) return;

      // Validate device ID before attempting to fetch data
      const numericDeviceId = parseInt(this.deviceId, 10);
      if (isNaN(numericDeviceId) || numericDeviceId <= 0) {
        this.logger.log(`Cannot initialize thermal mass from history - invalid device ID: ${this.deviceId}. This is normal during initial setup.`);
        return;
      }

      // Get recent energy data to learn thermal characteristics
      // Use local time to ensure correct date boundaries for the user's timezone
      const localNow = this.timeZoneHelper.getLocalTime().date;
      const toDate = `${localNow.getUTCFullYear()}-${String(localNow.getUTCMonth() + 1).padStart(2, '0')}-${String(localNow.getUTCDate()).padStart(2, '0')}`;
      const sevenDaysAgo = new Date(localNow.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fromDate = `${sevenDaysAgo.getUTCFullYear()}-${String(sevenDaysAgo.getUTCMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgo.getUTCDate()).padStart(2, '0')}`;

      const recentData = await this.melCloud.getEnergyData(this.deviceId, this.buildingId, fromDate, toDate);

      if (recentData && Array.isArray(recentData) && recentData.length > 0) {


        // Calibrate thermal mass based on energy consumption patterns
        const avgHeatingConsumption = recentData.reduce((sum, day) => sum + (day.TotalHeatingConsumed || 0), 0) / recentData.length;

        if (avgHeatingConsumption > 0) {
          // Estimate thermal capacity based on daily consumption
          // Typical relationship: higher consumption = larger thermal mass
          const thermalCapacity = Math.max(1.5, Math.min(4.0, avgHeatingConsumption / 10));

          // Estimate heat loss rate based on outdoor temperature correlation
          // This would need outdoor temperature data for proper calculation
          // For now, use a reasonable default based on consumption
          const heatLossRate = avgHeatingConsumption > 20 ? 1.0 : 0.6;

          // Create thermal mass model
          const thermalMassModel: ThermalMassModel = {
            thermalCapacity: thermalCapacity, // Using estimated thermalCapacity
            heatLossRate: heatLossRate, // Using estimated heatLossRate
            maxPreheatingTemp: 23,
            efficiencyFactor: 0.9,
            preheatingEfficiency: 0.9,
            lastCalibration: new Date(),
            lastUpdated: new Date()
          };

          this.thermalController.setThermalMassModel(thermalMassModel);

          this.logger.log('Thermal mass model initialized from history:', {
            capacity: thermalCapacity.toFixed(2),
            heatLoss: heatLossRate.toFixed(2),
            dataPoints: recentData.length // Using recentData.length as a proxy for valid models
          });
        }
      }

    } catch (error: unknown) {
      this.logger.log('Failed to initialize thermal mass from history:', error);
      this.logger.error('Failed to initialize thermal mass from history:', error);
      // Keep default values on error
    }
  }

  public setPriceProvider(provider: PriceProvider | null): void {
    this.priceAnalyzer.setPriceProvider(provider);
  }

  /**
   * Set thermal model parameters
   * @param K K-factor (thermal responsiveness)
   * @param S S-factor (optional)
   * @throws Error if validation fails
   */
  setThermalModel(K: number, S?: number): void {
    this.thermalController.setThermalModel(K, S);
  }

  /**
   * Set temperature constraints
   * @param minTemp Minimum temperature
   * @param maxTemp Maximum temperature
   * @param tempStep Temperature step
   * @throws Error if validation fails
   */
  setTemperatureConstraints(minTemp: number, maxTemp: number, tempStep: number): void {
    // Validate inputs
    const validMin = validateNumber(minTemp, 'minTemp', { min: 10, max: 30 });
    const validMax = validateNumber(maxTemp, 'maxTemp', { min: 10, max: 30 });

    // Ensure maxTemp is greater than minTemp
    if (validMax <= validMin) {
      throw new Error(`Invalid temperature range: maxTemp(${maxTemp}) must be greater than minTemp(${minTemp})`);
    }

    const validStep = validateNumber(tempStep, 'tempStep', { min: 0.1, max: 1 });

    // Use ConstraintManager to set constraints
    this.constraintManager.setZone1Constraints(validMin, validMax, validStep);

    this.logger.log(`Temperature constraints set - Min: ${validMin}°C, Max: ${validMax}°C, Step: ${validStep}°C`);
  }

  /**
   * Curve/Flow mode: how far the room must be above the setpoint before the unit stops heating.
   * Used for the coasting setpoint and for deciding when a setpoint write cannot change anything.
   */
  setCurveGateOffset(offsetC: number): void {
    this.thermalController.setCurveGateOffset(offsetC);
    this.logger.log(`Curve stop margin set to ${this.thermalController.getCurveGateOffset()}°C`);
  }

  /**
   * Set constraint values that protect against short cycling and rapid oscillation
   * @param minSetpointChangeMinutes Minimum time between setpoint changes
   * @param deadbandC Deadband to avoid unnecessary setpoint adjustments
   */
  setConstraintSettings(minSetpointChangeMinutes: number, deadbandC: number): void {
    const validatedMinChange = validateNumber(minSetpointChangeMinutes, 'minSetpointChangeMinutes', { min: 1, max: 180 });
    const validatedDeadband = validateNumber(deadbandC, 'deadbandC', { min: 0.1, max: 2 });

    this.minSetpointChangeMinutes = validatedMinChange;
    this.constraintManager.setZone1Deadband(validatedDeadband);

    this.logger.log(
      `Constraint settings updated - Min change: ${validatedMinChange}m, Deadband: ${validatedDeadband}°C`
    );
  }

  /**
   * Configure Zone2 temperature constraints and enablement
   */
  setZone2TemperatureConstraints(enableZone2: boolean, minTempZone2: number, maxTempZone2: number, tempStepZone2: number): void {
    const validMin = validateNumber(minTempZone2, 'minTempZone2', { min: 10, max: 30 });
    const validMax = validateNumber(maxTempZone2, 'maxTempZone2', { min: 10, max: 30 });

    if (validMax <= validMin) {
      throw new Error(`Invalid Zone2 temperature range: max(${maxTempZone2}) must be greater than min(${minTempZone2})`);
    }

    const validStep = validateNumber(tempStepZone2 || 0.5, 'tempStepZone2', { min: 0.1, max: 2 });

    // Use ConstraintManager to set constraints
    this.constraintManager.setZone2Constraints(enableZone2, validMin, validMax, validStep);

    this.logger.log(`Zone2 constraints updated - Enabled: ${enableZone2}, Min: ${validMin}°C, Max: ${validMax}°C, Step: ${validStep}°C`);
  }

  /**
   * Set home/away occupancy state
   * @param occupied True for home (occupied), false for away
   */
  setOccupied(occupied: boolean): void {
    const wasOccupied = this.occupied;
    this.occupied = occupied;

    if (this.homey) {
      if (this.settingsAccessor) {
        this.settingsAccessor.set('occupied', occupied);
      } else {
        this.homey.settings.set('occupied', occupied);
      }
    }

    this.logger.log(`Home / Away state changed: ${wasOccupied ? 'Home' : 'Away'} → ${occupied ? 'Home (Occupied)' : 'Away'} `);
  }

  /**
   * Refresh occupancy state from settings (called when settings change)
   */
  refreshOccupancyFromSettings(): void {
    if (!this.homey) return;

    const newOccupied = this.settingsAccessor?.getBoolean('occupied', true);

    if (typeof newOccupied === 'boolean' && newOccupied !== this.occupied) {
      this.occupied = newOccupied;
      this.logger.log(`Home / Away state refreshed from settings: ${this.occupied ? 'Home (Occupied)' : 'Away'} `);
    }
  }

  /**
   * Get current home/away occupancy state
   * @returns True if home (occupied), false if away
   */
  isOccupied(): boolean {
    return this.occupied;
  }

  /**
   * Get the appropriate comfort band (min/max temperatures) based on current occupancy.
   * Delegates to ConstraintManager to avoid duplicated logic.
   * @returns Object with minTemp and maxTemp based on occupied/away settings
   */
  private getCurrentComfortBand(): { minTemp: number; maxTemp: number } {
    let nightMode = false;
    if (this.settingsLoader) {
      const nightSettings = this.settingsLoader.loadNightSetbackSettings();
      nightMode = nightSettings.enabled && isNightHour(
        this.timeZoneHelper.getLocalTime().hour,
        nightSettings.startHour,
        nightSettings.endHour
      );
    }
    return this.constraintManager.getCurrentComfortBand(
      this.occupied,
      this.homey ? this.homey.settings : undefined,
      nightMode
    );
  }

  /**
   * Configure hot water tank control constraints and enablement
   */
  setTankTemperatureConstraints(enableTankControl: boolean, minTankTemp: number, maxTankTemp: number, tankTempStep: number): void {
    const validatedMin = validateNumber(minTankTemp, 'minTankTemp', { min: 30, max: 70 });
    const validatedMax = validateNumber(maxTankTemp, 'maxTankTemp', { min: 30, max: 70 });

    if (validatedMax <= validatedMin) {
      throw new Error(`Invalid tank temperature range: max(${maxTankTemp}) must be greater than min(${minTankTemp})`);
    }

    const validatedStep = validateNumber(tankTempStep || 1, 'tankTempStep', { min: 0.5, max: 5 });

    this.constraintManager.setTankConstraints(enableTankControl, validatedMin, validatedMax, validatedStep);

    this.logger.log(`Tank constraints updated - Enabled: ${enableTankControl}, Min: ${validatedMin}°C, Max: ${validatedMax}°C, Step: ${validatedStep}°C`);
  }

  /**
   * Expose current thermal model configuration
   */
  public getThermalModel(): ThermalModel {
    return this.thermalController.getThermalModel();
  }

  /**
   * Get the enhanced savings calculator instance
   * @deprecated Use getSavingsService() for new code
   */
  public getEnhancedSavingsCalculator(): EnhancedSavingsCalculator {
    return this.enhancedSavingsCalculator;
  }

  /**
   * Get the savings service instance for direct access to savings calculations
   */
  public getSavingsService(): SavingsService {
    return this.savingsService;
  }

  /**
   * Reset everything the optimizer has learned back to defaults.
   *
   * Intended for recovery after the learning inputs turn out to have been invalid — for example
   * comfort violations misattributed to the optimizer (which ratchet the price weights and
   * strategy parameters to their bounds), or thermal data collected while the device was in
   * Flow/Curve mode (which teaches a negative heating rate). Neither condition self-corrects:
   * the parameters are clamped at their bounds and the thermal model reports full confidence.
   *
   * @param options.clearThermalData Discard collected thermal samples as well, so the next
   *   analysis cannot simply relearn the same characteristics from the same bad data.
   */
  public resetLearnedState(options: { clearThermalData?: boolean } = {}): {
    adaptiveParameters: { before: LearnedControlParameters; after: LearnedControlParameters } | null;
    thermalModel: ThermalCharacteristics | null;
    thermalDataCleared: boolean;
  } {
    const clearThermalData = options.clearThermalData !== false;

    let adaptiveParameters: { before: LearnedControlParameters; after: LearnedControlParameters } | null = null;
    if (this.adaptiveParametersLearner) {
      adaptiveParameters = this.adaptiveParametersLearner.resetLearnedParameters();
      this.logger.log(
        `Adaptive parameters reset: priceWeight summer ${adaptiveParameters.before.priceWeightSummer}→${adaptiveParameters.after.priceWeightSummer}, ` +
        `winter ${adaptiveParameters.before.priceWeightWinter}→${adaptiveParameters.after.priceWeightWinter}, ` +
        `transition ${adaptiveParameters.before.priceWeightTransition}→${adaptiveParameters.after.priceWeightTransition}`
      );
    }

    let thermalModel: ThermalCharacteristics | null = null;
    if (this.thermalModelService) {
      thermalModel = this.thermalModelService.resetModel(clearThermalData);
    }

    return {
      adaptiveParameters,
      thermalModel,
      thermalDataCleared: clearThermalData && this.thermalModelService !== null
    };
  }

  /**
   * COP Normalizer for adaptive heating COP normalization with outlier guards
   * Handles persistence, range learning, and normalization
   */
  private readonly copNormalizer: CopNormalizer;

  /**
   * COP Normalizer dedicated to hot water COP (separate range from heating)
   */
  private readonly copNormalizerHotWater: CopNormalizer;

  /**
   * Energy Metrics Service for real energy data and optimization metrics
   * Handles MELCloud energy data, seasonal mode detection, and COP efficiency
   */
  private readonly energyMetricsService: EnergyMetricsService;

  /**
   * Set price threshold settings
   * @param preheatCheapPercentile Percentile threshold for considering prices "cheap" (0.05-0.5)
   * @throws Error if validation fails
   */
  setPriceThresholds(preheatCheapPercentile: number): void {
    // Validate input
    const validated = validateNumber(preheatCheapPercentile, 'preheatCheapPercentile', { min: 0.05, max: 0.5 });

    this.priceAnalyzer.setThresholds(validated);

    // Save to Homey settings if available
    if (this.homey) {
      try {
        this.homey.settings.set('preheat_cheap_percentile', validated);
      } catch (error) {
        this.logger.error('Failed to save price threshold settings to Homey settings:', error);
      }
    }

    this.logger.log(`Price threshold settings updated - Cheap Percentile: ${validated} (${(validated * 100).toFixed(1)}th percentile)`);
  }





  /**
   * Refresh hot water usage pattern from the dedicated hot water service when available
   * Provides ongoing updates beyond the initial historical seeding.
   */
  private refreshHotWaterUsagePattern(): void {
    // Delegate to HotWaterUsageLearner service
    const service = this.getHotWaterService();
    this.hotWaterUsageLearner.refreshFromService(service);
  }

  /**
   * Set COP settings
   * @param copWeight Weight given to COP in optimization
   * @param autoSeasonalMode Whether to automatically switch between summer and winter modes
   * @param summerMode Whether to use summer mode (only used when autoSeasonalMode is false)
   * @throws Error if validation fails
   */
  setCOPSettings(copWeight: number, autoSeasonalMode: boolean, summerMode: boolean): void {
    // Validate inputs
    this.copWeight = validateNumber(copWeight, 'copWeight', { min: 0, max: 1 });
    this.autoSeasonalMode = validateBoolean(autoSeasonalMode, 'autoSeasonalMode');
    this.summerMode = validateBoolean(summerMode, 'summerMode');

    // Update temperature optimizer with new settings
    this.temperatureOptimizer.updateCOPSettings(this.copWeight, this.autoSeasonalMode, this.summerMode);

    // Save to Homey settings if available
    if (this.homey) {
      try {
        this.homey.settings.set('cop_weight', this.copWeight);
        this.homey.settings.set('auto_seasonal_mode', this.autoSeasonalMode);
        this.homey.settings.set('summer_mode', this.summerMode);
      } catch (error) {
        this.logger.error('Failed to save COP settings to Homey settings:', error);
      }
    }

    this.logger.log(`COP settings updated - Weight: ${this.copWeight}, Auto Seasonal: ${this.autoSeasonalMode}, Summer Mode: ${this.summerMode} `);
  }



  /**
   * Get real energy data from MELCloud API and calculate optimization metrics
   * Delegates to EnergyMetricsService for actual data retrieval and processing
   * @returns Promise resolving to optimization metrics
   */
  private async getRealEnergyMetrics(): Promise<OptimizationMetrics | null> {
    return this.energyMetricsService.getRealEnergyMetrics(this.deviceId, this.buildingId);
  }

  /**
   * Get the last energy data retrieved (from EnergyMetricsService cache)
   * @returns Last energy data or null if none available
   */
  private get lastEnergyData(): RealEnergyData | null {
    return this.energyMetricsService.getLastEnergyData();
  }

  /**
   * Get the last calculated optimization metrics (from EnergyMetricsService cache)
   * @returns Last optimization metrics or null if none calculated
   */
  private get optimizationMetrics(): OptimizationMetrics | null {
    return this.energyMetricsService.getOptimizationMetrics();
  }

  /**
   * Calculate enhanced temperature optimization using real energy data
   * Delegates to TemperatureOptimizer service for calculations
   * @param currentPrice Current electricity price
   * @param avgPrice Average electricity price
   * @param minPrice Minimum electricity price
   * @param maxPrice Maximum electricity price
   * @param currentTemp Current room temperature
   * @param outdoorTemp Outdoor temperature
   * @param precomputedMetrics Optional precomputed optimization metrics
   * @param priceLevel Optional pre-calculated price level for accurate logging
   * @returns Optimal target temperature with reasoning
   */
  private async calculateOptimalTemperatureWithRealData(
    currentPrice: number,
    avgPrice: number,
    minPrice: number,
    maxPrice: number,
    currentTemp: number,
    outdoorTemp: number,
    precomputedMetrics?: OptimizationMetrics | null,
    priceLevel?: string
  ): Promise<{ targetTemp: number; reason: string; metrics?: OptimizationMetrics }> {
    // Get real energy metrics
    const metrics = precomputedMetrics ?? await this.getRealEnergyMetrics();

    // Get comfort band for constraints
    const comfortBand = this.getCurrentComfortBand();

    // Build price stats including priceLevel for accurate log descriptions
    const priceStats: PriceStats = {
      currentPrice,
      avgPrice,
      minPrice,
      maxPrice,
      priceLevel
    };

    // Delegate to TemperatureOptimizer service
    return this.temperatureOptimizer.calculateOptimalTemperatureWithRealData(
      priceStats,
      currentTemp,
      outdoorTemp,
      comfortBand,
      metrics,
      // Provide basic calculator for fallback
      async () => this.calculateOptimalTemperature(currentPrice, avgPrice, minPrice, maxPrice, currentTemp)
    );
  }

  /**
   * Enhanced optimization using real energy data - complements the existing optimization
   * @returns Promise resolving to enhanced optimization result
   */
  async runOptimization(): Promise<EnhancedOptimizationResult> {
    await this.ensureInitialized();

    const correlationId = randomUUID();
    const logger = this.createDecisionLogger(correlationId);
    logger('optimizer.run.start', {
      note: 'Starting enhanced optimization with real energy data analysis'
    });

    try {
      const inputs = await this.collectOptimizationInputs(logger);
      const zone1Result = await this.optimizeZone1(inputs, logger);
      const zone2Result = await this.optimizeZone2(inputs, zone1Result, logger);
      const tankResult = await this.optimizeTank(inputs, zone1Result, logger);
      const applied = await this.applySetpointChanges(zone1Result, zone2Result, tankResult, logger);
      const savings = await this.calculateCombinedSavings(zone1Result, zone2Result, tankResult, inputs, applied);
      this.updateThermalResponseAfterOptimization(inputs, zone1Result, applied, logger);
      return this.buildOptimizationResult(inputs, zone1Result, zone2Result, tankResult, savings, applied);
    } catch (error) {
      this.logger.error('Optimization run failed', error);
      return this.handleOptimizationError(error, logger);
    }
  }

  private createDecisionLogger(correlationId: string): DecisionLogger {
    return (event: string, payload: Record<string, unknown>) => {
      if (typeof this.logger.optimization === 'function') {
        this.logger.optimization(event, { correlationId, ...payload });
      } else if (typeof this.logger.log === 'function') {
        this.logger.log(`${event}: ${JSON.stringify({ correlationId, ...payload })} `);
      }
    };
  }

  private async collectOptimizationInputs(logger: DecisionLogger): Promise<OptimizationInputs> {
    const deviceState = await this.melCloud.getDeviceState(this.deviceId, this.buildingId);
    const currentTemp = deviceState.RoomTemperature || deviceState.RoomTemperatureZone1;
    // Prefer the ATW zone-1 register: it is the field the write path actually sets
    // (see MelCloudApi.setDeviceTemperature). SetTemperature is the ATA-shaped field and
    // reading it first made the read asymmetric with the write.
    const currentTarget = deviceState.SetTemperatureZone1 ?? deviceState.SetTemperature;

    // 0 = Room, 1 = Flow, 2 = Curve. Devices that do not report the field (ATA, older
    // firmware) are treated as Room so existing behaviour is preserved.
    const operationModeZone1 = typeof deviceState.OperationModeZone1 === 'number'
      ? deviceState.OperationModeZone1
      : undefined;
    const roomTargetIsRoomTemp = isRoomTargetMode(operationModeZone1);
    const outdoorTemp = deviceState.OutdoorTemperature || 0;

    const hotWaterService = this.getHotWaterService();
    if (hotWaterService && typeof hotWaterService.collectData === 'function') {
      try {
        await hotWaterService.collectData(deviceState);
        this.refreshHotWaterUsagePattern();
      } catch (error) {
        this.logger.warn('Hot water data collection failed during optimization input gathering', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (currentTemp === undefined && deviceState.RoomTemperature === undefined && deviceState.RoomTemperatureZone1 === undefined) {
      throw new Error('No temperature data available from device');
    }

    if (!this.priceAnalyzer.hasPriceProvider()) {
      throw new Error('Price provider not initialized');
    }

    let priceData: TibberPriceInfo;
    try {
      priceData = await this.priceAnalyzer.getPriceData();
    } catch (error) {
      logger('inputs.prices.error', {
        message: error instanceof Error ? error.message : String(error)
      });
      const holdTemp = currentTarget ?? currentTemp ?? 20;
      throw new OptimizationAbort({
        success: true,
        action: 'no_change',
        fromTemp: holdTemp,
        toTemp: holdTemp,
        reason: 'Price fetch failed; holding last setpoint',
        priceDataUnavailable: true,
        priceData: {
          current: 0,
          average: 0,
          min: 0,
          max: 0
        }
      });
    }

    logger('inputs.prices', {
      priceCount: Array.isArray(priceData.prices) ? priceData.prices.length : 0,
      quarterHourlyCount: Array.isArray(priceData.quarterHourly) ? priceData.quarterHourly.length : 0,
      intervalMinutes: priceData.intervalMinutes ?? 60,
      currency: priceData.currencyCode,
      currentPrice: priceData.current?.price
    });

    if (!priceData?.prices?.length || priceData.current?.price == null) {
      const holdTemp = currentTarget ?? currentTemp ?? 20;
      throw new OptimizationAbort({
        success: true,
        action: 'no_change',
        fromTemp: holdTemp,
        toTemp: holdTemp,
        reason: 'Missing price data; holding last setpoint',
        priceDataUnavailable: true,
        priceData: {
          current: 0,
          average: 0,
          min: 0,
          max: 0
        }
      });
    }

    const currentPrice = priceData.current.price;
    const avgPrice = priceData.prices.reduce((sum, p) => sum + p.price, 0) / priceData.prices.length;
    const minPrice = Math.min(...priceData.prices.map((p: any) => p.price));
    const maxPrice = Math.max(...priceData.prices.map((p: any) => p.price));
    
    // Use all available prices for percentile calculation (today + tomorrow when available)
    // This naturally extends to 48h after 13:00 when tomorrow's prices are fetched
    const referenceTs = priceData.current?.time ? Date.parse(priceData.current.time) : NaN;
    const windowStart = Number.isFinite(referenceTs) ? referenceTs : Date.now();
    
    // Filter to only include current and future prices (not stale past prices)
    const futureAndCurrentPrices = priceData.prices.filter((p: any) => {
      const ts = Date.parse(p.time);
      if (!Number.isFinite(ts)) {
        return true;
      }
      // Include prices from start of current hour onwards (allow some buffer for timing)
      const currentHourStart = windowStart - (60 * 60 * 1000); // 1 hour buffer
      return ts >= currentHourStart;
    });
    
    // Use all future prices (today + tomorrow) for better optimization decisions
    const percentileBase = futureAndCurrentPrices.length > 0 ? futureAndCurrentPrices : priceData.prices;
    const priceWindowHours = Math.round(percentileBase.length);
    
    const priceClassification = this.priceAnalyzer.analyzePrice(currentPrice, {
      prices: percentileBase,
      priceLevel: priceData.priceLevel
    });
    const pricePercentile = priceClassification.percentile;
    const priceLevel: string = priceClassification.label;

    // Enhanced logging for price analysis transparency
    this.logger.log(`Price analysis: ${currentPrice.toFixed(3)} kr/kWh`);
    this.logger.log(`  - Window: ${priceWindowHours}h (${percentileBase.length} prices from today${priceWindowHours > 24 ? '+tomorrow' : ''})`);
    this.logger.log(`  - Range: ${priceClassification.min.toFixed(3)} - ${priceClassification.max.toFixed(3)} kr/kWh`);
    this.logger.log(`  - Local percentile: ${pricePercentile.toFixed(0)}% → ${priceClassification.originalLabel || priceLevel}`);
    if (priceData.priceLevel) {
      this.logger.log(`  - Provider level: ${priceData.priceLevel}`);
    }
    if (priceClassification.floorApplied) {
      this.logger.log(`  - Floor applied: ${priceClassification.floorReason}`);
      this.logger.log(`  - Final level: ${priceLevel}`);
    }

    let nextHourPrice: number | undefined;
    try {
      const currentTs = priceData.current?.time ? new Date(priceData.current.time) : new Date();
      const next = priceData.prices.find((p: any) => {
        try {
          return new Date(p.time) > currentTs;
        } catch {
          return false;
        }
      });
      if (next && typeof next.price === 'number' && Number.isFinite(next.price)) {
        nextHourPrice = next.price;
      }
    } catch {
      nextHourPrice = undefined;
    }
    const priceForecast = priceData.forecast ?? null;
    const planningReferenceTime = priceData.current?.time ? new Date(priceData.current.time) : new Date();
    const planningReferenceTimeMs = planningReferenceTime.getTime();

    let thermalResponse = 1;
    let previousIndoorTemp: number | null = null;
    let previousIndoorTempTs: number | null = null;
    if (this.homey) {
      try {
        const rawResponse = this.homey.settings.get('thermal_response');
        const numericResponse = typeof rawResponse === 'number' ? rawResponse : Number(rawResponse);
        if (Number.isFinite(numericResponse) && numericResponse >= 0.5 && numericResponse <= 1.5) {
          thermalResponse = numericResponse;
        }
        const rawPrevTemp = this.homey.settings.get('optimizer_last_indoor_temp');
        if (typeof rawPrevTemp === 'number' && Number.isFinite(rawPrevTemp)) {
          previousIndoorTemp = rawPrevTemp;
        }
        const rawPrevTs = this.homey.settings.get('optimizer_last_indoor_temp_ts');
        if (typeof rawPrevTs === 'number' && Number.isFinite(rawPrevTs)) {
          previousIndoorTempTs = rawPrevTs;
        }
      } catch { }
    }

    try {
      const t = priceData.current?.time ? new Date(priceData.current.time).getTime() : NaN;
      const ageMin = Number.isFinite(t) ? (Date.now() - t) / 60000 : Infinity;
      if (!(ageMin >= 0 && ageMin <= 65)) {
        this.logger.warn('Price data appears stale or in the future', { ageMinutes: ageMin });
        throw new OptimizationAbort({
          success: true,
          action: 'no_change',
          fromTemp: currentTarget ?? currentTemp ?? 20,
          toTemp: currentTarget ?? currentTemp ?? 20,
          reason: 'Stale price data; safe hold',
          priceData: { current: currentPrice, average: avgPrice, min: minPrice, max: maxPrice }
        });
      }
    } catch (e) {
      if (e instanceof OptimizationAbort) {
        throw e;
      }
      this.logger.warn('Failed to validate price freshness; proceeding cautiously');
    }

    this.logger.log('Enhanced optimization state:', {
      currentTemp: currentTemp?.toFixed(1),
      currentTarget: currentTarget?.toFixed(1),
      outdoorTemp: outdoorTemp.toFixed(1),
      currentPrice: currentPrice.toFixed(3),
      avgPrice: avgPrice.toFixed(3)
    });

    const constraintsBand = this.getCurrentComfortBand();
    const safeCurrentTarget = Number.isFinite(currentTarget as number)
      ? (currentTarget as number)
      : Number.isFinite(currentTemp as number)
        ? (currentTemp as number)
        : constraintsBand.minTemp;

    return {
      deviceState,
      currentTemp,
      currentTarget,
      outdoorTemp,
      priceData,
      priceStats: {
        currentPrice,
        avgPrice,
        minPrice,
        maxPrice,
        pricePercentile,
        priceLevel,
        nextHourPrice
      },
      priceClassification,
      priceForecast,
      planningReferenceTime,
      planningReferenceTimeMs,
      thermalResponse,
      previousIndoorTemp,
      previousIndoorTempTs,
      constraintsBand,
      safeCurrentTarget,
      operationModeZone1,
      roomTargetIsRoomTemp
    };
  }

  private async optimizeZone1(inputs: OptimizationInputs, logger: DecisionLogger): Promise<Zone1OptimizationResult> {
    const {
      deviceState,
      currentTemp,
      currentTarget,
      outdoorTemp,
      priceData,
      priceStats,
      planningReferenceTime,
      planningReferenceTimeMs,
      thermalResponse,
      constraintsBand,
      safeCurrentTarget,
      operationModeZone1,
      roomTargetIsRoomTemp
    } = inputs;

    // Thermal learning moved to after weather fetch (see line ~1307)

    const cachedMetrics = await this.getRealEnergyMetrics();
    const optimizationResult = await this.calculateOptimalTemperatureWithRealData(
      priceStats.currentPrice,
      priceStats.avgPrice,
      priceStats.minPrice,
      priceStats.maxPrice,
      currentTemp || 20,
      outdoorTemp,
      cachedMetrics ?? undefined,
      priceStats.priceLevel
    );

    const metrics = optimizationResult.metrics ?? undefined;
    let targetTemp = optimizationResult.targetTemp;
    let adjustmentReason = optimizationResult.reason;

    let weatherInfo: WeatherInfo | null = null;
    let weatherAdjustment: WeatherAdjustmentInfo | null = null;
    let weatherTrend: WeatherTrendInfo | null = null;
    if (this.weatherApi?.getForecast && this.weatherApi.calculateWeatherBasedAdjustment) {
      try {
        const forecast = await this.weatherApi.getForecast();
        weatherAdjustment = this.weatherApi.calculateWeatherBasedAdjustment(
          forecast,
          currentTemp ?? null,
          currentTarget ?? null,
          priceStats.currentPrice ?? null,
          priceStats.avgPrice ?? null
        );
        weatherTrend = this.weatherApi.getWeatherTrend
          ? (this.weatherApi.getWeatherTrend(forecast) as WeatherTrendInfo)
          : null;

        if (weatherAdjustment && typeof weatherAdjustment.adjustment === 'number' && Math.abs(weatherAdjustment.adjustment) >= 0.1) {
          targetTemp += weatherAdjustment.adjustment;
          adjustmentReason += ` + Weather: ${weatherAdjustment.reason} (${weatherAdjustment.adjustment > 0 ? '+' : ''}${weatherAdjustment.adjustment.toFixed(1)}°C)`;
        }

        weatherInfo = {
          current: (forecast as { current?: Partial<WeatherData> })?.current,
          adjustment: weatherAdjustment || undefined,
          trend: weatherTrend || undefined,
          tempAdjustment: weatherAdjustment?.adjustment,
          condition: weatherAdjustment?.reason
        };
      } catch (wErr) {
        this.logger.error('Weather-based adjustment failed', wErr as Error);
      }
    }

    // Collect thermal learning data point AFTER weather fetch to use real weather data.
    // Collected in every mode, tagged with it. Outside Room mode the curve, not the setpoint,
    // decides how fast the room heats, so the analyser learns only the cooling rate from those
    // points (from whole heating-off stretches). The August "negative heating rate" came from
    // reading the ATA-shaped SetTemperature field (29 °C), not from the zone mode itself.
    if (this.useThermalLearning && this.thermalModelService) {
      try {
        const dataPoint = {
          timestamp: new Date().toISOString(),
          indoorTemperature: currentTemp ?? 20,
          outdoorTemperature: outdoorTemp,
          targetTemperature: currentTarget ?? 20,
          heatingActive: !deviceState.IdleZone1,
          roomTargetMode: roomTargetIsRoomTemp,
          weatherConditions: weatherInfo?.current ? {
            windSpeed: weatherInfo.current.windSpeed ?? 0,
            humidity: weatherInfo.current.humidity ?? 0,
            cloudCover: weatherInfo.current.cloudCover ?? 0,
            precipitation: weatherInfo.current.precipitation ?? 0
          } : undefined  // Fallback if no weather API
        };
        this.thermalModelService.collectDataPoint(dataPoint);
        this.logger.log('Thermal data point collected', {
          indoorTemp: dataPoint.indoorTemperature,
          outdoorTemp: dataPoint.outdoorTemperature,
          targetTemp: dataPoint.targetTemperature,
          heatingActive: dataPoint.heatingActive,
          zoneMode: describeZoneMode(operationModeZone1),
          learns: roomTargetIsRoomTemp ? 'heating and cooling' : 'cooling only',
          hasWeather: !!weatherInfo?.current
        });
      } catch (error) {
        this.logger.error('Error collecting thermal data point:', error);
      }
    }

    // Determine planning bias input: prefer quarter-hourly data for intra-hour spike detection
    // computePlanningBias internally aggregates sub-hourly data back to hourly with risk flags,
    // so window/lookahead params stay in hours regardless of input resolution.
    const baseWindowHours = 6;
    const baseLookaheadHours = 12;
    const hasQuarterHourly = Array.isArray(priceData.quarterHourly) && priceData.quarterHourly.length >= 8;
    const planningPrices = hasQuarterHourly
      ? priceData.quarterHourly!.map((p: any) => ({
        ...p,
        intervalMinutes: priceData.intervalMinutes ?? 15
      }))
      : priceData.prices;

    // Use adaptive price thresholds (very cheap multiplier) to avoid hardcoded symmetric expensive percentile
    const cheapPercentile = this.priceAnalyzer.getCheapPercentile() * 100;
    const adaptiveThresholds = this.adaptiveParametersLearner?.getStrategyThresholds();
    const priceThresholds = resolvePriceThresholds({
      cheapPercentile,
      veryCheapMultiplier: adaptiveThresholds?.veryCheapMultiplier
    });
    const VALID_PRICE_LEVELS = new Set<string>(['VERY_CHEAP', 'CHEAP', 'NORMAL', 'EXPENSIVE', 'VERY_EXPENSIVE']);
    const absolutePriceLevel = VALID_PRICE_LEVELS.has(priceData.priceLevel ?? '')
      ? priceData.priceLevel as AbsolutePriceLevel
      : undefined;
    const planningBiasResult = computePlanningBias(planningPrices, planningReferenceTime, {
      windowHours: baseWindowHours,
      lookaheadHours: baseLookaheadHours,
      cheapPercentile,
      expensivePercentile: priceThresholds.expensive,
      cheapBiasC: 0.5,
      expensiveBiasC: 0.3,
      maxAbsBiasC: 0.7,
      logger,
      absolutePriceLevel,
    });
    const scaledPlanningBiasRaw = planningBiasResult.biasC * thermalResponse;
    const scaledPlanningBias = Math.abs(scaledPlanningBiasRaw) < 1e-6
      ? 0
      : Math.max(-0.7, Math.min(0.7, scaledPlanningBiasRaw));
    if (scaledPlanningBias !== 0) {
      targetTemp += scaledPlanningBias;
      adjustmentReason += ` + Planning ${scaledPlanningBias > 0 ? '+' : ''}${scaledPlanningBias.toFixed(2)}°C`;
    }
    logger('optimizer.planning.bias', {
      rawBiasC: planningBiasResult.biasC,
      thermalResponse,
      scaledBiasC: scaledPlanningBias,
      windowHours: planningBiasResult.windowHours,
      hasCheap: planningBiasResult.hasCheap,
      hasExpensive: planningBiasResult.hasExpensive
    });
    logger('optimizer.planning.bias.source', {
      dataSource: hasQuarterHourly ? 'quarter-hourly' : 'hourly',
      inputPoints: planningPrices.length,
      riskyHourCount: planningBiasResult.riskyHourCount ?? 0
    });

    // Where the optimizer wants the zone, before the per-run ramp limit (for the thermostat hold).
    let desiredTarget = Math.min(constraintsBand.maxTemp, Math.max(constraintsBand.minTemp, targetTemp));
    const zone1ConstraintsInitial = applySetpointConstraints({
      proposedC: targetTemp,
      currentTargetC: safeCurrentTarget,
      minC: constraintsBand.minTemp,
      maxC: constraintsBand.maxTemp,
      stepC: this.getZone1Constraints().tempStep,
      deadbandC: this.getZone1Constraints().deadband,
      minChangeMinutes: this.minSetpointChangeMinutes,
      lastChangeMs: this.getZone1State().timestamp,
      maxDeltaPerChangeC: this.getZone1Constraints().tempStep // Enforce max step size
    });
    adjustmentReason += zone1ConstraintsInitial.reason !== 'within constraints'
      ? ` | ${zone1ConstraintsInitial.reason} `
      : '';
    logger('constraints.zone1.initial', {
      proposed: targetTemp,
      currentTarget: safeCurrentTarget,
      result: zone1ConstraintsInitial
    });
    targetTemp = zone1ConstraintsInitial.constrainedC;

    let tempDifference = Math.abs(zone1ConstraintsInitial.deltaC);
    let lockoutActive = zone1ConstraintsInitial.lockoutActive;
    let isSignificantChange = zone1ConstraintsInitial.changed && !lockoutActive;

    const priceRange = Math.max(priceStats.maxPrice - priceStats.minPrice, 0.0001);
    const priceNormalizedValue = Math.min(Math.max((priceStats.currentPrice - priceStats.minPrice) / priceRange, 0), 1);
    const storedZone1Setpoint = this.getZone1State().setpoint;
    const zone1DeviceConfirms = storedZone1Setpoint !== null &&
      Math.abs(safeCurrentTarget - storedZone1Setpoint) < 1e-4;
    let duplicateTarget = storedZone1Setpoint !== null &&
      Math.abs(storedZone1Setpoint - targetTemp) < 1e-4 &&
      zone1DeviceConfirms;

    const logData: any = {
      targetTemp: targetTemp.toFixed(1),
      tempDifference: tempDifference.toFixed(2),
      isSignificantChange,
      lockoutActive,
      duplicateTarget,
      adjustmentReason,
      priceNormalized: priceNormalizedValue.toFixed(2),
      pricePercentile: `${priceStats.pricePercentile.toFixed(0)}% `
    };

    if (optimizationResult.metrics) {
      logData.realMetrics = {
        heatingCOP: optimizationResult.metrics.realHeatingCOP.toFixed(2),
        hotWaterCOP: optimizationResult.metrics.realHotWaterCOP.toFixed(2),
        seasonalMode: optimizationResult.metrics.seasonalMode,
        optimizationFocus: optimizationResult.metrics.optimizationFocus,
        dailyConsumption: optimizationResult.metrics.dailyEnergyConsumption.toFixed(1) + ' kWh/day'
      };
    }

    let hotWaterAction = null;
    let thermalStrategy = null;

    // Apply thermal mass strategy for all optimization modes (heating, hotwater, both)
    // This uses learned parameters from AdaptiveParametersLearner for preheat/coast/boost decisions
    if (optimizationResult.metrics?.optimizationFocus) {
      const thermalMassModel = this.thermalController.getThermalMassModel();
      
      this.logger.log('Thermal strategy check:', {
        hasOptimizationFocus: !!optimizationResult.metrics?.optimizationFocus,
        optimizationFocus: optimizationResult.metrics?.optimizationFocus,
        hasThermalMassModel: !!thermalMassModel,
        priceCount: priceData.prices?.length || 0,
        meetsMinPrices: (priceData.prices?.length || 0) >= 24,
        currentTemp: currentTemp,
        targetTemp: targetTemp,
        cheapPercentile: this.priceAnalyzer.getCheapPercentile()
      });
      
      if (thermalMassModel && priceData.prices && priceData.prices.length >= 24) {
        const targetBeforeStrategy = targetTemp;
        thermalStrategy = this.thermalController.calculateThermalMassStrategy(
          currentTemp || 20,
          targetTemp,
          priceStats.currentPrice,
          priceData.prices,
          {
            heating: optimizationResult.metrics.realHeatingCOP,
            hotWater: optimizationResult.metrics.realHotWaterCOP,
            outdoor: outdoorTemp
          },
          this.priceAnalyzer,
          this.priceAnalyzer.getCheapPercentile(),
          constraintsBand,  // Pass the comfort band to respect user settings
          planningReferenceTimeMs,
          {
            currentTargetC: safeCurrentTarget,
            minC: constraintsBand.minTemp,
            maxC: constraintsBand.maxTemp,
            stepC: this.getZone1Constraints().tempStep,
            deadbandC: this.getZone1Constraints().deadband,
            minChangeMinutes: this.minSetpointChangeMinutes,
            lastChangeMs: this.getZone1State().timestamp ?? undefined,
            maxDeltaPerChangeC: this.getZone1Constraints().tempStep
          },
          priceData.priceLevel,                                    // NEW: Tibber native level
          this.priceAnalyzer.getHistoricalAvgPrice(),             // NEW: ENTSO-E fallback
          roomTargetIsRoomTemp
        );

        this.logger.log('Thermal strategy result:', {
          action: thermalStrategy.action,
          targetTemp: thermalStrategy.targetTemp,
          reasoning: thermalStrategy.reasoning,
          confidence: thermalStrategy.confidenceLevel
        });

        if (thermalStrategy.action !== 'maintain') {
          targetTemp = thermalStrategy.targetTemp;
          desiredTarget = thermalStrategy.targetTemp;
          adjustmentReason += ` + Thermal mass ${thermalStrategy.action}: ${thermalStrategy.reasoning} `;

          this.logger.log('Thermal mass strategy applied:', {
            action: thermalStrategy.action,
            fromTemp: targetBeforeStrategy,
            toTemp: thermalStrategy.targetTemp,
            reasoning: thermalStrategy.reasoning,
            estimatedSavings: thermalStrategy.estimatedSavings,
            confidence: thermalStrategy.confidenceLevel
          });
        }

        // Use HotWaterUsageLearner for pattern-based hot water optimization
        if (this.hotWaterUsageLearner.hasConfidentPattern()) {
          const currentHour = this.timeZoneHelper.getLocalTime().hour;
          const measuredDailyHotWaterKwh = this.lastEnergyData?.TotalHotWaterProduced ?? 0;
          const learnedDailyHotWaterKwhBeforeReconcile = this.hotWaterUsageLearner.getEstimatedDailyConsumption();
          const learnerReconciledToMeasured = measuredDailyHotWaterKwh > 0
            ? this.hotWaterUsageLearner.reconcileDailyConsumption(measuredDailyHotWaterKwh)
            : false;
          const learnedDailyHotWaterKwh = this.hotWaterUsageLearner.getEstimatedDailyConsumption();
          const estimatedDailyHotWaterKwh = measuredDailyHotWaterKwh > 0
            ? measuredDailyHotWaterKwh
            : learnedDailyHotWaterKwh;
          const hotWaterPattern = this.hotWaterUsageLearner.getPattern();
          const nonZeroDemandHours = hotWaterPattern.hourlyDemand
            .map((demand, hour) => ({ hour, demand }))
            .filter(({ demand }) => demand > 0)
            .sort((a, b) => b.demand - a.demand)
            .slice(0, 6);

          this.logger.log('Hot water learner state', {
            currentHour,
            dataPoints: this.hotWaterUsageLearner.getDataPointCount(),
            peakHours: hotWaterPattern.peakHours,
            estimatedDailyHotWaterKwh,
            estimatedDailyHotWaterKwhSource: measuredDailyHotWaterKwh > 0 ? 'melcloud_daily_total' : 'learner_history',
            measuredDailyHotWaterKwh,
            learnedDailyHotWaterKwh,
            learnedDailyHotWaterKwhBeforeReconcile,
            learnerReconciledToMeasured,
            lastLearningUpdate: hotWaterPattern.lastLearningUpdate,
            topDemandHours: nonZeroDemandHours
          });

          const hotWaterSchedule = this.hotWaterOptimizer.optimizeHotWaterSchedulingByPattern(
            currentHour,
            priceData.prices,
            optimizationResult.metrics.realHotWaterCOP,
            hotWaterPattern,
            planningReferenceTimeMs,
            {
              currencyCode: priceData.currencyCode || this.getCurrency(),
              gridFeePerKwh: this.getGridFee(),
              estimatedDailyHotWaterKwh,
              quarterHourly: Array.isArray(priceData.quarterHourly) ? priceData.quarterHourly : undefined
            }
          );

          hotWaterAction = {
            action: hotWaterSchedule.currentAction,
            reason: hotWaterSchedule.reasoning,
            scheduledTime: hotWaterSchedule.scheduledTime
          };

          this.logger.log('Pattern-based hot water optimization:', {
            action: hotWaterSchedule.currentAction,
            reason: hotWaterSchedule.reasoning,
            schedulePoints: hotWaterSchedule.schedulePoints.length,
            estimatedSavings: hotWaterSchedule.estimatedSavings
          });
        } else {
          const hotWaterOpt = await this.hotWaterOptimizer.optimizeHotWaterScheduling(
            priceStats.currentPrice,
            priceData,
            optimizationResult.metrics ?? cachedMetrics ?? null,
            this.lastEnergyData
          );
          hotWaterAction = hotWaterOpt;
        }
      } else {
        const hotWaterOpt = await this.hotWaterOptimizer.optimizeHotWaterScheduling(
          priceStats.currentPrice,
          priceData,
          optimizationResult.metrics ?? cachedMetrics ?? null,
          this.lastEnergyData
        );
        hotWaterAction = hotWaterOpt;
      }

      this.logger.log('Hot water optimization:', {
        action: hotWaterAction.action,
        reason: hotWaterAction.reason,
        scheduledTime: hotWaterAction.scheduledTime
      });
    }

    let expectedDelta = 0;
    const finalConstraintsBand = this.getCurrentComfortBand();
    const zone1FinalConstraints = applySetpointConstraints({
      proposedC: targetTemp,
      currentTargetC: safeCurrentTarget,
      minC: finalConstraintsBand.minTemp,
      maxC: finalConstraintsBand.maxTemp,
      stepC: this.getZone1Constraints().tempStep,
      deadbandC: this.getZone1Constraints().deadband,
      minChangeMinutes: this.minSetpointChangeMinutes,
      lastChangeMs: this.getZone1State().timestamp,
      maxDeltaPerChangeC: this.getZone1Constraints().tempStep // Enforce max step size
    });
    logger('constraints.zone1.final', {
      proposed: targetTemp,
      currentTarget: safeCurrentTarget,
      result: zone1FinalConstraints,
      thermalStrategyApplied: Boolean(thermalStrategy && thermalStrategy.action !== 'maintain')
    });
    if (
      zone1FinalConstraints.reason !== 'within constraints' &&
      !adjustmentReason.includes(zone1FinalConstraints.reason)
    ) {
      adjustmentReason += ` | ${zone1FinalConstraints.reason} `;
    }
    targetTemp = zone1FinalConstraints.constrainedC;
    const rawExpectedDelta = zone1FinalConstraints.changed ? zone1FinalConstraints.deltaC : 0;
    const clampLimit = 2;
    expectedDelta = Math.max(-clampLimit, Math.min(clampLimit, rawExpectedDelta));
    tempDifference = Math.abs(zone1FinalConstraints.deltaC);
    lockoutActive = zone1FinalConstraints.lockoutActive;
    isSignificantChange = zone1FinalConstraints.changed && !lockoutActive;

    logData.targetTemp = targetTemp.toFixed(1);
    logData.tempDifference = tempDifference.toFixed(2);
    logData.isSignificantChange = isSignificantChange;
    logData.lockoutActive = lockoutActive;
    duplicateTarget = storedZone1Setpoint !== null &&
      Math.abs(storedZone1Setpoint - targetTemp) < 1e-4 &&
      zone1DeviceConfirms;
    logData.duplicateTarget = duplicateTarget;
    logData.planningBias = scaledPlanningBias.toFixed(2);
    logData.thermalResponse = thermalResponse.toFixed(2);

    logger('optimizer.run.summary', logData);
    this.logger.log(
      `[ThermalModel] Adaptive interpretation: priceNormalized = ${priceNormalizedValue.toFixed(2)}, percentile = ${priceStats.pricePercentile.toFixed(1)}% → '${priceStats.priceLevel}'(thermal inertia thresholds).`,
      { thresholds: inputs.priceClassification.thresholds }
    );
    this.logger.log('Enhanced optimization result:', logData);

    // Heat-demand gate (Fix 4): when the room sits above the controllable comfort band (e.g. solar
    // gain in summer), every clamped setpoint is <= maxTemp < room, so it cannot call for heat —
    // applying a new zone1 setpoint is physically a no-op and only causes pointless MELCloud churn.
    // This is inert during heating season: the room is within/below the band whenever the pump can
    // actually heat, so the gate never blocks a real adjustment.
    const roomAboveBand =
      Number.isFinite(currentTemp as number) && (currentTemp as number) > constraintsBand.maxTemp;
    if (roomAboveBand) {
      const idleNote = deviceState?.IdleZone1 === true ? ', zone1 idle' : '';
      adjustmentReason += ` | Room ${(currentTemp as number).toFixed(1)}°C above comfort band ${constraintsBand.maxTemp}°C${idleNote} — setpoint has no effect, holding`;
    }

    // In Curve mode the setpoint only gates the curve on/off. With the room clearly below (or above)
    // both the current and the new target, the write changes nothing the unit does. The target the
    // optimizer wants must be on the same side too: otherwise a ramp of several steps toward a
    // target across the room would be held at every step and never get there. The margin covers
    // the deadband and how far the curve has been seen to warm the room in an hour.
    const inertMarginC = Math.max(this.getZone1Constraints().deadband, this.learnedCurveWarmingPerHour(outdoorTemp) ?? 0);
    const inertTo = (toC: number) => isThermostatChangeInert({
      operationMode: operationModeZone1,
      roomC: currentTemp as number,
      fromC: safeCurrentTarget,
      toC,
      marginC: inertMarginC,
      gateOffC: this.thermalController.getCurveGateOffset()
    });
    const thermostatHold = !roomAboveBand && zone1FinalConstraints.changed && inertTo(targetTemp) && inertTo(desiredTarget);
    if (thermostatHold) {
      const heating = (currentTemp as number) < targetTemp;
      adjustmentReason += ` | Room ${(currentTemp as number).toFixed(1)}°C ${heating ? 'below' : 'above'} both ` +
        `${safeCurrentTarget}°C and ${targetTemp}°C (${describeZoneMode(operationModeZone1)} mode) — ` +
        `thermostat stays ${heating ? 'on' : 'off'} either way, holding`;
    }

    return {
      targetTemp,
      reason: adjustmentReason,
      metrics,
      thermalStrategy,
      hotWaterAction,
      constraints: zone1FinalConstraints,
      expectedDelta,
      tempDifference,
      duplicateTarget,
      lockoutActive,
      changed: zone1FinalConstraints.changed,
      needsApply: zone1FinalConstraints.changed && !zone1FinalConstraints.lockoutActive && !duplicateTarget &&
        !roomAboveBand && !thermostatHold,
      heatDemandHold: roomAboveBand,
      thermostatHold,
      priceNormalized: priceNormalizedValue,
      weatherInfo,
      planningBias: scaledPlanningBias,
      safeCurrentTarget,
      indoorTemp: currentTemp,
      outdoorTemp
    };
  }

  /** Learned room warming (°C/h) while the curve runs at this outdoor temperature; null without data. */
  private learnedCurveWarmingPerHour(outdoorC: number): number | null {
    try {
      const curveWarming = this.thermalModelService?.getThermalCharacteristics()?.curveWarming;
      const rate = predictCurveWarming(curveWarming, outdoorC);
      return rate !== null && rate > 0 ? rate : null;
    } catch {
      return null;
    }
  }

  /**
   * Apply Zone 2 fallback with proper constraint checking and error handling
   * Prevents API spam by applying deadband, lockout, and duplicate detection
   */
  private async applyZone2Fallback(
    currentTarget: number,
    currentTemp: number,
    zone1Target: number,
    reason: string,
    logger: DecisionLogger
  ): Promise<SecondaryZoneResult | null> {
    const constraints = this.getZone2Constraints();

    // Calculate proposed target based on Zone 1
    const clampedTarget = Math.max(
      constraints.minTemp,
      Math.min(constraints.maxTemp, zone1Target)
    );

    // Apply full setpoint constraints (deadband, lockout, step rounding, etc.)
    const constraintResult = applySetpointConstraints({
      proposedC: clampedTarget,
      currentTargetC: currentTarget,
      minC: constraints.minTemp,
      maxC: constraints.maxTemp,
      stepC: constraints.tempStep,
      deadbandC: this.getZone1Constraints().deadband,
      minChangeMinutes: this.minSetpointChangeMinutes,
      lastChangeMs: this.getZone2State().timestamp || 0,
      maxDeltaPerChangeC: constraints.tempStep // Enforce max step size for Zone 2
    });

    const fallbackTarget = constraintResult.constrainedC;
    const shouldApply = constraintResult.changed && !constraintResult.lockoutActive;

    // Check for duplicate target (verify device state matches stored setpoint)
    const storedZone2Setpoint = this.getZone2State().setpoint;
    const isDuplicate = storedZone2Setpoint !== null &&
      Math.abs(storedZone2Setpoint - fallbackTarget) < 1e-4;

    logger('zone2.fallback', {
      proposed: clampedTarget,
      constrained: fallbackTarget,
      changed: constraintResult.changed,
      lockout: constraintResult.lockoutActive,
      duplicate: isDuplicate,
      reason: constraintResult.reason
    });

    if (shouldApply && !isDuplicate) {
      try {
        await this.melCloud.setZoneTemperature(
          this.deviceId,
          this.buildingId,
          fallbackTarget,
          2
        );

        this.stateManager.recordZone2Change(fallbackTarget);
        if (this.homey) {
          this.stateManager.saveToSettings(this.homey);
        }

        this.logger.log(
          `Zone2 fallback: ${currentTarget.toFixed(1)}°C → ${fallbackTarget.toFixed(1)}°C (${reason})`
        );

        return {
          fromTemp: currentTarget,
          toTemp: fallbackTarget,
          targetTemp: fallbackTarget,
          targetOriginal: currentTarget,
          indoorTemp: currentTemp,
          reason,
          success: true,
          changed: true,
          action: 'changed'
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error('Zone2 fallback temperature change failed', error);
        logger('zone2.fallback.error', { error: errorMsg });

        // Return error result but don't abort optimization
        return {
          fromTemp: currentTarget,
          toTemp: currentTarget,
          targetTemp: fallbackTarget,
          targetOriginal: currentTarget,
          indoorTemp: currentTemp,
          reason: `${reason} | Error: ${errorMsg}`,
          success: false,
          changed: false,
          action: 'hold'
        };
      }
    } else {
      const holdReason = isDuplicate
        ? 'duplicate target'
        : constraintResult.lockoutActive
          ? `lockout ${this.minSetpointChangeMinutes}m`
          : constraintResult.reason;

      this.logger.log(
        `Zone2 fallback hold (${holdReason}) – keeping ${currentTarget.toFixed(1)}°C`
      );

      return {
        fromTemp: currentTarget,
        toTemp: currentTarget,
        targetTemp: fallbackTarget,
        targetOriginal: currentTarget,
        indoorTemp: currentTemp,
        reason: `${reason} | ${holdReason}`,
        success: true,
        changed: false,
        action: 'hold'
      };
    }
  }

  public async optimizeZone2(

    inputs: OptimizationInputs,
    zone1Result: Zone1OptimizationResult,
    logger: DecisionLogger
  ): Promise<SecondaryZoneResult | null> {
    // Zone 2 is on by default; units without a Zone 2 simply skip it.
    const deviceSupportsZone2 = inputs.deviceState.SetTemperatureZone2 !== undefined;
    if (!this.getZone2Constraints().enabled || !deviceSupportsZone2) {
      return null;
    }

    const currentZone2Target = inputs.deviceState.SetTemperatureZone2;
    const currentZone2Temp = inputs.deviceState.RoomTemperatureZone2 || inputs.currentTemp;
    if (currentZone2Target === undefined) {
      return null;
    }

    // Handle missing price data gracefully with a guarded fallback
    if (!inputs.priceData.prices || inputs.priceData.prices.length === 0) {
      return await this.applyZone2Fallback(
        currentZone2Target,
        currentZone2Temp,
        zone1Result.targetTemp,
        'Zone2 fallback applied (no price data)',
        logger
      );
    }

    try {
      const zone2Opt = await this.zoneOptimizer.optimizeZone2(
        this.deviceId,
        this.buildingId,
        currentZone2Temp,
        currentZone2Target,
        zone1Result.targetTemp,
        zone1Result.weatherInfo ? {
          adjustment: zone1Result.weatherInfo.tempAdjustment ?? 0,
          reason: zone1Result.weatherInfo.condition || 'weather condition'
        } : null,
        inputs.priceStats.priceLevel,
        zone1Result.thermalStrategy || null,
        zone1Result.metrics || null,
        {
          minTemp: this.getZone2Constraints().minTemp,
          maxTemp: this.getZone2Constraints().maxTemp,
          tempStep: this.getZone2Constraints().tempStep,
          deadband: this.getZone1Constraints().deadband,
          minChangeMinutes: this.minSetpointChangeMinutes,
          lastChangeMs: this.getZone2State().timestamp || 0
        }
      );

      if (!zone2Opt) {
        return await this.applyZone2Fallback(
          currentZone2Target,
          currentZone2Temp,
          zone1Result.targetTemp,
          'Zone2 fallback applied (optimizer returned null)',
          logger
        );
      }

      if (zone2Opt.changed && zone2Opt.success) {
        this.stateManager.recordZone2Change(zone2Opt.toTemp);
        if (this.homey) {
          this.stateManager.saveToSettings(this.homey);
        }
      }

      logger('zone2.optimized', {
        changed: zone2Opt.changed,
        fromTemp: zone2Opt.fromTemp,
        toTemp: zone2Opt.toTemp,
        reason: zone2Opt.reason
      });

      return {
        success: zone2Opt.success,
        action: zone2Opt.changed ? 'changed' : 'hold',
        targetTemp: zone2Opt.toTemp,
        fromTemp: zone2Opt.fromTemp,
        toTemp: zone2Opt.toTemp,
        reason: zone2Opt.reason
      };
    } catch (error) {
      logger('zone2.error', { message: error instanceof Error ? error.message : String(error) });
      this.logger.error('Zone 2 optimization failed', error);
      return null;
    }
  }

  /**
   * Record that the tank should be reheated at a chosen future time.
   *
   * Persisted rather than held in memory so the commitment survives a restart — otherwise a
   * lowered tank could be left with nothing scheduled to bring it back up.
   */
  private recordScheduledTankReheat(scheduledTimeIso: string): void {
    const scheduledMs = Date.parse(scheduledTimeIso);
    if (!Number.isFinite(scheduledMs) || !this.homey) {
      return;
    }

    try {
      this.homey.settings.set(SCHEDULED_TANK_REHEAT_SETTING, scheduledMs);
      this.logger.log(`Tank reheat scheduled for ${scheduledTimeIso}`);
    } catch (error) {
      this.logger.error('Failed to persist scheduled tank reheat', error as Error);
    }
  }

  /**
   * Check whether a scheduled reheat has come due, clearing it once consumed or stale.
   *
   * The optimizer runs hourly, so a commitment is honoured within the window that follows its
   * start time. Anything older than that is discarded rather than acted on late — reheating at
   * an arbitrary later hour would defeat the point of having chosen a cheap one.
   */
  private consumeScheduledTankReheat(nowMs: number): {
    due: boolean;
    scheduledForIso?: string;
    minutesLate?: number;
  } {
    if (!this.homey) {
      return { due: false };
    }

    let scheduledMs: unknown;
    try {
      scheduledMs = this.homey.settings.get(SCHEDULED_TANK_REHEAT_SETTING);
    } catch {
      return { due: false };
    }

    if (typeof scheduledMs !== 'number' || !Number.isFinite(scheduledMs)) {
      return { due: false };
    }

    const clear = (): void => {
      try {
        this.homey?.settings.set(SCHEDULED_TANK_REHEAT_SETTING, null);
      } catch {
        // Best effort: a stale commitment expires on age anyway.
      }
    };

    if (nowMs < scheduledMs) {
      return { due: false };
    }

    const minutesLate = (nowMs - scheduledMs) / 60000;
    clear();

    if (minutesLate > SCHEDULED_TANK_REHEAT_GRACE_MINUTES) {
      this.logger.log(
        `Discarding stale tank reheat commitment (${minutesLate.toFixed(0)}m late, ` +
        `grace ${SCHEDULED_TANK_REHEAT_GRACE_MINUTES}m)`
      );
      return { due: false };
    }

    return {
      due: true,
      scheduledForIso: new Date(scheduledMs).toISOString(),
      minutesLate: Number(minutesLate.toFixed(1))
    };
  }

  private async optimizeTank(inputs: OptimizationInputs, zone1Result: Zone1OptimizationResult, logger: DecisionLogger): Promise<TankOptimizationPlan | null> {
    const currentTankTarget = inputs.deviceState.SetTankWaterTemperature;
    if (!this.getTankConstraints().enabled || currentTankTarget === undefined) {
      return null;
    }

    try {
      let tankTarget = currentTankTarget;
      let tankReason = 'Maintaining current tank temperature';
      let hwActionOverride: string | undefined;

      const hwAction: { action?: string; reason?: string; scheduledTime?: string } | null =
        zone1Result.hotWaterAction ?? null;
      const tankCons = this.getTankConstraints();

      // Honour a previously scheduled reheat. Without this, 'delay' only ever lowered the tank
      // and nothing remembered to bring it back up — the reheat happened by accident, whenever a
      // later run independently rediscovered a cheap price. Committing to the chosen hour is what
      // makes "wait for the cheap window" an actual plan rather than a description.
      const nowMs = Date.now();
      const scheduledReheat = this.consumeScheduledTankReheat(nowMs);
      if (scheduledReheat.due) {
        hwActionOverride = 'heat_now';
        this.logger.log('Tank reheat commitment is due', {
          scheduledFor: scheduledReheat.scheduledForIso,
          minutesLate: scheduledReheat.minutesLate
        });
      } else if (hwAction?.action === 'delay' && hwAction.scheduledTime) {
        this.recordScheduledTankReheat(hwAction.scheduledTime);
      }
      const hotWaterService = this.getHotWaterService();
      const fallbackTankTarget = (): number => {
        if (inputs.priceStats.priceLevel === 'VERY_CHEAP' || inputs.priceStats.priceLevel === 'CHEAP') {
          return tankCons.maxTemp;
        }
        if (inputs.priceStats.priceLevel === 'EXPENSIVE' || inputs.priceStats.priceLevel === 'VERY_EXPENSIVE') {
          return tankCons.minTemp;
        }
        return Math.round((tankCons.minTemp + tankCons.maxTemp) / 2);
      };

      // A due reheat commitment outranks the instantaneous price classification: the decision to
      // wait for this hour was already made when the tank was lowered.
      const effectiveAction = hwActionOverride ?? hwAction?.action;

      if (effectiveAction === 'heat_now') {
        // Cheap price window, upcoming usage peak, or a scheduled reheat coming due
        tankTarget = tankCons.maxTemp;
        tankReason = hwActionOverride
          ? `Pre-heating tank: scheduled reheat window reached`
          : `Pre-heating tank: ${hwAction?.reason ?? 'cheap window or upcoming usage'}`;
      } else if (effectiveAction === 'delay') {
        // Expensive price window: reduce to minimum to save energy
        tankTarget = tankCons.minTemp;
        tankReason = hwAction?.scheduledTime
          ? `Conserving tank energy until ${hwAction.scheduledTime}: ${hwAction.reason ?? 'waiting for cheaper window'}`
          : `Conserving tank energy: ${hwAction?.reason ?? 'waiting for cheaper window'}`;
      } else if (effectiveAction === 'maintain') {
        // "Maintain" should preserve a steady strategy, not pin the tank to whatever setpoint happened
        // to be active previously. Prefer the hot-water service's adaptive target, then fall back to
        // price-aware midpoint logic so the controller can move away from stale high targets.
        const predictedTarget = hotWaterService?.getOptimalTankTemperature?.(
          tankCons.minTemp,
          tankCons.maxTemp,
          inputs.priceStats.currentPrice,
          inputs.priceStats.priceLevel
        );
        const maintainSource = Number.isFinite(predictedTarget) ? 'service_prediction' : 'price_fallback';
        const resolvedTarget = Number.isFinite(predictedTarget) ? Number(predictedTarget) : fallbackTankTarget();

        // Hysteresis. Both the service prediction and the price fallback are memoryless — they
        // map the current price level onto a fixed band fraction — so without a dead zone every
        // price-level boundary crossing produces a new target and an hourly setpoint write, for
        // no economic gain. "Maintain" means no strong signal; only move if the adaptive target
        // has drifted meaningfully away from where the tank already is.
        const maintainHysteresisC = MAINTAIN_TANK_HYSTERESIS_C;
        const drift = Math.abs(resolvedTarget - currentTankTarget);
        const moveAwayFromCurrent = drift >= maintainHysteresisC;
        tankTarget = moveAwayFromCurrent ? resolvedTarget : currentTankTarget;

        this.logger.log('Tank maintain target decision', {
          currentTankTarget,
          predictedTarget: Number.isFinite(predictedTarget) ? Number(predictedTarget) : null,
          maintainSource,
          resolvedTarget,
          drift: Number(drift.toFixed(2)),
          hysteresisC: maintainHysteresisC,
          applied: moveAwayFromCurrent,
          tankTarget,
          priceLevel: inputs.priceStats.priceLevel,
          currentPrice: inputs.priceStats.currentPrice
        });
        tankReason = moveAwayFromCurrent
          ? `Maintaining adaptive tank target (${hwAction?.reason ?? 'no immediate price or usage signal'})`
          : `Holding tank setpoint (adaptive target ${resolvedTarget}°C within ${maintainHysteresisC}°C hysteresis)`;
      } else {
        // No hotWaterAction available: fall back to direct price-level heuristic
        tankTarget = fallbackTankTarget();
        tankReason = inputs.priceStats.priceLevel === 'VERY_CHEAP' || inputs.priceStats.priceLevel === 'CHEAP'
          ? `Price level ${inputs.priceStats.priceLevel}: pre-heating tank`
          : inputs.priceStats.priceLevel === 'EXPENSIVE' || inputs.priceStats.priceLevel === 'VERY_EXPENSIVE'
            ? `Price level ${inputs.priceStats.priceLevel}: conserving energy`
            : `Price level ${inputs.priceStats.priceLevel}: maintaining mid-range tank temperature`;
      }

      // Occupancy modifier: cap tank target when no one is home to conserve energy,
      // unless we are in an explicit cheap-window heat_now that makes pre-heating worthwhile.
      if (!this.occupied && effectiveAction !== 'heat_now') {
        const awayMax = tankCons.minTemp + Math.round((tankCons.maxTemp - tankCons.minTemp) * 0.3);
        if (tankTarget > awayMax) {
          tankTarget = awayMax;
          tankReason += ` (away: capped at ${awayMax}°C)`;
        }
      }

      // Low-tank recovery. The FTC does not start a reheat just because the tank has fallen far
      // below its setpoint: measured live, the tank sat 16-19 °C under target for hours with the
      // pump idle, then started within minutes of the setpoint being *raised*. So once the tank is
      // below the user's minimum, whatever the price:
      //  - not yet reheating: raise the setpoint by the largest single change allowed (the tank
      //    ramp cap). A one-step (2 °C) raise did not start the pump on 2026-10-16; a 4 °C raise
      //    on 2026-10-13 started it within 5 minutes.
      //  - already reheating: never lower the setpoint. On 2026-10-16 a 'delay' dropped the
      //    target to the minimum mid-reheat, so the tank stopped at 43.5 °C instead of recovering.
      const tankWaterTemp = Number(inputs.deviceState.TankWaterTemperature);
      const dhwRunning = inputs.deviceState.OperationMode === 1;
      const tankBelowMin = Number.isFinite(tankWaterTemp) && tankWaterTemp < tankCons.minTemp;
      const tankMaxDeltaPerChange = Math.max(tankCons.tempStep, COMFORT_CONSTANTS.DEFAULT_TANK_MAX_DELTA_PER_CHANGE);
      let lowTankKick: number | null = null;
      if (tankBelowMin && dhwRunning) {
        if (tankTarget < currentTankTarget) {
          tankTarget = currentTankTarget;
          tankReason = `Tank at ${tankWaterTemp}°C is below minimum ${tankCons.minTemp}°C and reheating: ` +
            `holding setpoint ${currentTankTarget}°C until it recovers`;
        }
      } else if (tankBelowMin) {
        lowTankKick = Math.min(tankCons.maxTemp, currentTankTarget + tankMaxDeltaPerChange);
        if (tankTarget < lowTankKick) {
          tankTarget = lowTankKick;
          tankReason = `Tank at ${tankWaterTemp}°C is below minimum ${tankCons.minTemp}°C: ` +
            `raising setpoint to ${lowTankKick}°C to start a reheat`;
        }
      }

      this.logger.log('Tank target resolved', {
        hwAction: hwAction?.action ?? 'none',
        effectiveAction: effectiveAction ?? 'none',
        scheduledOverride: hwActionOverride ?? null,
        tankWaterTemp: Number.isFinite(tankWaterTemp) ? tankWaterTemp : null,
        lowTankKick,
        occupied: this.occupied,
        tankTarget,
        tankReason
      });

      this.logger.log(
        `[HotWaterModel] Adaptive interpretation: percentile = ${inputs.priceStats.pricePercentile.toFixed(1)}% → '${inputs.priceStats.priceLevel}'(learned hot water sensitivity thresholds).`,
        { thresholds: inputs.priceClassification.thresholds }
      );

      const tankDeadband = Math.max(0.5, this.getTankConstraints().tempStep);
      const tankConstraints = applySetpointConstraints({
        proposedC: tankTarget,
        currentTargetC: currentTankTarget,
        minC: this.getTankConstraints().minTemp,
        maxC: this.getTankConstraints().maxTemp,
        stepC: this.getTankConstraints().tempStep,
        deadbandC: tankDeadband,
        minChangeMinutes: this.minSetpointChangeMinutes,
        lastChangeMs: this.getTankState().timestamp,
        // Ramp cap, deliberately decoupled from the rounding step. Frequency is governed
        // separately by minChangeMinutes, so a larger cap does not mean more writes — it means
        // fewer, because the target is reached in one or two runs and subsequent runs are then
        // suppressed by the deadband instead of stepping 1 °C at a time for hours.
        maxDeltaPerChangeC: Math.max(
          this.getTankConstraints().tempStep,
          COMFORT_CONSTANTS.DEFAULT_TANK_MAX_DELTA_PER_CHANGE
        )
      });
      logger('constraints.tank.final', {
        proposed: tankTarget,
        currentTarget: currentTankTarget,
        result: tankConstraints
      });

      tankTarget = tankConstraints.constrainedC;
      const tankChange = Math.abs(tankConstraints.deltaC);
      const tankLockout = tankConstraints.lockoutActive;

      if (
        tankConstraints.reason !== 'within constraints' &&
        !tankReason.includes(tankConstraints.reason)
      ) {
        tankReason += ` | ${tankConstraints.reason} `;
      }

      const storedTankSetpoint = this.getTankState().setpoint;
      const deviceConfirmsDuplicate = storedTankSetpoint !== null &&
        Math.abs(currentTankTarget - storedTankSetpoint) < 1e-4;
      const tankDuplicate = storedTankSetpoint !== null &&
        Math.abs(storedTankSetpoint - tankTarget) < 1e-4 &&
        deviceConfirmsDuplicate;
      const changeApplied = tankConstraints.changed && !tankLockout && !tankDuplicate;
      const tankHoldReason = tankDuplicate
        ? 'duplicate target'
        : tankLockout
          ? `lockout ${this.minSetpointChangeMinutes} m`
          : `change ${tankChange.toFixed(2)}°C below deadband ${tankDeadband.toFixed(2)}°C`;

      // Low tank and not reheating: forced hot water in the same run as the raise. Waiting an
      // hour to see whether the raise starts it left the tank cold: live, 2 °C raises started a
      // reheat 0 of 3 times and 4 °C raises 2 of 4, forced hot water 4 of 5 (2026-10-13 to -30;
      // 30 Oct 18:00 a raise with the tank at 40.5 °C did nothing and it fell to 37 °C).
      // Comfort first: no price check. A forced run the app started is switched back to auto
      // once the tank is near its target (or after a time limit), never one the user started.
      const forcedOn = inputs.deviceState.ForcedHotWaterMode === true;
      const forcedAt = Number(this.homey?.settings.get('low_tank_forced_at')) || null;
      // The unit ends a forced run by itself once the tank is hot. A record left behind would make
      // a later forced run the user starts look like the app's, and get it switched back to auto.
      const forcedAgeMs = forcedAt !== null ? nowMs - forcedAt : null;
      const forcedHadItsChance = forcedAgeMs !== null &&
        forcedAgeMs >= COMFORT_CONSTANTS.LOW_TANK_FORCED_WAIT_MINUTES * 60000;
      const forcedRequestLapsed = forcedHadItsChance && !forcedOn;
      // Live 2026-10-23: forced hot water was requested three hours running with the tank at 27 °C
      // and nothing happened. Record the unit state each time, to find out what blocks it, whether
      // MELCloud dropped the request or shows it on without running. A record older than a forced
      // run can last is a leftover, not a request that failed.
      let forcedNotStarted: ForcedHotWaterNotStarted | undefined;
      if (forcedHadItsChance && (forcedAgeMs as number) < COMFORT_CONSTANTS.LOW_TANK_FORCED_MAX_HOURS * 3600000 &&
        tankBelowMin && !dhwRunning) {
        const ds = inputs.deviceState;
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        forcedNotStarted = {
          requestedAtMs: forcedAt as number,
          tankC: tankWaterTemp,
          minC: tankCons.minTemp,
          forcedFlag: forcedOn,
          unitMode: num(ds.OperationMode),
          roomC: num(ds.RoomTemperatureZone1 ?? ds.RoomTemperature),
          zoneTargetC: num(ds.SetTemperatureZone1),
          zoneIdle: typeof ds.IdleZone1 === 'boolean' ? ds.IdleZone1 : null,
          retrying: false
        };
        tankReason += ` | forced hot water requested ${Math.round((forcedAgeMs as number) / 60000)} min ago ` +
          `did not start a reheat (forced ${forcedOn ? 'on' : 'off'}, unit mode ${forcedNotStarted.unitMode}, ` +
          `room ${forcedNotStarted.roomC}°C / target ${forcedNotStarted.zoneTargetC}°C, zone idle ${forcedNotStarted.zoneIdle})`;
      }
      let hotWaterMode: 'forced' | 'auto' | undefined;
      if (tankBelowMin && !dhwRunning && !forcedOn) {
        hotWaterMode = 'forced';
        tankReason += ` | tank ${tankWaterTemp}°C below minimum ${tankCons.minTemp}°C and not reheating: ` +
          'starting forced hot water';
      } else if (forcedOn && forcedAt !== null && (
        (Number.isFinite(tankWaterTemp) && tankWaterTemp >= currentTankTarget - 1) ||
        nowMs - forcedAt >= COMFORT_CONSTANTS.LOW_TANK_FORCED_MAX_HOURS * 3600000
      )) {
        hotWaterMode = 'auto';
        tankReason += ' | forced hot water done, back to auto';
      }
      if (forcedNotStarted) {
        forcedNotStarted.retrying = hotWaterMode === 'forced';
        logger('tank.forced_not_started', { ...forcedNotStarted });
      }

      logger('tank.optimized', {
        changed: tankConstraints.changed,
        hotWaterMode: hotWaterMode ?? null,
        fromTemp: currentTankTarget,
        toTemp: tankTarget,
        lockout: tankLockout,
        duplicate: tankDuplicate,
        holdReason: changeApplied ? undefined : tankHoldReason
      });

      return {
        fromTemp: currentTankTarget,
        toTemp: tankTarget,
        reason: tankReason,
        success: true,
        changed: tankConstraints.changed,
        needsApply: changeApplied,
        lockoutActive: tankLockout,
        duplicateTarget: tankDuplicate,
        evaluatedAtMs: tankConstraints.evaluatedAtMs,
        holdReason: changeApplied ? undefined : tankHoldReason,
        hotWaterMode,
        tankBelowMin,
        clearForcedRecord: forcedRequestLapsed,
        forcedNotStarted
      };
    } catch (error) {
      logger('tank.error', { message: error instanceof Error ? error.message : String(error) });
      this.logger.error('Tank optimization failed', error as Error);
      return null;
    }
  }

  private async applySetpointChanges(
    zone1Result: Zone1OptimizationResult,
    _zone2Result: SecondaryZoneResult | null,
    tankResult: TankOptimizationPlan | null,
    logger: DecisionLogger
  ): Promise<AppliedChanges> {
    const changes: AppliedChanges = {
      zone1Applied: false,
      zone2Applied: false,
      tankApplied: false
    };

    let lockoutActive = zone1Result.lockoutActive;
    try {
      const last = (this.homey && Number(this.homey.settings.get('last_setpoint_change_ms'))) || this.getZone1State().timestamp || 0;
      const sinceMin = last > 0 ? (Date.now() - last) / 60000 : Infinity;
      lockoutActive = lockoutActive || sinceMin < this.minSetpointChangeMinutes;
      if (lockoutActive && sinceMin < this.minSetpointChangeMinutes) {
        this.logger.log(`Setpoint change lockout active(${sinceMin.toFixed(1)}m since last < ${this.minSetpointChangeMinutes}m)`);
      }
    } catch { }
    changes.lockoutActive = lockoutActive;
    changes.duplicateTarget = zone1Result.duplicateTarget;

    if (zone1Result.needsApply && !lockoutActive) {
      const apiStart = Date.now();
      try {
        await this.melCloud.setDeviceTemperature(this.deviceId, this.buildingId, zone1Result.targetTemp);
        changes.zone1Applied = true;

        this.stateManager.recordZone1Change(zone1Result.targetTemp);

        if (this.homey) {
          this.stateManager.saveToSettings(this.homey);
        }

        const latencyMs = Date.now() - apiStart;
        logger('zone1.applied', {
          targetTemp: zone1Result.targetTemp,
          latencyMs
        });
        logger('optimizer.setpoint.applied', {
          targetTemp: zone1Result.targetTemp,
          from: zone1Result.safeCurrentTarget,
          delta: zone1Result.targetTemp - zone1Result.safeCurrentTarget,
          latencyMs
        });
      } catch (error) {
        changes.zone1Error = error instanceof Error ? error.message : String(error);
        logger('zone1.apply_error', { error: changes.zone1Error });
        logger('optimizer.setpoint.error', {
          error: changes.zone1Error,
          latencyMs: Date.now() - apiStart
        });
        this.logger.error('Failed to apply Zone 1 temperature', error);
      }
    } else {
      logger('zone1.skipped', {
        changed: zone1Result.changed,
        lockout: lockoutActive,
        duplicate: zone1Result.duplicateTarget
      });
    }

    if (!changes.zone1Applied) {
      changes.zone1HoldReason = changes.zone1Error
        ? `Temperature change requested but MELCloud rejected: ${changes.zone1Error} `
        : lockoutActive
          ? `Setpoint change lockout(${this.minSetpointChangeMinutes}m) to prevent cycling`
          : zone1Result.duplicateTarget
            ? 'Duplicate target – already applied recently'
            : zone1Result.heatDemandHold
              ? 'Room above comfort band — setpoint has no effect (no heat demand)'
              : zone1Result.thermostatHold
                ? `Zone thermostat stays ${Number(zone1Result.indoorTemp) < zone1Result.targetTemp ? 'on' : 'off'} ` +
                  `either way (room ${zone1Result.indoorTemp}°C, ${zone1Result.safeCurrentTarget} → ${zone1Result.targetTemp}°C) — holding`
                : `Temperature difference ${zone1Result.tempDifference.toFixed(1)}°C below deadband ${this.getZone1Constraints().deadband}°C`;
    }

    if (!changes.zone1Applied && changes.zone1HoldReason) {
      this.logger.log(`No enhanced temperature adjustment applied: ${changes.zone1HoldReason} `);
      logger('optimizer.setpoint.hold', { reason: changes.zone1HoldReason });
    }

    if (tankResult?.needsApply) {
      try {
        await this.melCloud.setTankTemperature(this.deviceId, this.buildingId, tankResult.toTemp);
        changes.tankApplied = true;

        this.stateManager.recordTankChange(tankResult.toTemp, tankResult.evaluatedAtMs ?? Date.now());

        // Persist tank lockout timestamp immediately. In summer zone1 never applies, so without
        // this a tank-only change is never written to settings and the anti-cycling lockout is
        // lost on restart (allowing a 2nd tank change within the hour). Mirrors the zone1 path above.
        if (this.homey) {
          this.stateManager.saveToSettings(this.homey);
        }

        logger('tank.applied', {
          fromTemp: tankResult.fromTemp,
          toTemp: tankResult.toTemp
        });
      } catch (error) {
        changes.tankError = error instanceof Error ? error.message : String(error);
        logger('tank.apply_error', { error: changes.tankError });
        this.logger.error('Failed to apply tank temperature', error);
      }
    }
    if (tankResult && !tankResult.needsApply && tankResult.holdReason && !changes.tankApplied) {
      changes.tankError = tankResult.holdReason;
    }

    // Low-tank bookkeeping: forced hot water on/off and the one-per-episode notice. Runs after
    // the setpoint write above, so forced hot water goes out with the raised target in place.
    if (tankResult && this.homey) {
      try {
        if (!tankResult.tankBelowMin) {
          this.homey.settings.unset('low_tank_notice_at');
        }
        if (tankResult.clearForcedRecord) {
          this.homey.settings.unset('low_tank_forced_at');
        }
        // One notice per low-tank episode; every run still logs tank.forced_not_started.
        if (tankResult.forcedNotStarted && !this.homey.settings.get('low_tank_notice_at')) {
          await this.notifyForcedHotWaterNotStarted(tankResult.forcedNotStarted);
          this.homey.settings.set('low_tank_notice_at', Date.now());
        }
        if (tankResult.hotWaterMode) {
          const forced = tankResult.hotWaterMode === 'forced';
          const accepted = await this.melCloud.setHotWaterMode(this.deviceId, this.buildingId, forced);
          if (!accepted) throw new Error(`MELCloud did not confirm hot water mode ${tankResult.hotWaterMode}`);
          if (forced) {
            this.homey.settings.set('low_tank_forced_at', Date.now());
          } else {
            this.homey.settings.unset('low_tank_forced_at');
          }
          logger('tank.hot_water_mode', { mode: tankResult.hotWaterMode });
          this.logger.log(`Hot water mode set to ${tankResult.hotWaterMode}: ${tankResult.reason}`);
        }
      } catch (error) {
        this.logger.error('Failed to set hot water mode', error);
      }
    }

    return changes;
  }

  /** Timeline notice for a forced hot water request that did not start a reheat. Never throws. */
  private async notifyForcedHotWaterNotStarted(info: ForcedHotWaterNotStarted): Promise<void> {
    const minutesAgo = Math.round((Date.now() - info.requestedAtMs) / 60000);
    const zone = info.zoneIdle === null ? 'zone state unknown' : info.zoneIdle ? 'zone idle' : 'zone calling for heat';
    const excerpt = `Hot water: tank ${info.tankC}°C is below the ${info.minC}°C minimum. Forced hot water ` +
      `requested ${minutesAgo} min ago did not start a reheat (unit mode ${info.unitMode}, forced ` +
      `${info.forcedFlag ? 'on' : 'off'}, room ${info.roomC}°C / target ${info.zoneTargetC}°C, ${zone}).` +
      (info.retrying ? ' Trying again.' : '');
    try {
      await this.homey?.notifications?.createNotification({ excerpt });
    } catch (error) {
      this.logger.warn('Could not post the forced hot water notice', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async calculateCombinedSavings(
    zone1Result: Zone1OptimizationResult,
    zone2Result: SecondaryZoneResult | null,
    tankResult: TankOptimizationPlan | null,
    inputs: OptimizationInputs,
    applied: AppliedChanges
  ): Promise<CombinedSavings> {
    const savings: CombinedSavings = {
      zone1: 0,
      zone2: 0,
      tank: 0,
      total: 0
    };
    // Always drain the sample buffer, but only attribute comfort violations to the optimizer
    // when it actually moved the setpoint. Otherwise summer solar gain — which pushes the room
    // above the band while the optimizer is in heat-demand hold and wrote nothing — is scored
    // as an optimizer failure, ratcheting the adaptive price weight down 2% every cycle until
    // it pins at its 0.2 floor and the optimizer effectively stops responding to price.
    const measuredComfortViolations = this.countComfortViolations(inputs.currentTemp, inputs.constraintsBand);
    const optimizerAffectedRoom = applied.zone1Applied === true && zone1Result.heatDemandHold !== true;
    const comfortViolations = optimizerAffectedRoom ? measuredComfortViolations : 0;

    if (!optimizerAffectedRoom && measuredComfortViolations > 0) {
      this.logger.log(
        `Comfort deviation observed (${measuredComfortViolations}) but not attributed to the optimizer ` +
        `(zone1Applied=${applied.zone1Applied === true}, heatDemandHold=${zone1Result.heatDemandHold === true})`
      );
    }

    if (applied.zone1Applied) {
      savings.zone1 = await this.savingsService.calculateRealHourlySavings(
        zone1Result.safeCurrentTarget,
        zone1Result.targetTemp,
        inputs.priceStats.currentPrice,
        zone1Result.metrics,
        'zone1'
      );
      try {
        if (zone2Result && typeof zone2Result.fromTemp === 'number' && typeof zone2Result.toTemp === 'number') {
          savings.zone2 = await this.savingsService.calculateRealHourlySavings(
            zone2Result.fromTemp,
            zone2Result.toTemp,
            inputs.priceStats.currentPrice,
            zone1Result.metrics,
            'zone2'
          );
        }
        if (tankResult && typeof tankResult.fromTemp === 'number' && typeof tankResult.toTemp === 'number') {
          savings.tank = await this.savingsService.calculateRealHourlySavings(
            tankResult.fromTemp,
            tankResult.toTemp,
            inputs.priceStats.currentPrice,
            zone1Result.metrics,
            'tank'
          );
        }
      } catch (savingsErr) {
        this.logger.warn('Failed to calculate secondary savings contributions', { error: savingsErr });
      }
      savings.total = savings.zone1 + savings.zone2 + savings.tank;

      const currentCOP = zone1Result.metrics?.realHeatingCOP || zone1Result.metrics?.realHotWaterCOP;
      this.learnFromOptimizationOutcome(savings.total, comfortViolations, currentCOP, zone1Result.metrics?.seasonalMode);
      this.logger.log(`Enhanced temperature adjusted from ${zone1Result.safeCurrentTarget.toFixed(1)}°C to ${zone1Result.targetTemp.toFixed(1)}°C`, {
        reason: zone1Result.reason,
        savingsEstimated: this.savingsService.estimateCostSavings(
          zone1Result.targetTemp,
          zone1Result.safeCurrentTarget,
          inputs.priceStats.currentPrice,
          inputs.priceStats.avgPrice,
          zone1Result.metrics
        ),
        savingsNumeric: savings.total
      });
      return savings;
    }

    try {
      const baselineSetpoint = inputs.constraintsBand.maxTemp;
      // The counterfactual is "a fixed thermostat parked at the top of the band". That is only
      // meaningful while the pump could actually have heated. When the room is already above the
      // band, a fixed thermostat would not have called for heat either — the counterfactual and
      // the actual are identical and the true saving is zero. Booking a difference here produced
      // a positive number every hour of summer, which then fed learnFromOutcome as a reward.
      if (zone1Result.heatDemandHold) {
        this.logger.log('Skipping zone1 baseline savings: room above band, a fixed thermostat would not have heated either');
      } else if (zone1Result.thermostatHold && Number(inputs.currentTemp) < zone1Result.safeCurrentTarget) {
        // Held because the zone heats with either target; a thermostat at the band top heats too.
        this.logger.log('Skipping zone1 baseline savings: the zone thermostat is on either way');
      } else if (baselineSetpoint > zone1Result.safeCurrentTarget + 0.1) {
        savings.zone1 += await this.savingsService.calculateRealHourlySavings(
          baselineSetpoint,
          zone1Result.safeCurrentTarget,
          inputs.priceStats.currentPrice,
          zone1Result.metrics,
          'zone1'
        );
      }
    } catch (baselineErr) {
      this.logger.warn('Failed to estimate baseline savings during hold', { error: baselineErr });
    }

    try {
      if (zone2Result && this.getZone2Constraints().enabled) {
        const zone2BaselineTarget = this.getZone2Constraints().maxTemp;
        if (zone2BaselineTarget > zone2Result.toTemp + 0.1) {
          savings.zone2 += await this.savingsService.calculateRealHourlySavings(
            zone2BaselineTarget,
            zone2Result.toTemp,
            inputs.priceStats.currentPrice,
            zone1Result.metrics,
            'zone2'
          );
        }
      }
      // Tank savings are measured against the setpoint we actually moved from, not against
      // maxTemp. A maxTemp baseline is a standing charge: it pays out every hour the tank sits
      // anywhere below maximum, whether or not the optimizer did anything, so it is positive by
      // construction. That kept `goodSavings` true on every cycle where the tank applied and
      // walked priceWeightSummer to its 0.9 ceiling even after the comfort arm was fixed.
      if (tankResult && this.getTankConstraints().enabled && applied.tankApplied
        && typeof tankResult.fromTemp === 'number' && typeof tankResult.toTemp === 'number') {
        savings.tank += await this.savingsService.calculateRealHourlySavings(
          tankResult.fromTemp,
          tankResult.toTemp,
          inputs.priceStats.currentPrice,
          zone1Result.metrics,
          'tank'
        );
      }
    } catch (savingsErr) {
      this.logger.warn('Failed to calculate secondary savings contributions (no change path)', { error: savingsErr });
    }

    savings.total = savings.zone1 + savings.zone2 + savings.tank;

    // Learning requires an outcome, and an outcome requires an action. On this path nothing was
    // written to zone 1, so the only admissible evidence is another actuator having moved.
    //
    // Without this the reward was positive by construction on every hold: the accrual above is
    // sign-guarded, so `goodSavings = actualSavings > 0` was always true and learnFromOutcome
    // took its ×1.02 branch every hour. Measured on a live device: priceWeightSummer walked
    // 0.7 → 0.8202 in 8 cycles (exactly 1.02^8) and was heading for the 0.9 ceiling. Fixing the
    // comfort-violation arm alone only inverted the ratchet; this closes the other arm.
    const actuatorMoved = applied.tankApplied || applied.zone2Applied;

    if (
      actuatorMoved &&
      Number.isFinite(savings.total) &&
      savings.total >= MIN_SAVINGS_FOR_LEARNING &&
      !applied.lockoutActive
    ) {
      const currentCOP = zone1Result.metrics?.realHeatingCOP ?? zone1Result.metrics?.realHotWaterCOP ?? null;
      this.learnFromOptimizationOutcome(savings.total, comfortViolations, currentCOP ?? undefined, zone1Result.metrics?.seasonalMode);
      this.logger.log(`Learned from hold: savings = ${savings.total.toFixed(3)}, COP = ${currentCOP?.toFixed(2) ?? 'N/A'} `);
    } else if (!actuatorMoved && savings.total >= MIN_SAVINGS_FOR_LEARNING) {
      this.logger.log(`Not learning: nothing was written this cycle (estimated savings ${savings.total.toFixed(3)} is a counterfactual, not an outcome)`);
    }

    return savings;
  }

  private buildOptimizationResult(
    inputs: OptimizationInputs,
    zone1Result: Zone1OptimizationResult,
    zone2Result: SecondaryZoneResult | null,
    tankResult: TankOptimizationPlan | null,
    savings: CombinedSavings,
    applied: AppliedChanges
  ): EnhancedOptimizationResult {
    const action = applied.zone1Applied ? 'temperature_adjusted' : 'no_change';
    const reason = applied.zone1Applied
      ? zone1Result.reason
      : (applied.zone1HoldReason ?? zone1Result.reason);

    return {
      success: true,
      action,
      fromTemp: zone1Result.safeCurrentTarget,
      toTemp: applied.zone1Applied ? zone1Result.targetTemp : zone1Result.safeCurrentTarget,
      reason,
      indoorTemp: inputs.currentTemp ?? null,
      outdoorTemp: inputs.outdoorTemp,
      priceData: {
        current: inputs.priceStats.currentPrice,
        average: inputs.priceStats.avgPrice,
        min: inputs.priceStats.minPrice,
        max: inputs.priceStats.maxPrice,
        level: inputs.priceStats.priceLevel,
        percentile: inputs.priceStats.pricePercentile,
        nextHour: inputs.priceStats.nextHourPrice
      },
      savings: savings.total,
      energyMetrics: zone1Result.metrics ?? undefined,
      comfortBand: { minTemp: inputs.constraintsBand.minTemp, maxTemp: inputs.constraintsBand.maxTemp },
      weather: zone1Result.weatherInfo || undefined,
      hotWaterAction: zone1Result.hotWaterAction || undefined,
      priceForecast: inputs.priceForecast ? {
        position: inputs.priceForecast.currentPosition,
        recommendation: inputs.priceForecast.recommendation,
        upcomingChanges: inputs.priceForecast.upcomingChanges,
        bestTimes: inputs.priceForecast.bestTimes,
        worstTimes: inputs.priceForecast.worstTimes
      } : undefined,
      zone2Data: zone2Result || undefined,
      tankData: tankResult || undefined,
      melCloudStatus: {
        setpointApplied: applied.zone1Applied,
        error: applied.zone1Error
      },
      tankStatus: tankResult ? {
        setpointApplied: applied.tankApplied,
        error: applied.tankError
      } : undefined
    };
  }

  private updateThermalResponseAfterOptimization(
    inputs: OptimizationInputs,
    zone1Result: Zone1OptimizationResult,
    applied: AppliedChanges,
    logger: DecisionLogger
  ): void {
    const nowMs = Date.now();
    const indoorTemp = typeof inputs.currentTemp === 'number' && Number.isFinite(inputs.currentTemp) ? inputs.currentTemp : null;
    if (indoorTemp === null) return;
    if (!applied.zone1Applied) return;

    if (this.homey) {
      try {
        this.homey.settings.set('optimizer_last_indoor_temp', indoorTemp);
        this.homey.settings.set('optimizer_last_indoor_temp_ts', nowMs);
      } catch { }
    }

    if (
      inputs.previousIndoorTemp !== null &&
      inputs.previousIndoorTempTs !== null &&
      nowMs - inputs.previousIndoorTempTs >= 20 * 60 * 1000 &&
      Math.abs(indoorTemp - inputs.previousIndoorTemp) < 5
    ) {
      const observedDelta = indoorTemp - inputs.previousIndoorTemp;
      const updatedThermalResponse = updateThermalResponse(inputs.thermalResponse, observedDelta, zone1Result.expectedDelta, {
        alpha: 0.1,
        min: 0.5,
        max: 1.5
      });
      if (Math.abs(updatedThermalResponse - inputs.thermalResponse) > 1e-6) {
        if (this.homey) {
          try {
            this.homey.settings.set('thermal_response', updatedThermalResponse);
          } catch { }
        }
        logger('optimizer.thermal.update', {
          previous: inputs.thermalResponse,
          observedDelta,
          expectedDelta: zone1Result.expectedDelta,
          updated: updatedThermalResponse
        });
      }
    }
  }

  /**
   * Record an indoor temperature sample for comfort-violation tracking.
   * Call this from the 5-minute device poll so violations that recover before
   * the hourly optimizer run are still counted.
   */
  public recordComfortSample(indoorTemp: number): void {
    this.comfortTracker.record(indoorTemp);
  }

  /**
   * Count comfort violations accumulated since the last optimizer run.
   * Includes the current snapshot and resets the buffer for the next window.
   */
  private countComfortViolations(
    indoorTemp: number | undefined,
    band: { minTemp: number; maxTemp: number }
  ): number {
    return this.comfortTracker.countAndReset(
      band,
      Number.isFinite(indoorTemp as number) ? (indoorTemp as number) : undefined
    );
  }

  private handleOptimizationError(error: unknown, logger: DecisionLogger): EnhancedOptimizationResult {
    if (error instanceof OptimizationAbort) {
      return error.result;
    }

    const err = (error instanceof Error) ? error : new Error(String(error));
    this.logger.error('Enhanced optimization failed', err);
    const fallbackBand = this.getCurrentComfortBand();
    return {
      success: false,
      action: 'no_change',
      fromTemp: fallbackBand.minTemp,
      toTemp: fallbackBand.minTemp,
      reason: `Enhanced optimization failed: ${err.message} `,
      priceDataUnavailable: true,
      priceData: {
        current: 0,
        average: 0,
        min: 0,
        max: 0
      }
    };
  }



  /**
   * Force cleanup/aggregation in the thermal model service
   */
  public forceThermalDataCleanup(): ReturnType<ThermalModelService['forceDataCleanup']> | { success: false; message: string } {
    if (!this.thermalModelService) {
      return { success: false, message: 'Thermal model service not initialized' };
    }
    return this.thermalModelService.forceDataCleanup();
  }

  /**
   * Run weekly calibration
   * Delegates to CalibrationService for actual calibration logic
   * @returns Promise resolving to calibration result
   */
  async runWeeklyCalibration(): Promise<CalibrationResult> {
    return this.calibrationService.runWeeklyCalibration();
  }

  /**
   * Learn from optimization outcome (called after each optimization cycle)
   * Delegates to CalibrationService for learning logic
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
    this.calibrationService.learnFromOptimizationOutcome(actualSavings, comfortViolations, currentCOP, controlSeason);
  }

  /**
   * Calculate optimal temperature based on price
   * Delegates to TemperatureOptimizer service for calculations
   * @param currentPrice Current electricity price
   * @param avgPrice Average electricity price
   * @param minPrice Minimum electricity price
   * @param maxPrice Maximum electricity price
   * @param currentTemp Current room temperature
   * @returns Optimal target temperature
   */
  private async calculateOptimalTemperature(
    currentPrice: number,
    avgPrice: number,
    minPrice: number,
    maxPrice: number,
    currentTemp: number
  ): Promise<number> {
    // Get the appropriate comfort band based on occupancy
    const comfortBand = this.getCurrentComfortBand();

    // Build price stats
    const priceStats: PriceStats = {
      currentPrice,
      avgPrice,
      minPrice,
      maxPrice
    };

    // Delegate to TemperatureOptimizer service
    return this.temperatureOptimizer.calculateOptimalTemperature(priceStats, currentTemp, comfortBand);
  }

  /**
   * Calculate savings from temperature change
   * @param oldTemp Original temperature
   * @param newTemp New temperature
   * @param currentPrice Current electricity price
   * @returns Estimated savings
   */
  public calculateSavings(
    oldTemp: number,
    newTemp: number,
    currentPrice: number,
    kind: 'zone1' | 'zone2' | 'tank' = 'zone1'
  ): number {
    return this.savingsService.calculateSavings(oldTemp, newTemp, currentPrice, kind);
  }



  /**
   * Cleanup method to properly stop thermal model service and other resources
   * Prevents memory leaks when the optimizer is destroyed
   */
  public cleanup(): void {
    try {
      if (this.thermalModelService) {
        this.thermalModelService.stop();
        this.thermalModelService = null;
        this.logger.log('Thermal model service stopped and cleaned up');
      }

      if (this.copHelper) {
        // COP helper doesn't have intervals to clean, but clear the reference
        this.copHelper = null;
        this.logger.log('COP helper reference cleared');
      }

      this.logger.log('Optimizer cleanup completed successfully');
    } catch (error) {
      this.logger.error('Error during optimizer cleanup:', error);
    }
  }
}
