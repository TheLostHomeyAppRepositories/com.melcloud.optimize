import { Logger, createFallbackLogger } from '../util/logger';
import { TibberPriceInfo, PricePoint } from '../types';
import { ErrorHandler, AppError, ErrorCategory } from '../util/error-handler';
import { BaseApiService, RateLimitError } from './base-api-service';
import { TimeZoneHelper } from '../util/time-zone-helper';

// Add global declaration for logger
declare global {
  var logger: Logger;
}

/**
 * Tibber Home information
 */
export interface TibberHome {
  id: string;
  appNickname: string | null;
  address: {
    address1: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
}

/**
 * Tibber API Service
 * Handles communication with the Tibber API to get electricity prices
 */
export class TibberApi extends BaseApiService {
  private static readonly CACHE_KEY_PRICES = 'tibber_prices';
  private apiEndpoint = 'https://api.tibber.com/v1-beta/gql';
  private token: string;
  private timeZoneHelper: TimeZoneHelper;
  private homeId: string | null = null;

  /**
   * Constructor
   * @param token Tibber API token
   * @param logger Logger instance
   * @param homeId Optional home ID to use for fetching prices (if user has multiple homes)
   */
  constructor(token: string, logger?: Logger, homeId?: string) {
    // Ensure we have a valid logger - use fallback if none provided
    const safeLogger = logger || (global.logger as Logger) || createFallbackLogger('Tibber');
    
    // Call the parent constructor with service name and logger
    super('Tibber', safeLogger, {
      failureThreshold: 3,
      resetTimeout: 60000, // 1 minute
      halfOpenSuccessThreshold: 1,
      timeout: 15000 // 15 seconds
    });

    this.token = token;
    this.homeId = homeId || null;

    // Initialize time zone helper
    this.timeZoneHelper = new TimeZoneHelper(this.logger);

    this.logger.api('Tibber API service initialized', { 
      token: token ? '***' : 'not provided',
      homeId: homeId || 'not specified (will use first home)'
    });
  }

  /**
   * Set the home ID to use for fetching prices
   * @param homeId The Tibber home ID to use
   */
  public setHomeId(homeId: string | null): void {
    this.homeId = homeId;
    this.logger.info(`Tibber home ID set to: ${homeId || 'default (first home)'}`);
    // Clear cache when home ID changes to ensure fresh data is fetched
    this.cache.delete(TibberApi.CACHE_KEY_PRICES);
  }

  /**
   * Get the current home ID
   * @returns The current home ID or null if using first home
   */
  public getHomeId(): string | null {
    return this.homeId;
  }

  /**
   * Get list of available homes from Tibber account
   * @returns Promise resolving to array of TibberHome objects
   */
  async getHomes(): Promise<TibberHome[]> {
    const query = `{
      viewer {
        homes {
          id
          appNickname
          address {
            address1
            city
            postalCode
            country
          }
        }
      }
    }`;

    try {
      const data = await this.retryableRequest(
        () => this.throttledApiCall<any>(query)
      );

      if (data.errors) {
        const errorMessage = `Tibber API error: ${data.errors[0].message}`;
        throw this.createApiError(new Error(errorMessage), {
          operation: 'getHomes',
          graphqlErrors: data.errors
        });
      }

      const homes = data.data?.viewer?.homes || [];
      this.logger.info(`Found ${homes.length} Tibber home(s)`);
      
      return homes.map((home: any) => ({
        id: home.id,
        appNickname: home.appNickname || null,
        address: home.address ? {
          address1: home.address.address1 || null,
          city: home.address.city || null,
          postalCode: home.address.postalCode || null,
          country: home.address.country || null
        } : null
      }));
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const appError = this.createApiError(error, {
        operation: 'getHomes'
      });

      this.errorHandler.logError(appError);
      throw appError;
    }
  }

  /**
   * Update timezone settings for this service
   * @param timeZoneOffset Timezone offset in hours
   * @param useDST Whether to use daylight saving time
   */
  public updateTimeZoneSettings(timeZoneOffset: number, useDST: boolean, timeZoneName?: string): void {
    this.timeZoneHelper.updateSettings(
      timeZoneOffset,
      useDST,
      typeof timeZoneName === 'string' && timeZoneName.length > 0 ? timeZoneName : undefined
    );
    this.logger.info(
      `Tibber API timezone settings updated: offset=${timeZoneOffset}, DST=${useDST}, name=${timeZoneName || 'n/a'}`
    );
  }

