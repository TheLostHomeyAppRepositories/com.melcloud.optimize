# Branch: `fix/curve-mode-and-learning-guards`

> **Status:** Phases 1, 2 and 3 complete and deployed as a dev build (14.0.64). Phases 4 and 5 open.
> **Baseline for comparison:** `main` / App Store build **14.0.54**.
> **Investigation date:** 2026-08-01. All live figures below were measured on the author's Homey Pro, not estimated.

This document exists so that a future agent or developer can pick this branch up without
re-deriving the investigation, and so the changes can be A/B tested against `main` honestly.
It records what was measured, what was changed, **what turned out to be wrong**, and what is
still unverified.

---

## 1. TL;DR — what was actually broken

The app looked healthy (100% model confidence, "Highly reliable", 5546 learning cycles, savings
displayed daily) while five independent defects compounded:

1. **The optimizer read the wrong setpoint field.** `deviceState.SetTemperature` (an ATA-shaped
   field, sitting at 29 °C) was read in preference to `SetTemperatureZone1` (the real ATW zone-1
   room target, 21 °C).
2. **That poisoned the thermal model.** `targetDiff = 29 − 23.5` stayed permanently positive, so
   the heating-rate regression collected samples of the room drifting for unrelated reasons and
   learned `heatingRate = −0.23` (physically impossible), which pinned the K-factor at its floor.
3. **Summer sunshine trained the optimizer to ignore electricity price.** Solar gain pushes the
   room above the comfort band; that counted as a "comfort violation" attributed to the
   optimizer, which multiplied the seasonal price weight by 0.98 every hour. Measured result:
   every learned control parameter pinned at a bound.
4. **The hot water tank could not complete an arbitrage.** A 1 °C-per-run ramp cap meant a
   full-range move took ~20 hourly writes — longer than any cheap window — while still writing a
   setpoint every hour.
5. **The savings display mixed up two quantities**, so "Last 7 days" and the monthly projection
   were showing electricity *cost* labelled as savings.

None of these were visible from the UI. Several are still present on `main`.

---

## 2. Live measurements (the evidence)

All from `homey api raw --path /api/app/com.melcloud.optimize/<endpoint>` on 2026-08-01.
**Keep these — they are the "before" side of any A/B test.**

### Device (via Homey `list_devices`, device `7d4553a1-…` "Heatpump")

```
thermostat_mode:            "curve"     -> OperationModeZone1 = 2
target_temperature:          29         <- this is deviceState.SetTemperature
SetTemperatureZone1:         21         <- the real zone-1 room target
target_temperature.tank:     44
measure_temperature:         23.5       (room)
measure_temperature.tank:    34.5
measure_temperature.outdoor: 17
operational_state.zone1:    "idle"
heating_cop:                 0.69
hotwater_cop:                2.97
```

### Learned state, before any fix (`getModelConfidence`)

```
learningCycles:         5546        confidence: 1
priceWeightSummer:      0.20   (default 0.7)  <- AT FLOOR
priceWeightTransition:  0.20   (default 0.5)  <- AT FLOOR, and this is the season in use
priceWeightWinter:      0.90   (default 0.4)  <- AT CEILING
preheatAggressiveness:  0.5    (default 2.0)
coastingReduction:      0.5    (default 1.5)
boostIncrease:          0.2    (default 0.5)

thermalModel: heatingRate -0.23098, coolingRate 0.10282,
              thermalMass 0.62077, modelConfidence 1
dataRetention: thermalRawPoints 336, thermalAggPoints 1104
```

A committed snapshot in `cleaned_data_for_visualization.json` shows these were still at their
defaults at 107 cycles (2025-10-19), so the drift happened over roughly 9 months of operation.

### Energy (`getCOPData`, daily totals normalised per day)

```
TotalHeatingConsumed  1.766 kWh    TotalHeatingProduced  1.221 kWh   -> COP 0.69
TotalHotWaterConsumed 1.467 kWh    TotalHotWaterProduced 4.363 kWh   -> COP 2.97
```

### Prices on the day (Tibber, SE)

```
min 0.234375   max 0.512225   avg 0.43513   SEK/kWh (spot)
spot ratio      2.19x
delivered ratio ~1.26x   (see section 5 — this is the number that matters)
```

### Savings display (`getModelConfidence.smartSavingsDisplay`)

```
today: 8.51   last7: 18.07   projection: 77.44   seasonMode: "transition"
today's history entry: valueMajor 1.67, baselineMajor 10.18, optimizedMajor 8.51
```

### DHW learned peaks (before)

