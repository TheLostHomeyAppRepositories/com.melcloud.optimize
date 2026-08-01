import * as https from 'https';
import type { CronJob } from 'cron';
import { TimelineEventType, TimelineHelperWrapper } from './timeline-helper-wrapper';
import { MelCloudApi as MelCloudService } from './src/services/melcloud-api';
import type { PriceProvider } from './src/types';
import type { Optimizer } from './src/services/optimizer';
import {
  DeviceInfo,
  TibberPriceInfo,
  JsonValue,
  SystemHealthCheckResult,
  HomeySettingsLike,
  HomeyLoggerLike,
  HomeyLike,
  LoggerLike,
  RetryableError,
  ApiLogger,
  ApiHandlerContext,
  ApiSuccess,
  ApiError,
  ApiResult,
  DeviceDropdownItem,
  BuildingDropdownItem,
  EnhancedOptimizationResult,
  WeeklyCalibrationResult,
  AugmentedOptimizationResult,
  OptimizerCostSnapshot,
  HourlyOptimizationData,
  ThermalModelDataPoint,
  ThermalModelResponseData,
  UpdateOptimizerSettingsResponse,
  GetDeviceListResponse,
  GetRunHourlyOptimizerResponse,
  GetThermalModelDataResponse,
  GetRunWeeklyCalibrationResponse,
  CronJobSnapshot,
  CronStatusSnapshot,
  GetStartCronJobsResponse,
  GetUpdateCronStatusResponse,
  GetCheckCronStatusResponse,
  ValidateAndStartCronResponse,
  GetCopDataResponse,
  GetWeeklyAverageCopResponse,
  ConnectionStatusResponse,
  RunThermalDataCleanupResponse,
  InternalCleanupResponse,
  GetModelConfidenceResponse,
  GetTibberHomesResponse,
  HotWaterServiceLike,
  HotWaterResponse,
  HotWaterClearRequest,
  HotWaterHandlers,
  ApiHandlers,
  OptimizationDecision
} from './src/types';
import type { ServiceState, HistoricalData } from './src/orchestration/service-manager';
import {
  applyServiceOverrides,
  getServiceState,
  getServiceStateSnapshot,
  initializeServices as ensureServicesInitialized,
  refreshPriceProvider,
  resetServiceState,
  setHistoricalData as setOrchestratorHistoricalData,
  updateOptimizerSettings as orchestratorUpdateSettings,
  saveHistoricalData
} from './src/orchestration/service-manager';
import { buildDecisionFromOptimization, buildPlaceholderDecision } from './src/util/decision-helper';



declare global {
  // Legacy globals used by the runtime layer (kept as any during migration)
  // eslint-disable-next-line no-var
  var hourlyJob: CronJob | null | undefined;
  // eslint-disable-next-line no-var
  var weeklyJob: CronJob | null | undefined;
}

// Helper function for making HTTP requests with retry capability
async function httpRequest(
  options: https.RequestOptions,
  data: JsonValue = null,
  maxRetries = 3,
  retryDelay = 1000,
  logger: LoggerLike | null = null
): Promise<any> {
  let lastError: RetryableError | null = null;
  const logLevel = logger?.homey?.settings?.get('log_level') || 1; // Default to INFO level
  const isDevelopment = process.env.HOMEY_APP_MODE === 'development' || process.env.NODE_ENV === 'development';

  // Helper function to log based on level
  const log = (message: string, level = 1) => {
    // Always log in development mode or if log level is appropriate
    if (isDevelopment || logLevel <= level) {
      if (logger && logger.log) {
        logger.log(message);
      } else {
        console.log(message);
      }
    }
  };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      // If this is a retry, log it
      if (attempt > 1) {
        log(`Retry attempt ${attempt - 1}/${maxRetries} for ${options.method} request to ${options.hostname}${options.path}`, 1);
      } else {
        log(`Making ${options.method} request to ${options.hostname}${options.path}`, 1);
      }

      // Create a new promise for this attempt
      const result = await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseData = '';

          // Log response status
          const statusCode = res.statusCode ?? 0;
          const statusMessage = res.statusMessage ?? '';
          log(`Response status: ${statusCode} ${statusMessage}`, 1);

          res.on('data', (chunk: Buffer | string) => {
            responseData += chunk;
          });

          res.on('end', () => {
            // Check if we got a redirect
            if (statusCode >= 300 && statusCode < 400) {
              const location = res.headers.location;
              log(`Received redirect to: ${location}`, 1);
              reject(new Error(`Received redirect to: ${location}`));
              return;
            }

            // Check if we got an error
            if (statusCode >= 400) {
              log(`Error response: ${responseData.substring(0, 200)}...`, 1);
              reject(new Error(`HTTP error ${statusCode}: ${statusMessage}`));
              return;
            }

            // Try to parse as JSON
            try {
              // Only log response details in development mode or debug level
              if (isDevelopment || logLevel <= 0) {
                log(`Response data (first 100 chars): ${responseData.substring(0, 100)}...`, 0);
              }

              const parsedData = JSON.parse(responseData);

              // We'll let the calling function handle the pretty printing of the full response
              // since it has more context about what the data represents

              resolve(parsedData);
            } catch (error: any) {
              log(`Failed to parse response as JSON. First 200 chars: ${responseData.substring(0, 200)}...`, 1);
              reject(new Error(`Failed to parse response: ${error instanceof Error ? error.message : String(error)}`));
            }
          });
        });

        req.on('error', (error: RetryableError) => {
          log(`Request error: ${error.message}`, 1);
          reject(error);
        });

        // Set a timeout to prevent hanging requests
        req.setTimeout(30000, () => {
          req.destroy();
          reject(new Error('Request timeout after 30 seconds'));
        });

        if (data !== null && data !== undefined) {
          const dataStr = JSON.stringify(data);
          // Only log request data in development mode or debug level
          if (isDevelopment || logLevel <= 0) {
            log(`Request data: ${dataStr.substring(0, 100)}...`, 0);
          }
          req.write(dataStr);
        }

        req.end();
      });

      // If we get here, the request was successful
      return result;

    } catch (error: any) {
      lastError = error as RetryableError;

      // Determine if we should retry based on the error
      const err = lastError;
      const isRetryable = (
        // Network errors are retryable
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        err?.code === 'ECONNREFUSED' ||
        err?.code === 'ENETUNREACH' ||
        // Timeout errors are retryable
        err?.message.includes('timeout') ||
        // Some HTTP errors are retryable (e.g., 500, 502, 503, 504)
        (err?.message.includes('HTTP error') &&
          (err.message.includes('500') ||
            err.message.includes('502') ||
            err.message.includes('503') ||
            err.message.includes('504')))
      );

      // If this error is not retryable, or we've used all our retries, throw the error
      if (!isRetryable || attempt > maxRetries) {
        log(`Request failed after ${attempt} attempt(s): ${err?.message ?? 'Unknown error'}`, 1);
        throw err;
      }

      // Wait before retrying
      log(`Waiting ${retryDelay}ms before retry...`, 1);
      await new Promise(resolve => setTimeout(resolve, retryDelay));

      // Increase the delay for the next retry (exponential backoff)
      retryDelay *= 2;
    }
  }

  // This should never happen, but just in case
  throw lastError || new Error('Request failed for unknown reason');
}

// Optimizer Service
// Create instances of services
const serviceState = getServiceState();
let melCloud = serviceState.melCloud;
let tibber = serviceState.tibber;
let weather = serviceState.weather;
let optimizer = serviceState.optimizer;

// Store historical data for weekly calibration
let historicalData = serviceState.historicalData;

function persistHistoricalData(homey: HomeyLike): void {
  setOrchestratorHistoricalData(historicalData);
  saveHistoricalData(homey);
  historicalData = getServiceState().historicalData;
}

function recordOptimizationEntry(
  homey: HomeyLike,
  optimizationResult: AugmentedOptimizationResult,
  savingsValue: number
): void {
  if (!historicalData || !Array.isArray(historicalData.optimizations)) {
    historicalData = { optimizations: [], lastCalibration: null };
  }

  try {
    const timestamp = typeof optimizationResult.timestamp === 'string'
      ? optimizationResult.timestamp
      : new Date().toISOString();
    const targetTemp = typeof optimizationResult.toTemp === 'number'
      ? optimizationResult.toTemp
      : (typeof optimizationResult.targetTemp === 'number' ? optimizationResult.targetTemp : null);
    const targetOriginal = typeof optimizationResult.fromTemp === 'number'
      ? optimizationResult.fromTemp
      : (typeof optimizationResult.targetOriginal === 'number' ? optimizationResult.targetOriginal : null);
    const priceNow = typeof optimizationResult.priceData?.current === 'number'
      ? optimizationResult.priceData.current
      : (typeof optimizationResult.priceNow === 'number' ? optimizationResult.priceNow : null);
    const comfort = typeof (optimizationResult as { comfort?: number }).comfort === 'number'
      ? (optimizationResult as { comfort?: number }).comfort
      : null;

  const indoorTemp = typeof optimizationResult.indoorTemp === 'number'
    ? optimizationResult.indoorTemp
    : null;
  const outdoorTemp = typeof optimizationResult.outdoorTemp === 'number'
    ? optimizationResult.outdoorTemp
    : null;
  const decision = buildDecisionFromOptimization(optimizationResult, timestamp);

  const entry = {
    timestamp,
    action: optimizationResult?.action ?? 'unknown',
    reason: optimizationResult?.reason ?? '',
      targetTemp,
      targetOriginal,
      indoorTemp,
      outdoorTemp,
    priceNow,
    savings: Number.isFinite(savingsValue) ? Number(savingsValue.toFixed(4)) : (optimizationResult?.savings ?? 0),
    comfort,
    priceData: optimizationResult?.priceData ?? null,
    weather: optimizationResult?.weather ?? null,
    zone2Data: optimizationResult?.zone2Data ?? null,
    tankData: optimizationResult?.tankData ?? null,
    decision: decision ?? null
  };

  historicalData.optimizations.push(entry);
  if (historicalData.optimizations.length > 168) {
    historicalData.optimizations.shift();
  }

  persistHistoricalData(homey);

  try {
    if (homey?.settings) {
      homey.settings.set('last_decision', decision ?? buildPlaceholderDecision());
    }
  } catch (err) {
    homey?.app?.error?.('Failed to persist last_decision snapshot', err as any);
  }
} catch (error) {
  homey?.app?.error?.('Failed to record optimization entry', error as any);
}
}

function requireMelCloud(): MelCloudService {
  if (!melCloud) {
    throw new Error('MELCloud service not initialized');
  }
  return melCloud;
}

function requireTibber(): PriceProvider {
  if (!tibber) {
    throw new Error('Tibber service not initialized');
  }
  return tibber;
}

function requireOptimizer(): Optimizer {
  if (!optimizer) {
    throw new Error('Optimizer service not initialized');
  }
  return optimizer;
}

function getHotWaterService(homey: HomeyLike): HotWaterServiceLike | null {
  const appWithService = homey.app as HomeyLoggerLike & { hotWaterService?: HotWaterServiceLike | null };
  const service = appWithService.hotWaterService ?? null;
  if (!service) return null;
  if (typeof service.resetPatterns !== 'function' || typeof service.clearData !== 'function') {
    return null;
  }
  return service;
}

// NOTE: test helper attachment moved to after module.exports to avoid being
// overwritten by the public export object.

// Initialize services
async function initializeServices(homey: HomeyLike): Promise<void> {
  const state = await ensureServicesInitialized(homey);
  melCloud = state.melCloud;
  tibber = state.tibber;
  optimizer = state.optimizer;
  weather = state.weather;
  historicalData = state.historicalData;
}

async function updatePriceProvider(homey: HomeyLike): Promise<void> {
  await ensureServicesInitialized(homey);
  const provider = refreshPriceProvider(homey);
  tibber = provider;
}

// Function to update optimizer settings from Homey settings
// This is exported so it can be called from the app.ts file
async function refreshOptimizerSettings(homey: HomeyLike): Promise<void> {
  await orchestratorUpdateSettings(homey);
  const state = getServiceState();
  optimizer = state.optimizer;
  historicalData = state.historicalData;
}

/**
 * Update timezone settings for all services
 * @param homey Homey instance
 * @param timeZoneOffset Timezone offset in hours
 * @param useDST Whether to use daylight saving time
 */
async function updateAllServiceTimezones(
  homey: HomeyLike,
  timeZoneOffset: number,
  useDST: boolean,
  timeZoneName?: string | null
): Promise<void> {
  const state = getServiceState();

  // Update MelCloud API service timezone
  if (state.melCloud && typeof state.melCloud.updateTimeZoneSettings === 'function') {
    state.melCloud.updateTimeZoneSettings(timeZoneOffset, useDST, timeZoneName ?? undefined);
    homey.app.log(`Updated MelCloud API timezone settings (${timeZoneName || `offset ${timeZoneOffset}`})`);
  }

  // Update Tibber API service timezone
  if (state.tibber && typeof state.tibber.updateTimeZoneSettings === 'function') {
    state.tibber.updateTimeZoneSettings(timeZoneOffset, useDST, timeZoneName ?? undefined);
    homey.app.log(`Updated Tibber API timezone settings (${timeZoneName || `offset ${timeZoneOffset}`})`);
  }

  // Update Hot Water Service timezone if available
  const hotWaterService = getHotWaterService(homey);
  if (hotWaterService && typeof (hotWaterService as any).updateTimeZoneSettings === 'function') {
    (hotWaterService as any).updateTimeZoneSettings(timeZoneOffset, useDST, timeZoneName ?? undefined);
    homey.app.log(`Updated Hot Water Service timezone settings (${timeZoneName || `offset ${timeZoneOffset}`})`);
  }

  // Update Optimizer timezone if available
  if (state.optimizer && typeof state.optimizer.updateTimeZoneSettings === 'function') {
    state.optimizer.updateTimeZoneSettings(timeZoneOffset, useDST, timeZoneName ?? undefined);
    homey.app.log(`Updated Optimizer timezone settings (${timeZoneName || `offset ${timeZoneOffset}`})`);
  }

  homey.app.log(`All services updated with timezone: offset=${timeZoneOffset}, DST=${useDST}, name=${timeZoneName || 'n/a'}`);
}

