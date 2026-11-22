import WeatherApi from '../../weather';
import { getTimeZoneName } from '../util/time-zone-helper';
import { getPriceSource, getZone2Settings } from '../services/settings-loader';
import { MelCloudApi } from '../services/melcloud-api';
import { TibberApi } from '../services/tibber-api';
import { EntsoePriceService } from '../services/entsoe-price-service';
import { PriceCacheService } from '../services/price-cache-service';
import { Optimizer } from '../services/optimizer';
import { COPHelper } from '../services/cop-helper';
import type { PriceProvider } from '../types';
import { DefaultComfortConfig } from '../config/comfort-defaults';
import { COMFORT_CONSTANTS, PRICE_CONSTANTS } from '../constants';
import { HomeyLogger } from '../util/logger';

export interface HomeyLikeSettings {
  get(key: string): any;
  set(key: string, value: any): void | Promise<void>;
}

export interface HomeyLoggerLike {
  log(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  warn?(message: string, ...args: any[]): void;
}

export interface HomeyLike {
  settings: HomeyLikeSettings;
  app: HomeyLoggerLike;
  hotWaterService?: unknown;
}

export interface HistoricalData {
  optimizations: any[];
  lastCalibration: any;
}

export interface ServiceState {
  melCloud: MelCloudApi | null;
  tibber: PriceProvider | null;
  optimizer: Optimizer | null;
  weather: WeatherApi | null;
  historicalData: HistoricalData;
}

const createEmptyHistoricalData = (): HistoricalData => ({
  optimizations: [],
  lastCalibration: null
});

// Default settings are now provided directly in the HTML form fields

/**
 * Initialize K factor with default value if not set
 * K factor is auto-calibrated by weekly jobs, but needs a starting value
 */
function initializeKFactor(homey: HomeyLike): void {
  const currentKFactor = homey.settings.get('initial_k');
  if (currentKFactor === null || currentKFactor === undefined || currentKFactor === 0) {
    homey.settings.set('initial_k', 0.3);
    homey.app.log?.('Initialized K factor (initial_k) with default value: 0.3 (will be auto-calibrated by weekly jobs)');
  }
}

function selectPriceProvider(
  homey: HomeyLike,
  priceSource: 'tibber' | 'entsoe',
  tibberToken: string | null,
  timeZoneOffset: number,
  useDST: boolean,
  timeZoneName?: string | null,
  appLogger?: any,
  tibberHomeId?: string | null
): PriceProvider | null {
  if (priceSource === 'tibber') {
    if (tibberToken) {
      const tibberLogger = (appLogger && typeof appLogger.api === 'function') ? appLogger : undefined;
      const homeId = typeof tibberHomeId === 'string' && tibberHomeId.length > 0 ? tibberHomeId : undefined;
      const tibberApi = new TibberApi(tibberToken, tibberLogger, homeId);
      tibberApi.updateTimeZoneSettings(
        timeZoneOffset,
        useDST,
        typeof timeZoneName === 'string' && timeZoneName.length > 0 ? timeZoneName : undefined
      );
      homey.app.log?.('Tibber price provider initialized');
      if (homeId) {
        homey.app.log?.(`Using Tibber home ID: ${homeId}`);
      }
      const cacheLogger = {
        log: (msg: string, ...args: unknown[]) => homey.app.log(msg, ...args),
        warn: (msg: string, ...args: unknown[]) => homey.app.warn ? homey.app.warn(msg, ...args) : homey.app.log(msg, ...args),
        error: (msg: string, ...args: unknown[]) => homey.app.error(msg, ...args)
      };
      return new PriceCacheService(tibberApi, homey.settings, cacheLogger, homeId);
    }
    homey.app.warn?.('Tibber selected as price source but token not configured. Falling back to ENTSO-E.');
  }

  try {
    const entsoeService = new EntsoePriceService(homey as any);
    homey.app.log?.('ENTSO-E price provider initialized');
    return entsoeService;
  } catch (error) {
    homey.app.error?.('Failed to initialize ENTSO-E price provider:', error);
    return null;
  }
}

const serviceState: ServiceState = {
  melCloud: null,
  tibber: null,
  optimizer: null,
  weather: null,
  historicalData: createEmptyHistoricalData()
};

export function getServiceState(): ServiceState {
  return serviceState;
}

export function resetServiceState(): void {
  serviceState.melCloud = null;
  serviceState.tibber = null;
  serviceState.optimizer = null;
  serviceState.weather = null;
  serviceState.historicalData = createEmptyHistoricalData();
}

// Default settings removed - now provided directly in HTML form

export function applyServiceOverrides(overrides: Partial<ServiceState>): void {
  if (Object.prototype.hasOwnProperty.call(overrides, 'melCloud')) {
    serviceState.melCloud = overrides.melCloud ?? null;
    (global as any).melCloud = serviceState.melCloud;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'tibber')) {
    serviceState.tibber = overrides.tibber ?? null;
    (global as any).tibber = serviceState.tibber;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'optimizer')) {
    serviceState.optimizer = overrides.optimizer ?? null;
    (global as any).optimizer = serviceState.optimizer;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'weather')) {
    serviceState.weather = overrides.weather ?? null;
  }
  if (overrides.historicalData) {
    serviceState.historicalData = overrides.historicalData;
  }
}

