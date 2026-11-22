# MELCloud Optimizer - Settings Reference

> Complete reference for all configuration parameters in the MELCloud Heat Pump Optimizer.

**Last Updated:** December 4, 2025

> [!IMPORTANT]
> All settings listed below are **user-configurable** via the Homey settings page. The "Default" column shows initial values only - users can change these to match their preferences. Code must always read current values from `SettingsLoader`, never assume defaults.

---

## Automatic fine-tuning (14.0.80)

These settings live under **Fine-tuning (optional)** on the settings page and default to
**Automatic**: `deadband_c`, `curve_gate_off_offset_c`, `min_setpoint_change_minutes`, `temp_step_max`,
`preheat_cheap_percentile`, `tank_temp_step`, `temp_step_zone2`, `log_level`.

- Automatic means the key is **unset**; the app then uses the default from `src/constants.ts`
  (`COMFORT_CONSTANTS`, `PRICE_CONSTANTS`, `LogLevel.INFO`), read via `SettingsLoader` /
  service-manager. The page gets the same values from `GET /getSettingDefaults`; never copy
  defaults into the page.
- The page stores a value only when the user changes it, and clears it on "Use automatic".
  A stored value equal to the default is treated as Automatic (migration for users whose page
  previously saved every field).
- Readers must treat `undefined`, `null` and `""` as unset (`Number(null)` is 0).

## Automatic from Homey (14.0.81)

Empty means automatic for these; the app works them out itself and `GET /getSettingDefaults`
returns what it detected (`detected`) so the page can show it.

| Setting | Empty means | Code |
|---------|-------------|------|
| `latitude` / `longitude` | Location set in Homey (`homey:manager:geolocation`) | `getHomeLocation` (`src/util/home-location.ts`) |
| `time_zone_name` | Homey clock zone (`homey.clock.getTimezone()`); the manual offset only if neither exists | `getTimeZoneName` (`src/util/time-zone-helper.ts`) |
| `currency` | Home country's currency (time zone, then coordinates), else EUR | `CurrencyDetector.getCurrencyWithFallback` (`src/util/currency-detector.ts`) |
| `entsoe_area_eic` | Zone of the home: country, then nearest reference town for SE/NO/DK/IT; error (no prices) if unknown | `automaticZone` (`src/entsoe.ts`), `zoneAreaForLocation` (`src/util/entsoe-zone-locator.ts`) |
| `price_data_source` | Tibber when a Tibber token is set, else ENTSO-E; a stored value (older pages) wins, and the page clears it when the token changes | `getPriceSource` (`src/services/settings-loader.ts`) |
| `tibber_home_id` | Tibber's first home; the page preselects the home nearest the Homey (`suggestedHomeId`) for the user to confirm | `getTibberHomes` (`api.ts`) |
| `enable_zone2`, `min_temp_zone2`, `max_temp_zone2` | On (skipped on units without Zone 2); limits = Home comfort range | `getZone2Settings` (`src/services/settings-loader.ts`) |
| `occupancy_source` | Stored once at app start: `manual` if `occupied` was already stored (Flows/switch users), else `presence` | `migrateOccupancySource`, `syncOccupancyFromPresence` (`src/services/presence-service.ts`) |
| `enable_consumer_markup` | **On** for ENTSO-E (only an explicit `false` turns it off) | `consumerMarkupInPrices` (`src/services/settings-loader.ts`) |
| `consumer_markup_config` | Built-in table, in EUR, converted at the price FX rate | `DEFAULT_CONSUMER_MARKUP` (`src/services/consumer-markup-defaults.ts`) |

- Read currency, time zone and location only through these helpers; never `settings.get('currency')` directly.
- A stored copy of the built-in markup table (saved by pages before 14.0.81) counts as built-in,
  whatever `markup_currency_unit` says.
- With the markup on, a user `grid_fee_per_kwh` replaces the table's grid fee inside the price
  (added after VAT), so `gridFeeOnTopOfPrices` returns 0 and nothing adds it again.

### Home/away from presence

With `occupancy_source = 'presence'` the device poll (every 5 min) reads Homey users via
`homey-api` (`homey:manager:api`). Home = any enabled user with `present === true`. Only
*changes* in presence are written to `occupied`, so the `set_occupied` Flow card, the device
switch and the page override until the next arrival or departure. `manual` never reads presence.
Tank: MELCloud reports only the unit's maximum (`Device.MaxTankTemperature`), no minimum; the page
caps `max_tank_temp` at it.

### Comfort temperature (page only)

The page shows comfort temperature T and variation V; they write `comfort_lower_occupied = T − V`
and `comfort_upper_occupied = T + V`. Away and night follow the occupied range at
`COMFORT_CONSTANTS.DEFAULT_AWAY_OFFSET_C` / `DEFAULT_NIGHT_OFFSET_C` (2 / 1 °C lower) unless the
user enters their own values. The raw range keys are still what is stored and what the app reads.

## Temperature Zone Settings

### Zone 1 (Primary Heating)

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `comfort_lower_occupied` | 20.0°C | 15-25°C | Minimum temperature when home is occupied |
| `comfort_upper_occupied` | 21.0°C | 15-25°C | Maximum temperature when home is occupied |
| `comfort_lower_away` | 19.0°C | 15-25°C | Minimum temperature when away |
| `comfort_upper_away` | 20.5°C | 15-25°C | Maximum temperature when away |