  /**
   * Check if an error is an authentication error
   * @param error Error to check
   * @returns True if it's an authentication error
   */
  private isAuthError(error: unknown): boolean {
    const appError = this.errorHandler.createAppError(error);
    return appError.category === ErrorCategory.AUTHENTICATION;
  }

  /**
   * Throttled API call to prevent rate limiting
   * @param query GraphQL query
   * @returns Promise resolving to API response
   */
  private async throttledApiCall<T>(query: string): Promise<T> {
    // Use circuit breaker to protect against cascading failures
    return this.circuitBreaker.execute(async () => {
      // Throttle requests using the base class method
      await this.throttle();

      // Log the API call
      this.logApiCall('POST', this.apiEndpoint, { query: 'GraphQL query' });

      // Make the API call
      this.logger.debug(`API Call to Tibber GraphQL endpoint`);

      const fetchFn = getFetch();
      const response = await fetchFn(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ query }),
      });

      if (response.status === 429) {
        const retryAfterHeader = (response as any).headers?.get?.('retry-after') ?? null;
        const retryAfterMs = parseRetryAfterHeader(retryAfterHeader) ?? 60000;
        this.applyRateLimit(retryAfterMs);
        throw new RateLimitError(`API rate limit: ${response.status} ${response.statusText}`, retryAfterMs);
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as T;
    });
  }

  /**
   * Get current and future electricity prices
   * @returns Promise resolving to price data
   */
  async getPrices(): Promise<TibberPriceInfo> {
    // Check cache first
    const cacheKey = TibberApi.CACHE_KEY_PRICES;
    const cachedData = this.getCachedData<any>(cacheKey);

    if (cachedData) {
      // Validate price data freshness even if cached
      if (this.isPriceDataFresh(cachedData)) {
        this.logger.debug(`Using cached Tibber price data`);
        return cachedData;
      } else {
        this.logger.warn(`Cached Tibber price data is stale, fetching fresh data`);
        // Clear stale cache
        this.cache.delete(cacheKey);
      }
    }

    const query = `{
      viewer {
        homes {
          id
          currentSubscription {
            priceInfo(resolution: QUARTER_HOURLY) {
              current {
                total
                energy
                tax
                startsAt
                level
              }
              today {
                total
                energy
                tax
                startsAt
                level
              }
              tomorrow {
                total
                energy
                tax
                startsAt
                level
              }
            }
          }
        }
      }
    }`;

    try {
      const data = await this.retryableRequest(
        () => this.throttledApiCall<any>(query)
      );

      if (data.errors) {
        const errorMessage = `Tibber API error: ${data.errors[0].message}`;
        throw this.createApiError(new Error(errorMessage), {
          operation: 'getPrices',
          graphqlErrors: data.errors
        });
      }

      const formattedData = this.formatPriceData(data);
      const summaryCounts = {
        hourly: formattedData.prices?.length || 0,
        quarterHourly: formattedData.quarterHourly?.length || 0
      };
      this.logger.log(
        `Tibber prices retrieved: hourly=${summaryCounts.hourly}, quarterHourly=${summaryCounts.quarterHourly}`
      );

      // Validate freshness of the fetched data
      if (!this.isPriceDataFresh(formattedData)) {
        this.logger.warn('Fetched price data is stale - this may indicate system time issues or Tibber API delays');
        // Still cache and return the data as it's the best we have
        // But log a warning for monitoring
      }

      // Cache the result
      this.setCachedData(cacheKey, formattedData);

      return formattedData;
    } catch (error) {
      // If this is already an AppError, just rethrow it
      if (error instanceof AppError) {
        throw error;
      }

      // Create a standardized error with context
      const appError = this.createApiError(error, {
        operation: 'getPrices'
      });

      // Log the error with appropriate level based on category
      this.errorHandler.logError(appError);

      // Throw the standardized error
      throw appError;
    }
  }

  /**
   * Format price data from Tibber API response
   * @param data Tibber API response data
   * @returns Formatted price data
   */
  private formatPriceData(data: any): TibberPriceInfo {
    try {
      const homes = data.data.viewer.homes;
      if (!homes || homes.length === 0) {
        const errorMessage = 'No homes found in Tibber account';
        this.logger.error(errorMessage);
        throw new Error(errorMessage);
      }

      // Find the selected home by ID, or fall back to first home
      let selectedHome = homes[0];
      if (this.homeId) {
        const matchingHome = homes.find((home: any) => home.id === this.homeId);
        if (matchingHome) {
          selectedHome = matchingHome;
          this.logger.debug(`Using selected Tibber home: ${this.homeId}`);
        } else {
          this.logger.warn(`Configured Tibber home ID '${this.homeId}' not found. Using first home instead.`);
        }
      } else if (homes.length > 1) {
        this.logger.info(`Multiple Tibber homes found (${homes.length}). Using first home. Consider setting tibber_home_id in settings.`);
      }

      const priceInfo = selectedHome.currentSubscription?.priceInfo;
      if (!priceInfo) {
        const errorMessage = 'No price information available';
        this.logger.error(errorMessage);
        throw new Error(errorMessage);
      }

      // Combine today and tomorrow prices
      const quarterHourlyPrices: PricePoint[] = [
        ...(priceInfo.today || []),
        ...(priceInfo.tomorrow || []),
      ].map(price => ({
        time: price.startsAt,
        price: price.total,
      }));

      const intervalMinutes = this.detectIntervalMinutes(quarterHourlyPrices) ?? undefined;
      const hourlyPrices = this.aggregateToHourly(quarterHourlyPrices);

      const rawCurrent = priceInfo.current ? {
        time: priceInfo.current.startsAt,
        price: priceInfo.current.total,
      } : {
        time: new Date().toISOString(),
        price: 0
      };

      // Rank-comparable current price. `prices` are hourly means once aggregation happens, so
      // publishing a raw 15-minute price as `current` meant the classifier ranked a quarter
      // against a distribution of hourly averages — a rising quarter can exceed the mean of
      // every hour, yielding percentile 100 and VERY_EXPENSIVE on an ordinary day. Observed
      // live: current 0.5168 against a window whose max was 0.512225.
      // The raw quarter is still published as `currentQuarter` for block-edge decisions.
      const currentHourBucket = hourlyPrices.length > 0
        ? hourlyPrices.find(p => {
          const start = Date.parse(p.time);
          return Number.isFinite(start)
            && Date.parse(rawCurrent.time) >= start
            && Date.parse(rawCurrent.time) < start + 3600000;
        })
        : undefined;

      const result: TibberPriceInfo = {
        current: currentHourBucket
          ? { time: currentHourBucket.time, price: currentHourBucket.price }
          : rawCurrent,
        currentQuarter: rawCurrent,
        prices: hourlyPrices.length > 0 ? hourlyPrices : quarterHourlyPrices,
        quarterHourly: quarterHourlyPrices,
        intervalMinutes,
        priceLevel: priceInfo.current?.level || priceInfo.current?.priceLevel || undefined
      };

      this.logger.log(
        `Formatted price data: current price ${result.current?.price || 'N/A'}, hourly=${result.prices.length}, quarterHourly=${quarterHourlyPrices.length}`
      );
      return result;
    } catch (error) {
      // Create a standardized error with context
      const appError = this.errorHandler.createAppError(error, {
        service: this.serviceName,
        operation: 'formatPriceData'
      }, 'Failed to format price data');

      // Log the error
      this.errorHandler.logError(appError);

      // Throw the standardized error
      throw appError;
    }
  }

  /**
   * Check if price data is fresh (not stale)
   * @param priceData Price data to validate
   * @returns True if data is fresh, false if stale
   */
  private isPriceDataFresh(priceData: TibberPriceInfo): boolean {
    try {
      if (!priceData?.current?.time) {
        this.logger.warn('Price data missing current time - considering stale');
        return false;
      }

      const currentPriceTime = new Date(priceData.current.time);
      const now = new Date();

      const intervalMinutes = priceData.intervalMinutes ?? 60;
      const maxStaleMinutes = intervalMinutes === 15 ? 20 : 65;
      const maxStaleTime = maxStaleMinutes * 60 * 1000;
      const timeDiff = now.getTime() - currentPriceTime.getTime();

      if (timeDiff > maxStaleTime) {
        this.logger.warn(`Price data is stale: current price from ${currentPriceTime.toISOString()}, age: ${Math.round(timeDiff / 60000)} minutes`);
        return false;
      }

      const futureThresholdMinutes = intervalMinutes === 15 ? 20 : 65;
      if (timeDiff < -futureThresholdMinutes * 60 * 1000) {
        this.logger.warn(`Price data has future timestamp: ${currentPriceTime.toISOString()}, system time: ${now.toISOString()}`);
        return false;
      }

      this.logger.debug(`Price data is fresh: current price from ${currentPriceTime.toISOString()}, age: ${Math.round(Math.abs(timeDiff) / 60000)} minutes`);
      return true;
    } catch (error) {
      this.logger.error(`Error validating price data freshness: ${error}`, { error });
      // If we can't validate, assume stale to be safe
      return false;
    }
  }

  /**
   * Clean up any pending timers and resources
   * This is important for tests to prevent memory leaks and lingering timers
   */
  cleanup(): void {
    // Call parent class cleanup to handle cache and circuit breaker
    super.cleanup();
  }

  private detectIntervalMinutes(prices: PricePoint[]): number | null {
    if (!Array.isArray(prices) || prices.length < 2) {
      return null;
    }

    for (let i = 1; i < prices.length; i += 1) {
      const prev = new Date(prices[i - 1].time).getTime();
      const current = new Date(prices[i].time).getTime();
      if (Number.isFinite(prev) && Number.isFinite(current)) {
        const diffMinutes = Math.round((current - prev) / 60000);
        if (diffMinutes > 0) {
          return diffMinutes;
        }
      }
    }

    return null;
  }

  private aggregateToHourly(prices: PricePoint[]): PricePoint[] {
    if (!Array.isArray(prices) || prices.length === 0) {
      return [];
    }

    const buckets = new Map<string, { sum: number; count: number }>();

    prices.forEach(({ time, price }) => {
      const date = new Date(time);
      if (!Number.isFinite(date.getTime())) {
        return;
      }

      // Round to hour start in UTC to preserve original timezone offset from startsAt
      // This avoids local timezone conversion that would shift price windows
      const utcYear = date.getUTCFullYear();
      const utcMonth = date.getUTCMonth();
      const utcDate = date.getUTCDate();
      const utcHour = date.getUTCHours();
      const bucketDate = new Date(Date.UTC(utcYear, utcMonth, utcDate, utcHour, 0, 0, 0));
      const bucketKey = bucketDate.toISOString();

      const bucket = buckets.get(bucketKey) || { sum: 0, count: 0 };
      bucket.sum += price;
      bucket.count += 1;
      buckets.set(bucketKey, bucket);
    });

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timeKey, { sum, count }]) => ({
        time: timeKey,
        price: count > 0 ? sum / count : 0,
      }));
  }
}

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: {
    get(name: string): string | null;
  };
  json(): Promise<any>;
}

