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
    DEFAULT_DEADBAND: 0.5,
    DEFAULT_MIN_SETPOINT_CHANGE_MINUTES: 30,
};

export const OPTIMIZATION_CONSTANTS = {
    MIN_SAVINGS_FOR_LEARNING: 0.05, // NOK/EUR etc
    MAX_RECONNECT_ATTEMPTS: 3,
    RECONNECT_DELAY_MS: 5000,
};
