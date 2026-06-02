import { HomeyLogger } from '../util/logger';
import { PriceAnalyzer } from './price-analyzer';
import { OptimizationMetrics, SchedulePoint } from '../types';
import { COP_THRESHOLDS } from '../constants';
import { CopNormalizer } from './cop-normalizer';

export interface HotWaterAction {
    action: 'heat_now' | 'delay' | 'maintain';
    reason: string;
    scheduledTime?: string;
}

type TimedPricePoint = {
    time: string;
    price: number;
};

type HourlyCandidateSlot = {
    hour: number;
    priceIndex: number;
    price: number;
    startMs: number;
    endMs: number;
};

export class HotWaterOptimizer {
    constructor(
        private readonly logger: HomeyLogger,
        private readonly priceAnalyzer: PriceAnalyzer
    ) { }

    private validateQuarterHourlyData(data: { time: string; price: number }[]): boolean {
        if (!Array.isArray(data) || data.length < 4) {
            return false;
        }
        const interval = this.detectIntervalMinutes(data);
        if (!interval || interval > 30) {
            return false;
        }
        // Check for large gaps (> 1.5x detected interval)
        const maxGapMs = interval * 1.5 * 60000;
        for (let i = 1; i < data.length; i += 1) {
            const prev = Date.parse(data[i - 1].time);
            const curr = Date.parse(data[i].time);
            if (Number.isFinite(prev) && Number.isFinite(curr) && (curr - prev) > maxGapMs) {
                this.logger.log('DHW decision source: hourly fallback (quarter-hourly data has gap)', {
                    gapMinutes: Math.round((curr - prev) / 60000),
                    maxAllowedMinutes: Math.round(maxGapMs / 60000)
                });
                return false;
            }
        }
        return true;
    }

    private detectIntervalMinutes(prices: { time: string }[]): number | null {
        if (!Array.isArray(prices) || prices.length < 2) {
            return null;
        }

        for (let i = 1; i < prices.length; i += 1) {
            const prev = new Date(prices[i - 1].time).getTime();
            const current = new Date(prices[i].time).getTime();
            if (Number.isFinite(prev) && Number.isFinite(current)) {
                const diffMinutes = Math.round((current - prev) / 60000);
                if (diffMinutes > 0) {
                    return diffMinutes;
                }
            }
        }
        return null;
    }

    private getIntervalMs(prices: { time: string }[], defaultIntervalMinutes: number): number {
        const detectedMinutes = this.detectIntervalMinutes(prices);
        const intervalMinutes = detectedMinutes && detectedMinutes > 0 ? detectedMinutes : defaultIntervalMinutes;
        return intervalMinutes * 60000;
    }

    private getWindowEndMs(prices: { time: string }[], referenceTimeMs: number, defaultIntervalMinutes: number): number {
        const intervalMs = this.getIntervalMs(prices, defaultIntervalMinutes);
        for (let i = prices.length - 1; i >= 0; i -= 1) {
            const ts = Date.parse(prices[i].time);
            if (Number.isFinite(ts)) {
                return ts + intervalMs;
            }
        }
        return referenceTimeMs + prices.length * intervalMs;
    }

    private getHourEndMs(timestampMs: number): number {
        const hourStart = new Date(timestampMs);
        hourStart.setUTCMinutes(0, 0, 0);
        return hourStart.getTime() + 3600000;
    }

    private buildPeakWindowHours(currentHour: number, peakHour: number, lookbackHours: number = 4): number[] {
        const hoursUntilPeak = (peakHour - currentHour + 24) % 24;
        const startOffset = Math.max(0, hoursUntilPeak - (lookbackHours - 1));
        const endOffset = Math.min(23, hoursUntilPeak);
        const validHours: number[] = [];

        for (let offset = startOffset; offset <= endOffset; offset += 1) {
            validHours.push((currentHour + offset) % 24);
        }

        return validHours;
    }

    private filterPricesToWindow(prices: TimedPricePoint[], startMs: number, endMs: number): TimedPricePoint[] {
        return prices.filter((pricePoint) => {
            const ts = Date.parse(pricePoint.time);
            return Number.isFinite(ts) && ts >= startMs && ts < endMs;
        });
    }

