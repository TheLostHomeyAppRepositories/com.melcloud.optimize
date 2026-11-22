import { describe, expect, test } from '@jest/globals';
import { isRoomTargetMode, describeZoneMode, getZoneOperationalState, isThermostatChangeInert, ZoneOperationMode } from '../../src/util/zone-mode';

describe('isRoomTargetMode', () => {
  test('Room mode (0) yields a genuine room target', () => {
    expect(isRoomTargetMode(ZoneOperationMode.Room)).toBe(true);
  });

  test('Flow mode (1) does not yield a room target', () => {
    expect(isRoomTargetMode(ZoneOperationMode.Flow)).toBe(false);
  });

  // Regression: this device runs in Curve mode and reported a "room target" of 29 °C,
  // which the thermal analyser consumed as (29 - indoor) and learned a negative heating rate from.
  test('Curve mode (2) does not yield a room target', () => {
    expect(isRoomTargetMode(ZoneOperationMode.Curve)).toBe(false);
  });

  test('unreported mode is treated as Room to preserve legacy/ATA behaviour', () => {
    expect(isRoomTargetMode(undefined)).toBe(true);
    expect(isRoomTargetMode(null)).toBe(true);
  });

  test('unknown modes are not assumed to be room targets', () => {
    expect(isRoomTargetMode(3)).toBe(false);
    expect(isRoomTargetMode(4)).toBe(false);
  });
});

describe('describeZoneMode', () => {
  test.each([
    [ZoneOperationMode.Room, 'room'],
    [ZoneOperationMode.Flow, 'flow'],
    [ZoneOperationMode.Curve, 'curve']
  ])('describes mode %s as %s', (mode, expected) => {
    expect(describeZoneMode(mode)).toBe(expected);
  });

  test('describes missing and unknown modes distinctly', () => {
    expect(describeZoneMode(undefined)).toBe('unreported');
    expect(describeZoneMode(null)).toBe('unreported');
    expect(describeZoneMode(9)).toBe('unknown(9)');
  });
});

describe('getZoneOperationalState', () => {
  // Regression: Device/Get has no Zone1InHeatMode, so zone 1 read idle while the unit was
  // heating (live 2026-10-23: OperationMode 2, Curve mode, 474 W, flow 33.5 C).
  test('Curve-mode zone reads heating while the unit space-heats, without Zone1InHeatMode', () => {
    expect(getZoneOperationalState({ OperationMode: 2, OperationModeZone1: ZoneOperationMode.Curve, IdleZone1: false }, 'Zone1'))
      .toBe('heating');
  });

  test('zone reads idle when its thermostat is satisfied', () => {
    expect(getZoneOperationalState({ OperationMode: 2, OperationModeZone1: ZoneOperationMode.Curve, IdleZone1: true }, 'Zone1'))
      .toBe('idle');
  });

  test('zone reads idle during a hot-water run', () => {
    expect(getZoneOperationalState({ OperationMode: 1, OperationModeZone1: ZoneOperationMode.Curve, IdleZone1: false }, 'Zone1'))
      .toBe('idle');
  });

  test('zone reads idle when the unit is idle', () => {
    expect(getZoneOperationalState({ OperationMode: 0, OperationModeZone1: ZoneOperationMode.Room, IdleZone1: false }, 'Zone1'))
      .toBe('idle');
  });

  test('explicit Zone1InHeatMode still wins when the API sends it', () => {
    expect(getZoneOperationalState({ OperationMode: 2, OperationModeZone1: ZoneOperationMode.Curve, Zone1InHeatMode: false, IdleZone1: false }, 'Zone1'))
      .toBe('idle');
  });

  test('cooling, defrost and prohibited states', () => {
    expect(getZoneOperationalState({ OperationMode: 3, IdleZone1: false }, 'Zone1')).toBe('cooling');
    expect(getZoneOperationalState({ OperationMode: 2, OperationModeZone1: 2, IdleZone1: false, DefrostMode: 1 }, 'Zone1')).toBe('defrost');
    expect(getZoneOperationalState({ OperationMode: 2, OperationModeZone1: 2, IdleZone1: false, ProhibitHeatingZone1: true }, 'Zone1')).toBe('prohibited');
  });

  test('zone 2 reads its own fields', () => {
    const state = { OperationMode: 2, OperationModeZone1: 2, OperationModeZone2: 0, IdleZone1: false, IdleZone2: true };
    expect(getZoneOperationalState(state, 'Zone1')).toBe('heating');
    expect(getZoneOperationalState(state, 'Zone2')).toBe('idle');
  });
});

