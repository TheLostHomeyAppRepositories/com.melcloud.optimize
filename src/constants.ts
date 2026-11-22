export const COP_THRESHOLDS = {
    EXCELLENT: 0.8,
    GOOD: 0.5,
    POOR: 0.2,
    VERY_POOR: 0.0, // Implicit lower bound
};

export const DEFAULT_WEIGHTS = {
    PRICE_SUMMER: 0.7,
    PRICE_WINTER: 0.4,
    PRICE_TRANSITION: 0.5,
    COP_EFFICIENCY_BONUS_HIGH: 0.3,
    COP_EFFICIENCY_BONUS_MEDIUM: 0.2,
};

export const COMFORT_CONSTANTS = {
    DEFAULT_MIN_TEMP: 18,
    DEFAULT_MAX_TEMP: 23,
    DEFAULT_MIN_TEMP_ZONE2: 18,
    DEFAULT_MAX_TEMP_ZONE2: 23,
    DEFAULT_MIN_TANK_TEMP: 40,
    DEFAULT_MAX_TANK_TEMP: 60,
    DEFAULT_TEMP_STEP: 0.5,
    DEFAULT_TEMP_STEP_ZONE2: 1.0,
    DEFAULT_TANK_TEMP_STEP: 1.0,
    /**
     * Maximum tank setpoint movement per optimization run, in °C.
     *
     * Deliberately larger than DEFAULT_TANK_TEMP_STEP (the rounding grid): the tank is a
     * buffer, not a comfort variable, and capping it at one grid step meant a full-range move
     * took ~20 hourly writes — longer than any cheap window, so the arbitrage never completed
     * while still writing a setpoint every hour.
     *
     * Not unbounded, though: large single jumps can bring a tank's resistance element in,
     * which burns direct electricity and defeats the saving. 4 °C reaches a useful target in
     * one or two runs while staying a modest step for the compressor.
     */
    DEFAULT_TANK_MAX_DELTA_PER_CHANGE: 4.0,
    /**
     * How long a forced hot water request gets to start a reheat before it counts as not started
     * (reported, record cleared), minutes (just under the hourly optimizer interval).
     */
    LOW_TANK_FORCED_WAIT_MINUTES: 50,
    /** Forced hot water started by the app is switched back to auto after this long at most, hours. */
    LOW_TANK_FORCED_MAX_HOURS: 3,
    DEFAULT_DEADBAND: 0.5,
    /**
     * Curve mode with a room sensor: how far the room must be above the zone setpoint before the
     * Ecodan's room thermostat switches heating off. Measured 2026-10-26..11-09 (hourly insights):
     * at +0.5 °C the pump never stopped (24/24 h); stops came at about +0.8 to +1.2 °C, and once
     * off it stayed off until the room fell back to about the setpoint.
     */
    DEFAULT_CURVE_GATE_OFF_OFFSET_C: 1.0,
    DEFAULT_MIN_SETPOINT_CHANGE_MINUTES: 30,
    /** Standard away band: the occupied band moved down by this much (settings page "standard"). */
    DEFAULT_AWAY_OFFSET_C: 2,
    /** Standard night band: the occupied band moved down by this much. */
    DEFAULT_NIGHT_OFFSET_C: 1,
};

export const PRICE_CONSTANTS = {
    /** Share of the coming day counted as cheap (preheat) and, mirrored, as expensive (pause). */
    DEFAULT_CHEAP_PERCENTILE: 0.25,
};

/**
 * Heat pump energy meter for Homey Energy. MELCloud only reports a total per finished day for
 * most units, so the day is followed through the compressor frequency and corrected to that
 * total once it is published.
 */
export const ENERGY_METER_CONSTANTS = {
    /** Longest gap between two compressor samples that is still integrated, minutes. */
    MAX_SAMPLE_GAP_MINUTES: 15,
    /** Finished days used to learn kWh per compressor Hz-hour. */
    CALIBRATION_DAYS: 14,
    /** A day needs this many sampled hours to calibrate (part days would bias the rate). */
    MIN_SAMPLED_HOURS_FOR_CALIBRATION: 20,
    /** Days to wait for MELCloud's day total before the estimate is taken as final. */
    MAX_DAYS_WAITING_FOR_TOTAL: 3,
};

/**
 * Compressor cycle tracker: starts, run length and run share over a rolling window, from the
 * same `HeatPumpFrequency` samples the energy meter uses.
 */
export const COMPRESSOR_CYCLE_CONSTANTS = {
    /** Window the published figures cover, hours. */
    WINDOW_HOURS: 24,
    /** Samples kept, hours: a little over the window so a full window is always available. */
    RETENTION_HOURS: 26,
    /** Hard cap on stored samples, in case the poll interval is set very short. */
    MAX_SAMPLES: 2000,
    /**
     * Longest gap between two samples still treated as continuous, minutes. Across a longer gap
     * (restart, MELCloud outage) a start or stop is unknown, so nothing is counted.
     */
    MAX_SAMPLE_GAP_MINUTES: 15,
    /** Sampled time needed before the figures are published, hours. */
    MIN_COVERAGE_HOURS: 1,
};

/**
 * Compressor power from the house meter (Tibber Pulse, P1 reader and similar). Each time the
 * compressor starts or stops between two polls, the change in house power is one measurement
 * of the compressor's draw. Other loads switching at the same moment add noise in both
 * directions, so the figure used is the median of many steps, never a single one.
 */
export const POWER_CALIBRATION_CONSTANTS = {
    /** Longest gap between the two polls around a start or stop that still counts, minutes. */
    MAX_PAIR_GAP_MINUTES: 10,
    /** House meter readings older than this are not used, minutes. */
    MAX_READING_AGE_MINUTES: 5,
    /** With no house meter found, how often the device list is searched again, minutes. */
    RESCAN_MINUTES: 30,
    /**
     * Plausible compressor draw per Hz (W/Hz). Steps outside are another load switching at the
     * same moment (a kettle, an EV charger) and are dropped before the median.
     */
    MIN_W_PER_HZ: 2,
    MAX_W_PER_HZ: 60,
    /** Steps needed before the measured figure replaces the estimate. */
    MIN_STEPS: 12,
    /** Steps kept: the most recent ones, so the figure follows the season. */
    MAX_STEPS: 120,
    /** Steps older than this are dropped, days. */
    RETENTION_DAYS: 21,
};

export const OPTIMIZATION_CONSTANTS = {
    MIN_SAVINGS_FOR_LEARNING: 0.05, // NOK/EUR etc
    MAX_RECONNECT_ATTEMPTS: 3,
    RECONNECT_DELAY_MS: 5000,
};
