import { DateTime } from 'luxon';

// App types
export interface LogEntry {
  ts: string;
  price: number;
  indoor: number;
  target: number;
}

export interface ThermalModel {
  K: number;
  S?: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  type: string;
  buildingId: number;
  data?: any;
}

export interface PricePoint {
  time: string;
  price: number;
}

export interface OptimizationResult {
  targetTemp: number;
  reason: string;
  priceNow: number;
  priceAvg: number;
  priceMin: number;
  priceMax: number;
  indoorTemp: number;
  outdoorTemp: number;
  targetOriginal: number;
  savings: number;
  comfort: number;
  timestamp: string;
  kFactor?: number;
  thermalModel?: {
    characteristics: ThermalCharacteristics;
    timeToTarget: number;
    confidence: number;
    recommendation: any;
  };
  cop?: {
    heating: number;
    hotWater: number;
    seasonal: number;
    weight: number;
    isSummerMode: boolean;
    autoSeasonalMode: boolean;
  };
}

// MELCloud API types
export interface MelCloudDevice {
  DeviceID: string;
  DeviceName: string;
  BuildingID: number;
  RoomTemperature?: number;
  RoomTemperatureZone1?: number;
  SetTemperature?: number;
  SetTemperatureZone1?: number;
  /** ATW zone control mode: 0 = Room, 1 = Flow, 2 = Curve (weather compensation). */
  OperationModeZone1?: number;
  OperationModeZone2?: number;
  OutdoorTemperature: number;
  IdleZone1: boolean;
  DailyHeatingEnergyProduced?: number;
  DailyHeatingEnergyConsumed?: number;
  DailyHotWaterEnergyProduced?: number;
  DailyHotWaterEnergyConsumed?: number;
  [key: string]: any; // For other properties
}

// Tibber API types
export interface TibberPriceInfo {
  current: {
    price: number;
    time: string;
  };
  prices: PricePoint[];
  quarterHourly?: PricePoint[];
  intervalMinutes?: number;
  currencyCode?: string;
  baseCurrency?: string;
  priceLevel?: string; // Optional native Tibber price level (very cheap...very expensive)
  forecast?: unknown;
}

export type AbsolutePriceLevel =
  | 'VERY_CHEAP'
  | 'CHEAP'
  | 'NORMAL'
  | 'EXPENSIVE'
  | 'VERY_EXPENSIVE';

export interface HousePriceContext {
  absoluteLevel: AbsolutePriceLevel;
  isCheapForThisHouse: boolean;
  houseBreakevenSpread: number;
  economicSpread: number;
  priceSource: 'tibber_native' | 'entsoe_historical' | 'local_percentile';
}

export interface PriceProvider {
  getPrices(): Promise<TibberPriceInfo>;
  updateTimeZoneSettings?(offsetHours: number, useDst: boolean, timeZoneName?: string): void;
  cleanup?(): void;
}

// Weather API types
export interface WeatherData {
  temperature: number;
  windSpeed: number;
  humidity: number;
  cloudCover: number;
  precipitation: number;
}

// Thermal model types
export interface ThermalCharacteristics {
  heatingRate: number;
  coolingRate: number;
  thermalMass: number;
  modelConfidence: number;
  lastUpdated: string;
}

export interface ThermalDataPoint {
  timestamp: string;
  indoorTemperature: number;
  outdoorTemperature: number;
  targetTemperature: number;
  heatingActive: boolean;
  weatherConditions?: {  // Optional to support fallback when weather API unavailable
    windSpeed: number;
    humidity: number;
    cloudCover: number;
    precipitation: number;
  };
}

// Homey app interfaces
export interface HomeySettings {
  get(key: string): any;
  set(key: string, value: any): Promise<void>;
  unset(key: string): Promise<void>;
  on(event: string, listener: (key: string) => void): void;
}