```
peakHours: 0, 19, 20, 21, 23
hourlyUsagePattern range 0.394 - 1.485 (weak, only 1.3-1.5x above mean)
06-08 were TROUGHS (0.508 / 0.508 / 0.600) despite the seeded prior putting a morning peak there
```

---

## 3. Root causes, with file references

| # | Defect | Location | Why it mattered |
|---|---|---|---|
| R1 | ATA field read before ATW field | `src/services/optimizer.ts` `collectOptimizationInputs` | Source of the 29 °C, and of R2 |
| R2 | Heating-rate regression accepts negative samples | `src/services/thermal-model/thermal-analyzer.ts` (`rate = (tempChange/timeDiff)/targetDiff`, `tempChange` unguarded) | Learned an impossible negative heating rate |
| R3 | Comfort violations attributed with no causal link | `src/services/comfort-violation-tracker.ts` (counts `t > maxTemp`) → `src/services/adaptive-parameters.ts` `learnFromOutcome` (`*= 0.98`, clamped `[0.2, 0.9]`) | Ratcheted every learned parameter to a bound |
| R4 | Tank ramp cap equals the rounding step | `src/services/optimizer.ts` `optimizeTank` | Arbitrage structurally impossible |
| R5 | `maintain` resolved a memoryless band fraction | `src/services/optimizer.ts` `optimizeTank`; `src/services/hot-water/hot-water-analyzer.ts` `getOptimalTankTemperature` | Hourly churn on price-level boundary crossings |
| R6 | `scheduledTime` produced but discarded | `src/services/hot-water-optimizer.ts` (producers) → `optimizer.ts` (consumer typed it away) | "Delay to the cheap hour" never happened |
| R7 | Usage learned from reheat, not draw | `src/services/hot-water/hot-water-service.ts` (`DailyHotWaterEnergyProduced`) → `hot-water-analyzer.ts` | Closed a feedback loop on the controller's own schedule |
| R8 | Savings written into a field named for cost | `api.ts` (`entry.optimizedMinor = toMinor(finalDailySavings)`) vs reader (`baselineMinor − optimizedMinor`) | 7-day and projection figures are `min(baselineCost, actualCost)` |
| R9 | Savings accrued with no physical effect | `src/services/optimizer.ts` `calculateCombinedSavings` no-change path, no `heatDemandHold` check | Fabricated reward fed back into the learner |
| R10 | Ramp limiting runs before the deadband test | `src/util/setpoint-constraints.ts` | `deadband_c > temp_step_max` froze zone1 permanently — UI-reachable |
| R11 | Confidence is count-only, never falls | `thermal-analyzer.ts` `min(1, points/168)`, `adaptive-parameters.ts` `min(1, cycles/100)`, `hot-water-analyzer.ts` `min(100, points/168*100)` | "100% / Highly reliable" measures elapsed time, not accuracy |
| R12 | Season detector too permissive | `src/services/energy-metrics-service.ts` `determineSeason` | Still returns `transition` in midsummer — see section 6 |

---

## 4. What this branch changed

Commits, oldest first. All were deployed as dev builds and verified live.

### `cf58410` — stop learning from bad data (Phase 1)

- **`optimizer.ts`**: `currentTarget` now prefers `SetTemperatureZone1` over `SetTemperature`
  (`??`, which also closes a falsy-zero hole). Fixes R1. **This is the single highest-value line
  in the branch.**
- **`optimizer.ts`**: thermal data collection skipped unless zone 1 is in Room mode. New helper
  `src/util/zone-mode.ts` (`isRoomTargetMode`, `describeZoneMode`). Devices that do not report
  `OperationModeZone1` are treated as Room, so ATA and older firmware are unaffected. Fixes R2's
  input path.
- **`optimizer.ts`** `calculateCombinedSavings`: comfort violations are only attributed when
  `applied.zone1Applied && !zone1Result.heatDemandHold`. The tracker is still drained so the
  sample buffer cannot grow. Fixes R3.
- **`setpoint-constraints.ts`**: ramp cap can never be smaller than the deadband. Plus a clamp in
  `settings-loader.ts` following the existing night-setback cross-field precedent. Fixes R10.
- **`api.ts`**: `getModelConfidence` now returns the stored price weights and strategy
  parameters, so drift is observable rather than inferred.

### `a7bb698` + `3784e67` — reset capability

- `AdaptiveParametersLearner.resetLearnedParameters()`, `ThermalAnalyzer.resetCharacteristics()`,
  `ThermalModelService.resetModel()`, `Optimizer.resetLearnedState()`.
