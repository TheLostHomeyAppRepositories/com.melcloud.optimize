/**
 * Zone control-mode helpers for Mitsubishi ATW (air-to-water) devices.
 *
 * MELCloud reports the zone control mode in `OperationModeZone1` / `OperationModeZone2`.
 * The meaning of the zone setpoint depends entirely on this mode:
 *
 *  - 0 Room   — the unit modulates flow temperature to reach `SetTemperatureZoneN`.
 *  - 1 Flow   — the unit holds a fixed flow temperature (`SetHeatFlowTemperatureZoneN`).
 *  - 2 Curve  — the unit follows its weather-compensation curve for flow temperature.
 *
 * `SetTemperatureZoneN` is a room temperature in every mode. With a room sensor fitted it acts as
 * a thermostat even in Curve mode: room at or above the setpoint means thermo-off, below means
 * the curve runs (measured live 2026-10-13: a raise above the room switched an idle unit to
 * heating within one poll). What Curve mode removes is *power*: a higher setpoint cannot make
 * the curve deliver more heat, so (target - indoor) says whether heat flows, not how fast. Any
 * model that learns a heating rate from that difference is only valid in Room mode.
 *
 * (The nonsense 29 °C "room target" seen in August came from reading the ATA-shaped
 * `SetTemperature` field, not from the zone mode.)
 */

export enum ZoneOperationMode {
  Room = 0,
  Flow = 1,
  Curve = 2
}

/**
 * True when the zone setpoint can be interpreted as a room-temperature target.
 *
 * Devices that do not report the field (ATA units, older firmware) return `undefined`,
 * which is treated as Room mode to preserve existing behaviour.
 */
export function isRoomTargetMode(operationMode: number | undefined | null): boolean {
  if (operationMode === undefined || operationMode === null) {
    return true;
  }
  return operationMode === ZoneOperationMode.Room;
}

/** Human-readable zone mode name for logs and diagnostics. */
export function describeZoneMode(operationMode: number | undefined | null): string {
  switch (operationMode) {
    case ZoneOperationMode.Room:
      return 'room';
    case ZoneOperationMode.Flow:
      return 'flow';
    case ZoneOperationMode.Curve:
      return 'curve';
    case undefined:
    case null:
      return 'unreported';
    default:
      return `unknown(${operationMode})`;
  }
}

/** Unit `OperationMode` values that mean the compressor is delivering heat to the zones. */
const SPACE_HEATING_UNIT_MODES = new Set([2, 7, 11]);
const COOLING_UNIT_MODE = 3;

export type ZoneOperationalState = 'heating' | 'cooling' | 'defrost' | 'prohibited' | 'idle';

/**
 * Operational state of one zone.
 *
 * Device/Get does not send `ZoneNInHeatMode` / `ZoneNInCoolMode`, so reading only those left the
 * zone stuck on idle while the unit was heating. When they are missing, heat mode comes from
 * `OperationModeZoneN` (Room/Flow/Curve are all heating modes) and cool mode from the unit mode.
 * A zone is active only while the unit itself is space heating (or cooling) and `IdleZoneN` is
 * false; during a hot-water run the valve feeds the tank, so the zone reads idle.
 */
export function getZoneOperationalState(
  deviceState: Record<string, unknown>,
  zone: 'Zone1' | 'Zone2'
): ZoneOperationalState {
  const unitMode = deviceState.OperationMode;
  const zoneMode = deviceState[`OperationMode${zone}`];
  const explicitHeat = deviceState[`${zone}InHeatMode`];
  const explicitCool = deviceState[`${zone}InCoolMode`];

  const inHeatMode = typeof explicitHeat === 'boolean'
    ? explicitHeat
    : zoneMode === ZoneOperationMode.Room || zoneMode === ZoneOperationMode.Flow || zoneMode === ZoneOperationMode.Curve;
  const inCoolMode = typeof explicitCool === 'boolean' ? explicitCool : unitMode === COOLING_UNIT_MODE;

  if ((inCoolMode && deviceState[`ProhibitCooling${zone}`]) || (inHeatMode && deviceState[`ProhibitHeating${zone}`])) {
    return 'prohibited';
  }

  if (deviceState.DefrostMode) {
    return 'defrost';
  }

  const zoneIdle = deviceState[`Idle${zone}`] === true;

  if (inCoolMode && !zoneIdle && unitMode === COOLING_UNIT_MODE) {
    return 'cooling';
  }

  if (inHeatMode && !zoneIdle && typeof unitMode === 'number' && SPACE_HEATING_UNIT_MODES.has(unitMode)) {
    return 'heating';
  }

  return 'idle';
}

/**
 * True when changing the zone setpoint from `fromC` to `toC` cannot change what the unit does.
 *
 * In Curve mode the setpoint is only an on/off gate: below it the curve runs, at or above it the
 * zone is thermo-off (measured live 2026-10-13). With the room clearly below both targets the zone
 * heats either way; with it clearly above both it stays off either way, so the write is a no-op
 * (live 2026-10-24: target 23 <-> 24 all night with the room at 21.5). `marginC` keeps writes that
 * may matter before the next run. Room mode also sets the flow temperature from the setpoint, and
 * Flow mode was never measured, so neither is ever treated as inert.
 *
 * The gate is not symmetric. The unit stops heating only once the room is `gateOffC` above the
 * setpoint (2026-10-26..11-09: at +0.5 °C it never stopped, 24/24 h; stops came at about +0.8 to
 * +1.2 °C). So "clearly above both" needs the room past the larger target by that much: room 21.5
 * with targets 21 -> 20.5 is not inert, because 21 keeps the curve running and 20.5 stops it.
 */
export function isThermostatChangeInert(params: {
  operationMode: number | undefined | null;
  roomC: number;
  fromC: number;
  toC: number;
  marginC: number;
  /** Room above setpoint at which the unit stops heating; 0 (default) treats the gate as symmetric. */
  gateOffC?: number;
}): boolean {
  const { operationMode, roomC, fromC, toC, marginC } = params;
  const gateOffC = Number.isFinite(params.gateOffC) ? (params.gateOffC as number) : 0;
  if (operationMode !== ZoneOperationMode.Curve || ![roomC, fromC, toC, marginC].every(Number.isFinite)) {
    return false;
  }
  return roomC < Math.min(fromC, toC) - marginC || roomC > Math.max(fromC, toC) + Math.max(marginC, gateOffC);
}