export interface HomeyLogger {
  log(message: string, ...args: any[]): void;
  error(message: string, error?: Error | unknown, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
  warn?(message: string, ...args: any[]): void;
}

export interface HomeyApp {
  id: string;
  manifest: {
    version: string;
  };
  version: string;
  platform: string;
  settings: HomeySettings;
  log(message: string, ...args: any[]): void;
  error(message: string, error?: Error | unknown, ...args: any[]): void;
  // Homey timeline and notifications APIs
  timeline?: {
    createEntry(options: { title: string; body: string; icon?: string; type?: string }): Promise<any>;
  };
  notifications?: {
    createNotification(options: { excerpt: string }): Promise<any>;
  };
  flow?: {
    runFlowCardAction(options: { uri: string; args: any }): Promise<any>;
    getActionCard(id: string): any;
    getConditionCard(id: string): any;
    getTriggerCard(id: string): any;
    getDeviceTriggerCard(id: string): any;
  };
  // Internationalization and localization
  i18n?: {
    getLanguage(): string;
    getCurrency(): string;
  };
  // Optional properties that might be used in some contexts
  melcloudApi?: any;
  weatherApi?: any;
}

// Type guards
// isError removed here; use isError from util/error-handler for consistency

export function isMelCloudDevice(value: any): value is MelCloudDevice {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.DeviceID === 'string' &&
    typeof value.BuildingID === 'number'
  );
}

export function isTibberPriceInfo(value: any): value is TibberPriceInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.current === 'object' &&
    typeof value.current.price === 'number' &&
    Array.isArray(value.prices)
  );
}

// Optimizer types
export interface RealEnergyData {
  TotalHeatingConsumed: number;
  TotalHeatingProduced: number;
  TotalHotWaterConsumed: number;
  TotalHotWaterProduced: number;
  TotalCoolingConsumed: number;
  TotalCoolingProduced: number;
  CoP?: number[];
  AverageHeatingCOP?: number;
  AverageHotWaterCOP?: number;
  // New explicit fields (preferred)
  heatingCOP?: number | null;
  hotWaterCOP?: number | null;
  coolingCOP?: number | null;
  averageCOP?: number | null;
}

export interface OptimizationMetrics {
  realHeatingCOP: number;
  realHotWaterCOP: number;
  dailyEnergyConsumption: number;
  heatingEfficiency: number;
  hotWaterEfficiency: number;
  seasonalMode: 'summer' | 'winter' | 'transition';
  optimizationFocus: 'heating' | 'hotwater' | 'both';
}

export interface ThermalMassModel {
  thermalCapacity: number;      // kWh/°C - Energy needed to heat home by 1°C
  heatLossRate: number;         // °C/hour - Temperature loss rate
  maxPreheatingTemp: number;    // Maximum safe preheat temperature
  preheatingEfficiency: number; // Efficiency factor for preheating strategy
  efficiencyFactor?: number;    // General efficiency factor
  lastCalibration: Date;        // When the model was last updated
  lastUpdated?: Date;           // Alternative timestamp
}

export interface ThermalStrategy {
  action: 'preheat' | 'coast' | 'maintain' | 'boost';
  targetTemp: number;
  reasoning: string;
  estimatedSavings: number;
  duration?: number; // Hours for the strategy
  confidenceLevel: number; // 0-1 confidence in the strategy
  houseContext?: HousePriceContext;
}

export interface HotWaterUsagePattern {
  hourlyDemand: number[];      // 24-hour relative demand pattern used for scheduling shape
  dailyUsageKWh: number;       // Measured daily hot water energy demand
  peakHours: number[];         // Hours with high demand
  minimumBuffer: number;       // Minimum hot water energy to maintain (kWh)
  lastLearningUpdate: Date;    // When pattern was last updated
  dataPoints: number;          // Number of data points used for learning
}

export interface HotWaterSchedule {
  schedulePoints: SchedulePoint[];
  currentAction: 'heat_now' | 'delay' | 'maintain';
  reasoning: string;
  estimatedSavings: number;
}

export interface SchedulePoint {
  hour: number;
  reason: string;
  priority: number; // 0-1, higher = more important
  cop: number;
  pricePercentile: number;
}

export interface EnhancedOptimizationResult {
  success: boolean;
  action: 'temperature_adjusted' | 'no_change';
  fromTemp: number;
  toTemp: number;
  reason: string;
  priceDataUnavailable?: boolean;
  indoorTemp?: number | null;
  outdoorTemp?: number | null;
  priceData: {
    current: number;
    average: number;
    min: number;
    max: number;
    level?: string;
    percentile?: number;
    nextHour?: number;
  };
  savings?: number;
  energyMetrics?: OptimizationMetrics;
  hotWaterAction?: {
    action: 'heat_now' | 'delay' | 'maintain';
    reason: string;
    scheduledTime?: string;
  };
  // Optional weather snapshot for timeline/details integration
  weather?: {
    current?: Partial<WeatherData>;
    adjustment?: { adjustment: number; reason: string };
    trend?: { trend: string; details: string };
  };
  priceForecast?: {
    position?: string;
    recommendation?: string;
    upcomingChanges?: any;
    bestTimes?: any;
    worstTimes?: any;
  };
  zone2Data?: SecondaryZoneResult;
  tankData?: TankOptimizationResult;
  melCloudStatus?: {
    setpointApplied: boolean;
    error?: string;
  };
  tankStatus?: {
    setpointApplied: boolean;
    error?: string;
  };
}