- `POST /reset-learned-state`, body `{ clearThermalData?, clearHotWaterPatterns? }`.
- **Operates on Homey settings directly**, because `requireOptimizer()` throws before the first
  hourly run — i.e. exactly when recovery is most needed. In-memory copies are also reset when
  the optimizer happens to be live, otherwise they would be written back over the settings.

### `14.0.58` — tank can reach its target

- Ramp cap decoupled from the rounding step:
  `max(tankConstraints.tempStep, COMFORT_CONSTANTS.DEFAULT_TANK_MAX_DELTA_PER_CHANGE)` (4 °C).
  **Not unbounded** — see section 5 on the resistance element. Fixes R4.
- `MAINTAIN_TANK_HYSTERESIS_C = 2.0`: on a `maintain` signal the tank holds unless the adaptive
  target has drifted at least 2 °C. Fixes R5. **These two must ship together** — widening the
  ramp without hysteresis converts a ±1 °C hourly flutter into a ±20 °C hourly slam.

### `14.0.59` — reheat commitment and spread gate

- Pattern scheduler now emits `scheduledTime` on `delay`; optimizer passes it through;
  `optimizeTank` persists it to `dhw_scheduled_reheat_ms` and honours it when due, overriding the
  instantaneous price classification. 90-minute staleness grace. Fixes R6.
- New `src/util/price-spread.ts` (`analysePriceSpread`). Gates DHW scheduling on whether the
  spread is worth acting on **at the delivered price**, and separates two thresholds:
  `worthRetiming` (absolute spread) and `worthSpendingExtraEnergy` (delivered ratio).

### `14.0.60` / `14.0.61` — draw-based learning

- New `src/util/dhw-draw.ts` (`estimateHourlyDraw`, `normaliseDrawPattern`). Usage is derived
  from tank temperature falling **while the pump is idle**, with a standing-loss allowance
  (default 0.4 °C/h) subtracted. Fixes R7.
- DHW confidence now counts usable draw intervals instead of stored samples. The old denominator
  assumed hourly sampling while collection runs every 5 minutes, so it reported 100% after ~14
  hours. Partially fixes R11.
- `clearHotWaterPatterns` added to the reset endpoint.

**Test coverage added:** `test/unit/zone-mode.test.ts`, `test/unit/price-spread.test.ts`,
`test/unit/dhw-draw.test.ts`, the `maxDeltaPerChangeC` block in
`test/unit/setpoint-constraints.test.ts` (which had **zero** coverage before — that is why R10
shipped), and four tank-reheat-commitment tests in `test/unit/optimizer.enhanced.coverage.test.ts`.

Suite: **1040 passing, 0 failing.** `npm run lint` (= `tsc --noEmit`) clean.

### `14.0.62` — the ratchet's other arm, season, and draw estimation

Found by running the previous release for 24 hours and reading the live data back.

- **The ratchet was still running, inverted.** Fixing the comfort arm left `goodSavings` true
  every cycle, because the hold path still accrued savings against a `maxTemp` baseline.
  Measured: `priceWeightSummer` walked 0.7 → 0.8202 in 8 cycles (exactly `1.02^8`). Learning now
  requires an actuator to have moved, and the zone-1 hold accrual is skipped under
  `heatDemandHold`. **Consequence: learning is dormant in summer.** That is correct — there is no
  outcome to learn from — but confirm it resumes in autumn.
- **Learning updated a parameter the controller does not read.** `calibration-service` picked the
  season by calendar month (August → summer) while control used `determineSeason` (→ transition).
  The control season is now threaded through, calendar kept as fallback.
- **`determineSeason` now tests efficiency** (`produced/consumed < 1.5 → summer`), not just
  absolute kWh. Fixes R12.
- **Draw estimator rewritten.** The first version had two flaws: a fixed 0.4 °C/h standing-loss
  allowance under-estimated this tank so overnight cooling read as draw, and excluding every
  heating interval discarded real draws — because a draw *triggers* the reheat that then masks
  it. Standing loss is now calibrated from the tank's own idle behaviour (a low percentile of
  idle fall rates) and falls faster than 3 °C/h count as draw regardless of heating state.

Live result after 24h: peaks moved from `02, 04, 05, 07, 23` (spread 1.9×10⁷) to
`09, 16, 17, 20, 23` (spread 12.8×) with an overnight trough at 02-08. Household-shaped.

### `14.0.63` — the savings display (Phase 2, part 1)

`optimizedMinor` held the *saving* while its name and every reader treated it as a *cost*, so
`baselineMinor - optimizedMinor` computed `cost - saving` — the quantity summed into the 7-day
total and the monthly projection. Meanwhile the "today" tile read `optimizedMajor` directly, so
the two tiles on one card reported different quantities. `optimizedMinor` now holds the cost;
entries carry `schemaVersion` so v1 entries are read from their (correct) `valueMajor` rather
than silently rewritten to a different wrong number.

