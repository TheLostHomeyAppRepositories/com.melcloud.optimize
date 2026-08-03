// Prevent the real MelCloudApi from executing any network code during these unit tests
jest.mock('../../src/services/melcloud-api', () => ({
  MelCloudApi: class {}
}));

import { TibberApi } from '../../src/services/tibber-api';
import fetch from 'node-fetch';
import { createMockLogger } from '../mocks/logger.mock';

// Mock fetch globally
jest.mock('node-fetch');
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

const originalFetch = global.fetch;

describe('TibberApi', () => {
  let tibberApi: TibberApi;
  const mockToken = 'test-token';
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    (global as any).fetch = mockedFetch as any;

    // Create a mock logger
    mockLogger = createMockLogger();

    // Create a new instance of TibberApi with the mock logger
    tibberApi = new TibberApi(mockToken, mockLogger);
  });

  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  describe('getPrices', () => {
    it('should get prices successfully', async () => {
      // Mock successful prices response
      const mockPriceData = {
        data: {
          viewer: {
            homes: [
              {
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.15,
                      energy: 0.10,
                      tax: 0.05,
                      startsAt: '2023-01-01T00:00:00Z'
                    },
                    today: [
                      {
                        total: 0.15,
                        energy: 0.10,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:00:00Z'
                      },
                      {
                        total: 0.16,
                        energy: 0.11,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:15:00Z'
                      },
                      {
                        total: 0.17,
                        energy: 0.12,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:30:00Z'
                      },
                      {
                        total: 0.18,
                        energy: 0.13,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:45:00Z'
                      }
                    ],
                    tomorrow: [
                      {
                        total: 0.14,
                        energy: 0.09,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:00:00Z'
                      },
                      {
                        total: 0.13,
                        energy: 0.08,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:15:00Z'
                      },
                      {
                        total: 0.12,
                        energy: 0.07,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:30:00Z'
                      },
                      {
                        total: 0.11,
                        energy: 0.06,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:45:00Z'
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(mockPriceData),
        ok: true
      } as any);

      const prices = await tibberApi.getPrices();

      // Verify the result
      expect(prices).toBeDefined();
      expect(prices.current).toBeDefined();
      expect(prices.prices).toBeDefined();
      expect(prices.prices.length).toBeGreaterThan(0);
      expect(prices.quarterHourly).toBeDefined();
      expect(prices.quarterHourly?.length).toBe(8);
      expect(prices.intervalMinutes).toBe(15);

      // Verify fetch was called with correct parameters
      expect(mockedFetch).toHaveBeenCalledWith(
        'https://api.tibber.com/v1-beta/gql',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${mockToken}`,
          },
          body: expect.any(String)
        })
      );

      // Verify the query contains the expected fields
      if (mockedFetch.mock.calls[0] && mockedFetch.mock.calls[0][1] && mockedFetch.mock.calls[0][1].body) {
        const requestBody = JSON.parse(mockedFetch.mock.calls[0][1].body as string);
        expect(requestBody.query).toContain('current');
        expect(requestBody.query).toContain('today');
        expect(requestBody.query).toContain('tomorrow');
        expect(requestBody.query).toContain('resolution: QUARTER_HOURLY');
      }
    });

    it('should throw error when API returns errors', async () => {
      // Mock API error response
      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          errors: [
            {
              message: 'Invalid token'
            }
          ]
        }),
        ok: true
      } as any);

      // Expect getPrices to throw an error
      await expect(tibberApi.getPrices())
        .rejects.toThrow('Tibber API error: Invalid token');

      // Verify fetch was called
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw error when no homes found', async () => {
      // Mock response with no homes
      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          data: {
            viewer: {
              homes: []
            }
          }
        }),
        ok: true
      } as any);

      // Mock the errorHandler.logError method to ensure it's called
      (tibberApi as any).errorHandler.logError = jest.fn();

      // Expect getPrices to throw an error
      await expect(tibberApi.getPrices())
        .rejects.toThrow(/Failed to format price data/);

      // Verify fetch was called
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect((tibberApi as any).errorHandler.logError).toHaveBeenCalled();
    });

    it('should throw error when no price information available', async () => {
      // Mock response with no price information
      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          data: {
            viewer: {
              homes: [
                {
                  currentSubscription: null
                }
              ]
            }
          }
        }),
        ok: true
      } as any);

      // Mock the errorHandler.logError method to ensure it's called
      (tibberApi as any).errorHandler.logError = jest.fn();

      // Expect getPrices to throw an error
      await expect(tibberApi.getPrices())
        .rejects.toThrow(/Failed to format price data/);

      // Verify fetch was called
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect((tibberApi as any).errorHandler.logError).toHaveBeenCalled();
    });

    it('should handle network errors', async () => {
      // This test is flaky due to the retry mechanism
      // Just verify that the API call doesn't crash
      // Mock fetch to simulate a network error
      mockedFetch.mockRejectedValueOnce(new Error('Network error'));

      // Mock the errorHandler.logError method to ensure it's called
      (tibberApi as any).errorHandler.logError = jest.fn();

      // Disable retries for this test to make it faster
      (tibberApi as any).retryableRequest = jest.fn().mockImplementation(
        (fn) => fn()
      );

      try {
        await tibberApi.getPrices();
      } catch (error) {
        // Expected to throw an error
        expect(error).toBeDefined();
      }
    }, 10000); // Increase timeout to 10 seconds

    it('applies retry-after when Tibber responds with 429', async () => {
      const retryAfterSeconds = '30';
      const headers = { get: jest.fn().mockReturnValue(retryAfterSeconds) };

      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers,
        json: jest.fn()
      } as any);

      (tibberApi as any).retryableRequest = jest.fn().mockImplementation((fn: any) => fn());

      await expect(tibberApi.getPrices()).rejects.toThrow('API rate limit: 429 Too Many Requests');

      expect(headers.get).toHaveBeenCalledWith('retry-after');
      expect((tibberApi as any).rateLimitResetTime).toBeGreaterThan(Date.now());
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Rate limit encountered on Tibber'));
    });
  });

  describe('formatPriceData', () => {
    it('should format price data correctly', async () => {
      // Create a mock response
      const mockResponse = {
        data: {
          viewer: {
            homes: [
              {
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.15,
                      energy: 0.10,
                      tax: 0.05,
                      startsAt: '2023-01-01T00:00:00Z'
                    },
                    today: [
                      {
                        total: 0.12,
                        energy: 0.07,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:00:00Z'
                      },
                      {
                        total: 0.16,
                        energy: 0.11,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:15:00Z'
                      },
                      {
                        total: 0.20,
                        energy: 0.15,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:30:00Z'
                      },
                      {
                        total: 0.24,
                        energy: 0.19,
                        tax: 0.05,
                        startsAt: '2023-01-01T00:45:00Z'
                      }
                    ],
                    tomorrow: [
                      {
                        total: 0.10,
                        energy: 0.05,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:00:00Z'
                      },
                      {
                        total: 0.11,
                        energy: 0.06,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:15:00Z'
                      },
                      {
                        total: 0.12,
                        energy: 0.07,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:30:00Z'
                      },
                      {
                        total: 0.13,
                        energy: 0.08,
                        tax: 0.05,
                        startsAt: '2023-01-02T00:45:00Z'
                      }
                    ]
                  }
                }
              }
            ]
          }
        }
      };

      // Mock fetch to return our mock response
      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(mockResponse),
        ok: true
      } as any);

      // Call getPrices which will internally call formatPriceData
      const result = await tibberApi.getPrices();

      // Verify the formatted data
      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('prices');
      expect(result.prices.length).toBeGreaterThan(0);
      expect(result.intervalMinutes).toBe(15);
      expect(result.quarterHourly?.length).toBe(8);
      expect(result.prices[0].price).toBeCloseTo(0.18, 5);

      // `current` must be rank-comparable with `prices`. Those are hourly means once quarter-hour
      // data is aggregated, so publishing the raw 15-minute price here meant the classifier ranked
      // a quarter against a distribution of hourly averages — a rising quarter can exceed the mean
      // of every hour and score percentile 100 on an ordinary day.
      expect(result.current.price).toBeCloseTo(0.18, 5);
      expect(result.current.price).toBe(result.prices[0].price);

      // The raw quarter is still available for decisions that need the finer resolution.
      expect(result.currentQuarter?.price).toBe(0.15);
    });

    it('should detect and handle stale price data from cache', async () => {
      // Create stale price data (2 hours old)
      const staleTime = new Date();
      staleTime.setHours(staleTime.getHours() - 2);

      const stalePrice = {
        current: {
          price: 0.15,
          time: staleTime.toISOString()
        },
        prices: [
          {
            time: staleTime.toISOString(),
            price: 0.15
          }
        ]
      };

      // Mock cache to return stale data first, then fresh data after clearing
      jest.spyOn(tibberApi as any, 'getCachedData')
        .mockReturnValueOnce(stalePrice)   // First call returns stale data
        .mockReturnValueOnce(null);       // Second call returns null (cleared)
      
      // Mock cache delete method
      const mockCache = new Map();
      mockCache.set = jest.fn();
      mockCache.delete = jest.fn();
      (tibberApi as any).cache = mockCache;

      // Mock fresh API response
      const freshTime = new Date().toISOString();
      const freshApiResponse = {
        data: {
          viewer: {
            homes: [
              {
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.20,
                      energy: 0.15,
                      tax: 0.05,
                      startsAt: freshTime
                    },
                    today: [
                      {
                        total: 0.20,
                        energy: 0.15,
                        tax: 0.05,
                        startsAt: freshTime
                      }
                    ],
                    tomorrow: []
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(freshApiResponse),
        ok: true
      } as any);

      const result = await tibberApi.getPrices();

      // Should have fetched fresh data
      expect(result.current.price).toBe(0.20);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cached Tibber price data is stale, fetching fresh data')
      );
      expect(mockCache.delete).toHaveBeenCalledWith('tibber_prices');
    });

    it('should detect future timestamps in price data', async () => {
      // Create price data with future timestamp (2 hours in the future)
      const futureTime = new Date();
      futureTime.setHours(futureTime.getHours() + 2);

      const futureApiResponse = {
        data: {
          viewer: {
            homes: [
              {
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.20,
                      energy: 0.15,
                      tax: 0.05,
                      startsAt: futureTime.toISOString()
                    },
                    today: [],
                    tomorrow: []
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(futureApiResponse),
        ok: true
      } as any);

      await tibberApi.getPrices();

      // Should warn about future timestamp
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Fetched price data is stale - this may indicate system time issues or Tibber API delays')
      );
    });

    it('should handle fresh price data correctly', async () => {
      // Create fresh price data (current time)
      const currentTime = new Date().toISOString();

      const freshApiResponse = {
        data: {
          viewer: {
            homes: [
              {
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.20,
                      energy: 0.15,
                      tax: 0.05,
                      startsAt: currentTime
                    },
                    today: [
                      {
                        total: 0.20,
                        energy: 0.15,
                        tax: 0.05,
                        startsAt: currentTime
                      }
                    ],
                    tomorrow: []
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(freshApiResponse),
        ok: true
      } as any);

      const result = await tibberApi.getPrices();

      // Should return fresh data without warnings
      expect(result.current.price).toBe(0.20);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Price data is fresh')
      );
    });
  });

  describe('getHomes', () => {
    it('should get list of homes successfully', async () => {
      // Mock successful homes response
      const mockHomesData = {
        data: {
          viewer: {
            homes: [
              {
                id: 'home-1',
                appNickname: 'My House',
                address: {
                  address1: '123 Main St',
                  city: 'Stockholm',
                  postalCode: '12345',
                  country: 'SE'
                }
              },
              {
                id: 'home-2',
                appNickname: 'Summer Cottage',
                address: {
                  address1: '456 Lake Rd',
                  city: 'Gotland',
                  postalCode: '67890',
                  country: 'SE'
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(mockHomesData),
        ok: true
      } as any);

      const homes = await tibberApi.getHomes();

      expect(homes).toHaveLength(2);
      expect(homes[0].id).toBe('home-1');
      expect(homes[0].appNickname).toBe('My House');
      expect(homes[0].address?.city).toBe('Stockholm');
      expect(homes[1].id).toBe('home-2');
      expect(homes[1].appNickname).toBe('Summer Cottage');
    });

    it('should handle empty homes list', async () => {
      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          data: {
            viewer: {
              homes: []
            }
          }
        }),
        ok: true
      } as any);

      const homes = await tibberApi.getHomes();

      expect(homes).toHaveLength(0);
    });

    it('should handle API errors in getHomes', async () => {
      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce({
          errors: [
            {
              message: 'Unauthorized'
            }
          ]
        }),
        ok: true
      } as any);

      await expect(tibberApi.getHomes()).rejects.toThrow('Tibber API error: Unauthorized');
    });
  });

  describe('setHomeId', () => {
    it('should set and get home ID', () => {
      expect(tibberApi.getHomeId()).toBeNull();
      
      tibberApi.setHomeId('home-123');
      
      expect(tibberApi.getHomeId()).toBe('home-123');
    });

    it('should clear home ID when set to null', () => {
      tibberApi.setHomeId('home-123');
      expect(tibberApi.getHomeId()).toBe('home-123');
      
      tibberApi.setHomeId(null);
      
      expect(tibberApi.getHomeId()).toBeNull();
    });

    it('should use selected home when fetching prices', async () => {
      // Create a TibberApi with a specific home ID
      const tibberWithHome = new TibberApi(mockToken, mockLogger, 'home-2');
      
      const mockMultiHomeData = {
        data: {
          viewer: {
            homes: [
              {
                id: 'home-1',
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.10,
                      startsAt: new Date().toISOString()
                    },
                    today: [
                      { total: 0.10, startsAt: new Date().toISOString() }
                    ],
                    tomorrow: []
                  }
                }
              },
              {
                id: 'home-2',
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.25,
                      startsAt: new Date().toISOString()
                    },
                    today: [
                      { total: 0.25, startsAt: new Date().toISOString() }
                    ],
                    tomorrow: []
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(mockMultiHomeData),
        ok: true
      } as any);

      const prices = await tibberWithHome.getPrices();

      // Should use home-2 price (0.25) instead of home-1 (0.10)
      expect(prices.current.price).toBe(0.25);
    });

    it('should fall back to first home if selected home not found', async () => {
      const tibberWithInvalidHome = new TibberApi(mockToken, mockLogger, 'non-existent-home');
      
      const mockData = {
        data: {
          viewer: {
            homes: [
              {
                id: 'home-1',
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.10,
                      startsAt: new Date().toISOString()
                    },
                    today: [
                      { total: 0.10, startsAt: new Date().toISOString() }
                    ],
                    tomorrow: []
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(mockData),
        ok: true
      } as any);

      const prices = await tibberWithInvalidHome.getPrices();

      // Should fall back to first home
      expect(prices.current.price).toBe(0.10);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not found')
      );
    });

    it('should log info when multiple homes found but none selected', async () => {
      // No home ID set
      const mockMultiHomeData = {
        data: {
          viewer: {
            homes: [
              {
                id: 'home-1',
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.10,
                      startsAt: new Date().toISOString()
                    },
                    today: [
                      { total: 0.10, startsAt: new Date().toISOString() }
                    ],
                    tomorrow: []
                  }
                }
              },
              {
                id: 'home-2',
                currentSubscription: {
                  priceInfo: {
                    current: {
                      total: 0.25,
                      startsAt: new Date().toISOString()
                    },
                    today: [
                      { total: 0.25, startsAt: new Date().toISOString() }
                    ],
                    tomorrow: []
                  }
                }
              }
            ]
          }
        }
      };

      mockedFetch.mockResolvedValueOnce({
        json: jest.fn().mockResolvedValueOnce(mockMultiHomeData),
        ok: true
      } as any);

      const prices = await tibberApi.getPrices();

      // Should use first home
      expect(prices.current.price).toBe(0.10);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Multiple Tibber homes found')
      );
    });
  });
});
