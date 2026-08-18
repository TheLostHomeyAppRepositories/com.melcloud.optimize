import { HomeyLogger } from '../util/logger';
import { HomeyApp } from '../types';
import { validateNumber } from '../util/validation';
import { NightSetbackSettings } from '../util/night-setback';

/**
 * COP (Coefficient of Performance) settings
 */
export interface COPSettings {
    weight: number;
    autoSeasonalMode: boolean;
    summerMode: boolean;
}

/**
 * Safety constraint settings
 */
export interface ConstraintSettings {
    minSetpointChangeMinutes: number;
    deadband: number;
    tempStepMax: number;
}

/**
 * Price threshold settings
 */
export interface PriceSettings {
    cheapPercentile: number;
}

/**
 * Timezone settings
 */
export interface TimezoneSettings {
    offset: number;
    useDST: boolean;
    name?: string;
}

/**
 * Occupancy state
 */
export interface OccupancySettings {
    occupied: boolean;
}

/**
 * All optimizer settings grouped together
 */
export interface OptimizerSettings {
    cop: COPSettings;
    constraints: ConstraintSettings;
    price: PriceSettings;
    timezone: TimezoneSettings;
    occupancy: OccupancySettings;
}

/**
 * SettingsLoader Service
 * 
 * Provides type-safe access to Homey settings with validation and defaults.
 * Centralizes all settings loading logic.
 */
export class SettingsLoader {
    constructor(
        private readonly homey: HomeyApp,
        private readonly logger: HomeyLogger
    ) { }

    /**
     * Load all optimizer settings at once
     */
    loadAllSettings(): OptimizerSettings {
        return {
            cop: this.loadCOPSettings(),
            constraints: this.loadConstraintSettings(),
            price: this.loadPriceSettings(),
            timezone: this.loadTimezoneSettings(),
            occupancy: this.loadOccupancySettings()
        };
    }

    /**
     * Load COP-related settings
     */
    loadCOPSettings(): COPSettings {
        const weight = this.getNumber('cop_weight', 0.3, { min: 0, max: 1 });
        const autoSeasonalMode = this.getBoolean('auto_seasonal_mode', true);
        const summerMode = this.getBoolean('summer_mode', false);

        this.logger.log(`COP settings loaded - Weight: ${weight}, Auto Seasonal: ${autoSeasonalMode}, Summer Mode: ${summerMode}`);

        return { weight, autoSeasonalMode, summerMode };
    }

    /**
     * Load safety constraint settings
     */
    loadConstraintSettings(): ConstraintSettings {
        const minSetpointChangeMinutes = this.getNumber('min_setpoint_change_minutes', 30, { min: 1, max: 180 });
        let deadband = this.getNumber('deadband_c', 0.5, { min: 0.1, max: 2 });
        const tempStepMax = this.getNumber('temp_step_max', 0.5, { min: 0.5, max: 1.0 });

        // Cross-field guard: the setpoint ramp limiter caps every change at tempStepMax before
        // the deadband is tested, so a deadband larger than the step can never be satisfied and
        // the setpoint freezes permanently. deadband_c allows up to 2.0 while temp_step_max caps
        // at 1.0, so this is a UI-reachable configuration.
        if (deadband > tempStepMax) {
            this.logger.log(`Deadband ${deadband}°C exceeds max step ${tempStepMax}°C — clamping to ${tempStepMax}°C to avoid setpoint freeze`);
            deadband = tempStepMax;
        }

        this.logger.log(`Constraint settings loaded - Min change: ${minSetpointChangeMinutes}m, Deadband: ${deadband}°C, Step: ${tempStepMax}°C`);

        return { minSetpointChangeMinutes, deadband, tempStepMax };
    }

    /**
     * Load price threshold settings
     */
    loadPriceSettings(): PriceSettings {
        const cheapPercentile = this.getNumber('preheat_cheap_percentile', 0.25, { min: 0.05, max: 0.5 });

        this.logger.log(`Price settings loaded - Cheap percentile: ${(cheapPercentile * 100).toFixed(1)}%`);

        return { cheapPercentile };
    }

    /**
     * Load timezone settings
     */
    loadTimezoneSettings(): TimezoneSettings {
        const offset = this.getNumber('time_zone_offset', 1, { min: -12, max: 14 });
        const useDST = this.getBoolean('use_dst', false);
        const name = this.getString('time_zone_name', '');

        this.logger.log(`Timezone settings loaded - Offset: UTC${offset >= 0 ? '+' : ''}${offset}, DST: ${useDST}${name ? `, Name: ${name}` : ''}`);

        return {
            offset,
            useDST,
            name: name.length > 0 ? name : undefined
        };
    }