Also: the widget rendered a `%` suffix on a currency-per-day figure via a rounding idiom whose
factors cancel; and the caption claimed "seasonal COP adjustments" that
`calculateHeatingEnergy`/`calculateHotWaterEnergy` never apply.

### `14.0.64` — the baseline, price resolution, and the headline (Phase 2, part 2)

- **Phantom summer heating removed.** `BaselineConfig.spaceHeatingActive` drives the
  space-heating term to zero when the season is summer. Previously ~3.5 of a 6.5 kWh/day
  baseline was heating that never happened — over half the displayed "saving" — against an
  actual consumption of 3.23 kWh/day.
- **Quarter-hour ranking mismatch fixed.** `current` was a raw 15-minute price ranked against
  hourly means. A rising quarter can exceed the mean of every hour and score percentile 100 on an
  ordinary day (observed: 0.5168 against a window max of 0.512225 → VERY_EXPENSIVE). `current` is
  now the hourly bucket; the raw value is published as `currentQuarter`.
- **`LEARNING_ADJUST` requires an actual temperature change**, so a hold is no longer titled
  "Adjusting to 21.0 °C" above a body reading "Room: Holding 21.0 °C".

---

## 5. Validated domain knowledge

Researched against academic literature, product prior art and Ecodan-specific sources. **This is
the part most expensive to re-derive — read it before changing any control logic.**

### Optimize the delivered price, not spot

Swedish delivered ≈ `(spot + energiskatt ~55 öre + nät ~25 öre) × 1.25`. The fixed per-kWh adder
is identical in every hour, so it compresses ratios dramatically. On this house:

```
spot      0.2344 -> 0.5122   =  2.19x
delivered 1.0844 -> 1.3622   =  1.26x
```

The app has a `grid_fee_per_kwh` setting but **omits it from the decision path** — it is used only
in savings accounting. Every ratio test therefore runs on a base ~0.85 SEK/kWh too low.

**But the two questions need different tests:**

- **Retiming** the same kWh to a cheaper hour: the adders cancel entirely. What matters is the
  **absolute spread**, and break-even is only whatever covers standing loss (~1.03–1.05 ratio).
- **Spending extra energy** (preheating, raising tank temperature): the extra kWh is bought at
  full delivered price, so break-even is the **delivered ratio ≥ 1 + energy penalty**.

`analysePriceSpread` encodes exactly this distinction.

### Break-even table

| Action | Required delivered ratio | At this house's 1.26x |
|---|---|---|
| DHW retiming, unchanged setpoint | 1.03–1.05 | pays easily |
| Space-heat coasting / down-shift | ~1.00 | pays, and saves energy |
| Space-heat preheat +1 K | 1.17–1.30 | marginal |
| DHW raising 48→55 °C | ~1.20 | marginal |
| Aggressive preheat +2 K | ~1.44 | loses money |

### Coasting beats preheating — the strongest signal in the literature

Foteinaki et al. (2020), *Energy & Buildings* 220:109804: setback-only scenarios cut cost 11–12%
**and energy 5–6%**. Preheating scenarios cut cost 6–9% but **increased energy 1.5–3.5%**. The
optimum was preheating *only* when price is in the bottom quartile: −12% cost at ~0% energy
penalty. Kelly et al. (2014) showed the failure mode at the extreme: full off-peak-only buffering
cost **+61% energy** and needed a 1.6:1 ratio it never got.

Tibber's published envelope is **−3 K down / +1 K up**, a 3:1 asymmetry. Copy that shape.

### COP penalty per Kelvin

Sources disagree: **2–2.5 %/K** from Ecodan ErP data and Carnot (PUZ-WM50VHA: SCOP 4.58 @ 35 °C
vs 3.33 @ 55 °C) versus **~3 %/K** from Fraunhofer field data on 58 systems (SPF falls 0.10–0.13
points per K). Use 2–3 %/K; being conservative biases against over-boosting.

Counterintuitive and important: **sensitivity is higher in mild weather**, and cheap hours are
often cold hours — the worst COP for an air-source unit. Any COP weighting must use the
**forecast ambient at the shifted hour**, not the current COP.

### DHW specifics

- Ecotope/CEC lab data: tank COP falls **2.8 → 1.8 from 51.7 °C to 68.3 °C** (2.6 %/K), steeper
  than Carnot because compressors hit pressure-ratio limits.