### Zone 2 (Secondary Heating)

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `zone2_enabled` | false | boolean | Enable Zone 2 optimization |
| `min_temp_zone2` | 17.0°C | 15-25°C | Minimum Zone 2 setpoint |
| `max_temp_zone2` | 22.0°C | 15-25°C | Maximum Zone 2 setpoint |
| `temp_step_zone2` | 0.5°C | 0.5-1.0°C | Step size for Zone 2 adjustments |

### Hot Water Tank

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `tank_min` | 40°C | 35-60°C | Minimum tank temperature |
| `tank_max` | 55°C | 40-70°C | Maximum tank temperature |
| `tank_step` | 1.0°C | 0.5-2.0°C | Step size for tank adjustments |

---

## Safety & Constraint Settings

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `min_setpoint_change_minutes` | 30 | 1-180 min | Minimum time between setpoint changes (anti-cycling) |
| `deadband_c` | 0.5 | 0.1-2.0°C | Minimum temperature change threshold |
| `curve_gate_off_offset_c` | 1.0 | 0.5-2.0°C | Curve mode: room above target at which the unit stops heating. Coasting targets go this far below the room, and writes are only held as no-ops when the room is this far above both targets |
| `temp_step_max` | 0.5 | 0.5-1.0°C | Maximum temperature step per cycle |

---

## COP (Coefficient of Performance) Settings

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `cop_weight` | 0.3 | 0-1 | How much COP influences optimization decisions |
| `auto_seasonal_mode` | true | boolean | Auto-detect summer/winter based on date |
| `summer_mode` | false | boolean | Manual summer mode override |

---

## Price Settings

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `preheat_cheap_percentile` | 0.25 | 0.05-0.5 | Threshold for "cheap" electricity (25th percentile) |
| `grid_fee_per_kwh` | 0 | 0+ | Fixed grid fee added to spot price (local currency/kWh) |
| `currency_code` | NOK | string | Display currency (NOK, SEK, EUR, etc.) |

### Price Provider Selection

| Setting Key | Values | Description |
|-------------|--------|-------------|
| `price_provider` | `tibber`, `entsoe` | Which API to fetch prices from |
| `tibber_api_key` | string | Tibber API token (required for Tibber) |
| `entsoe_area_eic` | string | ENTSO-E bidding zone EIC code |
| `entsoe_security_token` | string | ENTSO-E API token (optional, has default) |

### Consumer Markup (ENTSO-E Only)

| Setting Key | Default | Description |
|-------------|---------|-------------|
| `enable_consumer_markup` | false | Add retailer markup to spot prices |
| `consumer_markup_config` | JSON | Markup configuration (tiered pricing) |
| `markup_currency_unit` | LOCAL | Markup currency (LOCAL or EUR) |

---

## Timezone Settings

| Setting Key | Default | Range | Description |
|-------------|---------|-------|-------------|
| `time_zone_offset` | 1 | -12 to 14 | UTC offset in hours |
| `use_dst` | false | boolean | Adjust for daylight saving time |
| `time_zone_name` | "" | IANA name | e.g., "Europe/Stockholm" |

---

## Occupancy State

| Setting Key | Default | Description |
|-------------|---------|-------------|
| `occupied` | true | Current home/away state |

---

## Thermal Model Storage Keys

These are internal storage keys managed by the thermal learning system:

| Key | Description |
|-----|-------------|
| `thermal_model_characteristics` | Learned thermal properties (heatingRate, coolingRate, thermalMass, confidence) |
| `thermal_model_data` | Raw thermal data points (capped at 356 points) |
| `thermal_model_aggregated_data` | Aggregated thermal data (capped at 307 points) |

---

## COP Tracking Storage Keys

| Key | Description |
|-----|-------------|
| `cop_guards_v1` | COP normalization state (min/max observed, history) |
| `cop_snapshots_daily` | Daily COP snapshots |
| `cop_snapshots_weekly` | Weekly COP aggregates |

---

## Adaptive Learning Storage Keys

| Key | Description |
|-----|-------------|
| `adaptive_business_parameters` | Learned price sensitivity, COP thresholds, learning cycles |

---

## Savings & Metrics Storage Keys

| Key | Description |
|-----|-------------|
| `savings_history` | Daily savings records (30-day rolling) |
| `display_savings_history` | Formatted savings for UI display |
| `orchestrator_metrics` | Optimization run statistics |

---

## State Tracking Keys

| Key | Description |
|-----|-------------|
| `last_setpoint_change_ms` | Zone 1 last change timestamp |
| `last_issued_setpoint_c` | Zone 1 last issued setpoint |
| `last_zone2_setpoint_change_ms` | Zone 2 last change timestamp |
| `last_zone2_issued_setpoint_c` | Zone 2 last issued setpoint |
| `last_tank_setpoint_change_ms` | Tank last change timestamp |
| `last_tank_issued_setpoint_c` | Tank last issued setpoint |

---

## Hot Water Learning Storage Keys

| Key | Description |
|-----|-------------|
| `hot_water_usage_data` | Raw hot water usage data points |
| `hot_water_aggregated_data` | Aggregated usage patterns |
| `hot_water_usage_patterns` | Learned peak hours and demand curves |

---

## Debug & Development

| Setting Key | Description |
|-------------|-------------|
| `verbose_logging` | Enable detailed logging |
| `DEBUG_OPT_EXPORT` | Export optimization data as JSON snapshot |

---

## See Also

- [USER_GUIDE.md](./USER_GUIDE.md) - End-user documentation
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- [SERVICES_REFERENCE.md](./SERVICES_REFERENCE.md) - Service documentation