    private buildHourlyCandidateSlots(
        validHours: number[],
        currentHour: number,
        next24h: TimedPricePoint[],
        nowMs: number
    ): HourlyCandidateSlot[] {
        const intervalMs = this.getIntervalMs(next24h, 60);

        return validHours
            .map((hour) => {
                const priceIndex = (hour - currentHour + 24) % 24;
                if (priceIndex >= next24h.length) {
                    return null;
                }

                const pricePoint = next24h[priceIndex];
                if (!Number.isFinite(pricePoint?.price)) {
                    return null;
                }

                const rawStartMs = pricePoint.time ? Date.parse(pricePoint.time) : NaN;
                const nextStartMs = priceIndex + 1 < next24h.length
                    ? Date.parse(next24h[priceIndex + 1].time)
                    : NaN;
                if (!Number.isFinite(rawStartMs)) {
                    return null;
                }

                const startMs = Math.max(rawStartMs, nowMs);
                const endMs = Number.isFinite(nextStartMs) && nextStartMs > startMs
                    ? nextStartMs
                    : rawStartMs + intervalMs;

                return {
                    hour,
                    priceIndex,
                    price: pricePoint.price,
                    startMs,
                    endMs
                };
            })
            .filter((slot): slot is HourlyCandidateSlot => {
                return !!slot && Number.isFinite(slot.startMs) && Number.isFinite(slot.endMs) && slot.endMs > slot.startMs;
            });
    }

    private findBestQuarterHourlyBlock(prices: { time: string; price: number }[], nowMs: number, minSlots: number) {
        if (!Array.isArray(prices) || prices.length < minSlots) {
            return null;
        }

        const upcoming = prices
            .map((p) => ({ ...p, ts: Date.parse(p.time) }))
            .filter((p) => Number.isFinite(p.ts) && (p.ts as number) >= nowMs)
            .sort((a, b) => (a.ts as number) - (b.ts as number));

        if (upcoming.length < minSlots) {
            return null;
        }

        const intervalMinutes = this.detectIntervalMinutes(upcoming as any) ?? 15;
        if (intervalMinutes > 30) {
            return null;
        }

        let best = null as null | { start: number; end: number; avg: number; slots: number };
        let groupStart = 0;

        const isContiguous = (prev: number, current: number) => {
            const diff = (current - prev) / 60000;
            return diff <= intervalMinutes * 1.1; // allow slight drift
        };

        for (let i = 1; i <= upcoming.length; i += 1) {
            const prevTs = upcoming[i - 1].ts as number;
            const currentTs = i < upcoming.length ? (upcoming[i].ts as number) : NaN;
            const contiguous = Number.isFinite(currentTs) && isContiguous(prevTs, currentTs);
            if (!contiguous || i === upcoming.length) {
                const group = upcoming.slice(groupStart, i);
                if (group.length >= minSlots) {
                    // Sliding window within the group for minSlots..group.length
                    for (let windowSize = minSlots; windowSize <= group.length; windowSize += 1) {
                        for (let start = 0; start + windowSize <= group.length; start += 1) {
                            const window = group.slice(start, start + windowSize);
                            const sum = window.reduce((s, p) => s + p.price, 0);
                            const avg = sum / window.length;
                            const startTs = window[0].ts as number;
                            const endTs = window[window.length - 1].ts as number;
                            if (!best || avg < best.avg || (avg === best.avg && startTs < best.start)) {
                                best = { start: startTs, end: endTs, avg, slots: window.length };
                            }
                        }
                    }
                }
                groupStart = i;
            }
        }

        return best
            ? {
                startTime: new Date(best.start).toISOString(),
                endTime: new Date(best.end).toISOString(),
                averagePrice: best.avg,
                slots: best.slots,
            }
            : null;
    }