- **A large setpoint jump can bring the resistance element in.** This is why
  `DEFAULT_TANK_MAX_DELTA_PER_CHANGE` is 4 °C and not unbounded.
- Savings got *worse* above a ~57 °C max setpoint in that study.
- Tanks beat building fabric as storage — smaller losses. Fabric-only shifting saved **EUR 2–23
  per year** in an Austrian stock study.

### Realistic savings

**500–1,500 SEK/year**, concentrated in a minority of volatile days. The Ngenic/GodEl n=500 villa
study splits 24% (hourly-price customers) vs 20% (fixed-price), which means **price arbitrage is
worth ~4 percentage points; the other ~16 is control quality.** Vendor claims of 20–30% usually
measure reduction in average purchase price, not the bill. Do not print optimistic numbers in the
UI — Ngenic and CTC both got user backlash for exactly that.

### Curve mode (this device's configuration)

Verified against pymelcloud, openHAB, OlivierZal `melcloud-api`, homebridge-melcloud-control and
the reverse-engineered CN105 FTC serial protocol:

```
OperationModeZone1:  0 = Room, 1 = Flow, 2 = Curve, 3 = Cool Room, 4 = Cool Flow, 5 = Floor Dry
EffectiveFlags:      SetTemperatureZone1  0x200000080   (= 0x200000000 | 0x80)
                     OperationModeZone1   0x8
                     flow temperatures    0x1000000000000  (all four share one flag)
                     SetTankWaterTemperature 0x1000000000020
```

- `SetTemperatureZone1` **is a room temperature**, valid range 10–30 °C. It is *not* a flow
  temperature and *not* a curve offset.
- **There is no remote curve offset — not in MELCloud, and not even in the local serial
  protocol.** The two serious open-source Ecodan projects (CN105-to-MQTT, esphome-ecodan-hp) both
  force the unit into *Fixed Flow* mode and reimplement weather compensation themselves.
- ~~Therefore, while the unit stays in Curve mode, space-heating price optimization has no lever.~~
  **Refuted 2026-10-13.** With a room sensor fitted, `SetTemperatureZone1` works as a room
  thermostat in Curve mode: the curve sets flow temperature, the setpoint gates heating on/off.
  Live test: room 22.5 °C, setpoint 21 °C, unit idle; setpoint raised to 24 °C at 17:23, unit
  reported heating at the next poll (17:28) with DHW idle. The previous 24 h fit the same model
  (17–21 down-shift below the room coasted ~1 K; 14–15 raise kept heating on in cheap hours;
  01–04 raise to 23 °C on a 3 °C night added nothing because heating was already on).
  So **coasting works; preheating is "keep the curve running", not "more power"**. The owner keeps
  Curve mode on purpose (cheaper to run than Room mode) — do not propose switching.
  Note: Device/Get lacks `Zone1InHeatMode`, which left the Homey `operational_state.zone1`
  capability stuck on idle. Fixed 2026-10-23: `getZoneOperationalState` (`src/util/zone-mode.ts`)
  takes heat mode from `OperationModeZone1` when the flag is missing, and reads heating only
  while the unit space-heats and `IdleZone1` is false.

---

## 6. The season bug (unfixed, still open)

`determineSeason` in `energy-metrics-service.ts` still returns `transition` in midsummer. The
`heatingProduced < 0.5 kWh → summer` guard **is deployed and is passed a value on both call
paths** — it simply does not fire:

```
heatingProduced 1.221 > 0.5           -> guard misses
heatingConsumed 1.766 > 1.0           -> not summer
1.766 < 1.467 x 2 = 2.93              -> not winter
                                      -> transition
```

The pump reports ~1.2 kWh/day in the Heating bucket at 17 °C outdoor, at a **heating COP of
0.69** — producing less heat than the electricity it consumes, i.e. standby and short-cycling,
not heating.

**Recommended fix: discriminate on efficiency, not absolute kWh** —
`heatingProduced / heatingConsumed < ~1.5 → summer`. Raising the kWh threshold to ~1.5 also works
but is more brittle.

Secondary: the widget reads `smartSavingsDisplay.seasonMode` (today's entry in
`display_savings_history`), **not** the top-level `seasonalMode` (which is the weather >15 °C rule
and correctly said "summer"). `api.ts` accepts the newest of 30 stored entries with no recency
check, so a stale value persists. There are **five independent season detectors** in the codebase
with different rules — energy, weather, `cop-helper` calendar months 4–8, `calibration-service`
months 5–8, and `fixed-baseline-calculator` outdoor <10/>20.

---

## 7. How to compare this branch against `main`

`main` / App Store is **14.0.54**. This branch is **14.0.61**.