export function setHistoricalData(data: HistoricalData): void {
  serviceState.historicalData = data;
}

export function getServiceStateSnapshot(): ServiceState {
  return {
    melCloud: serviceState.melCloud,
    tibber: serviceState.tibber,
    optimizer: serviceState.optimizer,
    weather: serviceState.weather,
    historicalData: {
      optimizations: Array.isArray(serviceState.historicalData.optimizations)
        ? [...serviceState.historicalData.optimizations]
        : [],
      lastCalibration: serviceState.historicalData.lastCalibration
    }
  };
}

export function saveHistoricalData(homey: HomeyLike): boolean {
  try {
    if (homey && homey.settings) {
      homey.app.log('Saving optimizer historical data to persistent storage');
      homey.settings.set('optimizer_historical_data', serviceState.historicalData);
      homey.app.log(`Saved ${serviceState.historicalData.optimizations.length} optimization data points`);
      return true;
    }
    return false;
  } catch (error) {
    if (homey && homey.app) {
      homey.app.error('Error saving thermal model data:', error);
    } else {
      // eslint-disable-next-line no-console
      console.error('Error saving thermal model data:', error);
    }
    return false;
  }
}

export function loadHistoricalData(homey: HomeyLike): boolean {
  try {
    if (homey && homey.settings) {
      // Migration: Check if data exists in old location (thermal_model_data)
      const oldData = homey.settings.get('thermal_model_data');
      if (oldData && oldData.optimizations && Array.isArray(oldData.optimizations)) {
        homey.app.log('Migrating optimizer data from thermal_model_data to optimizer_historical_data');
        homey.settings.set('optimizer_historical_data', oldData);
        // Don't delete old key yet - thermal collector might have valid data there
        homey.app.log(`Migrated ${oldData.optimizations.length} optimization data points`);
      }

      const savedData = homey.settings.get('optimizer_historical_data');
      if (savedData) {
        homey.app.log('Loading optimizer historical data from persistent storage');
        if (savedData.optimizations && Array.isArray(savedData.optimizations)) {
          serviceState.historicalData = savedData;
          homey.app.log(`Loaded ${serviceState.historicalData.optimizations.length} optimization data points`);
          if (serviceState.historicalData.lastCalibration) {
            const ts = serviceState.historicalData.lastCalibration.timestamp;
            homey.app.log(`Last calibration: ${new Date(ts).toLocaleString()}, K=${serviceState.historicalData.lastCalibration.newK}`);
          }
          return true;
        }
        homey.app.log('Saved optimizer data has invalid format, using defaults');
      } else {
        homey.app.log('No saved optimizer data found, starting with empty dataset');
      }
    }
    return false;
  } catch (error) {
    if (homey && homey.app) {
      homey.app.error('Error loading thermal model data:', error);
    } else {
      // eslint-disable-next-line no-console
      console.error('Error loading thermal model data:', error);
    }
    return false;
  }
}