    /**
     * Optimize hot water scheduling based on price and COP
     */
    public async optimizeHotWaterScheduling(
        currentPrice: number,
        priceData: any,
        metrics: OptimizationMetrics | null,
        lastEnergyData: any
    ): Promise<HotWaterAction> {
        if (!metrics || !lastEnergyData) {
            return { action: 'maintain', reason: 'No real energy data available for hot water optimization' };
        }

        // Calculate hot water efficiency score
        const hotWaterCOP = metrics.realHotWaterCOP;

        // Find cheapest blocks (15m) or hours in the next 24 hours
        const referenceTimeMs = priceData.current?.time ? Date.parse(priceData.current.time) : NaN;
        const nowMs = Number.isFinite(referenceTimeMs) ? referenceTimeMs : Date.now();
        const upcomingPrices = priceData.prices.filter((pricePoint: any) => {
            const ts = Date.parse(pricePoint.time);
            if (!Number.isFinite(ts)) {
                return true;
            }
            return ts >= nowMs;
        });
        const prices = (upcomingPrices.length > 0 ? upcomingPrices : priceData.prices).slice(0, 24); // Next 24 hours
        const sortedPrices = [...prices].sort((a: any, b: any) => a.price - b.price);
        const cheapestHours = sortedPrices.slice(0, 4); // Top 4 cheapest hours

        const quarterHourlyRaw = Array.isArray((priceData as any).quarterHourly) ? (priceData as any).quarterHourly : [];
        const quarterHourlyValid = this.validateQuarterHourlyData(quarterHourlyRaw);
        const priceHorizonEndMs = this.getWindowEndMs(prices, nowMs, 60);
        const quarterHourly = quarterHourlyValid
            ? this.filterPricesToWindow(quarterHourlyRaw, nowMs, priceHorizonEndMs)
            : [];
        const bestQuarterBlock = quarterHourly.length > 0
            ? this.findBestQuarterHourlyBlock(quarterHourly, nowMs, 2) // 2 slots = 30 minutes
            : null;
        if (bestQuarterBlock) {
            this.logger.log('DHW quarter-hour block candidate selected', {
                start: bestQuarterBlock.startTime,
                end: bestQuarterBlock.endTime,
                slots: bestQuarterBlock.slots,
                averagePrice: bestQuarterBlock.averagePrice,
            });

            // Quarter-hour-informed decision: use block timing to improve hourly action
            const blockStartMs = Date.parse(bestQuarterBlock.startTime);
            const currentHourEnd = this.getHourEndMs(nowMs);
            const hourlyAvgPrice = prices.reduce((s: number, p: any) => s + p.price, 0) / prices.length;

            if (Number.isFinite(blockStartMs) && blockStartMs >= nowMs && blockStartMs < currentHourEnd) {
                // Cheapest block is within the current hour — strong signal to heat now
                if (bestQuarterBlock.averagePrice < hourlyAvgPrice) {
                    this.logger.log('DHW decision source: quarter-hourly', {
                        action: 'heat_now',
                        blockAvgPrice: bestQuarterBlock.averagePrice,
                        hourlyAvgPrice,
                    });
                    return {
                        action: 'heat_now',
                        reason: `Cheapest quarter-hour block in current hour (avg ${bestQuarterBlock.averagePrice.toFixed(4)} vs hourly avg ${hourlyAvgPrice.toFixed(4)})`
                    };
                }
            } else if (Number.isFinite(blockStartMs) && blockStartMs >= currentHourEnd) {
                // Cheapest block is in a future hour — delay to that block
                const cheapestHourPrice = sortedPrices[0]?.price ?? Infinity;
                if (bestQuarterBlock.averagePrice < cheapestHourPrice) {
                    this.logger.log('DHW decision source: quarter-hourly', {
                        action: 'delay',
                        blockStart: bestQuarterBlock.startTime,
                        blockAvgPrice: bestQuarterBlock.averagePrice,
                        cheapestHourPrice,
                    });
                    return {
                        action: 'delay',
                        reason: `Delay to cheapest quarter-hour block at ${bestQuarterBlock.startTime} (avg ${bestQuarterBlock.averagePrice.toFixed(4)} vs cheapest hour ${cheapestHourPrice.toFixed(4)})`,
                        scheduledTime: bestQuarterBlock.startTime
                    };
                }
            }
        } else if (quarterHourly.length === 0) {
            this.logger.log('DHW decision source: hourly fallback');
        }

        // Use CopNormalizer.roughNormalize for consistent COP normalization
        // Hot water COP typically ranges lower than heating, so use 4.0 as assumedMax
        const hotWaterEfficiency = CopNormalizer.roughNormalize(hotWaterCOP, 4.0);

        // Current price percentile
        const currentPercentile = prices.filter((p: any) => p.price <= currentPrice).length / prices.length;
        const cheapThreshold = this.priceAnalyzer.getCheapPercentile();

        // Improved COP-based hot water optimization
        if (hotWaterEfficiency > COP_THRESHOLDS.EXCELLENT) {
            // Excellent hot water COP: More flexible timing  
            if (currentPercentile <= (cheapThreshold * 1.6)) {
                return {
                    action: 'heat_now',
                    reason: `Excellent hot water COP (${hotWaterCOP.toFixed(2)}) + reasonable electricity price`
                };
            } else if (currentPercentile >= (1.0 - cheapThreshold * 0.8)) {
                const nextCheapHour = cheapestHours[0];
                return {
                    action: 'delay',
                    reason: `High COP but very expensive electricity - delay to ${bestQuarterBlock?.startTime || nextCheapHour.time} (cheapest block avg ${bestQuarterBlock ? bestQuarterBlock.averagePrice.toFixed(4) : nextCheapHour.price.toFixed(4)})`,
                    scheduledTime: bestQuarterBlock?.startTime || nextCheapHour.time
                };
            }
        } else if (hotWaterEfficiency > COP_THRESHOLDS.GOOD) {
            // Good hot water COP: Moderate optimization
            // Use ~1.2x cheap threshold (e.g., 30% when cheap=25%)
            if (currentPercentile <= cheapThreshold * 1.2) {
                return {
                    action: 'heat_now',
                    reason: `Good hot water COP (${hotWaterCOP.toFixed(2)}) + cheap electricity`
                };
            }
        } else if (hotWaterEfficiency > COP_THRESHOLDS.POOR) {
            // Poor hot water COP: Conservative approach
            // Use ~0.6x cheap threshold (e.g., 15% when cheap=25%)
            if (currentPercentile <= cheapThreshold * 0.6) {
                return {
                    action: 'heat_now',
                    reason: `Poor hot water COP (${hotWaterCOP.toFixed(2)}) - only during cheapest electricity`
                };
            } else {
                const nextCheapHour = cheapestHours[0];
                return {
                    action: 'delay',
                    reason: `Poor COP - wait for cheapest electricity at ${bestQuarterBlock?.startTime || nextCheapHour.time} (block avg ${bestQuarterBlock ? bestQuarterBlock.averagePrice.toFixed(4) : nextCheapHour.price.toFixed(4)})`,
                    scheduledTime: bestQuarterBlock?.startTime || nextCheapHour.time
                };
            }
        } else if (hotWaterCOP > 0) {
            // Very poor hot water COP: Emergency heating only
            // Use ~0.4x cheap threshold (e.g., 10% when cheap=25%)
            if (currentPercentile <= cheapThreshold * 0.4) {
                return {
                    action: 'heat_now',
                    reason: `Very poor hot water COP (${hotWaterCOP.toFixed(2)}) - emergency heating during absolute cheapest electricity`
                };
            } else {
                const nextCheapHour = cheapestHours[0];
                return {
                    action: 'delay',
                    reason: `Very poor COP - critical: wait for absolute cheapest electricity at ${bestQuarterBlock?.startTime || nextCheapHour.time} (block avg ${bestQuarterBlock ? bestQuarterBlock.averagePrice.toFixed(4) : nextCheapHour.price.toFixed(4)})`,
                    scheduledTime: bestQuarterBlock?.startTime || nextCheapHour.time
                };
            }
        }

        return { action: 'maintain', reason: 'Maintaining current hot water schedule' };
    }