async function syncDevicesWithOptimizationResult(homey: any, result: AugmentedOptimizationResult): Promise<void> {
  try {
    if (!result) return;

    const driver = (homey.drivers && typeof homey.drivers.getDriver === 'function')
      ? homey.drivers.getDriver('boiler')
      : null;

    if (!driver || typeof driver.getDevices !== 'function') {
      return;
    }

    const devices = driver.getDevices();
    if (!Array.isArray(devices) || devices.length === 0) {
      return;
    }

    const zone1Target = typeof result.toTemp === 'number' ? result.toTemp : undefined;
    const zone2Target = result.zone2Data && typeof result.zone2Data.toTemp === 'number' ? result.zone2Data.toTemp : undefined;
    const tankTarget = result.tankData && typeof result.tankData.toTemp === 'number' ? result.tankData.toTemp : undefined;

    await Promise.allSettled(devices.map(async (device: any) => {
      try {
        if (zone1Target !== undefined && device?.hasCapability?.('target_temperature')) {
          const current = device.getCapabilityValue?.('target_temperature');
          if (current !== zone1Target) {
            await device.setCapabilityValue('target_temperature', zone1Target);
          }
        }

        if (zone2Target !== undefined && device?.hasCapability?.('target_temperature.zone2')) {
          const currentZone2 = device.getCapabilityValue?.('target_temperature.zone2');
          if (currentZone2 !== zone2Target) {
            await device.setCapabilityValue('target_temperature.zone2', zone2Target);
          }
        }

        if (tankTarget !== undefined && device?.hasCapability?.('target_temperature.tank')) {
          const currentTank = device.getCapabilityValue?.('target_temperature.tank');
          if (currentTank !== tankTarget) {
            await device.setCapabilityValue('target_temperature.tank', tankTarget);
          }
        }
      } catch (deviceErr: any) {
        homey.app.error('Failed to synchronize device capability after optimization:', deviceErr?.message ?? String(deviceErr));
      }
    }));

  } catch (err: any) {
    homey.app.error('Error syncing device capabilities after optimization:', err?.message ?? String(err));
  }
}

