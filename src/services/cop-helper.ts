import { DateTime } from 'luxon';
import { CronJob } from 'cron';

// Constants for storage keys
const COP_SNAPSHOTS_DAILY = 'cop_snapshots_daily';
const COP_SNAPSHOTS_WEEKLY = 'cop_snapshots_weekly';
const COP_SNAPSHOTS_MONTHLY = 'cop_snapshots_monthly';

/**
 * Helper class for calculating and tracking COP (Coefficient of Performance)
 * for MELCloud heat pumps
 */
export class COPHelper {
  private device: any; // Homey device instance
  private homey: any; // Homey app instance
  private dailyJob: any;
  private weeklyJob: any;
  private monthlyJob: any;
  private logger: any;

  /**
   * Constructor
   * @param homey Homey app instance
   * @param logger Logger instance
   */
  constructor(homey: any, logger: any) {
    this.homey = homey;
    this.logger = logger;

    // Schedule jobs
    this.scheduleJobs();
  }



  /**
   * Schedule cron jobs for COP calculations
   */
  private scheduleJobs(): void {
    try {
      if (this.homey && this.homey.scheduler && typeof this.homey.scheduler.scheduleTask === 'function') {
        // Prefer Homey scheduler when available
        this.dailyJob = this.homey.scheduler.scheduleTask('5 0 * * *', async () => {
          this.logger.log('Daily COP calculation job triggered');
          await this.compute('daily');
        });

        this.weeklyJob = this.homey.scheduler.scheduleTask('10 0 * * 1', async () => {
          this.logger.log('Weekly COP calculation job triggered');
          await this.compute('weekly');
        });

        this.monthlyJob = this.homey.scheduler.scheduleTask('15 0 1 * *', async () => {
          this.logger.log('Monthly COP calculation job triggered');
          await this.compute('monthly');
        });
      } else {
        // Fallback to node-cron CronJob if Homey scheduler is unavailable
        this.dailyJob = new CronJob('0 5 0 * * *', async () => {
          this.logger.log('Daily COP calculation job triggered');
          await this.compute('daily');
        }, null, true);

        this.weeklyJob = new CronJob('0 10 0 * * 1', async () => {
          this.logger.log('Weekly COP calculation job triggered');
          await this.compute('weekly');
        }, null, true);

        this.monthlyJob = new CronJob('0 15 0 1 * *', async () => {
          this.logger.log('Monthly COP calculation job triggered');
          await this.compute('monthly');
        }, null, true);
      }

      this.logger.log('COP calculation jobs scheduled');
    } catch (error: unknown) {
      this.logger.error('Error scheduling COP calculation jobs:', error);
    }
  }

  /**
   * Compute COP for a specific timeframe
   * @param timeframe Timeframe for calculation (daily, weekly, monthly)
   */
  public async compute(timeframe: 'daily' | 'weekly' | 'monthly'): Promise<void> {
    try {
      this.logger.log(`Computing ${timeframe} COP values`);

      // Prefer the accurate EnergyCost/Report aggregates (the same source the live optimizer trusts).
      // The Device/Get DailyHeating/HotWaterEnergyProduced/Consumed fields read 0 on some units,
      // which previously made every persisted COP snapshot/weekly-trend 0 (DHW-2). Fall back to the
      // device-state daily counters only if the totals fetch is unavailable.
      let producedHeating: number;
      let consumedHeating: number;
      let producedHW: number;
      let consumedHW: number;

      const totals = await this.getEnergyTotals();
      if (totals) {
        producedHeating = totals.TotalHeatingProduced || 0;
        consumedHeating = totals.TotalHeatingConsumed || 0;
        producedHW = totals.TotalHotWaterProduced || 0;
        consumedHW = totals.TotalHotWaterConsumed || 0;
      } else {
        const melData = await this.getMELCloudData();
        if (!melData || !melData.Device) {
          this.logger.error('No MELCloud data available for COP calculation');
          return;
        }
        producedHeating = melData.Device.DailyHeatingEnergyProduced || 0;
        consumedHeating = melData.Device.DailyHeatingEnergyConsumed || 0;
        producedHW = melData.Device.DailyHotWaterEnergyProduced || 0;
        consumedHW = melData.Device.DailyHotWaterEnergyConsumed || 0;
      }

      // Safety – avoid division by zero
      const copHeat = consumedHeating > 0 ? producedHeating / consumedHeating : 0;
      const copHW = consumedHW > 0 ? producedHW / consumedHW : 0;

      // Store a snapshot for later aggregation
      await this.pushSnapshot(timeframe, {
        heat: { produced: producedHeating, consumed: consumedHeating, cop: copHeat },
        water: { produced: producedHW, consumed: consumedHW, cop: copHW },
        timestamp: DateTime.now().toISO(),
      });

      // Log the values
      this.logger.log(`${timeframe.charAt(0).toUpperCase() + timeframe.slice(1)} COP values:`);
      this.logger.log(`- Heating: Produced ${producedHeating.toFixed(2)} kWh, Consumed ${consumedHeating.toFixed(2)} kWh, COP ${copHeat.toFixed(2)}`);
      this.logger.log(`- Hot Water: Produced ${producedHW.toFixed(2)} kWh, Consumed ${consumedHW.toFixed(2)} kWh, COP ${copHW.toFixed(2)}`);
    } catch (error: unknown) {
      this.logger.error(`Error computing ${timeframe} COP:`, error);
    }
  }