type FetchFn = (url: string, init?: FetchInit) => Promise<FetchResponse>;

let cachedFetch: FetchFn | null = null;

async function loadFetchModule(): Promise<FetchFn> {
  const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;
  const mod: unknown = await dynamicImport('node-fetch');
  const candidate = (mod && typeof mod === 'object' && 'default' in mod)
    ? (mod as { default: unknown }).default
    : mod;
  if (typeof candidate !== 'function') {
    throw new AppError(
      'node-fetch module does not export a fetch-compatible function.',
      ErrorCategory.INTERNAL
    );
  }
  return (candidate as FetchFn).bind(globalThis);
}

function getFetch(): FetchFn {
  if (cachedFetch) {
    return cachedFetch;
  }

  const maybeFetch = (globalThis as any).fetch;
  if (typeof maybeFetch === 'function') {
    const boundFetch = (maybeFetch as FetchFn).bind(globalThis);
    cachedFetch = boundFetch;
    return boundFetch;
  }

  cachedFetch = (async (...args: Parameters<FetchFn>): ReturnType<FetchFn> => {
    cachedFetch = await loadFetchModule();
    return cachedFetch(...args);
  }) as FetchFn;

  return cachedFetch;
}

function parseRetryAfterHeader(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const numeric = Number(headerValue);
  if (!Number.isNaN(numeric)) {
    return Math.max(0, numeric * 1000);
  }

  const parsedDate = Date.parse(headerValue);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}
