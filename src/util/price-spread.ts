/**
 * Is the price spread large enough to be worth acting on?
 *
 * Rank-based logic ("heat in the cheapest hours") always finds a cheapest hour, even on a day
 * where every hour costs practically the same. Acting on that spread means paying real
 * compressor cycling and standing losses to chase a saving of a fraction of an öre.
 *
 * The test has to be made on the **delivered** price, not the spot price. In Sweden the fixed
 * per-kWh adders (energy tax, the variable grid component) are the same in every hour, so they
 * compress the ratio dramatically: a spot price moving 0.20 -> 0.80 SEK/kWh is a 4x spot ratio
 * but only about 1.6x at the meter. Controllers that rank on raw spot systematically overstate
 * how much every spread is worth.
 *
 * Two different questions need two different tests, and they have very different thresholds:
 *
 *  - **Retiming** the same energy to a cheaper hour costs (almost) nothing but standing loss,
 *    so it pays whenever the absolute spread clears that loss. The per-kWh adders cancel
 *    entirely, because the same number of kWh is bought either way.
 *  - **Spending extra energy** (preheating, raising the tank temperature) buys the additional
 *    kWh at the full delivered price, so it only pays when the delivered *ratio* exceeds
 *    1 + the energy penalty of the action.
 */

/** A price series point. Only the price is needed for spread analysis. */
export interface PricePoint {
  price: number;
}

export interface SpreadAnalysis {
  /** Lowest spot price in the horizon. */
  minPrice: number;
  /** Highest spot price in the horizon. */
  maxPrice: number;
  /** Absolute spot spread (max - min). Adders cancel, so this is the retiming opportunity. */
  absoluteSpread: number;
  /** Ratio of delivered max to delivered min, i.e. including the fixed per-kWh adders. */
  deliveredRatio: number;
  /** True when the absolute spread clears the retiming threshold. */
  worthRetiming: boolean;
  /** True when the delivered ratio clears the threshold for spending extra energy. */
  worthSpendingExtraEnergy: boolean;
}

export interface SpreadThresholds {
  /**
   * Fixed per-kWh cost added to every hour alike (energy tax + variable grid component).
   * Only affects the ratio test; it cancels out of the absolute test.
   */
  fixedAdderPerKwh?: number;
  /**
   * Minimum absolute spread, in currency per kWh, before retiming is worthwhile.
   * Covers tank standing losses and compressor cycling.
   */
  minAbsoluteSpread?: number;
  /**
   * Minimum delivered ratio before spending extra energy is worthwhile. Should be set to
   * roughly 1 + the energy penalty of the action being considered.
   */
  minDeliveredRatio?: number;
}

/** Standing losses and cycling cost of moving a tank charge, in currency per kWh. */
export const DEFAULT_MIN_ABSOLUTE_SPREAD = 0.05;

/**
 * Default ratio required before spending extra energy. Retiming a tank charge at an unchanged
 * setpoint carries only standing loss, which published break-even estimates put at roughly
 * 1.03-1.05; raising the tank temperature instead costs COP and needs about 1.2.
 */
export const DEFAULT_MIN_DELIVERED_RATIO = 1.05;

export function analysePriceSpread(
  prices: PricePoint[],
  thresholds: SpreadThresholds = {}
): SpreadAnalysis {
  const {
    fixedAdderPerKwh = 0,
    minAbsoluteSpread = DEFAULT_MIN_ABSOLUTE_SPREAD,
    minDeliveredRatio = DEFAULT_MIN_DELIVERED_RATIO
  } = thresholds;

  const valid = prices
    .map(p => p?.price)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));

  if (valid.length === 0) {
    return {
      minPrice: 0,
      maxPrice: 0,
      absoluteSpread: 0,
      deliveredRatio: 1,
      worthRetiming: false,
      worthSpendingExtraEnergy: false
    };
  }

  const minPrice = Math.min(...valid);
  const maxPrice = Math.max(...valid);
  const absoluteSpread = maxPrice - minPrice;

  const adder = Number.isFinite(fixedAdderPerKwh) ? Math.max(0, fixedAdderPerKwh) : 0;
  const deliveredMin = minPrice + adder;
  const deliveredMax = maxPrice + adder;
  // A non-positive delivered floor cannot produce a meaningful ratio (negative spot prices do
  // occur). Treat it as "no usable ratio" rather than dividing by zero or a negative number.
  const deliveredRatio = deliveredMin > 0 ? deliveredMax / deliveredMin : 1;

  return {
    minPrice,
    maxPrice,
    absoluteSpread,
    deliveredRatio,
    worthRetiming: absoluteSpread >= minAbsoluteSpread,
    worthSpendingExtraEnergy:
      absoluteSpread >= minAbsoluteSpread && deliveredRatio >= minDeliveredRatio
  };
}