describe('isThermostatChangeInert', () => {
  const curve = (roomC: number, fromC: number, toC: number) =>
    isThermostatChangeInert({ operationMode: ZoneOperationMode.Curve, roomC, fromC, toC, marginC: 0.3 });

  // Live 2026-10-24 01:00-06:00: room 21.5 °C the whole night while the target went
  // 23 -> 24 -> 23 -> 24 -> 23. Both targets keep the thermostat calling for heat; the curve sets
  // the power, so none of those writes changed anything.
  test('room clearly below both targets: the thermostat stays on either way', () => {
    expect(curve(21.5, 23, 24)).toBe(true);
    expect(curve(21.5, 24, 23)).toBe(true);
  });

  test('room clearly above both targets: the thermostat stays off either way', () => {
    expect(curve(23, 21, 22)).toBe(true);
  });

  test('a target that reaches the room changes the gate and is written', () => {
    // Live 2026-10-23 22:00: room 22, 23 -> 22 closed the gate.
    expect(curve(22, 23, 22)).toBe(false);
    expect(curve(22, 22, 23)).toBe(false);
  });

  test('within the margin of the lower target the change is written', () => {
    expect(curve(22.7, 23, 24)).toBe(false);
    expect(curve(22.8, 24, 23)).toBe(false);
    expect(curve(22.5, 23, 24)).toBe(true);
  });

  // Live 2026-11-09 15:00-18:00 at 8-9.4 SEK/kWh: room 21.5, target 21, the pump ran the whole
  // peak (flow 35 °C). Over 14 days the unit never stopped at +0.5 °C (24/24 h); it stopped at
  // about +1 °C. So with the room 0.5 above the current target, going lower is not a no-op.
  describe('with the unit stop margin (gateOffC)', () => {
    const gated = (roomC: number, fromC: number, toC: number, gateOffC = 1.0) =>
      isThermostatChangeInert({ operationMode: ZoneOperationMode.Curve, roomC, fromC, toC, marginC: 0.3, gateOffC });

    test('room only 0.5 above the current target: a lower target is written', () => {
      expect(gated(21.5, 21, 20.5)).toBe(false);
      // The old symmetric rule held this write, which kept the pump running.
      expect(curve(21.5, 21, 20.5)).toBe(true);
    });

    test('room past both targets by the stop margin: the unit is off either way', () => {
      expect(gated(22.5, 21, 20.5)).toBe(true);
      expect(gated(23.5, 21, 22)).toBe(true);
      // Exactly at the stop margin is not yet clearly off.
      expect(gated(23, 21, 22)).toBe(false);
    });

    test('the lower side is unchanged: room clearly below both still heats either way', () => {
      expect(gated(21.5, 23, 24)).toBe(true);
    });

    test('the margin never shrinks below marginC', () => {
      expect(gated(22.2, 21, 21.5, 0.5)).toBe(true);
      expect(gated(21.75, 21, 21.5, 0)).toBe(false);
    });
  });

  test('not in Flow mode: only Curve mode was measured to gate on the room setpoint', () => {
    expect(isThermostatChangeInert({ operationMode: ZoneOperationMode.Flow, roomC: 21.5, fromC: 23, toC: 24, marginC: 0.3 })).toBe(false);
  });

  test('never in Room mode: there the setpoint also sets the power', () => {
    expect(isThermostatChangeInert({ operationMode: ZoneOperationMode.Room, roomC: 21.5, fromC: 23, toC: 24, marginC: 0.3 })).toBe(false);
    expect(isThermostatChangeInert({ operationMode: undefined, roomC: 21.5, fromC: 23, toC: 24, marginC: 0.3 })).toBe(false);
  });

  test('no room reading: never inert', () => {
    expect(curve(Number.NaN, 23, 24)).toBe(false);
  });
});