export async function initializeServices(homey: HomeyLike): Promise<ServiceState> {
  if (serviceState.melCloud && serviceState.tibber && serviceState.optimizer) {
    return serviceState;
  }

  const appLogger = (homey.app as any)?.logger;
  // Ensure we have a valid logger instance with methods, not just a serialized object
  const isValidLogger = appLogger && typeof appLogger.warn === 'function';
  const sharedLogger = isValidLogger ? appLogger : new HomeyLogger(homey.app);

  if (isValidLogger && typeof appLogger.api === 'function') {
    (global as any).logger = appLogger;
  }

  // Default settings are now provided directly in the HTML form
  // Initialize K factor with default value (gets auto-calibrated by weekly jobs)
  initializeKFactor(homey);

  loadHistoricalData(homey);

  const melcloudUser = homey.settings.get('melcloud_user') || homey.settings.get('melcloudUser');
  const melcloudPass = homey.settings.get('melcloud_pass') || homey.settings.get('melcloudPass');
  const tibberToken = homey.settings.get('tibber_token') || homey.settings.get('tibberToken');
  const tibberHomeId = homey.settings.get('tibber_home_id');
  let deviceId = homey.settings.get('device_id') || homey.settings.get('deviceId') || 'Boiler';
  let buildingIdRaw = homey.settings.get('building_id') || homey.settings.get('buildingId') || '456';
  const useWeatherData = homey.settings.get('use_weather_data') !== false;
  const priceSource = getPriceSource(homey.settings);

  // Get timezone settings for all services
  const timeZoneOffset = homey.settings.get('time_zone_offset') || 2;
  const useDST = homey.settings.get('use_dst') || false;
  const timeZoneName = getTimeZoneName(homey);

  if (!melcloudUser || !melcloudPass) {
    throw new Error('MELCloud credentials are required. Please configure them in the settings.');
  }

  const parsedBuildingId = Number.parseInt(String(buildingIdRaw), 10);
  if (!Number.isFinite(parsedBuildingId)) {
    buildingIdRaw = '456';
  }
  let buildingId = Number.isFinite(parsedBuildingId) ? parsedBuildingId : 456;

  homey.app.log(`Using device ID: ${deviceId}`);
  homey.app.log(`Using building ID: ${buildingId}`);

  homey.app.log('Initializing services with settings:');
  homey.app.log('- MELCloud User:', melcloudUser ? '✓ Set' : '✗ Not set');
  homey.app.log('- MELCloud Pass:', melcloudPass ? '✓ Set' : '✗ Not set');
  homey.app.log('- Price source:', priceSource === 'entsoe' ? 'ENTSO-E day-ahead' : 'Tibber API');
  const tibberTokenStatus = tibberToken ? '✓ Set' : '✗ Not set';
  homey.app.log(`- Tibber Token: ${tibberTokenStatus}${priceSource === 'entsoe' ? ' (not used)' : ''}`);
  homey.app.log('- Device ID:', deviceId, '(Will be resolved after login)');
  homey.app.log('- Building ID:', buildingId, '(Will be resolved after login)');
  homey.app.log('- Weather Data:', useWeatherData ? '✓ Enabled' : '✗ Disabled');
  homey.app.log('- Timezone Offset:', timeZoneOffset, 'hours');
  homey.app.log('- Timezone Name:', timeZoneName || 'n/a');
  homey.app.log('- DST Enabled:', useDST ? '✓ Yes' : '✗ No');

  const melCloudLogger = sharedLogger;
  const melCloud = new MelCloudApi(melCloudLogger);
  // Set timezone settings after construction
  melCloud.updateTimeZoneSettings(
    timeZoneOffset,
    useDST,
    typeof timeZoneName === 'string' && timeZoneName.length > 0 ? timeZoneName : undefined
  );
  await melCloud.login(melcloudUser, melcloudPass);
  serviceState.melCloud = melCloud;
  (global as any).melCloud = melCloud;
  homey.app.log('Successfully logged in to MELCloud');

  const devices = await melCloud.getDevices();
  homey.app.log(`Found ${devices.length} devices in MELCloud account`);
  if (devices.length > 0) {
    homey.app.log('===== AVAILABLE DEVICES =====');
    devices.forEach((device: any) => {
      homey.app.log(`Device: ${device.name} (ID: ${device.id}, Building ID: ${device.buildingId})`);
    });
    homey.app.log('=============================');

    // Automatic device ID resolution for initial setup
    let resolvedDeviceId = deviceId;
    let resolvedBuildingId = buildingId;
    let deviceResolved = false;

    // Check if we need to resolve device IDs (placeholder values or invalid numeric IDs)
    const needsResolution = (
      deviceId === 'Boiler' || // Default placeholder
      buildingId === 456 || // Default placeholder
      !devices.some((device: any) => device.id?.toString() === deviceId.toString()) // Device ID doesn't exist
    );

    if (needsResolution) {
      // Try to find device by name match first
      let targetDevice = devices.find((device: any) =>
        String(device.name || '').toLowerCase() === deviceId.toLowerCase()
      );

      // If no name match, try by numeric ID
      if (!targetDevice) {
        targetDevice = devices.find((device: any) =>
          device.id?.toString() === deviceId.toString()
        );
      }

      // If still no match, use the first available device
      if (!targetDevice && devices.length > 0) {
        targetDevice = devices[0];
        homey.app.log(`WARNING: Configured device ID "${deviceId}" not found. Auto-resolving to first available device.`);
      }

      if (targetDevice) {
        resolvedDeviceId = targetDevice.id.toString();
        resolvedBuildingId = targetDevice.buildingId;
        deviceResolved = true;

        // Update settings with resolved IDs
        homey.settings.set('device_id', resolvedDeviceId);
        homey.settings.set('building_id', resolvedBuildingId);

        homey.app.log(`🔄 AUTO-RESOLVED DEVICE IDs:`);
        homey.app.log(`- Original: Device ID "${deviceId}", Building ID "${buildingId}"`);
        homey.app.log(`- Resolved: Device ID "${resolvedDeviceId}", Building ID "${resolvedBuildingId}"`);
        homey.app.log(`- Device Name: "${targetDevice.name}"`);
        homey.app.log(`✅ Settings updated with resolved device IDs`);
      }
    } else {
      // Verify that the configured device exists
      const exists = devices.some((device: any) => (
        device.id?.toString() === deviceId.toString() ||
        String(device.name || '').toLowerCase() === deviceId.toLowerCase()
      ));
      if (!exists && devices[0]) {
        const fallback = devices[0];
        homey.app.log(`WARNING: Configured device ID "${deviceId}" not found. Consider using ${fallback.name} (ID: ${fallback.id}).`);
      }
    }

    // Update the variables for subsequent service initialization
    if (deviceResolved) {
      deviceId = resolvedDeviceId;
      buildingId = resolvedBuildingId;
    }
  } else {
    homey.app.log('WARNING: No devices found in your MELCloud account.');
  }

  const priceProvider = selectPriceProvider(
    homey,
    priceSource,
    tibberToken || null,
    timeZoneOffset,
    useDST,
    typeof timeZoneName === 'string' && timeZoneName.length > 0 ? timeZoneName : undefined,
    sharedLogger,
    tibberHomeId || null
  );

  serviceState.tibber = priceProvider;
  (global as any).tibber = priceProvider;

  if (useWeatherData) {
    try {
      const weatherInstance = new WeatherApi(
        'MELCloudOptimizer/1.0 github.com/decline27/melcloud-optimizer',
        homey.app
      );
      serviceState.weather = weatherInstance;
      homey.app.log('Weather API initialized');
    } catch (error) {
      homey.app.error('Failed to initialize Weather API:', error);
      serviceState.weather = null;
    }
  } else {
    homey.app.log('Weather data disabled in settings');
    serviceState.weather = null;
  }

  const optimizerLogger = sharedLogger;
  const optimizer = new Optimizer(
    melCloud,
    priceProvider,
    deviceId,
    buildingId,
    optimizerLogger, // logger
    serviceState.weather as any, // weatherApi
    homey as any // homey instance for thermal learning
  );

  // Initialize optimizer in the background to avoid blocking startup on MELCloud history fetch
  optimizer.initialize()
    .then(() => homey.app.log('Optimizer initialization complete'))
    .catch(error => homey.app.error('Optimizer initialization failed (non-blocking):', error));

  serviceState.optimizer = optimizer;
  (global as any).optimizer = optimizer;

  // Initialize Hot Water Service and attach to homey
  if (!homey.hotWaterService) {
    try {
      const { HotWaterService } = await import('../services/hot-water/hot-water-service');
      const hotWaterService = new HotWaterService(homey as any);
      homey.hotWaterService = hotWaterService;
      homey.app.log('Hot Water Service initialized');
    } catch (error) {
      homey.app.error('Failed to initialize Hot Water Service:', error);
    }
  }

  await updateOptimizerSettings(homey);

  if (!(global as any).copHelper) {
    try {
      const copHelper = new COPHelper(homey as any, homey.app);
      (global as any).copHelper = copHelper;
      homey.app.log('COP Helper initialized globally');
    } catch (error) {
      homey.app.error('Failed to initialize COP Helper globally:', error);
    }
  }

  homey.app.log('Services initialized successfully');
  return serviceState;
}