### Honest caveat, read first

**A clean numeric A/B is no longer possible on this device.** The learned state was reset on
2026-08-01 (price weights, strategy parameters, thermal model, thermal data, DHW pattern). The
`main` build's behaviour depended on parameters that had drifted to their bounds over ~9 months;
that state cannot be restored, and re-creating it would take months of running the bug.

Compare **behaviour**, not headline savings.

### What to measure

| Question | Where to look | Expected on this branch |
|---|---|---|
| Is the ratchet fixed? | `getModelConfidence.adaptiveParameters.priceWeight*` over days | Stays near defaults; does **not** trend to 0.2 |
| Is the thermal model sane? | `getModelConfidence.thermalModel.heatingRate` | Null while in Curve mode (collection skipped). If it ever populates, it must be **positive** |
| Is the tank churning? | Count `setTankTemperature` calls per day in the app log | Should fall sharply vs `main` |
| Does delay-to-cheap-hour happen? | Log line `Tank reheat commitment is due`; setting `dhw_scheduled_reheat_ms` | Should appear; never did on `main` |
| Are DHW peaks plausible? | `getModelConfidence.hotWaterPatterns.hourlyUsagePattern` | Should show household-shaped peaks (morning/evening), not the app's own heating hours |
| Does the flat-day gate work? | Log line `DHW scheduling held: price spread too small` | Fires on low-spread days |

### Quick check

```bash
npm run check:health
```

`scripts/check-optimizer-health.mjs` reads the live device and reports PASS/WARN/FAIL on the
signals this branch was meant to change: price weights pinned at a bound, strategy parameters
collapsed, a negative heating rate, a night-heavy DHW peak profile (the signature of the old
reheat-derived signal), the season-detector disagreement, and the unfixed savings field mixup.
Exit code 1 if anything FAILs.

Note: the Homey CLI exits before flushing a piped stdout, truncating responses at 8 KB. The
script redirects to a temp file instead — do the same in any new tooling.

### Endpoints

```bash
homey api raw --path /api/app/com.melcloud.optimize/getModelConfidence
homey api raw --path /api/app/com.melcloud.optimize/getThermalModelData
homey api raw --path /api/app/com.melcloud.optimize/getCOPData
homey api raw --method POST --path /api/app/com.melcloud.optimize/reset-learned-state \
  --body '{"clearThermalData":true,"clearHotWaterPatterns":true}'
```

**Cold-start gotcha:** most endpoints throw `Optimizer service not initialized` until the first
hourly cron run. `reset-learned-state` works regardless by design; others do not.

### Deploying

```bash
npm run lint                                   # tsc --noEmit, ~1s incremental
npx jest --config jest.config.unit.js --coverage=false   # ~8s, 1040 tests
# bump BOTH app.json and .homeycompose/app.json, and add a .homeychangelog.json entry
npx homey app install
```

**Version bump discipline matters.** The June 2026 season fix was written, tested and committed
but the version was never bumped, so it never reached any device — the repo sat at 14.0.53 while
the installed app was 14.0.54. Always bump past the installed version.

---

## 8. Hypotheses that were investigated and REFUTED

Recorded so nobody re-derives them. Each of these was believed at some point during this
investigation and turned out to be wrong.

| Claim | Verdict |
|---|---|
| "29 °C is a flow/water temperature" | **Wrong.** `SetTemperatureZone1` is a room temperature (10–30 °C). The 29 was `deviceState.SetTemperature`, an ATA-shaped field the optimizer should never have read. |
| "29 °C is the tank setpoint leaking into the room field" | **Wrong.** Tank bounds are validated 30–70; 29 cannot be a tank value. Tank setpoint was 44 °C. |
| "The June season fix was never deployed" | **Wrong.** 14.0.54 is installed and contains it. The guard's threshold is simply too low. |
| "`hasZone1: false` / `hasTank: false` proves capability gaps" | **Wrong.** `api.ts` derives these from the ListDevices wrapper rather than `Device/Get`. False negatives. |
| "Percentile ranking guarantees VERY_EXPENSIVE at 23:00" | **Wrong.** Today+tomorrow prices are concatenated, so the window holds ~26 points at 23:00. It is smallest around midday. |
| "The price term is inert, so price can never move the setpoint" | **Half wrong.** The deadband applies to the summed proposal, not the price term alone. The formula is right; the conclusion does not follow. |
| "The cooling-rate branch is starved" | **Wrong.** `coolingRate` 0.103 differs from its 0.2 default, so it is being learned. |
| "The learner drifts upward (over-aggressive)" | **Wrong direction for summer.** Room-above-band counts as a comfort violation, so the `×0.98` branch wins and it drifts **down**. Winter drifts *up* to the ceiling because solar overshoot does not occur. |
| "Removing the tank ramp cap entirely is safe" | **Wrong.** Large setpoint jumps can trigger the resistance element. Raised to 4 °C, not removed. |
| "The spread is 2.19x so preheating pays easily" | **Wrong.** That is the *spot* ratio. Delivered is ~1.26x, which is marginal for preheating. |
| "This device's capacity tariff needs handling" | **Not applicable.** The user has no peak shaving; the "Peak Shaving Status" Homey device belongs to a separate experimental app. Sweden scrapped the effektavgift mandate 2026-03-13. |