  /**
   * Get accurate daily energy totals from the EnergyCost/Report aggregates.
   * This is the same source the live optimizer uses, and unlike the Device/Get daily
   * counters it reports real produced/consumed figures on all units.
   * @returns Daily energy totals, or null if unavailable
   */
  private async getEnergyTotals(): Promise<any | null> {
    try {
      const deviceId = this.homey.settings.get('device_id');
      const buildingId = parseInt(this.homey.settings.get('building_id') || '0');
      if (!deviceId || !buildingId) {
        return null;
      }

      const melCloud = (global as any).melCloud;
      if (!melCloud || typeof melCloud.getDailyEnergyTotals !== 'function') {
        return null;
      }

      return await melCloud.getDailyEnergyTotals(deviceId, buildingId);
    } catch (error: unknown) {
      this.logger.error('Error getting energy totals for COP calculation:', error);
      return null;
    }
  }

  /**
   * Get MELCloud data from the optimizer
   * @returns MELCloud data
   */
  private async getMELCloudData(): Promise<any> {
    try {
      // Get the device ID and building ID from settings
      const deviceId = this.homey.settings.get('device_id');
      const buildingId = parseInt(this.homey.settings.get('building_id') || '0');

      if (!deviceId || !buildingId) {
        this.logger.error('Device ID or Building ID not set in settings');
        return null;
      }

      // Get the MELCloud API instance from the global scope
      const melCloud = (global as any).melCloud;
      if (!melCloud) {
        this.logger.error('MELCloud API instance not available');
        return null;
      }

      // Get device state from MELCloud (contains Daily*Energy* fields for COP calculation)
      const deviceState = await melCloud.getDeviceState(deviceId, buildingId);
      return { Device: deviceState };
    } catch (error: unknown) {
      this.logger.error('Error getting MELCloud data for COP calculation:', error);
      return null;
    }
  }

  /**
   * Push a snapshot into device store
   * @param key Timeframe key (daily, weekly, monthly)
   * @param data Snapshot data
   */
  private async pushSnapshot(key: string, data: any): Promise<void> {
    try {
      const storeKey = `cop_snapshots_${key}`;
      const list = (await this.homey.settings.get(storeKey)) || [];
      list.push(data);

      // Keep only the latest 31 entries (≈ a month)
      if (list.length > 31) list.splice(0, list.length - 31);

      await this.homey.settings.set(storeKey, list);
      this.logger.log(`Saved ${key} COP snapshot (total: ${list.length})`);
    } catch (error: unknown) {
      this.logger.error(`Error saving ${key} COP snapshot:`, error);
    }
  }

  /**
   * Get the average COP for a specific timeframe
   * @param timeframe Timeframe for calculation (daily, weekly, monthly)
   * @param type Type of COP (heat or water)
   * @returns Average COP value
   */
  public async getAverageCOP(timeframe: 'daily' | 'weekly' | 'monthly', type: 'heat' | 'water'): Promise<number> {
    try {
      const storeKey = `cop_snapshots_${timeframe}`;
      const snapshots = await this.homey.settings.get(storeKey) || [];

      if (snapshots.length === 0) {
        return 0;
      }

      // Calculate average COP
      let totalCOP = 0;
      let validEntries = 0;

      for (const snapshot of snapshots) {
        const cop = type === 'heat' ? snapshot.heat.cop : snapshot.water.cop;
        if (cop > 0) {
          totalCOP += cop;
          validEntries++;
        }
      }

      return validEntries > 0 ? totalCOP / validEntries : 0;
    } catch (error: unknown) {
      this.logger.error(`Error getting average ${timeframe} ${type} COP:`, error);
      return 0;
    }
  }