export function refreshPriceProvider(homey: HomeyLike): PriceProvider | null {
  const appLogger = (homey.app as any)?.logger;
  const isValidLogger = appLogger && typeof appLogger.warn === 'function';
  const sharedLogger = isValidLogger ? appLogger : new HomeyLogger(homey.app);

  const priceSource = getPriceSource(homey.settings);
  const tibberToken = homey.settings.get('tibber_token') || homey.settings.get('tibberToken') || null;
  const tibberHomeId = homey.settings.get('tibber_home_id') || null;
  const timeZoneOffset = homey.settings.get('time_zone_offset') || 2;
  const useDST = homey.settings.get('use_dst') || false;
  const timeZoneName = getTimeZoneName(homey);

  const priceProvider = selectPriceProvider(
    homey,
    priceSource,
    tibberToken,
    timeZoneOffset,
    useDST,
    typeof timeZoneName === 'string' && timeZoneName.length > 0 ? timeZoneName : undefined,
    sharedLogger,
    tibberHomeId
  );

  serviceState.tibber = priceProvider;
  (global as any).tibber = priceProvider;

  if (serviceState.optimizer && typeof serviceState.optimizer.setPriceProvider === 'function') {
    (serviceState.optimizer as any).setPriceProvider(priceProvider);
  }

  return priceProvider;
}