export interface SecondaryZoneResult {
  fromTemp: number;
  toTemp: number;
  reason: string;
  targetOriginal?: number;
  targetTemp?: number;
  indoorTemp?: number;
  success?: boolean;
  changed?: boolean;
  action?: 'changed' | 'hold';
}

export interface TankOptimizationResult {
  fromTemp: number;
  toTemp: number;
  reason: string;
  success?: boolean;
  changed?: boolean;
}

// API Types
export type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type SystemHealthCheckResult = {
  healthy: boolean;
  issues?: string[];
  recovered?: boolean;
  [key: string]: unknown;
};

export interface HomeySettingsLike {
  get(key: string): any;
  set(key: string, value: any): Promise<void> | void;
  unset?(key: string): Promise<void> | void;
}

export interface HomeyLoggerLike {
  log(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
  warn?(message: string, ...args: any[]): void;
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
  };
  flow?: {
    runFlowCardAction(options: { uri: string; args: Record<string, unknown> }): Promise<void> | void;
  };
  runSystemHealthCheck?: () => Promise<SystemHealthCheckResult>;
  hourlyJob?: any;
  weeklyJob?: any;
  homey?: { settings?: HomeySettingsLike };
}

export interface HomeyLike {
  app: HomeyLoggerLike;
  settings: HomeySettingsLike;
  drivers?: {
    getDriver(driverName: string): any;
  };
  timeline?: {
    createEntry(options: { title: string; body: string; icon?: string; type?: string }): Promise<void> | void;
  };
  notifications?: {
    createNotification(options: { excerpt: string }): Promise<void> | void;
  };
  flow?: {
    runFlowCardAction(options: { uri: string; args: Record<string, unknown> }): Promise<void> | void;
  };
  i18n?: {
    getCurrency(): string | undefined;
  };
}

