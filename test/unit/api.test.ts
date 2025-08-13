import { Api } from '../../src/api';
import HeatOptimizerApp from '../../src/app';

// Mock the HeatOptimizerApp
jest.mock('../../src/app');

// Mock the api.js file to prevent requiring the actual implementation
jest.mock('../../api.js', () => ({
  getRunHourlyOptimizer: jest.fn().mockResolvedValue({ success: true }),
  getRunWeeklyCalibration: jest.fn().mockResolvedValue({ success: true }),
}));

describe('Api', () => {
  let api: Api;
  let mockApp: jest.Mocked<HeatOptimizerApp>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create a mock app instance
    mockApp = new HeatOptimizerApp() as jest.Mocked<HeatOptimizerApp>;

    // Mock app methods
    (mockApp as any).log = jest.fn();
    (mockApp as any).error = jest.fn();
    mockApp.runHourlyOptimizer = jest.fn().mockResolvedValue({ success: true });
    mockApp.runWeeklyCalibration = jest.fn().mockResolvedValue({ success: true });
    (mockApp as any).hotWaterService = {
      resetPatterns: jest.fn(),
      clearData: jest.fn().mockResolvedValue(undefined)
    };

    // Create API instance with mock app
    api = new Api(mockApp);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('runHourlyOptimizer', () => {
    it('should call app.runHourlyOptimizer and return success', async () => {
      const result = await api.runHourlyOptimizer();

      expect((mockApp as any).log).toHaveBeenCalledWith('API method runHourlyOptimizer called');
      expect(mockApp.runHourlyOptimizer).toHaveBeenCalled();
      expect(result).toEqual({ success: true, message: 'Hourly optimization completed' });
    }, 5000); // 5 second timeout

    it('should handle errors from app.runHourlyOptimizer', async () => {
      // Make runHourlyOptimizer fail
      mockApp.runHourlyOptimizer.mockRejectedValue(new Error('Optimization error'));

      try {
        await api.runHourlyOptimizer();
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('Optimization error');
      }

      expect((mockApp as any).log).toHaveBeenCalledWith('API method runHourlyOptimizer called');
      expect(mockApp.runHourlyOptimizer).toHaveBeenCalled();
    }, 5000); // 5 second timeout
  });

  describe('runWeeklyCalibration', () => {
    it('should call app.runWeeklyCalibration and return success', async () => {
      const result = await api.runWeeklyCalibration();

      expect((mockApp as any).log).toHaveBeenCalledWith('API method runWeeklyCalibration called');
      expect(mockApp.runWeeklyCalibration).toHaveBeenCalled();
      expect(result).toEqual({ success: true, message: 'Weekly calibration completed' });
    }, 5000); // 5 second timeout

    it('should handle errors from app.runWeeklyCalibration', async () => {
      // Make runWeeklyCalibration fail
      mockApp.runWeeklyCalibration.mockRejectedValue(new Error('Calibration error'));

      try {
        await api.runWeeklyCalibration();
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toBe('Calibration error');
      }

      expect((mockApp as any).log).toHaveBeenCalledWith('API method runWeeklyCalibration called');
      expect(mockApp.runWeeklyCalibration).toHaveBeenCalled();
    }, 5000); // 5 second timeout
  });

  describe('getMemoryUsage', () => {
    it('should return memory usage information', async () => {
      const result = await api.getMemoryUsage();

      expect((mockApp as any).log).toHaveBeenCalledWith('API method getMemoryUsage called');
      expect(result.success).toBe(true);
      expect(result.processMemory).toBeDefined();
      expect(result.timestamp).toBeDefined();
    }, 3000);
  });

  describe('resetHotWaterPatterns', () => {
    it('should reset hot water patterns when service is available', async () => {
      const result = await api.resetHotWaterPatterns();

      expect((mockApp as any).log).toHaveBeenCalledWith('API method resetHotWaterPatterns called');
      expect((mockApp as any).hotWaterService.resetPatterns).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        message: 'Hot water usage patterns have been reset to defaults'
      });
    }, 3000);

    it('should handle missing hot water service', async () => {
      (mockApp as any).hotWaterService = null;

      const result = await api.resetHotWaterPatterns();

      expect(result).toEqual({
        success: false,
        message: 'Hot water service not available'
      });
    }, 3000);
  });

  describe('clearHotWaterData', () => {
    it('should clear hot water data when service is available', async () => {
      const result = await api.clearHotWaterData();

      expect((mockApp as any).log).toHaveBeenCalledWith('API method clearHotWaterData called (clearAggregated: true)');
      expect((mockApp as any).hotWaterService.clearData).toHaveBeenCalledWith(true);
      expect(result).toEqual({
        success: true,
        message: 'Hot water usage data has been cleared including aggregated data'
      });
    }, 3000);

    it('should handle missing hot water service', async () => {
      (mockApp as any).hotWaterService = null;

      const result = await api.clearHotWaterData();

      expect(result).toEqual({
        success: false,
        message: 'Hot water service not available'
      });
    }, 3000);
  });
});
