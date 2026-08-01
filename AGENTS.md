# MELCloud Optimizer - LLM Agent Instructions

> **Last Updated:** December 8, 2025  
> Guidelines for AI agents working on this codebase.

---

## Project Overview

This is a **Homey app** that optimizes Mitsubishi Electric heat pump operation based on electricity prices, weather, and learned thermal characteristics. The goal is to maintain comfort while minimizing energy costs.

---

## Critical Rules

### 1. Control Philosophy
**ALWAYS control via room temperature targets, NOT flow temperature.**

```typescript
// ✅ CORRECT - adjust room setpoint (value from user settings)
SetTemperatureZone1: targetTemperature

// ❌ WRONG - never force flow temperature directly
SetHeatFlowTemperatureZone1: flowTemp
```

This preserves COP (efficiency) and aligns with Mitsubishi's control logic.

### 2. Safety Constraints (Never Bypass)

These constraints are **user-configurable** via the settings page. Always read them from settings:

```typescript
const settings = settingsLoader.loadConstraintSettings();
// settings.minSetpointChangeMinutes - Anti-cycling protection
// settings.deadband - Minimum change threshold
// settings.tempStepMax - Max change per cycle
```

**Never hardcode constraint values** - always use `SettingsLoader` to get user preferences.

### 3. Comfort Bands (Never Exceed)

Comfort bands are **user-configurable**. Always read from settings:

```typescript
import { getComfortBand } from './constraint-manager';

const band = getComfortBand(homey.settings, isOccupied);
// band.min - Lower limit (never go below)
// band.max - Upper limit (never exceed)
```

**Never hardcode temperature values** - users set their own comfort preferences.

### 4. COP Normalization

Always use `CopNormalizer.normalize()` for COP values. It:
- Filters outliers based on learned valid range
- Uses percentile-based bounds (learned over time)
- Persists state to settings

```typescript
const normalizedCOP = copNormalizer.normalize(rawCOP);
// Returns 0-1 value based on learned COP range
```

---

## Key Settings

All settings are **user-configurable** via the Homey settings page. Never assume default values - always read from `SettingsLoader`:

```typescript
const settingsLoader = new SettingsLoader(homey, logger);
const copSettings = settingsLoader.loadCOPSettings();
const priceSettings = settingsLoader.loadPriceSettings();
const constraintSettings = settingsLoader.loadConstraintSettings();
```

Full reference: [`documentation/SETTINGS_REFERENCE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/documentation/SETTINGS_REFERENCE.md)

---

## Trajectory-Aware Planning Bias

The planning bias (`computePlanningBias` in `src/services/planning-utils.ts`) is **trajectory-aware**:

- **Positive bias (+):** Applied when cheap prices are in the upcoming window → preheat opportunity
- **Negative bias (-):** Only applied when:
  1. Expensive prices exist in the **immediate window** (first 3 hours), AND
  2. Prices are **NOT trending downward** toward cheap periods
- **No bias (0):** When prices are declining toward cheap → wait rather than reduce temperature prematurely

This prevents the optimizer from lowering temperature during NORMAL price periods when cheap prices are coming soon. Instead, it waits for the cheap period to heat efficiently.

---

## Documentation

| Document | Purpose |
|----------|---------|
| [`ARCHITECTURE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/ARCHITECTURE.md) | System architecture |
| [`documentation/SETTINGS_REFERENCE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/documentation/SETTINGS_REFERENCE.md) | All configuration parameters |
| [`documentation/SERVICES_REFERENCE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/documentation/SERVICES_REFERENCE.md) | Service API reference |
| [`documentation/ALGORITHM_REFERENCE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/documentation/ALGORITHM_REFERENCE.md) | Optimization algorithms |
| [`documentation/MELCLOUD_API_REFERENCE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/documentation/MELCLOUD_API_REFERENCE.md) | MELCloud API patterns |
| [`documentation/USER_GUIDE.md`](file:///Users/kjetilvetlejord/Documents/mel/com.melcloud.optimize/documentation/USER_GUIDE.md) | End-user documentation |

---

## Do NOT

1. ❌ Bypass constraint manager for "urgent" changes
2. ❌ Store unbounded arrays in settings (use TTL/caps)
3. ❌ Call MELCloud API without circuit breaker
4. ❌ Force flow temperature as primary control
5. ❌ Ignore COP when planning heating strategy
6. ❌ Exceed comfort band limits to save money
7. ❌ **Hardcode any values** - temperatures, thresholds, timeouts, etc. must come from user settings or learned state
8. ❌ Assume default values - always read current user configuration via `SettingsLoader`

---

## Do

1. ✅ Persist learning state to settings
2. ✅ Log all optimization decisions with reasoning
