import {
  AugmentedOptimizationResult,
  DecisionCode,
  EnhancedOptimizationResult,
  OptimizationDecision
} from '../types';

function classifyPriceTier(priceData?: EnhancedOptimizationResult['priceData']): {
  tier: 'cheap' | 'normal' | 'expensive';
  spike: boolean;
} {
  if (!priceData || typeof priceData.current !== 'number' || typeof priceData.average !== 'number' || priceData.average === 0) {
    return { tier: 'normal', spike: false };
  }
  const ratio = priceData.current / priceData.average;
  let tier: 'cheap' | 'normal' | 'expensive' = 'normal';
  if (ratio < 0.8) tier = 'cheap';
  else if (ratio > 1.2) tier = 'expensive';

  const spike = typeof priceData.max === 'number' && priceData.max > priceData.average * 1.25;
  return { tier, spike };
}

type HotWaterAction = EnhancedOptimizationResult['hotWaterAction'] extends { action: infer A }
  ? A
  : 'heat_now' | 'delay' | 'maintain' | null;

function formatHeadline(code: DecisionCode, toTemp?: number | null, priceTier?: string, spike?: boolean, dhwAction?: HotWaterAction | null): string {
  const target = Number.isFinite(toTemp ?? NaN) ? `${Number(toTemp).toFixed(1)}°C` : null;
  const priceText = priceTier ? `${priceTier} prices` : 'current prices';
  const spikeText = spike ? ' (spike ahead)' : '';

  switch (code) {
    case 'HEAT_PREHEAT':
      return target ? `Preheated to ${target}` : 'Preheating for upcoming costs';
    case 'HEAT_COAST':
      return target ? `Coasting at ${target}` : 'Coasting to ride out high prices';
    case 'HEAT_MAINTAIN_DEADBAND':
      return target ? `Holding ${target}` : 'Holding current setpoint';
    case 'DHW_HEAT_CHEAP_WINDOW': {
      if (priceTier === 'expensive') {
        return 'Heating tank now (prices high)';
      }
      if (priceTier === 'normal') {
        return 'Heating tank now';
      }
      return 'Heating tank while prices are low';
    }
    case 'DHW_DELAY_EXPENSIVE':
      return priceTier === 'expensive' ? 'Pausing tank (prices high)' : 'Pausing tank';
    case 'LEARNING_ADJUST':
      return target ? `Adjusting to ${target}` : 'Adjusting based on comfort feedback';
    default:
      return 'Waiting for first optimization';
  }
}

function formatReason(
  code: DecisionCode,
  priceTier?: string,
  spike?: boolean,
  fromTemp?: number | null,
  toTemp?: number | null
): string {
  const change =
    Number.isFinite(fromTemp ?? NaN) && Number.isFinite(toTemp ?? NaN)
      ? `${Number(fromTemp).toFixed(1)}°C → ${Number(toTemp).toFixed(1)}°C`
      : null;
  const priceText = priceTier ? priceTier : 'normal';
  const spikeText = spike ? '; spike detected' : '';

  switch (code) {
    case 'HEAT_PREHEAT':
      return `Cheap window; ${change || 'raising setpoint'} ahead of expensive period${spikeText}`;
    case 'HEAT_COAST':
      return `Expensive period${spikeText}; coasting within comfort${change ? ` (${change})` : ''}`;
    case 'HEAT_MAINTAIN_DEADBAND':
      return `No change; within comfort/deadband${change ? ` (${change})` : ''}`;
    case 'DHW_HEAT_CHEAP_WINDOW':
      if (priceTier === 'expensive') {
        return 'Tank: heating up; Room: holding setpoint';
      }
      if (priceTier === 'normal') {
        return 'Tank: heating up; Room: holding setpoint';
      }
      return 'Tank: heating while prices are low; Room: holding setpoint';
    case 'DHW_DELAY_EXPENSIVE':
      return priceTier === 'expensive'
        ? 'Tank: pausing until prices ease; Room: holding setpoint'
        : 'Tank: pausing to save energy; Room: holding setpoint';
    case 'LEARNING_ADJUST':
      return `Adjusted after comfort feedback${change ? ` (${change})` : ''}`;
    default:
      return `Waiting for first optimization (${priceText}${spikeText})`;
  }
}

function summarizeHeating(fromTemp?: number | null, toTemp?: number | null): string | null {
  if (Number.isFinite(fromTemp ?? NaN) && Number.isFinite(toTemp ?? NaN)) {
    const fromVal = Number(fromTemp).toFixed(1);
    const toVal = Number(toTemp).toFixed(1);
    if (fromVal === toVal) return `Holding ${toVal}°C`;
    return `Heating ${fromVal}°C → ${toVal}°C`;
  }
  return null;
}

function summarizeTank(
  action?: HotWaterAction | null,
  tankData?: AugmentedOptimizationResult['tankData'] | null,
  priceTier?: string
): string | null {
  const fromTemp = tankData && Number.isFinite((tankData as any).fromTemp) ? Number((tankData as any).fromTemp) : null;
  const toTemp = tankData && Number.isFinite((tankData as any).toTemp) ? Number((tankData as any).toTemp) : null;

  if (fromTemp !== null && toTemp !== null) {
    if (toTemp > fromTemp) return 'Tank: heating';
    if (toTemp < fromTemp) return priceTier === 'expensive' ? 'Tank: pausing (prices high)' : 'Tank: pausing';
    return 'Tank: holding';
  }

  if (action === 'heat_now') return 'Tank: heating';
  if (action === 'delay') return priceTier === 'expensive' ? 'Tank: pausing (prices high)' : 'Tank: pausing';
  if (action === 'maintain') return 'Tank: holding';

  return null;
}