    /**
     * Load occupancy state
     */
    loadOccupancySettings(): OccupancySettings {
        const occupied = this.getBoolean('occupied', true);

        this.logger.log(`Occupancy loaded - ${occupied ? 'Home (Occupied)' : 'Away'}`);

        return { occupied };
    }

    /**
     * Load night setback settings
     */
    loadNightSetbackSettings(): NightSetbackSettings {
        const enabled = this.getBoolean('night_setback_enabled', false);
        const startHour = this.getNumber('night_start_hour', 22, { min: 0, max: 23 });
        const endHour = this.getNumber('night_end_hour', 6, { min: 0, max: 23 });
        const minTemp = this.getNumber('comfort_lower_night', 17.0, { min: 14, max: 22 });
        const maxTemp = this.getNumber('comfort_upper_night', 19.0, { min: 15, max: 23 });
        if (minTemp >= maxTemp) {
            this.logger.log('Night setback band invalid (min >= max), using defaults');
            return { enabled, startHour, endHour, minTemp: 17.0, maxTemp: 19.0 };
        }
        return { enabled, startHour, endHour, minTemp, maxTemp };
    }

    /**
     * Get a setting with type safety and default value
     * @param key Setting key
     * @param defaultValue Default value if setting is missing or invalid
     */
    private get<T>(key: string, defaultValue: T): T {
        const value = this.homey.settings.get(key);

        // Return default if value is null or undefined
        if (value === null || value === undefined) {
            return defaultValue;
        }

        // Type validation based on default value type
        const defaultType = typeof defaultValue;
        const valueType = typeof value;

        if (defaultType !== valueType) {
            this.logger.log(`Setting '${key}' has unexpected type: expected ${defaultType}, got ${valueType}. Using default.`);
            return defaultValue;
        }

        return value as T;
    }

    /**
     * Get number setting with range validation
     * @param key Setting key
     * @param defaultValue Default value
     * @param options Optional min/max validation
     */
    getNumber(
        key: string,
        defaultValue: number,
        options?: { min?: number; max?: number }
    ): number {
        const value = this.get(key, defaultValue);

        if (!Number.isFinite(value)) {
            return defaultValue;
        }

        if (options) {
            if (options.min !== undefined && value < options.min) {
                this.logger.log(`Setting '${key}' value ${value} below minimum ${options.min}. Using default.`);
                return defaultValue;
            }
            if (options.max !== undefined && value > options.max) {
                this.logger.log(`Setting '${key}' value ${value} above maximum ${options.max}. Using default.`);
                return defaultValue;
            }
        }

        return value;
    }

    /**
     * Get boolean setting
     * @param key Setting key
     * @param defaultValue Default value
     */
    getBoolean(key: string, defaultValue: boolean): boolean {
        return this.get(key, defaultValue);
    }

    /**
     * Get string setting
     * @param key Setting key
     * @param defaultValue Default value
     */
    getString(key: string, defaultValue: string): string {
        const value = this.get(key, defaultValue);
        return typeof value === 'string' ? value : defaultValue;
    }

    /**
     * Get currency code setting
     */
    getCurrency(): string {
        const currency = this.homey.settings.get('currency') || this.homey.settings.get('currency_code');
        return typeof currency === 'string' && currency.length > 0 ? currency : 'EUR';
    }

    /**
     * Get grid fee per kWh
     */
    getGridFee(): number {
        const gridFee = this.homey.settings.get('grid_fee_per_kwh');
        return typeof gridFee === 'number' && Number.isFinite(gridFee) ? gridFee : 0;
    }

    /**
     * Save a setting
     * @param key Setting key
     * @param value Value to save
     */
    saveSetting<T>(key: string, value: T): void {
        try {
            this.homey.settings.set(key, value);
        } catch (error) {
            this.logger.error(`Failed to save setting '${key}':`, error);
            throw error;
        }
    }

    /**
     * Save COP settings
     */
    saveCOPSettings(settings: COPSettings): void {
        this.saveSetting('cop_weight', settings.weight);
        this.saveSetting('auto_seasonal_mode', settings.autoSeasonalMode);
        this.saveSetting('summer_mode', settings.summerMode);
        this.logger.log('COP settings saved');
    }

    /**
     * Save price settings
     */
    savePriceSettings(settings: PriceSettings): void {
        this.saveSetting('preheat_cheap_percentile', settings.cheapPercentile);
        this.logger.log('Price settings saved');
    }

    /**
     * Save occupancy state
     */
    saveOccupancy(occupied: boolean): void {
        this.saveSetting('occupied', occupied);
        this.logger.log(`Occupancy saved - ${occupied ? 'Home (Occupied)' : 'Away'}`);
    }
}