    /**
     * Calculate estimated savings from pattern-based scheduling
     * Compares scheduled cheap-hour heating vs on-demand heating cost
     */
    private calculatePatternSavings(
        schedulePoints: SchedulePoint[],
        currentHour: number,
        priceData: any[],
        options: { gridFeePerKwh?: number; estimatedDailyHotWaterKwh?: number } = {}
    ): number {
        if (schedulePoints.length === 0 || priceData.length === 0) {
            return 0;
        }

        const gridFee = Number.isFinite(options.gridFeePerKwh) ? (options.gridFeePerKwh as number) : 0;

        // Derive a kWh scale from pattern priorities to avoid hard-coded constants.
        // Treat priorities as relative weights and scale by an estimated daily kWh if provided.
        const totalPriority = schedulePoints.reduce((sum, p) => sum + Math.max(p.priority, 0), 0);
        const dailyKwh = Number.isFinite(options.estimatedDailyHotWaterKwh)
            ? (options.estimatedDailyHotWaterKwh as number)
            : 0;
        if (totalPriority === 0 || dailyKwh <= 0) {
            return 0; // No meaningful estimate available
        }

        // Calculate cost of scheduled heating (during cheap hours)
        let scheduledCost = 0;
        let totalDemand = 0;

        for (const point of schedulePoints) {
            const hoursAhead = (point.hour - currentHour + 24) % 24;

            if (hoursAhead < priceData.length) {
                const hourPrice = priceData[hoursAhead].price;
                const estimatedKWh = (Math.max(point.priority, 0) / totalPriority) * dailyKwh;

                scheduledCost += (hourPrice + gridFee) * estimatedKWh;
                totalDemand += estimatedKWh;
            }
        }

        if (totalDemand === 0) {
            return 0;
        }

        // Calculate cost of on-demand heating at average price
        const avgPrice = priceData.reduce((sum, p) => sum + p.price, 0) / priceData.length;
        const onDemandCost = (avgPrice + gridFee) * totalDemand;

        // Savings = what it would cost on-demand minus scheduled cost
        const savings = Math.max(0, onDemandCost - scheduledCost);

        return Number(savings.toFixed(3));
    }