function summarizeDhw(action?: HotWaterAction | null, priceTier?: string): string | null {
  if (action === 'heat_now') {
    return priceTier === 'expensive' ? 'Tank: heating despite high prices' : 'Tank: heating now';
  }
  if (action === 'delay') {
    return priceTier === 'expensive' ? 'Tank: pausing during high prices' : 'Tank: pausing';
  }
  return null;
}

export function buildDecisionFromOptimization(
  optimizationResult: AugmentedOptimizationResult | null | undefined,
  timestampOverride?: string
): OptimizationDecision | null {
  if (!optimizationResult) return null;

  const { fromTemp, toTemp, hotWaterAction, reason, priceData, zone2Data, tankData, action } = optimizationResult;
  const { tier, spike } = classifyPriceTier(priceData);

  let code: DecisionCode = 'HEAT_MAINTAIN_DEADBAND';
  let zone: 'zone1' | 'zone2' | 'tank' | undefined;
  const heatingSummary = summarizeHeating(
    typeof fromTemp === 'number' ? fromTemp : optimizationResult?.targetOriginal,
    typeof toTemp === 'number' ? toTemp : optimizationResult?.targetTemp
  );
  const dhwSummary = summarizeDhw(hotWaterAction?.action ?? null, tier);
  const tankSummary = summarizeTank(hotWaterAction?.action ?? null, tankData ?? null, tier);

  // DHW-first mapping
  if (hotWaterAction?.action === 'heat_now') {
    code = 'DHW_HEAT_CHEAP_WINDOW';
    zone = 'tank';
  } else if (hotWaterAction?.action === 'delay') {
    code = 'DHW_DELAY_EXPENSIVE';
    zone = 'tank';
  } else if (tankData && typeof tankData.toTemp === 'number' && typeof tankData.fromTemp === 'number') {
    if (tankData.toTemp > tankData.fromTemp) {
      code = 'DHW_HEAT_CHEAP_WINDOW';
      zone = 'tank';
    } else if (tankData.toTemp < tankData.fromTemp) {
      code = 'DHW_DELAY_EXPENSIVE';
      zone = 'tank';
    }
  }

  // Room heating mapping (override only if not DHW-specific)
  if (zone !== 'tank') {
    const effectiveFrom = Number.isFinite(fromTemp)
      ? Number(fromTemp)
      : (Number.isFinite(optimizationResult?.targetOriginal) ? Number(optimizationResult?.targetOriginal) : undefined);
    const effectiveTo = Number.isFinite(toTemp)
      ? Number(toTemp)
      : (Number.isFinite(optimizationResult?.targetTemp) ? Number(optimizationResult?.targetTemp) : undefined);

    if (action === 'no_change' || (effectiveFrom !== undefined && effectiveTo !== undefined && effectiveFrom === effectiveTo)) {
      code = 'HEAT_MAINTAIN_DEADBAND';
    } else if (effectiveFrom !== undefined && effectiveTo !== undefined && effectiveTo > effectiveFrom) {
      code = 'HEAT_PREHEAT';
    } else if (effectiveFrom !== undefined && effectiveTo !== undefined && effectiveTo < effectiveFrom) {
      code = 'HEAT_COAST';
    }

    if (!zone && optimizationResult.zone2Data) {
      zone = 'zone2';
    } else if (!zone) {
      zone = 'zone1';
    }
  }

  // Learning/comfort reaction hint. Requires an actual setpoint change: the only optimizer
  // reasons containing "comfort" are hold reasons ("Room above comfort band — setpoint has no
  // effect"), so matching on the word alone relabelled every hold as an adjustment and produced
  // self-contradicting output — headline "Adjusting to 21.0°C" above body "Room: Holding 21.0°C".
  const temperatureChanged =
    typeof fromTemp === 'number' && typeof toTemp === 'number' && Math.abs(toTemp - fromTemp) > 1e-6;

  if (temperatureChanged && typeof reason === 'string' && reason.toLowerCase().includes('comfort')) {
    code = 'LEARNING_ADJUST';
  }

  const timestamp = typeof optimizationResult.timestamp === 'string'
    ? optimizationResult.timestamp
    : (timestampOverride || new Date().toISOString());

  const headline = formatHeadline(code, toTemp ?? optimizationResult?.targetTemp, tier, spike, hotWaterAction?.action ?? null);
  const roomText = heatingSummary ? `Room: ${heatingSummary}` : 'Room: holding setpoint';
  const tankText = tankSummary || dhwSummary || 'Tank: holding';

  let friendlyReason = `${tankText}; ${roomText}`;
  if (code === 'LEARNING_ADJUST') {
    friendlyReason = `${tankText}; ${roomText}; Adjusting after comfort feedback`;
  }

  return {
    code,
    headline,
    reason: friendlyReason,
    timestamp,
    context: {
      fromTemp: fromTemp ?? optimizationResult?.targetOriginal ?? null,
      toTemp: toTemp ?? optimizationResult?.targetTemp ?? null,
      priceTier: tier,
      spike,
      dhwAction: hotWaterAction?.action ?? null,
      zone
    }
  };
}

export function buildPlaceholderDecision(): OptimizationDecision {
  const now = new Date().toISOString();
  return {
    code: 'NONE',
    headline: 'Waiting for first optimization',
    reason: 'No optimization history yet',
    timestamp: now,
    context: {
      priceTier: 'normal',
      spike: false,
      dhwAction: null,
      zone: 'zone1'
    }
  };
}