---

## 9. Still open

**Phase 2 — the dishonest numbers** (highest remaining value):
- R8: `optimizedMinor` holds savings; reader computes `baseline − optimized`. Fix the field
  semantics so "today" and "last 7 days" read the same quantity.
- R9: gate savings accrual on `heatDemandHold` / `zone1Applied`.
- `model-confidence-shared.js` fabricates a `%` on a SEK/day figure via a `×100` then `/100` that
  cancels.
- `fixed-baseline-calculator.ts` charges ~3.5 kWh/day of phantom summer space heating (~54% of
  the displayed baseline).
- The UI caption claims "seasonal COP adjustments"; `calculateHeatingEnergy` and
  `calculateHotWaterEnergy` accept COP parameters and **never read them**.

**Phase 4 — space heating.** Unblocked 2026-10-13: the setpoint is an on/off thermostat gate in
Curve mode (see section 5). The existing setpoint logic already behaves correctly under that
reading ("heat until X"). Remaining work: learn the cooling rate during thermo-off periods (thermal
collection is still skipped outside Room mode, so preheat confidence stays 0) and use it to size
coasting. **Never switch a user's mode silently.**

**Also 2026-10-13 (14.0.69–70):**
- The FTC does not start a DHW reheat on tank deficit alone (tank 16–19 °C under target for hours,
  pump idle) but starts within minutes of a setpoint *raise*. `optimizeTank` now raises the tank
  setpoint one step when the tank is below the user minimum.
- The displayed daily saving is now measured, not modelled: `src/util/run-price-ledger.ts` records
  per-hour run share (each poll) and price (each hourly run); saving = energy × (average price −
  run-weighted price). The modelled baseline had shown 45–60 SEK/day. Pre-v3 history entries are no
  longer counted.

**2026-10-14 (14.0.71–72):**
- Savings also include an energy part against a normal pump at the comfort-band midpoint
  (steady-state degree-hours from polled room/outdoor temperature).
- First full measured night: the pump ran flat out 07–09 at 2.33 SEK/kWh with room 21.5 / target 22.
  The coast branch never fired: it needed a top-~20 % price and `room > target − 0.5` (strict, so
  21.5 vs 22 failed). Coasting now uses the controller's own expensive threshold, requires headroom
  above the comfort minimum, and sets the target below the room (gate) but never below the minimum.
- `applySetpointConstraints` re-clamps after step rounding (tank max 53 on a 2 °C grid had become 54).
- Yesterday's savings entry is finalised after midnight (its last hour was dropped); the projection
  and daily average use completed days only; the reader uses the local date, not UTC.

**2026-10-14 (14.0.73–74):**
- Measured savings no longer score weather: the normal pump's heating is priced at the
  demand-weighted price (Σ price·(baseline − outdoor)⁺), and room excess above the midpoint counts
  only in proportion to the pump's run share.
- Thermal data is collected in every zone mode again, tagged `roomTargetMode`. Non-Room points teach
  only the cooling rate, from whole heating-off stretches of ≥ 2 h (`coolingRatesFromStretches`), so
  0.5 °C sensor quantisation no longer biases the rate upwards. The heating rate is never learned
  outside Room mode. `modelConfidence` is still a point count, not accuracy.
- 14.0.76: Curve/Flow mode also learns `curveWarming`: net room warming (°C/h) from heating-on
  stretches, binned by outdoor temperature (2 °C), rebuilt from stored points each update. The
  preheat gate caps the storable heat at one hour of learned warming and blocks preheat when the
  curve only holds the room; with no data within ±2 °C it keeps the old estimate.

**2026-10-24:**
- Zone writes that cannot change the gate are held (`isThermostatChangeInert`, `src/util/zone-mode.ts`):
  Curve mode only (Flow was never measured). The room must be more than the margin below (or above)
  the current target, this run's ramp step *and* the target the optimizer wants before the ramp, or a
  multi-step ramp across the room would be held forever. Margin = max(deadband, learned curve warming
  per hour). No baseline saving is booked while held with the thermostat on. Live the night before:
  23 ↔ 24 °C four times with the room at 21.5 °C.