const apiHandlers: ApiHandlers = {
  // API endpoints for hot water functionality
  postHotWaterResetPatterns: async ({ homey }: ApiHandlerContext): Promise<HotWaterResponse> => {
    homey.app.log('API method postHotWaterResetPatterns called');
    const service = getHotWaterService(homey);
    if (!service) {
      return {
        success: false,
        message: 'Hot water service not available'
      };
    }

    try {
      service.resetPatterns();
      return {
        success: true,
        message: 'Hot water usage patterns have been reset to defaults.'
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      homey.app.error('Error resetting hot water patterns:', error);
      return {
        success: false,
        message: `Error resetting hot water usage patterns: ${message} `
      };
    }
  },

  postResetLearnedState: async ({ homey, body }: ApiHandlerContext): Promise<{
    success: boolean;
    message: string;
    result?: unknown;
  }> => {
    homey.app.log('API method postResetLearnedState called');

    try {
      const clearThermalData = (body as { clearThermalData?: boolean } | undefined)?.clearThermalData !== false;

      // Reset the persisted state first. Homey settings are the source of truth and survive
      // whether or not the optimizer happens to be initialised, so recovery must not depend on
      // a live service. The learners' load paths spread stored values over their defaults, so
      // deleting a key restores that key's default on next construction.
      const before: Record<string, unknown> = {};
      const RESET_KEYS = [
        'priceWeightSummer', 'priceWeightWinter', 'priceWeightTransition',
        'preheatAggressiveness', 'coastingReduction', 'boostIncrease'
      ];

      const rawAdaptive = homey.settings.get('adaptive_business_parameters');
      if (rawAdaptive) {
        const parsed = typeof rawAdaptive === 'string' ? JSON.parse(rawAdaptive) : { ...rawAdaptive };
        for (const key of RESET_KEYS) {
          before[key] = parsed[key];
          delete parsed[key];
        }
        homey.settings.set('adaptive_business_parameters', JSON.stringify(parsed));
      }

      const rawThermal = homey.settings.get('thermal_model_characteristics');
      before.thermalCharacteristics = typeof rawThermal === 'string' ? JSON.parse(rawThermal) : rawThermal ?? null;
      homey.settings.set('thermal_model_characteristics', null);

      if (clearThermalData) {
        homey.settings.set('thermal_model_data', null);
        homey.settings.set('thermal_model_aggregated_data', null);
      }

      // If the optimizer is live, also reset its in-memory copies, otherwise they would be
      // written back over the settings on the next save.
      let inMemoryReset = false;
      try {
        const activeOptimizer = requireOptimizer();
        activeOptimizer.resetLearnedState({ clearThermalData });
        inMemoryReset = true;
      } catch {
        homey.app.log('Optimizer not initialised; persisted state reset only (applies on next start)');
      }

      return {
        success: true,
        message: `Learned state reset to defaults${clearThermalData ? ', thermal data cleared' : ''}. ` +
          (inMemoryReset ? 'Applied immediately.' : 'Applies on next optimizer start.'),
        result: { before, clearThermalData, inMemoryReset }
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      homey.app.error('Error resetting learned state:', error);
      return {
        success: false,
        message: `Error resetting learned state: ${message}`
      };
    }
  },

  postHotWaterClearData: async ({ homey, body }: ApiHandlerContext): Promise<HotWaterResponse> => {
    homey.app.log('API method postHotWaterClearData called');
    const service = getHotWaterService(homey);
    if (!service) {
      return {
        success: false,
        message: 'Hot water service not available'
      };
    }

    const payload = (body ?? {}) as HotWaterClearRequest;
    const clearAggregated = payload.clearAggregated === undefined
      ? true
      : Boolean(payload.clearAggregated);

    try {
      await service.clearData(clearAggregated);
      const suffix = clearAggregated
        ? ' including aggregated data.'
        : ' while keeping aggregated data.';
      return {
        success: true,
        message: `Hot water usage data has been cleared${suffix} `
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      homey.app.error('Error clearing hot water data:', error);
      return {
        success: false,
        message: `Error clearing hot water usage data: ${message} `
      };
    }
  },

  getHotWaterPatterns: async ({ homey }: ApiHandlerContext): Promise<HotWaterResponse> => {
    homey.app.log('API method getHotWaterPatterns called');

    try {
      // Get patterns from Homey settings
      const patternsData = homey.settings.get('hot_water_usage_patterns');

      if (!patternsData) {
        homey.app.log('===== HOT WATER USAGE PATTERNS =====');
        homey.app.log('No usage patterns found - using defaults');
        homey.app.log('=====================================');
        return {
          success: true,
          message: 'No usage patterns found - check terminal for details'
        };
      }

      const patterns = JSON.parse(patternsData);

      // Pretty print to terminal
      homey.app.log('===== HOT WATER USAGE PATTERNS =====');
      homey.app.log(`Last Updated: ${patterns.lastUpdated || 'Unknown'} `);
      homey.app.log(`Confidence: ${patterns.confidence || 0}% `);
      homey.app.log('');

      // Hourly patterns (0-23 hours)
      homey.app.log('📅 HOURLY USAGE PATTERN (24 hours):');
      if (patterns.hourlyUsagePattern && Array.isArray(patterns.hourlyUsagePattern)) {
        patterns.hourlyUsagePattern.forEach((usage: number, hour: number) => {
          const bar = '█'.repeat(Math.round(usage * 10));
          homey.app.log(`  ${String(hour).padStart(2, '0')}:00 ${usage.toFixed(2)} ${bar} `);
        });
      } else {
        homey.app.log('  No hourly pattern data available');
      }
      homey.app.log('');

      // Daily patterns (0-6 days, 0=Sunday)
      homey.app.log('📊 DAILY USAGE PATTERN (7 days):');
      if (patterns.dailyUsagePattern && Array.isArray(patterns.dailyUsagePattern)) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        patterns.dailyUsagePattern.forEach((usage: number, day: number) => {
          const bar = '█'.repeat(Math.round(usage * 10));
          homey.app.log(`  ${dayNames[day].padEnd(9)} ${usage.toFixed(2)} ${bar} `);
        });
      } else {
        homey.app.log('  No daily pattern data available');
      }
      homey.app.log('');

      // Get service stats if available
      const service = getHotWaterService(homey);
      if (service && typeof (service as any).getUsageStatistics === 'function') {
        try {
          const stats = (service as any).getUsageStatistics(7);
          if (stats) {
            homey.app.log('📈 RECENT STATISTICS (Last 7 days):');
            homey.app.log(`  Data Points: ${stats.statistics?.totalDataPoints || 'Unknown'} `);
            homey.app.log(`  Avg Tank Temp: ${stats.statistics?.avgTankTemp?.toFixed(1) || 'Unknown'}°C`);
            homey.app.log(`  Avg Energy: ${stats.statistics?.avgEnergyProduced?.toFixed(2) || 'Unknown'} kWh`);
            homey.app.log('');

            if (stats.predictions && Array.isArray(stats.predictions)) {
              homey.app.log('🔮 NEXT 24H PREDICTIONS:');
              const now = new Date();
              stats.predictions.slice(0, 12).forEach((prediction: number, i: number) => {
                const hour = (now.getHours() + i) % 24;
                const bar = '█'.repeat(Math.round(prediction * 10));
                homey.app.log(`  ${String(hour).padStart(2, '0')}:00 ${prediction.toFixed(2)} ${bar} `);
              });
            }
          }
        } catch (statsError) {
          homey.app.log('📈 STATISTICS: Error retrieving stats');
        }
      }

      homey.app.log('=====================================');

      return {
        success: true,
        message: 'Hot water usage patterns dumped to terminal - check the logs!'
      };

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      homey.app.error('Error getting hot water patterns:', error);
      return {
        success: false,
        message: `Error retrieving hot water patterns: ${message} `
      };
    }
  },

  // API endpoint for updating optimizer settings; invoked from app.ts during runtime refresh
  updateOptimizerSettings: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method updateOptimizerSettings called');
      homey.app.log('API method updateOptimizerSettings called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message} `,
          needsConfiguration: true
        };
      }

      // Update optimizer with the latest settings
      await refreshOptimizerSettings(homey);

      return {
        success: true,
        message: 'Optimizer settings updated successfully'
      };
    } catch (err: any) {
      console.error('Error in updateOptimizerSettings API endpoint:', err);
      return { success: false, error: err.message };
    }
  },
  getDeviceList: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getDeviceList called');
      homey.app.log('API method getDeviceList called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message} `,
          needsConfiguration: true
        };
      }

      // Get the list of devices
      try {
        // Refresh the device list to ensure we have the latest data
        const melCloudService = requireMelCloud();
        const devices = await melCloudService.getDevices();
        homey.app.log(`Found ${devices.length} devices in MELCloud account`);

        // Format the devices for the dropdown
        const formattedDevices = devices.map(device => ({
          id: device.id,
          name: device.name,
          buildingId: device.buildingId,
          type: device.type,
          // Include information about zones if available
          hasZone1: device.data && device.data.SetTemperatureZone1 !== undefined,
          hasZone2: device.data && device.data.SetTemperatureZone2 !== undefined,
          // Include information about tank if available
          hasTank: device.data && (device.data.SetTankWaterTemperature !== undefined || device.data.TankWaterTemperature !== undefined),
          SetTankWaterTemperature: device.data && device.data.SetTankWaterTemperature,
          TankWaterTemperature: device.data && device.data.TankWaterTemperature,
          // Include current temperatures if available
          currentTemperatureZone1: device.data && device.data.RoomTemperatureZone1,
          currentTemperatureZone2: device.data && device.data.RoomTemperatureZone2,
          currentSetTemperatureZone1: device.data && device.data.SetTemperatureZone1,
          currentSetTemperatureZone2: device.data && device.data.SetTemperatureZone2
        }));

        // Group devices by building
        const buildings: Record<number, BuildingDropdownItem> = {};
        devices.forEach(device => {
          if (!buildings[device.buildingId]) {
            buildings[device.buildingId] = {
              id: device.buildingId,
              name: `Building ${device.buildingId} `,
              devices: []
            };
          }
          buildings[device.buildingId].devices.push(device.id);
        });

        // Format buildings for the dropdown
        const formattedBuildings = Object.values(buildings);

        return {
          success: true,
          devices: formattedDevices,
          buildings: formattedBuildings
        };
      } catch (deviceErr: any) {
        homey.app.error('Error getting device list:', deviceErr);
        return {
          success: false,
          error: `Failed to get device list: ${deviceErr.message} `
        };
      }
    } catch (err: any) {
      console.error('Error in getDeviceList:', err);
      return { success: false, error: err.message };
    }
  },

  getRunHourlyOptimizer: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getRunHourlyOptimizer called');
      homey.app.log('API method getRunHourlyOptimizer called');

      // Initialize services if needed
      try {
        await initializeServices(homey);

        // Update optimizer with the latest settings
        await refreshOptimizerSettings(homey);
      } catch (initErr: any) {
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message} `,
          needsConfiguration: true
        };
      }

      // Run hourly optimization
      const activeOptimizer = requireOptimizer();
      const melCloudService = requireMelCloud();
      const enhancedCalculator = activeOptimizer.getSavingsService().getEnhancedSavingsCalculator();
      const baselineComparisonEnabled = homey.settings.get('enable_baseline_comparison') !== false;
      homey.app.log('Starting hourly optimization');
      homey.app.log('===== HOURLY OPTIMIZATION STARTED =====');

      try {
        // Run the enhanced optimization with real API data
        const result = await activeOptimizer.runOptimization() as AugmentedOptimizationResult;

        // Calculate enhanced savings with baseline comparison early for timeline (using result.savings)
        let enhancedSavingsData = null;
        let optimizerCostSnapshot: OptimizerCostSnapshot | null = null;
        try {
          if (baselineComparisonEnabled && enhancedCalculator?.hasBaselineCapability()) {
            // Use result.savings for early calculation
            const initialSavings = (typeof result.savings === 'number' && !Number.isNaN(result.savings)) ? result.savings : 0;

            // Get actual consumption for baseline calculation
            const actualConsumptionKWh = result.energyMetrics?.dailyEnergyConsumption || 1.0;
            
            // Calculate actual cost from consumption and current price (not from savings)
            let actualCost = 0;
            const currentPrice = result.priceData?.current;
            if (typeof currentPrice === 'number' && currentPrice > 0) {
              // Estimate cost from consumption * current price
              actualCost = actualConsumptionKWh * currentPrice;
            } else {
              // Fallback: use a conservative estimate (1 currency unit per kWh)
              actualCost = actualConsumptionKWh * 1.0;
            }

            // Get historical optimizations for enhanced calculation
            const today = new Date().toISOString().split('T')[0];
            const optimizationHistory = homey.settings.get('optimization_history') || [];
            const todayOptimizations = optimizationHistory.filter((opt: any) =>
              opt.timestamp && opt.timestamp.startsWith(today)
            );

            enhancedSavingsData = await activeOptimizer.getSavingsService().calculateEnhancedDailySavingsWithBaseline(
              initialSavings,
              todayOptimizations,
              actualConsumptionKWh,
              actualCost,
              true
            );

            homey.app.log('Enhanced savings with baseline calculated (early):', {
              standardSavings: enhancedSavingsData.dailySavings.toFixed(2),
              baselineSavings: enhancedSavingsData.baselineComparison?.baselineSavings.toFixed(2) || 'n/a',
              baselinePercentage: enhancedSavingsData.baselineComparison?.baselinePercentage.toFixed(1) || 'n/a',
              confidence: enhancedSavingsData.baselineComparison?.confidenceLevel.toFixed(2) || 'n/a'
            });

            const baselineBreakdown = enhancedSavingsData.baselineComparison?.breakdown;
            if (baselineBreakdown) {
              const baselineCostMajor = Number(baselineBreakdown.baselineCost);
              const optimizedCostMajor = Number(baselineBreakdown.actualCost);
              if (Number.isFinite(baselineCostMajor) && Number.isFinite(optimizedCostMajor)) {
                optimizerCostSnapshot = {
                  baselineCostMajor,
                  optimizedCostMajor
                };
              }
            }
          }
        } catch (enhancedErr: any) {
          homey.app.error('Error calculating enhanced savings with baseline (early):', enhancedErr.message || String(enhancedErr));
        }

        // ============================================================
        // SINGLE SOURCE OF TRUTH: Calculate finalDailySavings ONCE
        // This value is used for BOTH timeline and widget display
        // ============================================================
        let finalDailySavings: number = 0;
        {
          const hourlySavings = Number(result.savings || 0);
          // Default: project hourly savings to daily
          let projectedDaily = hourlySavings * 24;

          // Prefer enhanced daily savings calculation if available
          if (enhancedSavingsData?.dailySavings !== undefined && Number.isFinite(enhancedSavingsData.dailySavings)) {
            projectedDaily = enhancedSavingsData.dailySavings;
          }

          // Use baseline savings if available (comparison vs traditional 21°C heat pump)
          if (enhancedSavingsData?.baselineComparison?.baselineSavings !== undefined &&
              Number.isFinite(enhancedSavingsData.baselineComparison.baselineSavings)) {
            finalDailySavings = enhancedSavingsData.baselineComparison.baselineSavings;
          } else {
            finalDailySavings = projectedDaily;
          }
        }

        // Quick-win DHW scheduling: toggle forced hot-water when cheap
        try {
          const enableTank = homey.settings.get('enable_tank_control') === true;
          if (enableTank && result && result.hotWaterAction && result.hotWaterAction.action) {
            const action = result.hotWaterAction.action;
            const deviceId = homey.settings.get('device_id') || 'Boiler';
            const buildingIdSetting = homey.settings.get('building_id');
            const parsedBuildingId = Number.parseInt(String(buildingIdSetting ?? ''), 10);
            const buildingId = Number.isFinite(parsedBuildingId) ? parsedBuildingId : 0;
            if (action === 'heat_now') {
              await melCloudService.setHotWaterMode(deviceId, buildingId, true);
              homey.app.log('DHW action: Forced hot water mode (cheap price window)');
            } else if (action === 'delay') {
              await melCloudService.setHotWaterMode(deviceId, buildingId, false);
              homey.app.log('DHW action: Auto mode (delaying in expensive window)');
            }
          }
        } catch (dhwErr: any) {
          homey.app.error('DHW scheduling toggle failed:', dhwErr && dhwErr.message ? dhwErr.message : String(dhwErr));
        }

        // Log the enhanced optimization result
        homey.app.log('Enhanced optimization result:', JSON.stringify(result, null, 2));

        // Log to timeline (using app.log for now)
        if (result.action === 'temperature_adjusted') {
          homey.app.log(`🔄 TIMELINE: Enhanced optimization adjusted Zone1 temperature from ${result.fromTemp}°C to ${result.toTemp}°C`);
        } else {
          homey.app.log(`🔄 TIMELINE: Enhanced optimization - no temperature change needed(${result.reason})`);
        }

        // Log energy data if available
        if (result.energyMetrics) {
          const metrics = result.energyMetrics;
          const heatingCop = Number.isFinite(metrics.realHeatingCOP) ? metrics.realHeatingCOP.toFixed(2) : 'n/a';
          const hotWaterCop = Number.isFinite(metrics.realHotWaterCOP) ? metrics.realHotWaterCOP.toFixed(2) : 'n/a';
          const consumption = Number.isFinite(metrics.dailyEnergyConsumption) ? metrics.dailyEnergyConsumption.toFixed(2) : 'n/a';
          homey.app.log(`📊 Energy Metrics: daily = ${consumption} kWh, heatingCOP = ${heatingCop}, hotWaterCOP = ${hotWaterCop} `);
        }

        // Log price data
        if (result.priceData) {
          const hasNext = (typeof result.priceData.nextHour === 'number' && Number.isFinite(result.priceData.nextHour));
          const nextHourText = hasNext ? `${result.priceData.nextHour} kr / kWh` : 'n/a';
          homey.app.log(`💰 Price Data: Current: ${result.priceData.current} kr / kWh, Next Hour: ${nextHourText} `);
        }

        // Send to timeline using our standardized TimelineHelperWrapper
        try {
          // Create a timeline helper wrapper instance
          const timelineHelper = new TimelineHelperWrapper(homey as any);

          // Prepare additional data for the optimization timeline entry
          const additionalData: Record<string, unknown> = {
            fromTemp: result.fromTemp,
            toTemp: result.toTemp,
            targetTemp: result.toTemp,           // For timeline compatibility
            targetOriginal: result.fromTemp,     // For timeline compatibility
            action: result.action
          };

          // Add hot water tank data if available in the optimization result
          if (result.tankData) {
            // Use the rounded API value for timeline display (whole degrees only)
            additionalData.tankTemp = result.tankData.toTemp;
            additionalData.tankOriginal = result.tankData.fromTemp;
          }

          // Add Zone2 data if available in the optimization result
          if (result.zone2Data) {
            additionalData.zone2Temp = result.zone2Data.toTemp;
            additionalData.zone2Original = result.zone2Data.fromTemp;
          }

          // Prepare details for the timeline entry
          const details: Record<string, unknown> = {};

          // Add reason if available
          if (result.reason) {
            // Extract first part of reason (before any parentheses or periods)
            details.reason = result.reason.split(/[(.]/)[0].trim();
          }

          // Add price context from optimization price data
          const currentPrice = result.priceData?.current;
          const avgPrice = result.priceData?.average;
          if (currentPrice && avgPrice) {
            const priceRatio = currentPrice / avgPrice;
            let priceContext = '';
            if (priceRatio > 1.5) priceContext = 'Very high';
            else if (priceRatio > 1.2) priceContext = 'High';
            else if (priceRatio < 0.8) priceContext = 'Low';
            else if (priceRatio < 0.5) priceContext = 'Very low';
            else priceContext = 'Average';

            details.price = priceContext;
            additionalData.priceData = {
              current: currentPrice,
              average: avgPrice,
              min: result.priceData.min,
              max: result.priceData.max
            };
          }

          // Add weather data if available
          if (result.weather) {
            if (result.weather.current) {
              const currentWeather = result.weather.current;
              const temperature = currentWeather.temperature !== undefined ? `${currentWeather.temperature}°C` : 'n/a';
              const symbol = (currentWeather as Record<string, unknown>).symbol ?? '';
              details.weather = `${temperature}, ${symbol} `;
            }
            additionalData.weather = result.weather;
          }

          // Add Zone2 optimization info if data exists
          const zone2Payload = result.zone2Data;
          if (zone2Payload && typeof zone2Payload === 'object') {
            const zone2Target = (zone2Payload as any).toTemp ?? (zone2Payload as any).targetTemp;
            const zone2Original = (zone2Payload as any).fromTemp ?? (zone2Payload as any).targetOriginal;
            if (zone2Target !== undefined && zone2Original !== undefined) {
              additionalData.zone2Temp = zone2Target;
              additionalData.zone2Original = zone2Original;
            }
          }

          // Add tank optimization info if data exists
          const tankPayload = result.tankData;
          if (tankPayload && typeof tankPayload === 'object') {
            const tankTarget = (tankPayload as any).toTemp ?? (tankPayload as any).targetTemp;
            const tankOriginal = (tankPayload as any).fromTemp ?? (tankPayload as any).targetOriginal;
            if (tankTarget !== undefined && tankOriginal !== undefined) {
              additionalData.tankTemp = tankTarget;
              additionalData.tankOriginal = tankOriginal;
            }
          }

          // Use the single source of truth for daily savings (calculated earlier)
          additionalData.dailySavings = finalDailySavings;

          // Attach baseline metadata for reference (without re-calculating)
          if (enhancedSavingsData?.baselineComparison) {
            additionalData.baselineSavings = enhancedSavingsData.baselineComparison.baselineSavings;
            additionalData.baselinePercentage = enhancedSavingsData.baselineComparison.baselinePercentage;
            additionalData.enhancedSavings = enhancedSavingsData;
          }

          try {
            const currencyCode = homey.settings.get('currency') || homey.settings.get('currency_code') || 'EUR';
            homey.app.log(`Daily savings (single source): ${finalDailySavings.toFixed(2)} ${currencyCode}/day`);
          } catch (_: any) {
            homey.app.log(`Daily savings (single source): ${finalDailySavings.toFixed(2)} /day`);
          }

          // Create the timeline entry using our standardized helper
          await timelineHelper.addTimelineEntry(
            TimelineEventType.HOURLY_OPTIMIZATION_RESULT,
            details,
            false, // Don't create notification by default
            additionalData
          );

          homey.app.log('Timeline entry created using TimelineHelperWrapper');
        } catch (timelineErr: any) {
          homey.app.log('Timeline logging failed:', timelineErr.message);
        }

        await syncDevicesWithOptimizationResult(homey, result);

        homey.app.log('===== HOURLY OPTIMIZATION COMPLETED SUCCESSFULLY =====');

        // Persist savings history for settings summary (mirror app.ts addSavings)
        let computedSavings = (typeof result.savings === 'number' && !Number.isNaN(result.savings))
          ? result.savings
          : 0;

        try {
          if (!(typeof result.savings === 'number' && !Number.isNaN(result.savings))) {
            try {
              const p = result.priceData?.current || 0;
              const metrics = result.energyMetrics;
              const savingsService = activeOptimizer.getSavingsService();

              if (result.fromTemp !== undefined && result.toTemp !== undefined) {
                computedSavings += await savingsService.calculateRealHourlySavings(result.fromTemp, result.toTemp, p, metrics, 'zone1');
              }
              if (result.zone2Data && result.zone2Data.fromTemp !== undefined && result.zone2Data.toTemp !== undefined) {
                computedSavings += await savingsService.calculateRealHourlySavings(result.zone2Data.fromTemp, result.zone2Data.toTemp, p, metrics, 'zone2');
              }
              if (result.tankData && result.tankData.fromTemp !== undefined && result.tankData.toTemp !== undefined) {
                computedSavings += await savingsService.calculateRealHourlySavings(result.tankData.fromTemp, result.tankData.toTemp, p, metrics, 'tank');
              }
            } catch (_: any) { }
          }
          if (typeof computedSavings === 'number' && !Number.isNaN(computedSavings)) {
            // Keep both positive and negative savings for proper net accumulation
            // This fixes the issue where only positive individual savings were being added to daily totals
            computedSavings = Number((computedSavings || 0).toFixed(4));
            const toPersist = computedSavings; // Allow negative savings to be accumulated

            // Log for debugging savings accumulation
            if (computedSavings !== 0) {
              homey.app.log(`Savings accumulation: ${computedSavings > 0 ? '+' : ''}${computedSavings.toFixed(4)} SEK (individual optimization)`);
            }
            const tzOffset = parseInt(homey.settings.get('time_zone_offset'));
            const useDST = !!homey.settings.get('use_dst');
            const now = new Date();
            const local = new Date(now.getTime());
            if (!Number.isNaN(tzOffset)) local.setUTCHours(now.getUTCHours() + tzOffset);
            if (useDST) {
              const m = now.getUTCMonth();
              if (m > 2 && m < 10) local.setUTCHours(local.getUTCHours() + 1);
            }
            const y = local.getFullYear();
            const mo = String(local.getMonth() + 1).padStart(2, '0');
            const d = String(local.getDate()).padStart(2, '0');
            const todayStr = `${y}-${mo}-${d}`;

            const hist = homey.settings.get('savings_history') || [];
            const arr = Array.isArray(hist) ? hist.slice() : [];
            let todayEntry = arr.find(h => h && h.date === todayStr);

            // Determine currency/decimals for minor units
            const currencyCode = homey.settings.get('currency_code') || homey.settings.get('currency') || '';
            const decimalsMap: Record<string, number> = { JPY: 0, KWD: 3 };
            const decimals = decimalsMap[String(currencyCode).toUpperCase()] ?? 2;
            const toMinor = (amt: number): number => Math.round((Number(amt) || 0) * Math.pow(10, decimals));

            if (!todayEntry) {
              // Create entry in minor-units format
              todayEntry = { date: todayStr, totalMinor: 0, currency: currencyCode, decimals };
              arr.push(todayEntry);
            }

            // If entry already using minor units, keep using that; otherwise fall back to legacy 'total'
            if (todayEntry.totalMinor !== undefined) {
              todayEntry.currency = todayEntry.currency || currencyCode;
              if (todayEntry.decimals === undefined) todayEntry.decimals = decimals;
              const nextMinor = Number(todayEntry.totalMinor || 0) + toMinor(toPersist);
              // Store the actual net total (can be negative), but ensure display never shows negative
              todayEntry.totalMinor = nextMinor;
            } else {
              const nextTotal = Number(((Number(todayEntry.total || 0)) + toPersist).toFixed(4));
              // Store the actual net total (can be negative), but ensure display never shows negative
              todayEntry.total = nextTotal;
            }
            // Keep last 30 days only
            arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            const trimmed = arr.slice(Math.max(0, arr.length - 30));
            homey.settings.set('savings_history', trimmed);
            try {
              const todayMajor = todayEntry.totalMinor !== undefined
                ? (todayEntry.totalMinor / Math.pow(10, todayEntry.decimals ?? decimals)).toFixed(4)
                : Number(todayEntry.total || 0).toFixed(4);
              homey.app.log(`Updated savings_history: +${toPersist.toFixed(4)} -> today ${todayMajor} (${todayStr}), size=${trimmed.length}`);
            } catch (_: any) { }

            // Update display_savings_history (read-only estimates for UI)
            // Uses finalDailySavings (single source of truth) calculated earlier
            try {
              const calculatorHasBaseline = enhancedCalculator && typeof enhancedCalculator.calculateEnhancedDailySavingsWithBaseline === 'function';
              if (optimizerCostSnapshot || calculatorHasBaseline) {
                const displayHistoryRaw = homey.settings.get('display_savings_history') || [];
                const displayHistory = Array.isArray(displayHistoryRaw) ? displayHistoryRaw.slice() : [];
                const entryIndex = displayHistory.findIndex((item: any) => item && item.date === todayStr);
                const entry = entryIndex >= 0 ? { ...displayHistory[entryIndex] } : { date: todayStr };
                const hasStoredBaseline = Number.isFinite(entry?.baselineMinor) && Number.isFinite(entry?.optimizedMinor);

                let baselineCostMajor: number | null = null;
                let optimizedCostMajor: number | null = null;
                let baselineSource: 'optimizer' | 'stored' | 'fallback' | null = null;

                if (optimizerCostSnapshot) {
                  baselineCostMajor = optimizerCostSnapshot.baselineCostMajor;
                  optimizedCostMajor = optimizerCostSnapshot.optimizedCostMajor;
                  baselineSource = 'optimizer';
                } else if (hasStoredBaseline) {
                  baselineSource = 'stored';
                } else if (calculatorHasBaseline) {
                  // Gather historical optimizations (today only preferred)
                  const historicalOptimizations = Array.isArray(historicalData?.optimizations)
                    ? historicalData.optimizations.filter(opt => {
                      if (!opt || !opt.timestamp) return false;
                      return opt.timestamp.startsWith(todayStr);
                    })
                    : [];

                  // Estimate actual consumption and cost from metrics
                  const dailyConsumption = Number(result.energyMetrics?.dailyEnergyConsumption);
                  const gridFee = Number(homey.settings.get('grid_fee_per_kwh')) || 0;
                  const priceAverage = Number(result.priceData?.average);
                  const priceCurrent = Number(result.priceData?.current);
                  let pricePerKWh = Number.isFinite(priceAverage) && priceAverage > 0 ? priceAverage : undefined;
                  if (pricePerKWh === undefined && Number.isFinite(priceCurrent) && priceCurrent > 0) {
                    pricePerKWh = priceCurrent;
                  }
                  if (pricePerKWh !== undefined && Number.isFinite(gridFee) && gridFee > 0) {
                    pricePerKWh += gridFee;
                  } else if (pricePerKWh === undefined && Number.isFinite(gridFee) && gridFee > 0) {
                    pricePerKWh = gridFee;
                  }

                  const actualConsumptionKWh = Number.isFinite(dailyConsumption) && dailyConsumption > 0 ? dailyConsumption : undefined;
                  let actualCost = actualConsumptionKWh !== undefined && pricePerKWh !== undefined
                    ? actualConsumptionKWh * pricePerKWh
                    : undefined;

                  if ((actualCost === undefined || Number.isNaN(actualCost)) && enhancedSavingsData?.baselineComparison?.breakdown?.actualCost !== undefined) {
                    const fallbackCost = Number(enhancedSavingsData.baselineComparison.breakdown.actualCost);
                    if (Number.isFinite(fallbackCost) && fallbackCost >= 0) {
                      actualCost = fallbackCost;
                    }
                  }

                  const baselineOptions: any = {
                    enableBaseline: true,
                    baselineConfig: {
                      heatingSetpoint: 21,
                      hotWaterSetpoint: 60,
                      operatingProfile: 'always_on'
                    }
                  };

                  if (actualConsumptionKWh !== undefined) baselineOptions.actualConsumptionKWh = actualConsumptionKWh;
                  if (actualCost !== undefined) baselineOptions.actualCost = actualCost;
                  if (pricePerKWh !== undefined) baselineOptions.pricePerKWh = pricePerKWh;

                  const currentHourLocal = local.getHours();
                  const baselineResult = enhancedCalculator!.calculateEnhancedDailySavingsWithBaseline(
                    Number.isFinite(computedSavings) ? Number(computedSavings) : 0,
                    historicalOptimizations,
                    currentHourLocal,
                    undefined,
                    baselineOptions
                  );

                  const comparison = baselineResult?.baselineComparison;
                  baselineCostMajor = comparison?.breakdown && Number.isFinite(comparison.breakdown.baselineCost)
                    ? Number(comparison.breakdown.baselineCost)
                    : null;
                  optimizedCostMajor = comparison?.breakdown && Number.isFinite(comparison.breakdown.actualCost)
                    ? Number(comparison.breakdown.actualCost)
                    : null;
                  if (baselineCostMajor !== null && optimizedCostMajor !== null) {
                    baselineSource = 'fallback';
                  }
                }

                const seasonModeValue = result.energyMetrics?.seasonalMode;
                let entryUpdated = false;

                // Use finalDailySavings (single source of truth) for widget display
                if (Number.isFinite(finalDailySavings)) {
                  entry.currency = currencyCode;
                  entry.decimals = decimals;
                  entry.valueMajor = finalDailySavings;
                  entry.optimizedMinor = toMinor(Math.max(0, finalDailySavings));
                  entryUpdated = true;
                }

                if ((baselineSource === 'optimizer' || baselineSource === 'fallback') &&
                  baselineCostMajor !== null && optimizedCostMajor !== null) {
                  entry.currency = currencyCode;
                  entry.decimals = decimals;
                  entry.baselineMinor = toMinor(Math.max(0, baselineCostMajor));
                  // Keep baseline cost; optimizedMinor already set to savings above
                  entryUpdated = true;
                } else if (!hasStoredBaseline && baselineSource !== 'stored') {
                  homey.app.log('Skipping display_savings_history update: no baseline data available for today');
                }

                if (seasonModeValue && entry.seasonMode !== seasonModeValue) {
                  entry.seasonMode = seasonModeValue;
                  entryUpdated = true;
                }

                if (entryIndex >= 0) {
                  displayHistory[entryIndex] = entry;
                } else if (entryUpdated) {
                  displayHistory.push(entry);
                }

                if (entryUpdated) {
                  entry.updatedAt = new Date().toISOString();
                  displayHistory.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
                  const trimmedDisplay = displayHistory.slice(Math.max(0, displayHistory.length - 30));
                  homey.settings.set('display_savings_history', trimmedDisplay);

                  try {
                    const baselineLog = baselineCostMajor !== null ? baselineCostMajor.toFixed(2) : 'n/a';
                    const optimizedLog = optimizedCostMajor !== null ? optimizedCostMajor.toFixed(2) : 'n/a';
                    homey.app.log(`Updated display_savings_history (${baselineSource || 'stored'}): baseline=${baselineLog}, optimized=${optimizedLog} (${todayStr})`);
                  } catch (_: any) { }
                }
              }
            } catch (displayErr: any) {
              homey.app.error('Failed to update display_savings_history:', displayErr && displayErr.message ? displayErr.message : String(displayErr));
            }
          } else {
            homey.app.log('No numeric savings value to persist for this optimization run.');
          }
        } catch (persistErr: any) {
          homey.app.error('Failed to persist savings_history:', persistErr && persistErr.message ? persistErr.message : String(persistErr));
        }

        // Prepare additional helper fields for the app layer (priceNow, savings, hourly baseline)
        let hourlyBaselineKWh: number | null = null;
        const dailyConsumption = result.energyMetrics?.dailyEnergyConsumption;
        if (typeof dailyConsumption === 'number' && Number.isFinite(dailyConsumption) && dailyConsumption > 0) {
          hourlyBaselineKWh = dailyConsumption / 24;
        }

        // Only record entries with valid price data — failed price fetches
        // (priceNow: 0, action: no_change) pollute the history buffer and
        // displace real optimization data used by model confidence calculations.
        const hasPriceData = result.priceDataUnavailable !== true
          && typeof result.priceData?.current === 'number'
          && Number.isFinite(result.priceData.current);
        if (hasPriceData) {
          recordOptimizationEntry(homey, result, computedSavings);
        } else {
          homey.app.log('Skipping optimization history entry: no valid price data');
        }

        return {
          success: true,
          message: 'Hourly optimization completed',
          data: {
            // Use the enhanced optimization result structure
            action: result.action,
            fromTemp: result.fromTemp,
            toTemp: result.toTemp,
            targetTemp: result.toTemp,  // Added for driver logging compatibility
            reason: result.reason,
            priceData: result.priceData,
            // Added for compatibility with app.ts accounting logic
            priceNow: result && result.priceData ? result.priceData.current : undefined,
            savings: (typeof computedSavings === 'number' && !Number.isNaN(computedSavings)) ? computedSavings : (result.savings || 0),
            hourlyBaselineKWh: hourlyBaselineKWh,
            timestamp: new Date().toISOString(),
            // Enhanced savings with baseline comparison
            enhancedSavings: enhancedSavingsData
          },
          result
        };
      } catch (optimizeErr: any) {
        homey.app.error('Hourly optimization error', optimizeErr);

        // Log notification
        homey.app.error(`NOTIFICATION: HourlyOptimizer error: ${optimizeErr.message}`);

        // Try to send notification if the method exists
        try {
          if (typeof homey.notifications === 'object' && typeof homey.notifications.createNotification === 'function') {
            const notify = homey.notifications.createNotification.bind(homey.notifications);
            await notify({ excerpt: `HourlyOptimizer error: ${optimizeErr.message}` });
          }
        } catch (notifyErr: any) {
          homey.app.error('Notification system not available:', notifyErr.message);
        }

        homey.app.error('===== HOURLY OPTIMIZATION FAILED =====');
        throw optimizeErr; // Re-throw to be caught by the outer try-catch
      }
    } catch (err: any) {
      console.error('Error in getRunHourlyOptimizer:', err);
      return { success: false, error: err.message };
    }
  },

  getThermalModelData: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getThermalModelData called');
      homey.app.log('API method getThermalModelData called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        homey.app.error('Failed to initialize services:', initErr);
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message}`,
          needsConfiguration: true
        };
      }

      // Log thermal model data to terminal
      homey.app.log('===== THERMAL MODEL DATA =====');
      homey.app.log(`Optimization Count: ${historicalData.optimizations.length} data points`);

      if (optimizer) {
        const thermalModel = typeof optimizer?.getThermalModel === 'function'
          ? optimizer.getThermalModel()
          : null;
        if (thermalModel && typeof thermalModel.K === 'number') {
          homey.app.log(`Current K-Factor: ${thermalModel.K.toFixed(2)}`);
        }
      } else {
        homey.app.log('Current K-Factor: Not available (optimizer not initialized)');
      }

      if (historicalData.lastCalibration) {
        const calibDate = new Date(historicalData.lastCalibration.timestamp).toLocaleString();
        homey.app.log(`Last Calibration: ${calibDate}`);
        homey.app.log(`K-Factor Change: ${historicalData.lastCalibration.oldK.toFixed(2)} → ${historicalData.lastCalibration.newK.toFixed(2)}`);
        homey.app.log(`Analysis: ${historicalData.lastCalibration.analysis}`);
      } else {
        homey.app.log('Last Calibration: Never performed');
      }

      if (historicalData.optimizations.length > 0) {
        const lastOpt = historicalData.optimizations[historicalData.optimizations.length - 1];
        const optDate = new Date(lastOpt.timestamp).toLocaleString();
        homey.app.log(`Last Optimization: ${optDate}`);
        homey.app.log(`Target Temperature: ${lastOpt.targetTemp !== undefined ? lastOpt.targetTemp : 'N/A'}°C (was ${lastOpt.targetOriginal !== undefined ? lastOpt.targetOriginal : 'N/A'}°C)`);
        homey.app.log(`Indoor Temperature: ${lastOpt.indoorTemp !== undefined ? lastOpt.indoorTemp : 'N/A'}°C`);
        homey.app.log(`Outdoor Temperature: ${lastOpt.outdoorTemp !== undefined ? lastOpt.outdoorTemp : 'N/A'}°C`);
        homey.app.log(`Current Price: ${lastOpt.priceNow !== undefined ? lastOpt.priceNow.toFixed(4) : 'N/A'}`);
      } else {
        homey.app.log('No optimization data available yet');
      }

      homey.app.log('Recent data points:');
      // Log the last 5 data points (or fewer if not available)
      const recentPoints = historicalData.optimizations.slice(-5);
      recentPoints.forEach((point, index) => {
        const date = new Date(point.timestamp).toLocaleString();
        const indoorTemp = point.indoorTemp !== undefined ? point.indoorTemp : 'N/A';
        const outdoorTemp = point.outdoorTemp !== undefined ? point.outdoorTemp : 'N/A';
        const targetTemp = point.targetTemp !== undefined ? point.targetTemp : 'N/A';
        const price = point.priceNow !== undefined ? point.priceNow.toFixed(4) : 'N/A';
        homey.app.log(`[${index + 1}] ${date}: Indoor ${indoorTemp}°C, Outdoor ${outdoorTemp}°C, Target ${targetTemp}°C, Price ${price}`);
      });

      homey.app.log('=============================');

      // Return the thermal model data
      return {
        success: true,
        data: {
          optimizationCount: historicalData.optimizations.length,
          lastOptimization: historicalData.optimizations.length > 0 ?
            historicalData.optimizations[historicalData.optimizations.length - 1] : null,
          lastCalibration: historicalData.lastCalibration,
          kFactor: optimizer && typeof optimizer.getThermalModel === 'function'
            ? optimizer.getThermalModel().K
            : null,
          dataPoints: historicalData.optimizations.map(opt => ({
            timestamp: opt.timestamp,
            targetTemp: opt.targetTemp,
            indoorTemp: opt.indoorTemp,
            outdoorTemp: opt.outdoorTemp,
            priceNow: opt.priceNow
          }))
        }
      };
    } catch (err: any) {
      console.error('Error in getThermalModelData:', err);
      homey.app.error('Error in getThermalModelData:', err);
      return { success: false, error: err.message };
    }
  },

  getRunWeeklyCalibration: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getRunWeeklyCalibration called');
      homey.app.log('API method getRunWeeklyCalibration called');

      // Initialize services if needed
      try {
        await initializeServices(homey);

        // Update optimizer with the latest settings
        await refreshOptimizerSettings(homey);
      } catch (initErr: any) {
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message}`,
          needsConfiguration: true
        };
      }

      const activeOptimizer = requireOptimizer();

      // Run weekly calibration
      homey.app.log('Starting weekly calibration');
      homey.app.log('===== WEEKLY CALIBRATION STARTED =====');

      try {
        // Check if we have historical data
        if (historicalData.optimizations.length < 24) {
          const message = `Not enough historical data for calibration. Have ${historicalData.optimizations.length} data points, need at least 24.`;
          homey.app.log(message);

          return {
            success: false,
            message: message,
            historicalDataCount: historicalData.optimizations.length
          };
        }

        // Run the actual calibration
        const result = await activeOptimizer.runWeeklyCalibration();

        // Log the result
        homey.app.log('Calibration result:', JSON.stringify(result, null, 2));

        // Log to timeline (using app.log for now)
        homey.app.log(`📊 TIMELINE: Calibrated thermal model: K=${result.newK.toFixed(2)}`);

        // Send to timeline using our standardized TimelineHelperWrapper
        try {
          // Create a timeline helper wrapper instance
          const timelineHelper = new TimelineHelperWrapper(homey as any);

          // Prepare additional data for the timeline entry
          const additionalData: Record<string, unknown> = {
            oldK: result.oldK,
            newK: result.newK,
            method: result.method ?? 'Advanced Thermal Learning'
          };

          // Prepare details for the timeline entry
          const details: Record<string, unknown> = {};

          // Add S value if available
          if (typeof result.newS === 'number') {
            details.s = result.newS.toFixed(2);
          }

          // Add thermal characteristics if available
          if (result.thermalCharacteristics) {
            const characteristics = result.thermalCharacteristics as Record<string, unknown>;
            const heatingRate = characteristics.heatingRate;
            const coolingRate = characteristics.coolingRate;
            if (typeof heatingRate === 'number' && Number.isFinite(heatingRate)) {
              details.heatingRate = heatingRate.toFixed(3);
            }
            if (typeof coolingRate === 'number' && Number.isFinite(coolingRate)) {
              details.coolingRate = coolingRate.toFixed(3);
            }
          }

          // Create the main calibration timeline entry
          await timelineHelper.addTimelineEntry(
            TimelineEventType.WEEKLY_CALIBRATION_RESULT,
            details,
            false, // Don't create notification by default
            additionalData
          );

          homey.app.log('Timeline entries created using TimelineHelperWrapper');
        } catch (timelineErr: any) {
          homey.app.log('Timeline logging failed:', timelineErr.message);
        }

        // Update settings
        homey.settings.set('initial_k', result.newK);

        homey.app.log('===== WEEKLY CALIBRATION COMPLETED SUCCESSFULLY =====');

        historicalData.lastCalibration = {
          ...result,
          timestamp: result.timestamp || new Date().toISOString()
        };
        persistHistoricalData(homey);

        return {
          success: true,
          message: 'Weekly calibration completed',
          result
        };
      } catch (calibrateErr: any) {
        homey.app.error('Weekly calibration error', calibrateErr);

        // Log notification
        homey.app.error(`NOTIFICATION: WeeklyCalibration error: ${calibrateErr.message}`);

        // Try to send notification if the method exists
        try {
          if (typeof homey.notifications === 'object' && typeof homey.notifications.createNotification === 'function') {
            const notify = homey.notifications.createNotification.bind(homey.notifications);
            await notify({ excerpt: `WeeklyCalibration error: ${calibrateErr.message}` });
          }
        } catch (notifyErr: any) {
          homey.app.error('Notification system not available:', notifyErr.message);
        }

        homey.app.error('===== WEEKLY CALIBRATION FAILED =====');
        throw calibrateErr; // Re-throw to be caught by the outer try-catch
      }
    } catch (err: any) {
      console.error('Error in getRunWeeklyCalibration:', err);
      return { success: false, error: err.message };
    }
  },

  getStartCronJobs: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getStartCronJobs called');
      homey.app.log('API method getStartCronJobs called');

      // Try to initialize the cron jobs directly in the API
      try {
        homey.app.log('Initializing cron jobs directly in the API');

        // Import the cron library
        const { CronJob } = require('cron');

        const resolveCronTimezone = (): string => {
          try {
            const tzName = homey.settings.get('time_zone_name');
            if (typeof tzName === 'string' && tzName.trim().length > 0) {
              return tzName.trim();
            }
          } catch (err) {
            homey.app.warn?.('Failed to read time_zone_name setting, falling back to default', err);
          }
          if (typeof process !== 'undefined' && typeof process.env === 'object' && process.env.TZ) {
            return String(process.env.TZ);
          }
          return 'Europe/Stockholm';
        };
        const cronTimeZone = resolveCronTimezone();

        // Create hourly job - runs at minute 5 of every hour
        homey.app.log(`Creating hourly cron job with pattern: 0 5 * * * * (tz: ${cronTimeZone})`);
        const hourlyJob = new CronJob('0 5 * * * *', async () => {
          // Log the trigger
          const currentTime = new Date().toISOString();
          homey.app.log('===== AUTOMATIC HOURLY CRON JOB TRIGGERED =====');
          homey.app.log(`Current time: ${currentTime}`);

          // Store the last run time in settings
          homey.settings.set('last_hourly_run', currentTime);

          // Intentionally skip timeline post for cron trigger (noisy/duplicative)

          // Call the hourly optimizer
          try {
            await apiHandlers.getRunHourlyOptimizer({ homey });
          } catch (err: any) {
            homey.app.error('Error in hourly cron job', err);
          }
        }, null, false, cronTimeZone);

        // Create daily job - runs at 00:05 every day
        homey.app.log(`Creating daily calibration cron job with pattern: 5 0 * * * (tz: ${cronTimeZone})`);
        const weeklyJob = new CronJob('5 0 * * *', async () => {
          // Log the trigger
          const currentTime = new Date().toISOString();
          homey.app.log('===== AUTOMATIC DAILY CALIBRATION CRON JOB TRIGGERED =====');
          homey.app.log(`Current time: ${currentTime}`);

          // Store the last run time in settings
          homey.settings.set('last_weekly_run', currentTime);

          // Intentionally skip timeline post for cron trigger (noisy/duplicative)

          // Call the weekly calibration
          try {
            await apiHandlers.getRunWeeklyCalibration({ homey });
          } catch (err: any) {
            homey.app.error('Error in daily calibration cron job', err);
          }
        }, null, false, cronTimeZone);

        // Start the cron jobs
        homey.app.log('Starting hourly cron job...');
        hourlyJob.start();
        homey.app.log('Hourly cron job started');

        homey.app.log('Starting daily calibration cron job...');
        weeklyJob.start();
        homey.app.log('Daily calibration cron job started');

        // Store the jobs in settings for future reference
        homey.settings.set('cron_status', {
          hourlyJob: {
            running: hourlyJob.running,
            nextRun: hourlyJob.nextDate().toString(),
            cronTime: String(hourlyJob.cronTime?.source ?? '')
          },
          weeklyJob: {
            running: weeklyJob.running,
            nextRun: weeklyJob.nextDate().toString(),
            cronTime: String(weeklyJob.cronTime?.source ?? '')
          },
          lastHourlyRun: homey.settings.get('last_hourly_run') || 'Never',
          lastWeeklyRun: homey.settings.get('last_weekly_run') || 'Never',
          lastUpdated: new Date().toISOString()
        });

        // Store the jobs in global variables for future access
        global.hourlyJob = hourlyJob;
        global.weeklyJob = weeklyJob;

        // Skip timeline post for cron initialization (not needed)

        // Update the cron status in settings
        await apiHandlers.getUpdateCronStatus({ homey });

        return {
          success: true,
          message: 'Cron jobs initialized directly in the API',
          hourlyJobRunning: hourlyJob.running,
          weeklyJobRunning: weeklyJob.running
        };
      } catch (err: any) {
        homey.app.error('Error initializing cron jobs directly in the API:', err);
        return {
          success: false,
          error: err.message || 'Unknown error'
        };
      }
    } catch (err: any) {
      console.error('Error in getStartCronJobs:', err);
      return { success: false, error: err.message };
    }
  },

  getUpdateCronStatus: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getUpdateCronStatus called');
      homey.app.log('API method getUpdateCronStatus called');

      // Manually update the cron status in settings
      try {
        // Get the hourly and weekly jobs from the app instance if possible
        let hourlyJob = null;
        let weeklyJob = null;

        try {
          // First try to access the global cron jobs
          if (global.hourlyJob && global.weeklyJob) {
            hourlyJob = global.hourlyJob;
            weeklyJob = global.weeklyJob;
            homey.app.log('Successfully accessed cron jobs from global variables');
          }
          // If not found in global, try to access from app instance
          else if (homey.app && typeof homey.app === 'object') {
            hourlyJob = homey.app.hourlyJob;
            weeklyJob = homey.app.weeklyJob;

            if (hourlyJob && weeklyJob) {
              homey.app.log('Successfully accessed cron jobs from app instance');
            } else {
              homey.app.log('Cron jobs not found in app instance');
              homey.app.log('hourlyJob:', hourlyJob ? 'found' : 'not found');
              homey.app.log('weeklyJob:', weeklyJob ? 'found' : 'not found');
            }
          } else {
            console.log('homey.app is not accessible or not an object');
          }
        } catch (err: any) {
          console.log('Could not access cron jobs from app instance:', err && err.message ? err.message : err);
        }

        // Create a status object with the available information
        const status = {
          hourlyJob: hourlyJob ? {
            running: hourlyJob.running,
            nextRun: hourlyJob.nextDate().toString(),
            cronTime: String(hourlyJob.cronTime?.source ?? '')
          } : { running: false, error: 'Could not access hourly job' },

          weeklyJob: weeklyJob ? {
            running: weeklyJob.running,
            nextRun: weeklyJob.nextDate().toString(),
            cronTime: String(weeklyJob.cronTime?.source ?? '')
          } : { running: false, error: 'Could not access weekly job' },

          lastHourlyRun: homey.settings.get('last_hourly_run') || 'Never',
          lastWeeklyRun: homey.settings.get('last_weekly_run') || 'Never',
          lastUpdated: new Date().toISOString()
        };

        // Save the status to settings
        homey.settings.set('cron_status', status);
        homey.app.log('Manually updated cron status in settings');

        return {
          success: true,
          message: 'Cron status updated successfully',
          cronStatus: status
        };
      } catch (err: any) {
        homey.app.error('Error updating cron status:', err);
        return {
          success: false,
          error: err.message || 'Unknown error'
        };
      }
    } catch (err: any) {
      console.error('Error in getUpdateCronStatus:', err);
      return { success: false, error: err.message };
    }
  },

  getCheckCronStatus: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getCheckCronStatus called');
      homey.app.log('API method getCheckCronStatus called');

      // Check if the global cron jobs exist
      if (!global.hourlyJob || !global.weeklyJob) {
        homey.app.log('Global cron jobs not found, attempting to start them');

        // Try to start the cron jobs
        try {
          const startResult = await apiHandlers.getStartCronJobs({ homey });
          if (startResult.success) {
            homey.app.log('Successfully started cron jobs via API');
          } else {
            homey.app.log('Failed to start cron jobs via API:', startResult.error);
          }
        } catch (err: any) {
          homey.app.error('Error calling getStartCronJobs:', err);
        }
      }

      // Try to get the latest cron status by calling the update endpoint
      try {
        // Call the update endpoint to get the latest status
        const updateResult = await apiHandlers.getUpdateCronStatus({ homey });
        if (updateResult.success) {
          homey.app.log('Successfully updated cron status via API');
        } else {
          homey.app.log('Failed to update cron status via API:', updateResult.error);
        }
      } catch (err: any) {
        homey.app.error('Error calling getUpdateCronStatus:', err);
      }

      // Get information about the cron jobs from settings
      const cronStatus = homey.settings.get('cron_status') || {
        hourlyJob: { running: false, error: 'Cron status not available in settings' },
        weeklyJob: { running: false, error: 'Cron status not available in settings' },
        lastHourlyRun: homey.settings.get('last_hourly_run') || 'Never',
        lastWeeklyRun: homey.settings.get('last_weekly_run') || 'Never',
        lastUpdated: new Date().toISOString()
      };

      // Add last run times if not present in cronStatus
      if (!cronStatus.lastHourlyRun) {
        cronStatus.lastHourlyRun = homey.settings.get('last_hourly_run') || 'Never';
      }

      if (!cronStatus.lastWeeklyRun) {
        cronStatus.lastWeeklyRun = homey.settings.get('last_weekly_run') || 'Never';
      }

      // Get the current time for reference
      const currentTime = new Date().toISOString();

      // Log the cron status for debugging
      homey.app.log('Cron status:', JSON.stringify(cronStatus, null, 2));

      // Create a timeline entry to show the cron status
      try {
        homey.app.log('Creating timeline entry for cron status check');

        // First try the direct timeline API if available
        if (typeof homey.timeline === 'object' && typeof homey.timeline.createEntry === 'function') {
          await homey.timeline.createEntry({
            title: 'MELCloud Optimizer',
            body: '⏱️ Cron job status checked',
            icon: 'flow:device_changed'
          });
          homey.app.log('Timeline entry created using timeline API');
        }
        // Then try the notifications API as the main fallback
        else if (typeof homey.notifications === 'object' && typeof homey.notifications.createNotification === 'function') {
          const notify = homey.notifications.createNotification.bind(homey.notifications);
          await notify({
            excerpt: 'MELCloud Optimizer: ⏱️ Cron job status checked',
          });
          homey.app.log('Timeline entry created using notifications API');
        }
        // Finally try homey.app.flow if available
        else if (homey.app && homey.app.flow && typeof homey.app.flow.runFlowCardAction === 'function') {
          await homey.app.flow.runFlowCardAction({
            uri: 'homey:flowcardaction:homey:manager:timeline:log',
            args: { text: '⏱️ Cron job status checked' }
          });
          homey.app.log('Timeline entry created using app flow API');
        }
        else {
          homey.app.log('Timeline API not available, using log only');
        }
      } catch (err: any) {
        homey.app.error('Failed to create timeline entry for cron status check', err);
      }

      return {
        success: true,
        currentTime,
        hourlyJob: cronStatus.hourlyJob,
        weeklyJob: cronStatus.weeklyJob,
        lastHourlyRun: cronStatus.lastHourlyRun,
        lastWeeklyRun: cronStatus.lastWeeklyRun
      };
    } catch (err: any) {
      console.error('Error in getCheckCronStatus:', err);
      return { success: false, error: err.message };
    }
  },

  getCOPData: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getCOPData called');
      homey.app.log('API method getCOPData called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message}`,
          needsConfiguration: true
        };
      }

      // Get the device ID and building ID from settings
      const deviceId = homey.settings.get('device_id');
      const buildingId = parseInt(homey.settings.get('building_id') || '0');

      if (!deviceId || !buildingId) {
        return {
          success: false,
          error: 'Device ID or Building ID not set in settings'
        };
      }

      try {
        // Get COP data from MELCloud
        const melCloudService = requireMelCloud();
        const copData = await melCloudService.getEnhancedCOPData(deviceId, buildingId);

        // Check if we have a COP helper instance
        if (!global.copHelper) {
          homey.app.log('COP Helper not initialized, creating instance');

          // Import the COPHelper class
          const { COPHelper } = require('./src/services/cop-helper');

          // Create a new instance
          global.copHelper = new COPHelper(homey, homey.app);
          homey.app.log('COP Helper initialized');
        }

        // Get COP data from the helper
        const copHelperInstance = global.copHelper!;
        const helperData = await copHelperInstance.getCOPData();

        // Combine the data
        const result = {
          success: true,
          melcloud: copData,
          helper: helperData,
          settings: {
            copWeight: homey.settings.get('cop_weight') || 0.3,
            autoSeasonalMode: homey.settings.get('auto_seasonal_mode') !== false,
            summerMode: homey.settings.get('summer_mode') === true
          }
        };

        return result;
      } catch (error: any) {
        homey.app.error('Error getting COP data:', error);
        return {
          success: false,
          error: error.message
        };
      }
    } catch (err: any) {
      console.error('Error in getCOPData:', err);
      return { success: false, error: err.message };
    }
  },

  getWeeklyAverageCOP: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getWeeklyAverageCOP called');
      homey.app.log('API method getWeeklyAverageCOP called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        return {
          success: false,
          error: `Failed to initialize services: ${initErr.message}`,
          needsConfiguration: true
        };
      }

      // Get the device ID and building ID from settings
      const deviceId = homey.settings.get('device_id');
      const buildingId = parseInt(homey.settings.get('building_id') || '0');

      if (!deviceId || !buildingId) {
        return {
          success: false,
          error: 'Device ID or Building ID not set in settings'
        };
      }

      try {
        // Get weekly COP data from MELCloud
        const melCloudService = requireMelCloud();
        const weeklyData = await melCloudService.getWeeklyAverageCOP(deviceId, buildingId);

        // Check if we have a COP helper instance
        if (!global.copHelper) {
          homey.app.log('COP Helper not initialized, creating instance');

          // Import the COPHelper class
          const { COPHelper } = require('./src/services/cop-helper');

          // Create a new instance
          global.copHelper = new COPHelper(homey, homey.app);
          homey.app.log('COP Helper initialized');
        }

        // Get weekly average COP from the helper
        const copHelperInstance = global.copHelper!;
        const heatingCOP = await copHelperInstance.getAverageCOP('weekly', 'heat');
        const hotWaterCOP = await copHelperInstance.getAverageCOP('weekly', 'water');

        return {
          success: true,
          melcloud: weeklyData,
          helper: {
            heating: heatingCOP,
            hotWater: hotWaterCOP
          }
        };
      } catch (error: any) {
        homey.app.error('Error getting weekly average COP:', error);
        return {
          success: false,
          error: error.message
        };
      }
    } catch (err: any) {
      console.error('Error in getWeeklyAverageCOP:', err);
      return { success: false, error: err.message };
    }
  },

  getMelCloudStatus: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getMelCloudStatus called');
      homey.app.log('API method getMelCloudStatus called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        return {
          connected: false,
          error: `Failed to initialize services: ${initErr.message}`,
          needsConfiguration: true
        };
      }

      try {
        const activeMelCloud = melCloud;

        // Check if MELCloud is initialized
        if (!activeMelCloud) {
          homey.app.log('MELCloud API not initialized');
          return {
            connected: false,
            error: 'MELCloud API not initialized'
          };
        }

        const melCloudInternal = activeMelCloud as unknown as { contextKey?: string | null };

        // Check if we have a context key (logged in)
        if (!melCloudInternal.contextKey) {
          homey.app.log('MELCloud API not logged in');

          // Try to login
          try {
            const melcloudUser = homey.settings.get('melcloud_user');
            const melcloudPass = homey.settings.get('melcloud_pass');

            if (!melcloudUser || !melcloudPass) {
              return {
                connected: false,
                error: 'MELCloud credentials not available'
              };
            }

            const loginSuccess = await activeMelCloud.login(melcloudUser, melcloudPass);

            if (loginSuccess) {
              homey.app.log('Successfully reconnected to MELCloud');
              return {
                connected: true,
                reconnected: true
              };
            } else {
              return {
                connected: false,
                error: 'Failed to reconnect to MELCloud'
              };
            }
          } catch (loginError: any) {
            homey.app.error('Error reconnecting to MELCloud:', loginError);
            return {
              connected: false,
              error: `Failed to reconnect: ${loginError.message}`
            };
          }
        }

        // Try to get devices as a connection test
        try {
          const devices = await activeMelCloud.getDevices();
          return {
            connected: true,
            devices: devices.length
          };
        } catch (deviceError: any) {
          homey.app.error('Error getting MELCloud devices:', deviceError);
          return {
            connected: false,
            error: `Failed to get devices: ${deviceError.message}`
          };
        }
      } catch (error: any) {
        homey.app.error('Error checking MELCloud status:', error);
        return {
          connected: false,
          error: error.message
        };
      }
    } catch (err: any) {
      console.error('Error in getMelCloudStatus:', err);
      return { connected: false, error: err.message };
    }
  },

  getTibberStatus: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getTibberStatus called');
      homey.app.log('API method getTibberStatus called');

      // Initialize services if needed
      try {
        await initializeServices(homey);
      } catch (initErr: any) {
        return {
          connected: false,
          error: `Failed to initialize services: ${initErr.message}`,
          needsConfiguration: true
        };
      }

      try {
        const activeTibber = tibber;
        // Check if Tibber is initialized
        if (!activeTibber) {
          homey.app.log('Tibber API not initialized');
          return {
            connected: false,
            error: 'Tibber API not initialized'
          };
        }

        // Try to get prices as a connection test
        try {
          const prices = await activeTibber.getPrices();
          return {
            connected: true,
            pricePoints: prices.prices.length
          };
        } catch (priceError: any) {
          homey.app.error('Error getting Tibber prices:', priceError);
          return {
            connected: false,
            error: `Failed to get prices: ${priceError.message}`
          };
        }
      } catch (error: any) {
        homey.app.error('Error checking Tibber status:', error);
        return {
          connected: false,
          error: error.message
        };
      }
    } catch (err: any) {
      console.error('Error in getTibberStatus:', err);
      return { connected: false, error: err.message };
    }
  },

  getTibberHomes: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getTibberHomes called');
      homey.app.log('API method getTibberHomes called');

      // Get the Tibber token from settings
      const tibberToken = homey.settings.get('tibber_token') || homey.settings.get('tibberToken');
      if (!tibberToken) {
        return {
          success: false,
          error: 'Tibber API token not configured',
          homes: []
        };
      }

      try {
        // Create a temporary TibberApi instance to fetch homes
        // Use app logger if available for consistent logging
        const { TibberApi } = require('./src/services/tibber-api');
        const appLogger = (homey.app as any)?.logger;
        const tibberLogger = (appLogger && typeof appLogger.api === 'function') ? appLogger : undefined;
        const tempTibber = new TibberApi(tibberToken, tibberLogger);
        const homes = await tempTibber.getHomes();

        // Get the currently selected home ID
        const selectedHomeId = homey.settings.get('tibber_home_id') || null;

        // Format homes for the dropdown
        const formattedHomes = homes.map((home: any) => {
          let displayName = home.appNickname || 'Unnamed Home';
          if (home.address) {
            const addressParts = [
              home.address.address1,
              home.address.city,
              home.address.postalCode
            ].filter(Boolean);
            if (addressParts.length > 0) {
              displayName += ` (${addressParts.join(', ')})`;
            }
          }
          return {
            id: home.id,
            name: displayName,
            selected: home.id === selectedHomeId
          };
        });

        homey.app.log(`Found ${formattedHomes.length} Tibber home(s)`);

        return {
          success: true,
          homes: formattedHomes,
          selectedHomeId
        };
      } catch (error: any) {
        homey.app.error('Error fetching Tibber homes:', error);
        return {
          success: false,
          error: error.message || 'Failed to fetch Tibber homes',
          homes: []
        };
      }
    } catch (err: any) {
      console.error('Error in getTibberHomes:', err);
      return { success: false, error: err.message, homes: [] };
    }
  },

  runSystemHealthCheck: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method runSystemHealthCheck called');
      homey.app.log('API method runSystemHealthCheck called');

      try {
        // Call the app's health check method if available
        if (typeof homey.app.runSystemHealthCheck === 'function') {
          return await homey.app.runSystemHealthCheck();
        }
        return {
          healthy: false,
          issues: ['Health check not available in this runtime'],
          recovered: false
        };
      } catch (error: any) {
        homey.app.error('Error running system health check:', error);
        return {
          healthy: false,
          issues: [`Error running health check: ${error.message}`],
          recovered: false
        };
      }
    } catch (err: any) {
      console.error('Error in runSystemHealthCheck:', err);
      return {
        healthy: false,
        issues: [`API error: ${err.message}`],
        recovered: false
      };
    }
  },

  runThermalDataCleanup: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method runThermalDataCleanup called');
      homey.app.log('API method runThermalDataCleanup called');

      try {
        // Initialize services if needed
        await initializeServices(homey);

        // Run thermal data cleanup if available
        if (optimizer && typeof optimizer.forceThermalDataCleanup === 'function') {
          const cleanupResult = optimizer.forceThermalDataCleanup();
          if (cleanupResult && typeof (cleanupResult as { success?: unknown }).success === 'boolean') {
            return cleanupResult as RunThermalDataCleanupResponse;
          }
          return {
            success: true,
            ...(cleanupResult as Record<string, unknown>)
          } as RunThermalDataCleanupResponse;
        } else {
          return {
            success: false,
            message: 'Thermal model service not available'
          };
        }
      } catch (error: any) {
        homey.app.error('Error running thermal data cleanup:', error);
        return {
          success: false,
          message: `Error running thermal data cleanup: ${error.message}`
        };
      }
    } catch (err: any) {
      console.error('Error in runThermalDataCleanup:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Cleanup all API resources to prevent memory leaks
   * Should be called when the app is shutting down
   */
  // Private cleanup (not exposed as HTTP endpoint)
  internalCleanup: async ({ homey }: ApiHandlerContext) => {
    try {
      homey.app.log('Starting API resources cleanup...');

      // Clean up optimizer (which includes thermal model service)
      if (global.optimizer && typeof global.optimizer.cleanup === 'function') {
        try {
          global.optimizer.cleanup();
          homey.app.log('Optimizer resources cleaned up');
        } catch (optimizerError: any) {
          homey.app.error('Error cleaning up optimizer:', optimizerError);
        }
      }

      // Clean up MELCloud API
      if (global.melCloud && typeof global.melCloud.cleanup === 'function') {
        try {
          global.melCloud.cleanup();
          homey.app.log('MELCloud API resources cleaned up');
        } catch (melCloudError: any) {
          homey.app.error('Error cleaning up MELCloud API:', melCloudError);
        }
      }

      // Clean up price provider
      if (global.tibber && typeof global.tibber.cleanup === 'function') {
        try {
          global.tibber.cleanup();
          homey.app.log('Price provider resources cleaned up');
        } catch (tibberError: any) {
          homey.app.error('Error cleaning up price provider:', tibberError);
        }
      }

      // Clean up COP Helper (best-effort – helper may not expose cleanup)
      const copHelperInstance = global.copHelper as unknown as { cleanup?: () => void } | null;
      if (copHelperInstance?.cleanup) {
        try {
          copHelperInstance.cleanup();
          homey.app.log('COP Helper resources cleaned up');
        } catch (copError: any) {
          homey.app.error('Error cleaning up COP Helper:', copError);
        }
      }

      // Clear global references
      global.optimizer = null;
      global.melCloud = null;
      global.tibber = null;
      global.copHelper = null;

      homey.app.log('All API resources cleaned up successfully');
      return {
        success: true,
        message: 'All resources cleaned up successfully'
      };

    } catch (error: any) {
      homey.app.error('Error during API cleanup:', error);
      return {
        success: false,
        error: error.message
      };
    }
  },

  'hot-water': {
    'reset-patterns': async ({ homey }: ApiHandlerContext): Promise<HotWaterResponse> => {
      homey.app.log('API method hot-water/reset-patterns called');
      const service = getHotWaterService(homey);
      if (!service) {
        return {
          success: false,
          message: 'Hot water service not available'
        };
      }

      try {
        service.resetPatterns();
        return {
          success: true,
          message: 'Hot water usage patterns have been reset to defaults.'
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        homey.app.error('Error resetting hot water patterns:', error);
        return {
          success: false,
          message: `Error resetting hot water usage patterns: ${message}`
        };
      }
    },

    'clear-data': async ({ homey, body }: ApiHandlerContext): Promise<HotWaterResponse> => {
      homey.app.log('API method hot-water/clear-data called');
      const service = getHotWaterService(homey);
      if (!service) {
        return {
          success: false,
          message: 'Hot water service not available'
        };
      }

      const payload = (body ?? {}) as HotWaterClearRequest;
      const clearAggregated = payload.clearAggregated === undefined
        ? true
        : Boolean(payload.clearAggregated);

      try {
        await service.clearData(clearAggregated);
        const suffix = clearAggregated
          ? ' including aggregated data.'
          : ' while keeping aggregated data.';
        return {
          success: true,
          message: `Hot water usage data has been cleared${suffix}`
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        homey.app.error('Error clearing hot water data:', error);
        return {
          success: false,
          message: `Error clearing hot water usage data: ${message}`
        };
      }
    }
  },

  validateAndStartCron: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method validateAndStartCron called');
      homey.app.log('API method validateAndStartCron called');

      try {
        // Validate required settings using the same logic as other API endpoints
        const melcloudUser = homey.settings.get('melcloud_user');
        const melcloudPass = homey.settings.get('melcloud_pass');
        const tibberToken = homey.settings.get('tibber_token');
        const deviceId = homey.settings.get('device_id');
        const priceDataSource = homey.settings.get('price_data_source') || 'entsoe';

        // Check for missing required settings
        const missingSettings = [];
        if (!melcloudUser) missingSettings.push('MELCloud email');
        if (!melcloudPass) missingSettings.push('MELCloud password');

        // Only require Tibber token if Tibber is selected as price source
        if (priceDataSource === 'tibber' && !tibberToken) {
          missingSettings.push('Tibber API token');
        }

        if (!deviceId) missingSettings.push('Device ID');

        const isValid = missingSettings.length === 0;

        if (isValid) {
          // Refresh the price provider to pick up any changed settings (e.g., tibber_home_id)
          try {
            await updatePriceProvider(homey);
            homey.app.log('✅ Price provider refreshed with current settings');
          } catch (priceError: any) {
            homey.app.log('Warning: Could not refresh price provider:', priceError.message);
          }

          // Try to get the driver instances and restart cron jobs
          try {
            const driverManager = (homey.drivers && typeof homey.drivers.getDriver === 'function')
              ? homey.drivers.getDriver('boiler')
              : null;

            if (driverManager && typeof driverManager.restartCronJobs === 'function') {
              await driverManager.restartCronJobs();
              homey.app.log('✅ Settings valid, cron jobs restarted');
            } else {
              homey.app.log('✅ Settings valid, but driver restart not available');
            }
          } catch (driverError: any) {
            homey.app.log('Settings valid, but could not restart cron jobs:', driverError.message);
          }

          return {
            success: true,
            cronRunning: true,
            message: 'Settings validated successfully, optimization started'
          };
        } else {
          homey.app.log('⚠️ Settings validation failed, missing:', missingSettings.join(', '));
          return {
            success: true,
            cronRunning: false,
            message: `Please complete required settings: ${missingSettings.join(', ')}`
          };
        }
      } catch (error: any) {
        homey.app.error('Error validating settings and managing cron jobs:', error);
        return {
          success: false,
          error: `Validation error: ${error.message}`
        };
      }
    } catch (err: any) {
      console.error('Error in validateAndStartCron:', err);
      return { success: false, error: err.message };
    }
  },

  getModelConfidence: async ({ homey }: ApiHandlerContext) => {
    try {
      console.log('API method getModelConfidence called');
      homey.app.log('API method getModelConfidence called');
      let lastDecision: OptimizationDecision | null = null;
      let latestHistoricalEntry: any = null;

      // Read thermal characteristics from settings
      const thermalCharacteristicsKey = 'thermal_model_characteristics';
      const thermalCharacteristicsRaw = homey.settings.get(thermalCharacteristicsKey);
      let thermalModel = {
        confidence: null as number | null,
        heatingRate: null as number | null,
        coolingRate: null as number | null,
        thermalMass: null as number | null,
        lastUpdated: null as string | null
      };

      if (thermalCharacteristicsRaw) {
        try {
          const parsed = typeof thermalCharacteristicsRaw === 'string'
            ? JSON.parse(thermalCharacteristicsRaw)
            : thermalCharacteristicsRaw;

          thermalModel = {
            confidence: parsed.modelConfidence ?? null,
            heatingRate: parsed.heatingRate ?? null,
            coolingRate: parsed.coolingRate ?? null,
            thermalMass: parsed.thermalMass ?? null,
            lastUpdated: parsed.lastUpdated ?? null
          };
        } catch (parseErr) {
          homey.app.error('Failed to parse thermal characteristics:', parseErr);
        }
      }

      // Read adaptive parameters from settings
      const adaptiveParametersKey = 'adaptive_business_parameters';
      const adaptiveParametersRaw = homey.settings.get(adaptiveParametersKey);
      let adaptiveParameters = {
        learningCycles: null as number | null,
        confidence: null as number | null,
        lastUpdated: null as string | null,
        // Diagnostics: the seasonal price weights are clamped to [0.2, 0.9] and are driven down
        // by comfort violations. Surfacing them makes drift toward the 0.2 floor observable
        // instead of something that has to be inferred.
        priceWeightSummer: null as number | null,
        priceWeightWinter: null as number | null,
        priceWeightTransition: null as number | null,
        preheatAggressiveness: null as number | null,
        coastingReduction: null as number | null
      };

      if (adaptiveParametersRaw) {
        try {
          const parsed = typeof adaptiveParametersRaw === 'string'
            ? JSON.parse(adaptiveParametersRaw)
            : adaptiveParametersRaw;

          adaptiveParameters = {
            learningCycles: parsed.learningCycles ?? null,
            confidence: parsed.confidence ?? null,
            lastUpdated: parsed.lastUpdated ?? null,
            priceWeightSummer: parsed.priceWeightSummer ?? null,
            priceWeightWinter: parsed.priceWeightWinter ?? null,
            priceWeightTransition: parsed.priceWeightTransition ?? null,
            preheatAggressiveness: parsed.preheatAggressiveness ?? null,
            coastingReduction: parsed.coastingReduction ?? null
          };
        } catch (parseErr) {
          homey.app.error('Failed to parse adaptive parameters:', parseErr);
        }
      }

      // Read thermal model data for retention statistics
      const thermalDataKey = 'thermal_model_data';
      const thermalAggKey = 'thermal_model_aggregated_data';
      const thermalDataRaw = homey.settings.get(thermalDataKey);
      const thermalAggRaw = homey.settings.get(thermalAggKey);

      let dataRetention = {
        thermalRawPoints: 0,
        thermalAggPoints: 0,
        rawKB: 0,
        aggKB: 0
      };

      if (thermalDataRaw) {
        try {
          const dataStr = typeof thermalDataRaw === 'string' ? thermalDataRaw : JSON.stringify(thermalDataRaw);
          const dataParsed = typeof thermalDataRaw === 'string' ? JSON.parse(thermalDataRaw) : thermalDataRaw;
          dataRetention.thermalRawPoints = Array.isArray(dataParsed) ? dataParsed.length : 0;
          dataRetention.rawKB = Math.round((dataStr.length / 1024) * 100) / 100;
        } catch (parseErr) {
          homey.app.error('Failed to parse thermal data:', parseErr);
        }
      }

      if (thermalAggRaw) {
        try {
          const aggStr = typeof thermalAggRaw === 'string' ? thermalAggRaw : JSON.stringify(thermalAggRaw);
          const aggParsed = typeof thermalAggRaw === 'string' ? JSON.parse(thermalAggRaw) : thermalAggRaw;
          dataRetention.thermalAggPoints = Array.isArray(aggParsed) ? aggParsed.length : 0;
          dataRetention.aggKB = Math.round((aggStr.length / 1024) * 100) / 100;
        } catch (parseErr) {
          homey.app.error('Failed to parse thermal aggregated data:', parseErr);
        }
      }

      // Read hot water usage patterns for learning overview
      const hotWaterPatternsKey = 'hot_water_usage_patterns';
      const hotWaterPatternsRaw = homey.settings.get(hotWaterPatternsKey);
      let hotWaterPatterns = {
        confidence: null as number | null,
        hourlyUsagePattern: null as number[] | null,
        lastUpdated: null as string | null
      };

      if (hotWaterPatternsRaw) {
        try {
          const parsed = typeof hotWaterPatternsRaw === 'string'
            ? JSON.parse(hotWaterPatternsRaw)
            : hotWaterPatternsRaw;

          hotWaterPatterns = {
            confidence: parsed.confidence ?? null,
            hourlyUsagePattern: parsed.hourlyUsagePattern ?? null,
            lastUpdated: parsed.lastUpdated ?? null
          };
        } catch (parseErr) {
          homey.app.error('Failed to parse hot water patterns:', parseErr);
        }
      }

      // Read orchestrator metrics and savings history
      const metricsKey = 'orchestrator_metrics';
      const metricsRaw = homey.settings.get(metricsKey);
      const savingsHistoryRaw = homey.settings.get('savings_history');
      const displaySavingsHistoryRaw = homey.settings.get('display_savings_history');
      const currency = homey.settings.get('currency') || homey.settings.get('currency_code') || 'EUR';
      const currencySymbol = homey.settings.get('currency_symbol') || currency;

      let savingsMetrics = {
        totalSavings: null as number | null,
        averageDailySavings: null as number | null,
        todaySavings: null as number | null,
        last7DaysSavings: null as number | null,
        projectedDailySavings: null as number | null
      };

      // Get currency decimals helper
      const getCurrencyDecimals = (curr: string): number => {
        const code = (curr || 'EUR').toUpperCase();
        if (['JPY', 'KRW'].includes(code)) return 0;
        if (['BHD', 'KWD', 'OMR'].includes(code)) return 3;
        return 2;
      };

      const minorToMajor = (minor: number, decimals: number): number => {
        const divisor = Math.pow(10, decimals);
        return minor / divisor;
      };

      const decimals = getCurrencyDecimals(currency);

      // Process orchestrator metrics
      if (metricsRaw) {
        try {
          const parsed = typeof metricsRaw === 'string'
            ? JSON.parse(metricsRaw)
            : metricsRaw;

          if (parsed.totalSavings !== undefined) {
            savingsMetrics.totalSavings = parsed.totalSavings;
          }

          // Check for projected daily savings
          if (parsed.projectedDailySavings !== undefined) {
            savingsMetrics.projectedDailySavings = parsed.projectedDailySavings;
          }
        } catch (parseErr) {
          homey.app.error('Failed to parse savings metrics:', parseErr);
        }
      }

      // Process savings history for today and last 7 days
      if (savingsHistoryRaw && Array.isArray(savingsHistoryRaw)) {
        try {
          const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD format
          const todayDate = new Date(`${today}T00:00:00`);
          const last7Cutoff = new Date(todayDate);
          last7Cutoff.setDate(todayDate.getDate() - 6); // 7-day window including today

          // Calculate today's savings
          const todayEntry = savingsHistoryRaw.find((h: any) => h.date === today);
          if (todayEntry) {
            if (todayEntry.totalMinor !== undefined) {
              const entryDecimals = todayEntry.decimals ?? decimals;
              savingsMetrics.todaySavings = minorToMajor(todayEntry.totalMinor, entryDecimals);
            } else if (todayEntry.total !== undefined) {
              savingsMetrics.todaySavings = Number(todayEntry.total);
            }
          }

          // Calculate last 7 days total
          let last7TotalMinor = 0;
          for (const entry of savingsHistoryRaw) {
            if (entry && entry.date) {
              const entryDate = new Date(`${entry.date}T00:00:00`);
              if (entryDate >= last7Cutoff && entryDate <= todayDate) {
                if (entry.totalMinor !== undefined) {
                  last7TotalMinor += entry.totalMinor;
                } else if (entry.total !== undefined) {
                  // Legacy format - convert to minor
                  const entryDecimals = entry.decimals ?? decimals;
                  last7TotalMinor += Math.round(entry.total * Math.pow(10, entryDecimals));
                }
              }
            }
          }

          if (last7TotalMinor > 0) {
            savingsMetrics.last7DaysSavings = minorToMajor(last7TotalMinor, decimals);
          }

          // Calculate average daily savings from last 7 days
          if (savingsMetrics.last7DaysSavings !== null) {
            const daysWithData = savingsHistoryRaw.filter((h: any) => {
              if (!h || !h.date) return false;
              const entryDate = new Date(`${h.date}T00:00:00`);
              return entryDate >= last7Cutoff && entryDate <= todayDate && (h.totalMinor > 0 || h.total > 0);
            }).length;

            if (daysWithData > 0) {
              savingsMetrics.averageDailySavings = savingsMetrics.last7DaysSavings / daysWithData;
            }
          }
        } catch (parseErr) {
          homey.app.error('Failed to parse savings history:', parseErr);
        }
      }

      const smartSavingsDisplay: {
        currency: string;
        currencySymbol: string;
        decimals: number;
        today: number | null;
        last7: number | null;
        projection: number | null;
        seasonMode: string | null;
        history: Array<{
          date: string;
          valueMajor: number | null;
          baselineMajor: number | null;
          optimizedMajor: number | null;
          seasonMode: string | null;
          decimals: number;
          updatedAt?: string;
        }>;
      } = {
        currency,
        currencySymbol,
        decimals,
        today: null,
        last7: null,
        projection: null,
        seasonMode: null,
        history: []
      };

      if (displaySavingsHistoryRaw && Array.isArray(displaySavingsHistoryRaw)) {
        try {
          const todayIso = new Date().toISOString().slice(0, 10);
          const todayMidnight = new Date(`${todayIso}T00:00:00`);
          const last7Cutoff = new Date(todayMidnight);
          last7Cutoff.setDate(todayMidnight.getDate() - 6);

          const entries = displaySavingsHistoryRaw
            .filter((entry: any) => entry && typeof entry.date === 'string')
            .slice()
            .sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

          const historyEntries: Array<{
            date: string;
            valueMajor: number | null;
            baselineMajor: number | null;
            optimizedMajor: number | null;
            seasonMode: string | null;
            decimals: number;
            updatedAt?: string;
          }> = [];

          let last7Total = 0;
          let last7Days = 0;
          for (const entry of entries) {
            if (!entry || !entry.date) continue;
            const entryDate = new Date(`${entry.date}T00:00:00`);
            const entryDecimals = entry.decimals ?? decimals;
            const baselineMinor = Number(entry.baselineMinor);
            const optimizedMinor = Number(entry.optimizedMinor);
            let baselineMajor: number | null = null;
            let optimizedMajor: number | null = null;
            let valueMajor: number | null = null;

            if (Number.isFinite(baselineMinor) && Number.isFinite(optimizedMinor)) {
              baselineMajor = Number(minorToMajor(Math.max(0, baselineMinor), entryDecimals).toFixed(entryDecimals));
              optimizedMajor = Number(minorToMajor(Math.max(0, optimizedMinor), entryDecimals).toFixed(entryDecimals));
              const savingsMinor = Math.max(0, baselineMinor - optimizedMinor);
              valueMajor = Number(minorToMajor(savingsMinor, entryDecimals).toFixed(entryDecimals));
            } else if (typeof entry.valueMajor === 'number') {
              valueMajor = Number(entry.valueMajor);
            } else if (typeof entry.value === 'number') {
              valueMajor = Number(entry.value);
            }

            if (typeof valueMajor === 'number') {
              historyEntries.push({
                date: entry.date,
                valueMajor,
                baselineMajor,
                optimizedMajor,
                seasonMode: typeof entry.seasonMode === 'string' ? entry.seasonMode : null,
                decimals: entryDecimals,
                updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined
              });
            }

            if (entryDate < last7Cutoff || entryDate > todayMidnight) continue;
            if (typeof valueMajor === 'number') {
              last7Total += valueMajor;
              last7Days += 1;
            }
          }

          smartSavingsDisplay.history = historyEntries;

          const todayHistory = historyEntries.find(entry => entry.date === todayIso);
          if (todayHistory) {
            if (typeof todayHistory.valueMajor === 'number') {
              // Prefer optimized/standard savings over baseline deltas when both are present
              const optimizedValue = typeof todayHistory.optimizedMajor === 'number' ? todayHistory.optimizedMajor : todayHistory.valueMajor;
              smartSavingsDisplay.today = optimizedValue;
            }
            if (todayHistory.seasonMode) {
              smartSavingsDisplay.seasonMode = todayHistory.seasonMode;
            }
          }

          if (last7Days > 0) {
            smartSavingsDisplay.last7 = Number(last7Total.toFixed(decimals));
            const avgDaily = last7Total / last7Days;
            const projectionMonthly = avgDaily * 30;
            if (!Number.isNaN(projectionMonthly)) {
              smartSavingsDisplay.projection = Number(projectionMonthly.toFixed(decimals));
            }
          } else if (smartSavingsDisplay.today !== null) {
            const projectionMonthly = smartSavingsDisplay.today * 30;
            if (!Number.isNaN(projectionMonthly)) {
              smartSavingsDisplay.projection = Number(projectionMonthly.toFixed(decimals));
            }
          }

          if (!smartSavingsDisplay.seasonMode && entries.length > 0) {
            const latest = entries[entries.length - 1];
            if (latest?.seasonMode && typeof latest.seasonMode === 'string') {
              smartSavingsDisplay.seasonMode = latest.seasonMode;
            }
          }
        } catch (displayErr) {
          homey.app.error('Failed to parse display savings history:', displayErr);
        }
      }

      // Calculate baseline savings comparison (read-only, UI display only)
      let baselineSavings = null;
      let enhancedSavings: any = null;
      let seasonalMode: string | null = null;

      try {
        // Get optimizer instance from service manager for read-only calculation
        const serviceState = getServiceState();
        const optimizer = serviceState?.optimizer;

        // Run baseline calculation if we have any savings data (even if negative)
        // Also run if we have recent optimization data, even without savings history yet
        const hasSavingsData = savingsMetrics.todaySavings !== null && Math.abs(savingsMetrics.todaySavings) > 0.001;
        const hasRecentData = homey.settings.get('melcloud_historical_data')?.length > 0;

        if (optimizer && (hasSavingsData || hasRecentData)) {
          // Get actual consumption estimate (use today's savings as proxy for cost delta)
          // This is a read-only calculation, doesn't affect storage
          const actualCost = hasSavingsData ? Math.abs(savingsMetrics.todaySavings!) : 5.0; // Default 5 SEK if no savings yet
          const actualConsumptionKWh = actualCost / 1.5; // Rough estimate: ~1.5 SEK/kWh average

          // Get historical optimizations for context (read-only)
          const historicalData = homey.settings.get('melcloud_historical_data');
          let historicalOptimizations: any[] = [];
          if (historicalData && Array.isArray(historicalData)) {
            const today = new Date().toISOString().slice(0, 10);
            historicalOptimizations = historicalData
              .filter((h: any) => h && h.timestamp && h.timestamp.startsWith(today))
              .slice(0, 24); // Max 24 hours
          }

          // Calculate enhanced savings with baseline comparison (READ-ONLY)
          const currentHourSavings = hasSavingsData ? savingsMetrics.todaySavings! : 0;
          const result = await optimizer.getSavingsService().calculateEnhancedDailySavingsWithBaseline(
            currentHourSavings,
            historicalOptimizations,
            actualConsumptionKWh,
            0, // actualCost - set to 0 to get full baseline cost as savings potential
            true // enable baseline
          );

          if (result && result.baselineComparison) {
            enhancedSavings = {
              baselineSavings: result.baselineComparison.baselineSavings,
              baselinePercentage: result.baselineComparison.baselinePercentage,
              projectedSavings: result.projectedSavings,
              confidence: result.baselineComparison.confidenceLevel,
              method: result.baselineComparison.method,
              breakdown: result.baselineComparison.breakdown
            };

            baselineSavings = {
              todayVsBaseline: result.baselineComparison.baselineSavings,
              percentageSaved: result.baselineComparison.baselinePercentage,
              confidence: result.baselineComparison.confidenceLevel,
              projectedMonthly: result.projectedSavings * 30
            };
          };

          // NOTE: Do NOT override smartSavingsDisplay.today here!
          // The value was already correctly set from display_savings_history,
          // which contains finalDailySavings computed in getRunHourlyOptimizer.
          // This ensures timeline and widget show the same number.
          // 
          // Only update projection if we don't have one yet from history
          if (smartSavingsDisplay.projection === null && enhancedSavings?.baselineSavings !== undefined) {
            const decimals = smartSavingsDisplay.decimals || 2;
            smartSavingsDisplay.projection = Number((enhancedSavings.baselineSavings * 30).toFixed(decimals));
            homey.app.log(`[getModelConfidence] Set projection from baseline (no history): ${smartSavingsDisplay.projection}`);
          }
        }

        // Get seasonal mode (read-only)
        const summerMode = homey.settings.get('summer_mode');
        const autoSeasonalMode = homey.settings.get('auto_seasonal_mode');
        if (autoSeasonalMode && serviceState?.weather) {
          try {
            const weather = await serviceState.weather.getCurrentWeather();
            if (weather && weather.temperature !== undefined && weather.temperature !== null) {
              const temp = weather.temperature;
              if (temp > 15) {
                seasonalMode = 'summer';
              } else if (temp > 5) {
                seasonalMode = 'transition';
              } else {
                seasonalMode = 'winter';
              }
            }
          } catch (weatherErr) {
            homey.app.error('Error getting weather for seasonal mode:', weatherErr);
          }
        } else if (summerMode) {
          seasonalMode = 'summer';
        } else {
          seasonalMode = 'winter'; // Default assumption
        }
      } catch (baselineErr) {
        homey.app.error('Error calculating baseline savings (non-critical):', baselineErr);
        // Continue without baseline data - graceful degradation
      }

      // Build price data for currency context
      const priceData = {
        currencySymbol: currencySymbol,
        currency: currency
      };

      // Calculate average price from last 7 days of historical optimization data
      let averageSpotPrice: number | null = null;
      let priceDataPoints = 0;
      try {
        homey.app.log('[getModelConfidence] Starting average price calculation...');
        // Read from the correct storage key used by the optimizer
        const optimizerData = homey.settings.get('optimizer_historical_data');
        const historicalData = optimizerData?.optimizations || null;
        homey.app.log(`[getModelConfidence] Optimizer data exists: ${!!optimizerData}, optimizations array: ${Array.isArray(historicalData)}, length: ${Array.isArray(historicalData) ? historicalData.length : 'N/A'}`);

        // Log a sample of historical data entries for debugging
        if (historicalData && Array.isArray(historicalData) && historicalData.length > 0) {
          latestHistoricalEntry = historicalData[historicalData.length - 1];
          homey.app.log(`[getModelConfidence] Sample historical entries (first 3):`);
          historicalData.slice(0, 3).forEach((entry: any, idx: number) => {
            homey.app.log(`[getModelConfidence]   [${idx}] timestamp: ${entry?.timestamp || 'missing'}, priceNow: ${entry?.priceNow || 'missing'}, targetTemp: ${entry?.targetTemp || 'N/A'}`);
          });
          if (historicalData.length > 3) {
            homey.app.log(`[getModelConfidence]   ... and ${historicalData.length - 3} more entries`);
          }
        }

        let needsFallback = false;

        if (historicalData && Array.isArray(historicalData) && historicalData.length > 0) {
          const now = new Date();
          const last7Days = new Date(now);
          last7Days.setDate(now.getDate() - 7);

          homey.app.log(`[getModelConfidence] Date range: ${last7Days.toISOString()} to ${now.toISOString()}`);

          // Filter to last 7 days and extract valid prices
          const recentEntries = historicalData.filter((entry: any) => {
            if (!entry || !entry.timestamp) return false;
            const entryDate = new Date(entry.timestamp);
            return entryDate >= last7Days && entryDate <= now;
          });

          homey.app.log(`[getModelConfidence] Recent entries in last 7 days: ${recentEntries.length}`);

          const recentPrices = recentEntries
            .map((entry: any) => {
              const price = Number(entry.priceNow);
              if (!Number.isFinite(price) || price <= 0) {
                homey.app.log(`[getModelConfidence] Invalid price in entry: ${JSON.stringify(entry).substring(0, 200)}`);
              }
              return price;
            })
            .filter((price: number) => Number.isFinite(price) && price > 0);

          priceDataPoints = recentPrices.length;

          homey.app.log(`[getModelConfidence] Valid price data points: ${priceDataPoints}`);
          if (recentPrices.length > 0 && recentPrices.length <= 10) {
            homey.app.log(`[getModelConfidence] Sample prices: ${recentPrices.slice(0, 5).map(p => p.toFixed(4)).join(', ')}`);
          }

          if (recentPrices.length > 0) {
            const sum = recentPrices.reduce((acc: number, price: number) => acc + price, 0);
            averageSpotPrice = sum / recentPrices.length;
            homey.app.log(`[getModelConfidence] ✅ Calculated 7-day average spot price: ${averageSpotPrice.toFixed(4)} ${currency}/kWh from ${priceDataPoints} data points`);
          } else {
            homey.app.log('[getModelConfidence] ⚠️ No valid price data in last 7 days, will try fallback');
            needsFallback = true;
          }
        } else {
          homey.app.log('[getModelConfidence] ❌ No historical data available, will try fallback');
          needsFallback = true;
        }

        // Try fallback if no historical data was usable
        if (needsFallback) {
          homey.app.log('[getModelConfidence] Attempting fallback to current prices...');
          try {
            const serviceState = getServiceState();
            homey.app.log(`[getModelConfidence] Service state exists: ${!!serviceState}, tibber exists: ${!!serviceState?.tibber}`);
            const priceProvider = serviceState?.tibber;

            if (priceProvider) {
              homey.app.log('[getModelConfidence] Fetching current prices from provider...');
              const priceInfo = await priceProvider.getPrices();
              homey.app.log(`[getModelConfidence] Price info received, prices array length: ${Array.isArray(priceInfo?.prices) ? priceInfo.prices.length : 'N/A'}`);

              if (priceInfo && Array.isArray(priceInfo.prices) && priceInfo.prices.length > 0) {
                const validPrices = priceInfo.prices
                  .map((p: any) => Number(p.price))
                  .filter((price: number) => Number.isFinite(price) && price > 0);

                homey.app.log(`[getModelConfidence] Valid current prices: ${validPrices.length}`);

                if (validPrices.length > 0) {
                  const sum = validPrices.reduce((acc: number, price: number) => acc + price, 0);
                  averageSpotPrice = sum / validPrices.length;
                  priceDataPoints = validPrices.length;
                  homey.app.log(`[getModelConfidence] ✅ Fallback successful: ${averageSpotPrice.toFixed(4)} ${currency}/kWh from ${priceDataPoints} current/future prices`);
                } else {
                  homey.app.log('[getModelConfidence] ❌ No valid prices in current data');
                }
              } else {
                homey.app.log('[getModelConfidence] ❌ Price info empty or invalid');
              }
            } else {
              homey.app.log('[getModelConfidence] ❌ No price provider available');
            }
          } catch (fallbackErr) {
            homey.app.error('[getModelConfidence] ❌ Fallback price fetch failed:', fallbackErr);
          }
        }
      } catch (priceErr) {
        homey.app.error('[getModelConfidence] ❌ Error calculating average price:', priceErr);
        // Continue without average price data - graceful degradation
      }

      if (!smartSavingsDisplay.seasonMode) {
        smartSavingsDisplay.seasonMode = seasonalMode;
      }

      homey.app.log(`[getModelConfidence] 📊 Final result summary:`);
      homey.app.log(`[getModelConfidence]   - Currency: ${currency} (${currencySymbol})`);
      homey.app.log(`[getModelConfidence]   - Average spot price: ${averageSpotPrice !== null ? averageSpotPrice.toFixed(4) : 'null'} ${currency}/kWh`);
      homey.app.log(`[getModelConfidence]   - Price data points: ${priceDataPoints}`);
      homey.app.log(`[getModelConfidence]   - Today's savings: ${smartSavingsDisplay.today !== null ? smartSavingsDisplay.today.toFixed(2) : 'null'}`);
      homey.app.log(`[getModelConfidence]   - Last 7 days savings: ${smartSavingsDisplay.last7 !== null ? smartSavingsDisplay.last7.toFixed(2) : 'null'}`);
      homey.app.log(`[getModelConfidence]   - Seasonal mode: ${smartSavingsDisplay.seasonMode || 'null'}`);
      homey.app.log(`[getModelConfidence]   - Thermal confidence: ${thermalModel.confidence !== null ? (thermalModel.confidence * 100).toFixed(0) + '%' : 'null'}`);

      try {
        const stored = homey.settings.get('last_decision');
        if (stored && typeof stored === 'object' && stored.code) {
          lastDecision = stored as OptimizationDecision;
        }
      } catch (decErr) {
        homey.app.error('Error reading last_decision from settings:', decErr);
      }

      if (!lastDecision && latestHistoricalEntry) {
        const derived = buildDecisionFromOptimization(latestHistoricalEntry as AugmentedOptimizationResult);
        if (derived) {
          lastDecision = derived;
        }
      }

      if (!lastDecision) {
        lastDecision = buildPlaceholderDecision();
      }

      return {
        success: true,
        thermalModel,
        adaptiveParameters,
        dataRetention,
        hotWaterPatterns,
        savingsMetrics,
        baselineSavings,
        enhancedSavings,
        seasonalMode,
        priceData,
        smartSavingsDisplay,
        averageSpotPrice,
        priceDataPoints, // Include for debugging/transparency
        lastDecision
      };
    } catch (err: any) {
      console.error('Error in getModelConfidence:', err);
      homey.app.error('Error in getModelConfidence:', err);
      return { success: false, error: err.message };
    }
  }
};

const exportedApi = apiHandlers as typeof apiHandlers & {
  __test?: Record<string, unknown>;
  updateAllServiceTimezones?: typeof updateAllServiceTimezones;
  updatePriceProvider?: typeof updatePriceProvider;
};

// Add the timezone update function to exports
exportedApi.updateAllServiceTimezones = updateAllServiceTimezones;
exportedApi.updatePriceProvider = updatePriceProvider;

module.exports = exportedApi;

// Hide internalCleanup from ManagerApi endpoint enumeration (keep it private)
try {
  if (exportedApi && typeof exportedApi.internalCleanup === 'function') {
    const __ic = exportedApi.internalCleanup;
    delete (exportedApi as unknown as Record<string, unknown>).internalCleanup;
    Object.defineProperty(exportedApi, 'internalCleanup', {
      value: __ic,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
} catch (_: any) { }

// Test helpers - only exposed when running in test environment
if (process.env.NODE_ENV === 'test') {
  exportedApi.__test = {
    // Inject internal service instances (mocks) for deterministic unit tests
    setServices({ melCloud: m, tibber: t, optimizer: o, weather: w }: Partial<ServiceState>) {
      applyServiceOverrides({ melCloud: m ?? undefined, tibber: t ?? undefined, optimizer: o ?? undefined, weather: w ?? undefined });
      const state = getServiceState();
      melCloud = state.melCloud;
      tibber = state.tibber;
      optimizer = state.optimizer;
      weather = state.weather;
      historicalData = state.historicalData;
    },
    // Replace historical data map
    setHistoricalData(data: HistoricalData) {
      setOrchestratorHistoricalData(data);
      historicalData = getServiceState().historicalData;
    },
    // Reset to defaults
    resetAll() {
      resetServiceState();
      const state = getServiceState();
      melCloud = state.melCloud;
      tibber = state.tibber;
      optimizer = state.optimizer;
      weather = state.weather;
      historicalData = state.historicalData;
    },
    // Expose internal state for assertions
    getState() {
      return getServiceStateSnapshot();
    }
  };
}
