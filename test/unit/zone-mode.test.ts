import { describe, expect, test } from '@jest/globals';
import { isRoomTargetMode, describeZoneMode, ZoneOperationMode } from '../../src/util/zone-mode';

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