- Forced hot water was requested at 21:00, 22:00 and 23:00 with the tank at 27 °C and did nothing;
  the 00:00 request worked, ten minutes after the zone target dropped to the room temperature.
  Unexplained. A request 50 min–3 h old with the tank still below the minimum and no reheat logs
  `tank.forced_not_started` (whether MELCloud shows forced on or off) and posts one timeline notice
  per low-tank episode (`low_tank_notice_at`) with the unit mode, forced flag, room vs zone target and
  `IdleZone1`; `setHotWaterMode` logs MELCloud's reply. Use these to test whether open space-heating
  demand blocks forced DHW.
- `low_tank_forced_at` is cleared once the unit no longer reports forced mode (≥ 50 min after the
  request). Before, it stayed set forever and a later user-started forced run was switched to auto.

**2026-10-29 (14.0.88):**
- Removed the "quick-win DHW" block in `api.ts` `getRunHourlyOptimizer`. It forced hot water on every
  `heat_now` from the hot water planner and switched it to auto on every `delay`, beside the tank
  logic and without `low_tank_forced_at`. Live: forced mode at 09:01 with the tank at 50.5 °C and
  5 SEK/kWh, not started by the user; reheats began about 20 min after most `heat_now` runs. Forced
  hot water now comes only from `optimizeTank`.

**2026-10-31:**
- Below the tank minimum and not reheating, forced hot water goes out in the same run as the setpoint
  raise. The raise used to get an hour first (`low_tank_kick_at`, removed). Live record of what
  started a reheat: 2 °C raises 0 of 3, 4 °C raises 2 of 4, forced 4 of 5 (the failure: 23 Oct, open
  space-heating demand). 30 Oct 18:00 a 48 → 50 °C raise with the tank at 40.5 °C did nothing and the
  tank fell to 37 °C before the next run's forced request started the reheat.

**2026-11-09:**
- The Curve-mode gate is asymmetric. Hourly insights 2026-10-26..11-09: hours where the pump was
  running and the room was 0.5 °C above the setpoint kept running 24 of 24 times; stops came at about
  +0.8 to +1.2 °C, and once off the unit stayed off at +0.5 until the room fell to about the setpoint.
  Live: 15:00–18:00 at 8–9.4 SEK/kWh, room 21.5 / target 21, flow 35 °C, the pump ran the whole peak.
  It had not stopped once since the cold started on 11-07.
- Two causes: coasting set the target only `COAST_BELOW_ROOM_C` (0.5) below the room, and
  `isThermostatChangeInert` treated room 21.5 vs targets 21 → 20.5 as "off either way" and held the
  write that would have stopped it.
- New setting `curve_gate_off_offset_c` (default 1.0, 0.5–2.0, Automatic on the settings page). In
  Curve/Flow mode the coast target goes that far below the room (never below the comfort minimum);
  the inert check needs the room that far above the larger target before calling it a no-op. Room
  mode keeps 0.5. With the pump off the house cooled ~0.1 °C/h (11-07: 22.0 → 21.5 in 5 h at 5–6 °C).

**Phase 5 — COP weighting.** `delivered_price / COP(forecast_ambient)`. A curve already exists at
`data/cop_curve.csv` (keyed by `temp_out_c, delta_c`) with a bilinear interpolator in
`simulate.ts`, but it is never loaded at runtime. Guard the division — EMHASS has a live COP
blow-up bug from this exact formula when outdoor > supply temperature.

**Known limitations of what shipped:**
- Day-of-week and hour-by-day DHW patterns still use the reheat signal. They do not drive peak
  selection, but they are now inconsistent with the hourly pattern.
- The draw estimator is a proxy; it cannot cleanly separate a shower from standing loss. The
  0.4 °C/h allowance is a guess, not a measurement for this tank.
- Confidence is still count-based everywhere (R11). Nothing in `src/services/` computes a
  residual, RMSE or out-of-sample error. A model that never validates against prediction error
  but reports 100% remains a real defect.
- `copWeight` (user setting, live value 0.3) is read only in `calculateOptimalTemperature`, never
  in `calculateOptimalTemperatureWithRealData`, which is the path the optimizer actually uses. The
  slider does nothing.
- The `LEARNING_ADJUST` headline is chosen by substring-matching the word "comfort" in a prose
  reason string, so holds are labelled as actions ("Adjusting to 21.0 °C … Room: Holding 21.0 °C").
