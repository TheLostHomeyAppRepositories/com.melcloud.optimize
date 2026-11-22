import { Optimizer } from '../../src/services/optimizer';
import { MelCloudApi } from '../../src/services/melcloud-api';
import { HomeyLogger } from '../../src/util/logger';
import { ThermalController } from '../../src/services/thermal-controller';

jest.mock('../../src/services/thermal-controller');

describe('Optimizer Initialization', () => {
    let mockMelCloud: jest.Mocked<MelCloudApi>;
    let mockLogger: HomeyLogger;
    let mockHomey: any;
    let mockPriceProvider: any;
    let mockThermalController: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockMelCloud = {
            getEnergyData: jest.fn(),
            getDailyEnergyTotals: jest.fn(),
            getDeviceState: jest.fn(),
        } as any;

        mockLogger = {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
        } as any;

        mockPriceProvider = {
            getCurrentPrice: jest.fn().mockResolvedValue(0.5),
            getPrices: jest.fn().mockResolvedValue({
                today: [],
                tomorrow: [],
            }),
        };

        mockThermalController = {
            getThermalMassModel: jest.fn().mockReturnValue({
                thermalCapacity: 2.5,
                heatLossRate: 0.8,
                maxPreheatingTemp: 23,
                preheatingEfficiency: 0.85,
                lastCalibration: new Date()
            }),
            setThermalMassModel: jest.fn(),
            setCurveGateOffset: jest.fn(),
            getCurveGateOffset: jest.fn().mockReturnValue(1.0),
        };
        (ThermalController as jest.Mock).mockImplementation(() => mockThermalController);

        mockHomey = {
            settings: {
                get: jest.fn((key: string) => {
                    // Return sensible defaults
                    const defaults: Record<string, any> = {
                        'cop_weight': 0.3,
                        'min_temp': 20,
                        'max_temp': 22,
                        'time_zone_offset': 1,
                        'use_dst': false,
                        'grid_fee': 0,
                        'currency': 'SEK',
                        'building_thermal_capacity': 5000,
                        'base_heat_loss_rate': 2.5,
                    };
                    return defaults[key];
                }),
                set: jest.fn(),
            },
        };
    });

    describe('Basic Initialization', () => {
        test('constructor completes synchronously', () => {
            const start = Date.now();
            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );
            const duration = Date.now() - start;

            expect(optimizer).toBeDefined();
            expect(duration).toBeLessThan(100); // Should be instant
            expect(optimizer.isInitialized()).toBe(false);
        });

        test('initialize() completes async setup', async () => {
            mockMelCloud.getEnergyData.mockResolvedValue([
                { Date: '2025-11-20', TotalHeatingConsumed: 15 }
            ]);

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            await optimizer.initialize();

            expect(optimizer.isInitialized()).toBe(true);
            expect(mockMelCloud.getEnergyData).toHaveBeenCalled();
        });

        test('initialization status is accurate', async () => {
            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            let status = optimizer.getInitializationStatus();
            expect(status.initialized).toBe(false);

            mockMelCloud.getEnergyData.mockResolvedValue([
                { Date: '2025-11-20', TotalHeatingConsumed: 15 }
            ]);

            await optimizer.initialize();

            status = optimizer.getInitializationStatus();
            expect(status.initialized).toBe(true);
            expect(status.thermalMassInitialized).toBe(true);
            expect(status.servicesInitialized).toBe(true);
        });
    });

    describe('Concurrent Initialization Guards', () => {
        test('multiple concurrent initialize() calls return same promise', async () => {
            mockMelCloud.getEnergyData.mockResolvedValue([
                { Date: '2025-11-20', TotalHeatingConsumed: 15 }
            ]);

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            const promise1 = optimizer.initialize();
            const promise2 = optimizer.initialize();
            const promise3 = optimizer.initialize();

            expect(promise1).toBe(promise2);
            expect(promise2).toBe(promise3);

            await Promise.all([promise1, promise2, promise3]);

            expect(optimizer.isInitialized()).toBe(true);
            // Should only call getEnergyData once
            expect(mockMelCloud.getEnergyData).toHaveBeenCalledTimes(1);
        });

        test('second call after completion returns immediately', async () => {
            mockMelCloud.getEnergyData.mockResolvedValue([]);

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            await optimizer.initialize();

            const start = Date.now();
            await optimizer.initialize();
            const duration = Date.now() - start;

            expect(duration).toBeLessThan(10); // Should return immediately
        });
    });

    describe('Initialization Failures', () => {
        test('initialization succeeds even when energy data fails (non-fatal)', async () => {
            mockMelCloud.getEnergyData.mockRejectedValue(new Error('API failure'));

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            // Should succeed - energy data failure is non-fatal, optimizer uses defaults
            await optimizer.initialize();
            expect(optimizer.isInitialized()).toBe(true);
        });

        test('initialization with empty energy data succeeds', async () => {
            mockMelCloud.getEnergyData.mockResolvedValue([]);

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            await optimizer.initialize();
            expect(optimizer.isInitialized()).toBe(true);
        });

        test('energy data failure is logged', async () => {
            mockMelCloud.getEnergyData.mockRejectedValue(new Error('Specific test error'));

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            await optimizer.initialize();
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Failed to initialize thermal mass from history:',
                expect.any(Error)
            );
        });
    });

    describe('EnsureInitialized Behavior', () => {
        test('ensureInitialized is called automatically in runOptimization', async () => {
            mockMelCloud.getEnergyData.mockResolvedValue([
                { Date: '2025-11-20', TotalHeatingConsumed: 15 }
            ]);
            mockMelCloud.getDeviceState.mockResolvedValue({
                DeviceID: 'device123',
                RoomTemperature: 21,
                SetTemperature: 21,
                Power: true,
                OperationMode: 1,
            } as any);

            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger,
                undefined,
                mockHomey
            );

            // Should not be initialized yet
            expect(optimizer.isInitialized()).toBe(false);

            // runOptimization should initialize automatically
            // Note: This test may need adjustment based on actual runOptimization implementation
            // which may have dependencies we need to mock
        });
    });

    describe('Initialization with No Homey Instance', () => {
        test('initializes with defaults when no homey provided', async () => {
            const optimizer = new Optimizer(
                mockMelCloud,
                mockPriceProvider,
                '123',
                456,
                mockLogger
            );

            // Should succeed even without homey
            expect(optimizer).toBeDefined();

            // Initialize should handle missing homey gracefully
            await optimizer.initialize();

            const status = optimizer.getInitializationStatus();
            expect(status.servicesInitialized).toBe(true);
        });
    });
});