  /**
   * Get the latest COP values
   * @returns Latest COP values for heating and hot water
   */
  public async getLatestCOP(): Promise<{ heating: number; hotWater: number }> {
    try {
      const dailySnapshots = await this.homey.settings.get('cop_snapshots_daily') || [];

      if (dailySnapshots.length === 0) {
        return { heating: 0, hotWater: 0 };
      }

      const latest = dailySnapshots[dailySnapshots.length - 1];
      return {
        heating: latest.heat.cop || 0,
        hotWater: latest.water.cop || 0
      };
    } catch (error: unknown) {
      this.logger.error('Error getting latest COP values:', error);
      return { heating: 0, hotWater: 0 };
    }
  }

  /**
   * Check if it's summer season (for seasonal adjustments)
   * @returns True if it's summer season
   */
  public isSummerSeason(): boolean {
    const now = new Date();
    const month = now.getMonth(); // 0-11 (Jan-Dec)

    // Consider May through September as summer (months 4-8)
    return month >= 4 && month <= 8;
  }

  /**
   * Get the current season-appropriate COP value
   * @returns COP value based on season
   */
  public async getSeasonalCOP(): Promise<number> {
    try {
      const isSummer = this.isSummerSeason();

      if (isSummer) {
        // In summer, prioritize hot water COP
        return await this.getAverageCOP('daily', 'water');
      } else {
        // In winter, prioritize heating COP
        return await this.getAverageCOP('daily', 'heat');
      }
    } catch (error: unknown) {
      this.logger.error('Error getting seasonal COP, falling back to default:', error);
      // Return reasonable default COP based on season
      const isSummer = this.isSummerSeason();
      return isSummer ? 2.5 : 3.0; // Hot water COP typically lower than heating COP
    }
  }

  /**
   * Get COP data for the API
   * @returns COP data for API response
   */
  public async getCOPData(): Promise<any> {
    try {
      const dailyHeating = await this.getAverageCOP('daily', 'heat');
      const weeklyHeating = await this.getAverageCOP('weekly', 'heat');
      const monthlyHeating = await this.getAverageCOP('monthly', 'heat');

      const dailyHotWater = await this.getAverageCOP('daily', 'water');
      const weeklyHotWater = await this.getAverageCOP('weekly', 'water');
      const monthlyHotWater = await this.getAverageCOP('monthly', 'water');

      const isSummer = this.isSummerSeason();
      const seasonalCOP = isSummer ? dailyHotWater : dailyHeating;

      // Get snapshots for trends
      const dailySnapshots = await this.homey.settings.get('cop_snapshots_daily') || [];
      const weeklySnapshots = await this.homey.settings.get('cop_snapshots_weekly') || [];

      return {
        heating: {
          daily: dailyHeating,
          weekly: weeklyHeating,
          monthly: monthlyHeating,
          snapshots: dailySnapshots.map((s: any) => ({
            timestamp: s.timestamp,
            cop: s.heat.cop,
            produced: s.heat.produced,
            consumed: s.heat.consumed
          }))
        },
        hotWater: {
          daily: dailyHotWater,
          weekly: weeklyHotWater,
          monthly: monthlyHotWater,
          snapshots: dailySnapshots.map((s: any) => ({
            timestamp: s.timestamp,
            cop: s.water.cop,
            produced: s.water.produced,
            consumed: s.water.consumed
          }))
        },
        seasonal: {
          isSummer,
          currentCOP: seasonalCOP
        },
        weeklyTrend: weeklySnapshots.map((s: any) => ({
          timestamp: s.timestamp,
          heatingCOP: s.heat.cop,
          hotWaterCOP: s.water.cop
        }))
      };
    } catch (error: unknown) {
      this.logger.error('Error getting COP data for API:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        error: errorMessage,
        heating: { daily: 0, weekly: 0, monthly: 0 },
        hotWater: { daily: 0, weekly: 0, monthly: 0 },
        seasonal: { isSummer: this.isSummerSeason(), currentCOP: 0 }
      };
    }
  }
}
