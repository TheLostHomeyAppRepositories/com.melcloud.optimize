import { MelCloudApi } from '../../src/services/melcloud-api';
import * as https from 'https';
import { EventEmitter } from 'events';
import { IncomingMessage, ClientRequest } from 'http';

// Increase timeout for all tests in this file
jest.setTimeout(30000);

// Mock https module
jest.mock('https', () => {
  return {
    request: jest.fn()
  };
});

// Create mock request and response objects
const mockRequestObject = new EventEmitter() as EventEmitter & Partial<ClientRequest>;
mockRequestObject.write = jest.fn();
mockRequestObject.end = jest.fn();

const mockResponse = new EventEmitter() as EventEmitter & Partial<IncomingMessage>;
mockResponse.statusCode = 200;
mockResponse.statusMessage = 'OK';

// Mock https.request
const mockRequest = jest.fn().mockImplementation((options, callback) => {
  if (callback) {
    callback(mockResponse);
  }
  return mockRequestObject;
});

// Set up the mock implementation
(https.request as jest.Mock).mockImplementation(mockRequest);

describe('MelCloudApi', () => {
  let melCloudApi: MelCloudApi;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset mock response
    mockResponse.statusCode = 200;
    mockResponse.statusMessage = 'OK';

    // Create a new instance of MelCloudApi
    melCloudApi = new MelCloudApi();

    // Mock the logger to prevent errors in cleanup
    (melCloudApi as any).logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      api: jest.fn()
    };

    // Mock the errorHandler to prevent errors
    (melCloudApi as any).errorHandler = {
      logError: jest.fn(),
      createAppError: jest.fn().mockImplementation((category, message, originalError) => {
        return {
          category: category || 'NETWORK',
          message: message || 'Network error',
          originalError: originalError || new Error(message || 'Network error')
        };
      })
    };
  });

  afterEach(() => {
    // Clean up any pending timers
    melCloudApi.cleanup();
  });

  describe('login', () => {
    it('should login successfully', async () => {
      // Set up the response data
      const responseData = {
        ErrorId: null,
        LoginData: {
          ContextKey: 'test-context-key'
        }
      };

      // Create a promise that resolves when the test is complete
      const testPromise = melCloudApi.login('test@example.com', 'password')
        .then(result => {
          // Verify the result
          expect(result).toBe(true);

          // Verify https.request was called with correct parameters
          expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              hostname: 'app.melcloud.com',
              path: '/Mitsubishi.Wifi.Client/Login/ClientLogin',
              method: 'POST',
              headers: expect.objectContaining({
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              })
            }),
            expect.any(Function)
          );

          // Verify request body was written
          expect(mockRequestObject.write).toHaveBeenCalledWith(expect.stringContaining('"Email":"test@example.com"'));
          expect(mockRequestObject.write).toHaveBeenCalledWith(expect.stringContaining('"Password":"password"'));
        });

      // Emit data and end events to simulate response
      mockResponse.emit('data', JSON.stringify(responseData));
      mockResponse.emit('end');

      // Wait for the test to complete
      return testPromise;
    });

    it('should throw error when login fails', async () => {
      // Set up the response data
      const responseData = {
        ErrorId: 1,
        ErrorMessage: 'Invalid credentials'
      };

      // Set up a mock implementation for the error handler
      const mockError = new Error('MELCloud login failed: Invalid credentials');
      (melCloudApi as any).errorHandler.createAppError.mockReturnValueOnce({
        category: 'API',
        message: 'MELCloud login failed: Invalid credentials',
        originalError: mockError
      });

      // Create a promise to track when the test is complete
      const loginPromise = melCloudApi.login('test@example.com', 'wrong-password');

      // Emit data and end events to simulate response
      mockResponse.emit('data', JSON.stringify(responseData));
      mockResponse.emit('end');

      // Expect the login to fail with the correct error message
      await expect(loginPromise).rejects.toThrow('MELCloud login failed: Invalid credentials');
    });

    it('should handle network errors', async () => {
      // Set up a mock implementation for the error handler
      const mockError = new Error('API request error: Network error');
      (melCloudApi as any).errorHandler.createAppError.mockReturnValueOnce({
        category: 'NETWORK',
        message: 'API request error: Network error',
        originalError: mockError
      });

      // Create a promise to track when the test is complete
      const loginPromise = melCloudApi.login('test@example.com', 'password');

      // Emit error event to simulate network error
      const requestError = new Error('Network error');
      mockRequestObject.emit('error', requestError);

      // Expect the login to fail with the correct error message
      await expect(loginPromise).rejects.toThrow('API request error: Network error');

      // Verify that the error handler was called
      expect((melCloudApi as any).errorHandler.logError).toHaveBeenCalled();
    });
  });

  describe('getDevices', () => {
    beforeEach(() => {
      // Set contextKey for authenticated requests
      (melCloudApi as any).contextKey = 'test-context-key';
    });

    it('should get devices successfully', async () => {
      // Set up the response data
      const responseData = [
        {
          ID: 123,
          Structure: {
            Devices: [
              {
                DeviceID: 456,
                DeviceName: 'Test Device',
              }
            ]
          }
        }
      ];

      // Create a promise that resolves when the test is complete
      const testPromise = melCloudApi.getDevices()
        .then(devices => {
          // Verify the result
          expect(devices).toHaveLength(1);
          expect(devices[0].id).toBe(456);
          expect(devices[0].name).toBe('Test Device');
          expect(devices[0].buildingId).toBe(123);

          // Verify https.request was called with correct parameters
          expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              hostname: 'app.melcloud.com',
              path: '/Mitsubishi.Wifi.Client/User/ListDevices',
              method: 'GET',
              headers: expect.objectContaining({
                'X-MitsContextKey': 'test-context-key',
                'Accept': 'application/json'
              })
            }),
            expect.any(Function)
          );
        });

      // Emit data and end events to simulate response
      mockResponse.emit('data', JSON.stringify(responseData));
      mockResponse.emit('end');

      // Wait for the test to complete
      return testPromise;
    });

    it('should throw error when not logged in', async () => {
      // Reset contextKey to simulate not being logged in
      (melCloudApi as any).contextKey = null;

      // Mock the error handler to throw a specific error
      const mockError = new Error('Not logged in to MELCloud');
      (melCloudApi as any).errorHandler.createAppError.mockImplementation(() => {
        throw mockError;
      });

      try {
        // This should throw an error
        await melCloudApi.getDevices();
        // If we get here, the test should fail
        fail('Expected getDevices to throw an error');
      } catch (error) {
        // We expect an error to be thrown
        expect(error).toBe(mockError);
      }

      // Verify https.request was not called
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should handle API errors', async () => {
      // Set up the response status code to indicate an error
      mockResponse.statusCode = 500;
      mockResponse.statusMessage = 'Internal Server Error';

      // Create a promise that resolves when the test is complete
      const testPromise = expect(melCloudApi.getDevices())
        .rejects.toThrow('API error: 500 Internal Server Error');

      // Emit data and end events to simulate response
      mockResponse.emit('data', '{"error": "Internal Server Error"}');
      mockResponse.emit('end');

      // Wait for the test to complete
      return testPromise;
    });
  });

  describe('getDeviceById', () => {
    beforeEach(() => {
      // Set devices for lookup
      (melCloudApi as any).devices = [
        {
          id: '123',
          name: 'Device 1',
          buildingId: 456
        },
        {
          id: '789',
          name: 'Device 2',
          buildingId: 456
        }
      ];
    });

    it('should return device when found', () => {
      const device = melCloudApi.getDeviceById('123');

      expect(device).not.toBeNull();
      expect(device.id).toBe('123');
      expect(device.name).toBe('Device 1');
    });

    it('should return null when device not found', () => {
      const device = melCloudApi.getDeviceById('999');

      expect(device).toBeNull();
    });
  });

  describe('getDeviceState', () => {
    beforeEach(() => {
      // Set contextKey for authenticated requests
      (melCloudApi as any).contextKey = 'test-context-key';
    });

    it('should get device state successfully', async () => {
      // Set up the response data
      const responseData = {
        DeviceID: '123',
        BuildingID: 456,
        RoomTemperatureZone1: 21.5,
        SetTemperatureZone1: 22.0
      };

      // Create a promise that resolves when the test is complete
      const testPromise = melCloudApi.getDeviceState('123', 456)
        .then(state => {
          // Verify the result
          expect(state).toBeDefined();
          expect(state.DeviceID).toBe('123');
          expect(state.RoomTemperatureZone1).toBe(21.5);

          // Verify https.request was called with correct parameters
          expect(mockRequest).toHaveBeenCalledWith(
            expect.objectContaining({
              hostname: 'app.melcloud.com',
              path: '/Mitsubishi.Wifi.Client/Device/Get?id=123&buildingID=456',
              method: 'GET',
              headers: expect.objectContaining({
                'X-MitsContextKey': 'test-context-key',
                'Accept': 'application/json'
              })
            }),
            expect.any(Function)
          );
        });

      // Emit data and end events to simulate response
      mockResponse.emit('data', JSON.stringify(responseData));
      mockResponse.emit('end');

      // Wait for the test to complete
      return testPromise;
    });

    it('should throw error when not logged in', async () => {
      // Reset contextKey to simulate not being logged in
      (melCloudApi as any).contextKey = null;

      // Mock the error handler to throw a specific error
      const mockError = new Error('Not logged in to MELCloud');
      (melCloudApi as any).errorHandler.createAppError.mockImplementation(() => {
        throw mockError;
      });

      try {
        // This should throw an error
        await melCloudApi.getDeviceState('123', 456);
        // If we get here, the test should fail
        fail('Expected getDeviceState to throw an error');
      } catch (error) {
        // We expect an error to be thrown
        expect(error).toBe(mockError);
      }

      // Verify https.request was not called
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should handle API errors', async () => {
      // Set up the response status code to indicate an error
      mockResponse.statusCode = 500;
      mockResponse.statusMessage = 'Internal Server Error';

      // Set up a mock implementation for the error handler
      const mockError = new Error('API error: 500 Internal Server Error');
      (melCloudApi as any).errorHandler.createAppError.mockReturnValueOnce({
        category: 'API',
        message: 'API error: 500 Internal Server Error',
        originalError: mockError
      });

      // Create a promise to track when the test is complete
      const getDeviceStatePromise = melCloudApi.getDeviceState('123', 456);

      // Emit data and end events to simulate response
      mockResponse.emit('data', '{"error": "Internal Server Error"}');
      mockResponse.emit('end');

      // Expect the getDeviceState to fail with the correct error message
      await expect(getDeviceStatePromise).rejects.toThrow('API error: 500 Internal Server Error');
    });
  });

  describe('setDeviceTemperature', () => {
    beforeEach(() => {
      // Set contextKey for authenticated requests
      (melCloudApi as any).contextKey = 'test-context-key';
    });

    it('should set device temperature successfully', async () => {
      // Set up the response data for the first call (getDeviceState)
      const getDeviceStateResponse = {
        DeviceID: '123',
        BuildingID: 456,
        SetTemperature: 21.0
      };

      // Set up the response data for the second call (setDeviceTemperature)
      const setTemperatureResponse = {};

      // Mock the implementation for both requests in one go
      mockRequest
        // First call for getDeviceState
        .mockImplementationOnce((options, callback) => {
          if (callback) {
            setTimeout(() => {
              callback(mockResponse);
              mockResponse.emit('data', JSON.stringify(getDeviceStateResponse));
              mockResponse.emit('end');
            }, 10);
          }
          return mockRequestObject;
        })
        // Second call for setDeviceTemperature
        .mockImplementationOnce((options, callback) => {
          if (callback) {
            setTimeout(() => {
              callback(mockResponse);
              mockResponse.emit('data', JSON.stringify(setTemperatureResponse));
              mockResponse.emit('end');
            }, 10);
          }
          return mockRequestObject;
        });

      // Execute the test
      const result = await melCloudApi.setDeviceTemperature('123', 456, 22.0);

      // Verify the result
      expect(result).toBe(true);

      // Verify https.request was called twice (get state and set temperature)
      expect(mockRequest).toHaveBeenCalledTimes(2);

      // Verify the second call was to set temperature
      expect(mockRequest.mock.calls[1][0]).toMatchObject({
        hostname: 'app.melcloud.com',
        path: '/Mitsubishi.Wifi.Client/Device/SetAta',
        method: 'POST'
      });

      // Verify request body was written with the correct temperature
      expect(mockRequestObject.write).toHaveBeenCalledWith(expect.stringContaining('"SetTemperature":22'));
    });

    it('should throw error when not logged in', async () => {
      // Reset contextKey to simulate not being logged in
      (melCloudApi as any).contextKey = null;

      // Mock the error handler to throw a specific error
      const mockError = new Error('Not logged in to MELCloud');
      (melCloudApi as any).errorHandler.createAppError.mockImplementation(() => {
        throw mockError;
      });

      try {
        // This should throw an error
        await melCloudApi.setDeviceTemperature('123', 456, 22.0);
        // If we get here, the test should fail
        fail('Expected setDeviceTemperature to throw an error');
      } catch (error) {
        // We expect an error to be thrown
        expect(error).toBe(mockError);
      }

      // Verify https.request was not called
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should handle API errors', async () => {
      // Set up the response status code to indicate an error
      mockResponse.statusCode = 500;
      mockResponse.statusMessage = 'Internal Server Error';

      // Set up a mock implementation for the error handler
      const mockError = new Error('API error: 500 Internal Server Error');
      (melCloudApi as any).errorHandler.createAppError.mockReturnValueOnce({
        category: 'API',
        message: 'API error: 500 Internal Server Error',
        originalError: mockError
      });

      // Create a promise to track when the test is complete
      const setDeviceTemperaturePromise = melCloudApi.setDeviceTemperature('123', 456, 22.0);

      // Emit data and end events to simulate response
      mockResponse.emit('data', '{"error": "Internal Server Error"}');
      mockResponse.emit('end');

      // Expect the setDeviceTemperature to fail with the correct error message
      await expect(setDeviceTemperaturePromise).rejects.toThrow('API error: 500 Internal Server Error');
    });
  });
});