    /**
     * Optimize hot water scheduling based on usage patterns
     */
    public optimizeHotWaterSchedulingByPattern(
        currentHour: number,
        priceData: any[],
        hotWaterCOP: number,
        usagePattern: { peakHours: number[], hourlyDemand: number[] },
        referenceTimeMs?: number,
        options: { currencyCode?: string; gridFeePerKwh?: number; estimatedDailyHotWaterKwh?: number; quarterHourly?: { time: string; price: number }[] } = {}
    ): {
        schedulePoints: SchedulePoint[];
        currentAction: 'heat_now' | 'delay' | 'maintain';
        reasoning: string;
        estimatedSavings: number;
    } {
        try {
            if (!Array.isArray(priceData) || priceData.length === 0) {
                this.logger.warn('Hot water scheduling skipped: no price data available');
                return {
                    schedulePoints: [],
                    currentAction: 'maintain',
                    reasoning: 'No price data available',
                    estimatedSavings: 0
                };
            }

            const validPrices = priceData.filter(p => p && Number.isFinite(p.price));
            if (validPrices.length === 0) {
                this.logger.warn('Hot water scheduling skipped: price data missing price field');
                return {
                    schedulePoints: [],
                    currentAction: 'maintain',
                    reasoning: 'Price data missing values',
                    estimatedSavings: 0
                };
            }

            const nowMs = typeof referenceTimeMs === 'number' && Number.isFinite(referenceTimeMs)
                ? referenceTimeMs
                : Date.now();
            const upcomingPrices = validPrices.filter(pricePoint => {
                const ts = pricePoint.time ? Date.parse(pricePoint.time) : NaN;
                if (!Number.isFinite(ts)) {
                    return true;
                }
                return ts >= nowMs;
            });
            const priceWindow = upcomingPrices.length > 0 ? upcomingPrices : validPrices;
            const next24h = priceWindow.slice(0, 24).filter(p => Number.isFinite(p.price));
            if (next24h.length === 0) {
                this.logger.warn('Hot water scheduling skipped: no valid prices in next window');
                return {
                    schedulePoints: [],
                    currentAction: 'maintain',
                    reasoning: 'No valid price data for scheduling',
                    estimatedSavings: 0
                };
            }
            this.logger.log('DHW pattern scheduler inputs', {
                currentHour,
                peakHours: usagePattern.peakHours,
                next24hCount: next24h.length,
                quarterHourlyCount: Array.isArray(options.quarterHourly) ? options.quarterHourly.length : 0,
                estimatedDailyHotWaterKwh: options.estimatedDailyHotWaterKwh ?? null
            });
            const schedulePoints: SchedulePoint[] = [];

            // For each peak demand hour, find optimal heating time
            usagePattern.peakHours.forEach(peakHour => {
                // Schedule inside the next 24h only, covering the peak hour and up to 3 hours before it.
                const validHours = this.buildPeakWindowHours(currentHour, peakHour);
                const priority = usagePattern.hourlyDemand[peakHour];

                if (validHours.length > 0) {
                    // Find cheapest hour in valid window (hourly baseline)
                    let cheapestHour = validHours.reduce((min, hour) => {
                        const priceIndex = (hour - currentHour + 24) % 24;
                        const minPriceIndex = (min - currentHour + 24) % 24;

                        if (priceIndex >= next24h.length || minPriceIndex >= next24h.length) {
                            return min;
                        }
                        const priceA = next24h[priceIndex]?.price;
                        const priceB = next24h[minPriceIndex]?.price;
                        if (!Number.isFinite(priceA) || !Number.isFinite(priceB)) return min;
                        return priceA < priceB ? hour : min;
                    });

                    // Refine with quarter-hourly data: find cheapest 30-min block within valid window
                    const qhRaw = Array.isArray(options.quarterHourly) ? options.quarterHourly : [];
                    const qh = this.validateQuarterHourlyData(qhRaw) ? qhRaw : [];
                    if (qh.length >= 2) {
                        const candidateSlots = this.buildHourlyCandidateSlots(validHours, currentHour, next24h, nowMs);
                        const hourlyIndex = (cheapestHour - currentHour + 24) % 24;
                        const hourlyCheapestPrice = hourlyIndex < next24h.length ? next24h[hourlyIndex]?.price : Infinity;
                        const bestQuarterCandidate = candidateSlots
                            .map((slot) => {
                                const slotPrices = this.filterPricesToWindow(qh, slot.startMs, slot.endMs);
                                const block = this.findBestQuarterHourlyBlock(slotPrices, slot.startMs, 2);
                                return block ? { slot, block } : null;
                            })
                            .filter((candidate): candidate is { slot: HourlyCandidateSlot; block: NonNullable<ReturnType<HotWaterOptimizer['findBestQuarterHourlyBlock']>> } => {
                                return candidate !== null;
                            })
                            .reduce((best, candidate) => {
                                if (!best) {
                                    return candidate;
                                }
                                const bestStartMs = Date.parse(best.block.startTime);
                                const candidateStartMs = Date.parse(candidate.block.startTime);
                                if (candidate.block.averagePrice < best.block.averagePrice) {
                                    return candidate;
                                }
                                if (candidate.block.averagePrice === best.block.averagePrice && candidateStartMs < bestStartMs) {
                                    return candidate;
                                }
                                return best;
                            }, null as null | { slot: HourlyCandidateSlot; block: NonNullable<ReturnType<HotWaterOptimizer['findBestQuarterHourlyBlock']>> });

                        if (bestQuarterCandidate && bestQuarterCandidate.block.averagePrice < hourlyCheapestPrice) {
                            cheapestHour = bestQuarterCandidate.slot.hour;
                            this.logger.log('DHW pattern scheduling: quarter-hour block selected', {
                                peakHour,
                                blockStart: bestQuarterCandidate.block.startTime,
                                blockAvgPrice: bestQuarterCandidate.block.averagePrice,
                                hourlyBestPrice: hourlyCheapestPrice,
                            });
                        }
                    }

                    const priceIndex = (cheapestHour - currentHour + 24) % 24;
                    const refPrice = priceIndex < next24h.length ? next24h[priceIndex]?.price : undefined;
                    const pricePercentile = Number.isFinite(refPrice)
                        ? next24h.filter((p: any) => Number.isFinite(p.price) && p.price <= refPrice).length / next24h.length
                        : 0;

                    this.logger.log('DHW peak scheduling decision', {
                        peakHour,
                        validHours,
                        selectedHour: cheapestHour,
                        selectedPrice: Number.isFinite(refPrice) ? refPrice : null,
                        pricePercentile,
                        priority,
                        withinPriceHorizon: priceIndex < next24h.length
                    });

                    schedulePoints.push({
                        hour: cheapestHour,
                        reason: `Prepare for peak demand at ${peakHour}:00`,
                        priority,
                        cop: hotWaterCOP,
                        pricePercentile
                    });
                } else {
                    this.logger.log('DHW peak scheduling skipped', {
                        peakHour,
                        reason: 'no valid future hours in planning window',
                        currentHour,
                        priority
                    });
                }
            });

            // Sort by priority (highest first)
            schedulePoints.sort((a, b) => b.priority - a.priority);

            // Determine current action
            let currentAction: 'heat_now' | 'delay' | 'maintain' = 'maintain';
            // Reason that reflects what actually drove the decision (Fix 6). Previously a single
            // "Predictive scheduling…" template was returned for every branch, so a price-driven
            // delay was mislabeled as predictive scheduling.
            let actionReason = 'Holding tank setpoint (no immediate action)';
            const peaksStr = usagePattern.peakHours.join(', ');

            // Check if current hour is a scheduled heating time
            const isScheduledNow = schedulePoints.some(point => point.hour === currentHour);

            if (isScheduledNow) {
                currentAction = 'heat_now';
                actionReason = `Pre-heating in scheduled cheap window ahead of usage peaks (${peaksStr}h)`;
            } else {
                // Check if we're approaching a peak and haven't heated yet
                const nextPeak = usagePattern.peakHours.find(peak => {
                    const hoursUntilPeak = (peak - currentHour + 24) % 24;
                    return hoursUntilPeak <= 2 && hoursUntilPeak > 0;
                });

                if (nextPeak && hotWaterCOP > 0) {
                    // Emergency heating before peak
                    currentAction = 'heat_now';
                    actionReason = `Pre-heating: usage peak within 2h (peak at ${nextPeak}h)`;
                } else {
                    // Check if current price is exceptional
                    const currentPrice = Number.isFinite(next24h[0]?.price) ? next24h[0].price : 0;
                    const avgPrice = next24h.reduce((sum: number, p: any) => sum + (Number.isFinite(p.price) ? p.price : 0), 0) / next24h.length;
                    const priceRatio = avgPrice > 0 ? currentPrice / avgPrice : 1;

                    // Convert user's cheap percentile to price ratio threshold
                    const priceRatioThreshold = 1.0 - (this.priceAnalyzer.getCheapPercentile() * 1.2);

                    // Use normalized COP with adaptive threshold instead of hardcoded raw COP value
                    const normalizedHWCOP = CopNormalizer.roughNormalize(hotWaterCOP, 4.0);
                    if (currentPrice < avgPrice * priceRatioThreshold && normalizedHWCOP > COP_THRESHOLDS.GOOD) {
                        currentAction = 'heat_now';
                        actionReason = `Heating now: price low (${priceRatio.toFixed(2)}× avg) and COP favourable`;
                    } else if (currentPrice > avgPrice * (1 + this.priceAnalyzer.getCheapPercentile() * 1.2)) {
                        // Expensive hour: reduce tank to save energy, heat later at cheaper price
                        currentAction = 'delay';
                        actionReason = `Conserving tank: price high (${priceRatio.toFixed(2)}× avg), reheat later at cheaper price`;
                    } else {
                        actionReason = `Holding tank setpoint (price ${priceRatio.toFixed(2)}× avg, near normal)`;
                    }
                }
            }

            // Calculate estimated savings
            const estimatedSavings = next24h.length > 0
                ? this.calculatePatternSavings(
                    schedulePoints,
                    currentHour,
                    next24h,
                    {
                        gridFeePerKwh: options.gridFeePerKwh,
                        estimatedDailyHotWaterKwh: options.estimatedDailyHotWaterKwh
                    }
                )
                : 0;

            const currencyCode = options.currencyCode || 'EUR';

            this.logger.log('Pattern-based hot water savings calculated', {
                schedulePoints: schedulePoints.length,
                totalDemand: schedulePoints.reduce((sum, p) => sum + Math.max(p.priority, 0), 0),
                estimatedSavings
            });

            return {
                schedulePoints,
                currentAction,
                reasoning: currentAction === 'maintain'
                    ? actionReason
                    : `${actionReason} (peaks: ${peaksStr}h, saves ${estimatedSavings.toFixed(2)} ${currencyCode})`,
                estimatedSavings
            };

        } catch (error) {
            this.logger.error('Error optimizing hot water scheduling:', error);
            return {
                schedulePoints: [],
                currentAction: 'maintain',
                reasoning: 'Error in scheduling - maintaining current operation',
                estimatedSavings: 0
            };
        }
    }
}