export interface LoggerLike {
  log(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  warn?(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
  homey?: { settings?: HomeySettingsLike };
}

export type RetryableError = NodeJS.ErrnoException & { message: string };

export type ApiLogger = LoggerLike & { homey?: { settings?: HomeySettingsLike } };

export interface ApiHandlerContext {
  homey: HomeyLike;
  body?: unknown;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

export type ApiSuccess<T extends object = Record<string, unknown>> = { success: true } & T;

export interface ApiError {
  success: false;
  error?: string;
  message?: string;
  needsConfiguration?: boolean;
  [key: string]: unknown;
}

export type ApiResult<T extends object = Record<string, unknown>> = ApiSuccess<T> | ApiError;

export interface DeviceDropdownItem {
  id: string;
  name: string;
  buildingId: number;
  type: string;
  hasZone1: boolean;
  hasZone2: boolean;
  hasTank: boolean;
  SetTankWaterTemperature?: number | null;
  TankWaterTemperature?: number | null;
  currentTemperatureZone1?: number | null;
  currentTemperatureZone2?: number | null;
  currentSetTemperatureZone1?: number | null;
  currentSetTemperatureZone2?: number | null;
}

export interface BuildingDropdownItem {
  id: number;
  name: string;
  devices: string[];
}

export type WeeklyCalibrationResult = {
  oldK: number;
  newK: number;
  oldS?: number;
  newS: number;
  timestamp: string;
  thermalCharacteristics?: any;
  method?: string;
  analysis?: string;
  success?: boolean;
  calibrated?: boolean;
  [key: string]: any;
};

export type AugmentedOptimizationResult = EnhancedOptimizationResult & {
  timestamp?: string;
  targetTemp?: number;
  targetOriginal?: number;
  indoorTemp?: number;
  outdoorTemp?: number;
  priceNow?: number;
  comfort?: number;
  zone2Temperature?: {
    fromTemp?: number;
    toTemp?: number;
    targetTemp?: number;
    targetOriginal?: number;
  };
  tankTemperature?: {
    fromTemp?: number;
    toTemp?: number;
    targetTemp?: number;
    targetOriginal?: number;
  };
};

export type OptimizerCostSnapshot = {
  baselineCostMajor: number;
  optimizedCostMajor: number;
};

export type DecisionCode =
  | 'HEAT_MAINTAIN_DEADBAND'
  | 'HEAT_PREHEAT'
  | 'HEAT_COAST'
  | 'DHW_HEAT_CHEAP_WINDOW'
  | 'DHW_DELAY_EXPENSIVE'
  | 'LEARNING_ADJUST'
  | 'NONE';

export interface OptimizationDecision {
  code: DecisionCode;
  headline: string;
  reason: string;
  timestamp: string;
  context?: {
    fromTemp?: number | null;
    toTemp?: number | null;
    priceTier?: 'cheap' | 'normal' | 'expensive';
    spike?: boolean;
    dhwAction?: 'heat_now' | 'delay' | 'maintain' | null;
    zone?: 'zone1' | 'zone2' | 'tank';
  };
}

export type HourlyOptimizationData = {
  action: EnhancedOptimizationResult['action'];
  fromTemp: number;
  toTemp: number;
  reason: string;
  priceData: EnhancedOptimizationResult['priceData'];
  priceNow?: number;
  savings: number;
  hourlyBaselineKWh: number | null;
  timestamp: string;
};

export interface ThermalModelDataPoint {
  timestamp: string;
  targetTemp: number | null | undefined;
  indoorTemp: number | null | undefined;
  outdoorTemp: number | null | undefined;
  priceNow: number | null | undefined;
}

export interface ThermalModelResponseData {
  optimizationCount: number;
  lastOptimization: Record<string, unknown> | null;
  lastCalibration: Record<string, unknown> | null;
  kFactor: number | null;
  dataPoints: ThermalModelDataPoint[];
}

export type UpdateOptimizerSettingsResponse = ApiResult<{ message: string }>;
export type GetDeviceListResponse = ApiResult<{ devices: DeviceDropdownItem[]; buildings: BuildingDropdownItem[] }>;
export type GetRunHourlyOptimizerResponse = ApiResult<{ message: string; data: HourlyOptimizationData; result: EnhancedOptimizationResult }>;
export type GetThermalModelDataResponse = ApiResult<{ data: ThermalModelResponseData }>;
export type GetRunWeeklyCalibrationResponse = ApiResult<{ message?: string; result?: WeeklyCalibrationResult; historicalDataCount?: number }>;

export type CronJobSnapshot = {
  running: boolean;
  nextRun?: string;
  cronTime?: string;
  error?: string;
};

export interface CronStatusSnapshot {
  hourlyJob: CronJobSnapshot;
  weeklyJob: CronJobSnapshot;
  lastHourlyRun: string;
  lastWeeklyRun: string;
  lastUpdated?: string;
}

export type GetStartCronJobsResponse = ApiResult<{ message: string; hourlyJobRunning: boolean; weeklyJobRunning: boolean }>;
export type GetUpdateCronStatusResponse = ApiResult<{ message: string; cronStatus: CronStatusSnapshot }>;
export type GetCheckCronStatusResponse = ApiResult<{
  currentTime: string;
  hourlyJob: CronJobSnapshot;
  weeklyJob: CronJobSnapshot;
  lastHourlyRun: string;
  lastWeeklyRun: string;
}>;
export type ValidateAndStartCronResponse = ApiResult<{ cronRunning: boolean; message: string }>;

export type GetCopDataResponse = ApiResult<{
  melcloud: unknown;
  helper: unknown;
  settings: {
    copWeight: number;
    autoSeasonalMode: boolean;
    summerMode: boolean;
  };
}>;

export type GetWeeklyAverageCopResponse = ApiResult<{
  melcloud: unknown;
  helper: {
    heating: unknown;
    hotWater: unknown;
  };
}>;

export interface ConnectionStatusResponse {
  connected: boolean;
  error?: string;
  needsConfiguration?: boolean;
  devices?: number;
  reconnected?: boolean;
  pricePoints?: number;
}

export type RunThermalDataCleanupResponse = ApiResult<Record<string, unknown>>;

export type InternalCleanupResponse = ApiResult<{ message: string }>;

export type GetModelConfidenceResponse = ApiResult<{
  thermalModel: {
    confidence: number | null;
    heatingRate: number | null;
    coolingRate: number | null;
    thermalMass: number | null;
    lastUpdated: string | null;
  };
  adaptiveParameters: {
    learningCycles: number | null;
    confidence: number | null;
    lastUpdated: string | null;
  };
  dataRetention: {
    thermalRawPoints: number;
    thermalAggPoints: number;
    rawKB: number;
    aggKB: number;
  };
  hotWaterPatterns: {
    confidence: number | null;
    hourlyUsagePattern: number[] | null;
    lastUpdated: string | null;
  };
  savingsMetrics: {
    totalSavings: number | null;
    averageDailySavings: number | null;
    todaySavings: number | null;
    last7DaysSavings: number | null;
    projectedDailySavings: number | null;
  };
  baselineSavings: {
    todayVsBaseline: number;
    percentageSaved: number;
    confidence: number;
    projectedMonthly: number;
  } | null;
  enhancedSavings: {
    baselineSavings: number;
    baselinePercentage: number;
    projectedSavings: number;
    confidence: number;
    method: string;
    breakdown: any;
  } | null;
  seasonalMode: string | null;
  priceData: {
    currencySymbol: string;
    currency: string;
  };
  smartSavingsDisplay: {
    currency: string;
    currencySymbol: string;
    decimals: number;
    today: number | null;
    last7: number | null;
    projection: number | null;
    seasonMode: string | null;
  };
  lastDecision?: OptimizationDecision;
}>;

export interface HotWaterServiceLike {
  resetPatterns(): void;
  clearData(clearAggregated: boolean): Promise<void>;
}

export type HotWaterResponse = ApiResult<{ message: string }>;

export interface HotWaterClearRequest {
  clearAggregated?: boolean;
}

export interface HotWaterHandlers {
  'reset-patterns'(context: ApiHandlerContext): Promise<HotWaterResponse>;
  'clear-data'(context: ApiHandlerContext): Promise<HotWaterResponse>;
}

export interface TibberHomeInfo {
  id: string;
  name: string;
  selected?: boolean;
}

export type GetTibberHomesResponse = ApiResult<{
  homes: TibberHomeInfo[];
  selectedHomeId: string | null;
}>;

export interface ApiHandlers {
  updateOptimizerSettings(context: ApiHandlerContext): Promise<UpdateOptimizerSettingsResponse>;
  postHotWaterResetPatterns(context: ApiHandlerContext): Promise<HotWaterResponse>;
  postHotWaterClearData(context: ApiHandlerContext): Promise<HotWaterResponse>;
  postResetLearnedState(context: ApiHandlerContext): Promise<{ success: boolean; message: string; result?: unknown }>;
  getHotWaterPatterns(context: ApiHandlerContext): Promise<HotWaterResponse>;
  getDeviceList(context: ApiHandlerContext): Promise<GetDeviceListResponse>;
  getRunHourlyOptimizer(context: ApiHandlerContext): Promise<GetRunHourlyOptimizerResponse>;
  getThermalModelData(context: ApiHandlerContext): Promise<GetThermalModelDataResponse>;
  getRunWeeklyCalibration(context: ApiHandlerContext): Promise<GetRunWeeklyCalibrationResponse>;
  getStartCronJobs(context: ApiHandlerContext): Promise<GetStartCronJobsResponse>;
  getUpdateCronStatus(context: ApiHandlerContext): Promise<GetUpdateCronStatusResponse>;
  getCheckCronStatus(context: ApiHandlerContext): Promise<GetCheckCronStatusResponse>;
  getCOPData(context: ApiHandlerContext): Promise<GetCopDataResponse>;
  getWeeklyAverageCOP(context: ApiHandlerContext): Promise<GetWeeklyAverageCopResponse>;
  getMelCloudStatus(context: ApiHandlerContext): Promise<ConnectionStatusResponse>;
  getTibberStatus(context: ApiHandlerContext): Promise<ConnectionStatusResponse>;
  getTibberHomes(context: ApiHandlerContext): Promise<GetTibberHomesResponse>;
  runSystemHealthCheck(context: ApiHandlerContext): Promise<SystemHealthCheckResult>;
  runThermalDataCleanup(context: ApiHandlerContext): Promise<RunThermalDataCleanupResponse>;
  internalCleanup(context: ApiHandlerContext): Promise<InternalCleanupResponse>;
  validateAndStartCron(context: ApiHandlerContext): Promise<ValidateAndStartCronResponse>;
  getModelConfidence(context: ApiHandlerContext): Promise<GetModelConfidenceResponse>;
  'hot-water': HotWaterHandlers;
}

// Enhanced COP helpers
export { EnhancedCOPData, DailyCOPData, getCOPValue, isEnhancedCOPData } from './enhanced-cop-data';

// Homey extensions - type-safe service access
export { HotWaterService, HomeyWithOptimizer, hasHotWaterService } from './homey-extensions';