export async function updateOptimizerSettings(homey: HomeyLike): Promise<void> {
  const optimizer = serviceState.optimizer;
  if (!optimizer) {
    return;
  }

  const toNumber = (value: unknown): number | null => {
    // Unset, null and empty all mean 'automatic': Number(null) would otherwise read as 0.
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const clampNumber = (value: number | null, min: number, max: number, fallback: number): number => {
    if (value === null || value === undefined) {
      return fallback;
    }
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, value));
  };

  // Use user settings with fallback to defaults (don't mix them for min/max calculation)
  const userComfortLowerOccupied = toNumber(homey.settings.get('comfort_lower_occupied'));
  const userComfortLowerAway = toNumber(homey.settings.get('comfort_lower_away'));
  const userComfortUpperOccupied = toNumber(homey.settings.get('comfort_upper_occupied'));
  const userComfortUpperAway = toNumber(homey.settings.get('comfort_upper_away'));

  // Use user settings if available, otherwise use defaults
  const comfortLowerOccupied = userComfortLowerOccupied ?? DefaultComfortConfig.comfortOccupied.lowerC;
  const comfortLowerAway = userComfortLowerAway ?? DefaultComfortConfig.comfortAway.lowerC;
  const comfortUpperOccupied = userComfortUpperOccupied ?? DefaultComfortConfig.comfortOccupied.upperC;
  const comfortUpperAway = userComfortUpperAway ?? DefaultComfortConfig.comfortAway.upperC;

  // Check current occupancy state to select appropriate comfort band
  const currentlyOccupied = homey.settings.get('occupied') !== false; // Default to true if not set

  const derivedMin = currentlyOccupied ? comfortLowerOccupied : comfortLowerAway;
  let derivedMax = currentlyOccupied ? comfortUpperOccupied : comfortUpperAway;

  if (derivedMax <= derivedMin) {
    derivedMax = derivedMin + 1;
  }

  const minTemp = Math.max(16, Math.min(derivedMin, 26));
  let maxTemp = Math.max(minTemp + 0.5, Math.min(derivedMax, 26));

  // Debug comfort band resolution
  homey.app.log('Comfort band resolution:');
  homey.app.log('- User Occupied:', userComfortLowerOccupied ?? 'unset', '→', userComfortUpperOccupied ?? 'unset');
  homey.app.log('- User Away:', userComfortLowerAway ?? 'unset', '→', userComfortUpperAway ?? 'unset');
  homey.app.log('- Final Occupied:', comfortLowerOccupied, '→', comfortUpperOccupied);
  homey.app.log('- Final Away:', comfortLowerAway, '→', comfortUpperAway);
  homey.app.log('- Currently Occupied:', currentlyOccupied ? 'YES (Home)' : 'NO (Away)');
  homey.app.log('- Selected Range:', derivedMin, '→', derivedMax, currentlyOccupied ? '(Occupied)' : '(Away)');

  if (maxTemp - minTemp < 0.5) {
    maxTemp = minTemp + 0.5;
  }

  const tempStep = toNumber(homey.settings.get('temp_step_max')) ?? COMFORT_CONSTANTS.DEFAULT_TEMP_STEP;
  const kFactor = toNumber(homey.settings.get('initial_k')) ?? 0.5;

  const deadbandC = clampNumber(
    toNumber(homey.settings.get('deadband_c')),
    0.1,
    2,
    COMFORT_CONSTANTS.DEFAULT_DEADBAND
  );
  const curveGateOffsetC = clampNumber(
    toNumber(homey.settings.get('curve_gate_off_offset_c')),
    0.5,
    2,
    COMFORT_CONSTANTS.DEFAULT_CURVE_GATE_OFF_OFFSET_C
  );
  const minSetpointChangeMinutes = clampNumber(
    toNumber(homey.settings.get('min_setpoint_change_minutes')),
    1,
    180,
    COMFORT_CONSTANTS.DEFAULT_MIN_SETPOINT_CHANGE_MINUTES
  );

  const zone2Settings = getZone2Settings(homey.settings);
  const enableZone2 = zone2Settings.enabled;
  const minTempZone2 = zone2Settings.min;
  const maxTempZone2 = zone2Settings.max;
  const tempStepZone2 = toNumber(homey.settings.get('temp_step_zone2')) ?? COMFORT_CONSTANTS.DEFAULT_TEMP_STEP_ZONE2;

  const enableTankControl = homey.settings.get('enable_tank_control') === true;
  const minTankTemp = toNumber(homey.settings.get('min_tank_temp')) ?? COMFORT_CONSTANTS.DEFAULT_MIN_TANK_TEMP;
  const maxTankTemp = toNumber(homey.settings.get('max_tank_temp')) ?? COMFORT_CONSTANTS.DEFAULT_MAX_TANK_TEMP;
  const tankTempStep = toNumber(homey.settings.get('tank_temp_step')) ?? COMFORT_CONSTANTS.DEFAULT_TANK_TEMP_STEP;

  homey.app.log('Optimizer settings:');
  homey.app.log('- Derived Min Target:', minTemp, '°C');
  homey.app.log('- Derived Max Target:', maxTemp, '°C');
  homey.app.log('- Temp Step:', tempStep, '°C (MELCloud supports 0.5°C increments)');
  homey.app.log('- Deadband:', deadbandC, '°C');
  homey.app.log('- Min Setpoint Interval:', `${minSetpointChangeMinutes} minutes`);
  homey.app.log('- K Factor:', kFactor);

  homey.app.log('Zone2 settings:');
  homey.app.log('- Zone2 Control:', enableZone2 ? 'Enabled' : 'Disabled');
  if (enableZone2) {
    homey.app.log('- Min Temp Zone2:', minTempZone2, '°C');
    homey.app.log('- Max Temp Zone2:', maxTempZone2, '°C');
    homey.app.log('- Temp Step Zone2:', tempStepZone2, '°C');
  }

  homey.app.log('Hot Water Tank settings:');
  homey.app.log('- Tank Control:', enableTankControl ? 'Enabled' : 'Disabled');
  if (enableTankControl) {
    homey.app.log('- Min Tank Temp:', minTankTemp, '°C');
    homey.app.log('- Max Tank Temp:', maxTankTemp, '°C');
    homey.app.log('- Tank Temp Step:', tankTempStep, '°C');
  }

  const copWeight = homey.settings.get('cop_weight') || 0.3;
  const autoSeasonalMode = homey.settings.get('auto_seasonal_mode') !== false;
  const summerMode = homey.settings.get('summer_mode') === true;

  homey.app.log('COP settings:');
  homey.app.log('- COP Weight:', copWeight);
  homey.app.log('- Auto Seasonal Mode:', autoSeasonalMode ? 'Enabled' : 'Disabled');
  homey.app.log('- Summer Mode:', summerMode ? 'Enabled' : 'Disabled');

  // Load price threshold settings
  const preheatCheapPercentile = toNumber(homey.settings.get('preheat_cheap_percentile')) ?? PRICE_CONSTANTS.DEFAULT_CHEAP_PERCENTILE;

  homey.app.log('Price threshold settings:');
  homey.app.log('- Cheap Percentile:', preheatCheapPercentile, `(${(preheatCheapPercentile * 100).toFixed(1)}th percentile)`);

  optimizer.setConstraintSettings(minSetpointChangeMinutes, deadbandC);
  optimizer.setCurveGateOffset(curveGateOffsetC);
  optimizer.setTemperatureConstraints(minTemp, maxTemp, tempStep);
  optimizer.setZone2TemperatureConstraints(enableZone2, minTempZone2, maxTempZone2, tempStepZone2);
  optimizer.setTankTemperatureConstraints(enableTankControl, minTankTemp, maxTankTemp, tankTempStep);
  optimizer.setThermalModel(kFactor);
  optimizer.refreshOccupancyFromSettings();
  optimizer.setCOPSettings(copWeight, autoSeasonalMode, summerMode);
  optimizer.setPriceThresholds(preheatCheapPercentile);
}
