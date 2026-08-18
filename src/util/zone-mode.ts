/**
 * Zone control-mode helpers for Mitsubishi ATW (air-to-water) devices.
 *
 * MELCloud reports the zone control mode in `OperationModeZone1` / `OperationModeZone2`.
 * The meaning of the zone setpoint depends entirely on this mode:
 *
 *  - 0 Room   — `SetTemperatureZoneN` is a room-temperature target.
 *  - 1 Flow   — `SetTemperatureZoneN` is a target water (flow) temperature.
 *  - 2 Curve  — the unit follows a weather-compensation curve; the setpoint is a
 *               curve/water reference, not a room temperature.
 *
 * Treating a Flow/Curve setpoint as a room target produces nonsensical values (e.g. a
 * "room target" of 29 °C) and corrupts any model that learns from
 * (targetTemperature - indoorTemperature).
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
