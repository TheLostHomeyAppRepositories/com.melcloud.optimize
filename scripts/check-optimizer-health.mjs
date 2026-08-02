#!/usr/bin/env node
/**
 * Post-deploy health check for the optimizer's learned state.
 *
 * Reads the live device and reports on the specific signals that the
 * fix/curve-mode-and-learning-guards branch was meant to change. Run it a few days after a
 * deploy: the failure modes it looks for are all slow drifts that look fine for one cycle.
 *
 *   node scripts/check-optimizer-health.mjs
 *
 * Requires the Homey CLI to be authenticated and the machine to be on the same network as the
 * Homey. Background in documentation/BRANCH_CURVE_MODE_AND_LEARNING_FIXES.md.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const ENDPOINT = '/api/app/com.melcloud.optimize/getModelConfidence';

// Defaults the learners reset to. Drift away from these is the thing being watched.
const DEFAULTS = {
  priceWeightSummer: 0.7,
  priceWeightWinter: 0.4,
  priceWeightTransition: 0.5,
  preheatAggressiveness: 2.0,
  coastingReduction: 1.5
};

const FLOOR = 0.2;
const CEILING = 0.9;

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';

const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
}

async function fetchSnapshot() {
  // The Homey CLI exits before flushing a piped stdout, truncating the response at the 8 KB pipe
  // buffer. Redirecting to a file avoids the pipe entirely.
  const outFile = join(tmpdir(), `melcloud-health-${process.pid}.json`);

  try {
    await run('sh', ['-c', `homey api raw --path ${ENDPOINT} > ${outFile} 2>/dev/null`]);
    const raw = await readFile(outFile, 'utf8');
    const start = raw.indexOf('{');
    if (start === -1) throw new Error(`No JSON in response: ${raw.slice(0, 200)}`);
    return JSON.parse(raw.slice(start));
  } finally {
    await unlink(outFile).catch(() => {});
  }
}

function checkPriceWeights(adaptive) {
  const seasons = ['priceWeightSummer', 'priceWeightWinter', 'priceWeightTransition'];
  const missing = seasons.filter(k => typeof adaptive?.[k] !== 'number');

  if (missing.length === seasons.length) {
    record(WARN, 'Price weights', 'Not reported yet — the app has not re-saved since a reset. Re-run after the next hourly cycle.');
    return;
  }

  for (const key of seasons) {
    const value = adaptive[key];
    if (typeof value !== 'number') continue;

    const atBound = Math.abs(value - FLOOR) < 1e-6 || Math.abs(value - CEILING) < 1e-6;
    const drift = value - DEFAULTS[key];
    const detail = `${value} (default ${DEFAULTS[key]}, drift ${drift >= 0 ? '+' : ''}${drift.toFixed(3)})`;

    if (atBound) {
      record(FAIL, key, `${detail} — PINNED AT A BOUND. The ratchet is still running.`);
    } else if (Math.abs(drift) > 0.15) {
      record(WARN, key, `${detail} — drifting; check whether comfort violations are being misattributed.`);
    } else {
      record(PASS, key, detail);
    }
  }
}

function checkStrategyParameters(adaptive) {
  for (const key of ['preheatAggressiveness', 'coastingReduction']) {
    const value = adaptive?.[key];
    if (typeof value !== 'number') continue;
    const ratio = value / DEFAULTS[key];
    const detail = `${value} (default ${DEFAULTS[key]})`;
    if (ratio < 0.5) {
      record(FAIL, key, `${detail} — collapsed to ${(ratio * 100).toFixed(0)}% of default.`);
    } else {
      record(PASS, key, detail);
    }
  }
}

function checkThermalModel(thermal) {
  const rate = thermal?.heatingRate;

  if (rate === null || rate === undefined) {
    record(PASS, 'Thermal heatingRate', 'Not learned — expected while the device is in Flow/Curve mode (collection is skipped by design).');
    return;
  }
  if (typeof rate !== 'number') return;

  if (rate < 0) {
    record(FAIL, 'Thermal heatingRate', `${rate.toFixed(4)} — NEGATIVE. A heating rate cannot be negative; the model is learning from invalid data.`);
  } else if (rate < 0.05) {
    record(WARN, 'Thermal heatingRate', `${rate.toFixed(4)} — implausibly low.`);
  } else {
    record(PASS, 'Thermal heatingRate', `${rate.toFixed(4)} (units are 1/h, not °C/h)`);
  }
}

function checkHotWaterPattern(hw) {
  const pattern = hw?.hourlyUsagePattern;

  if (!Array.isArray(pattern) || pattern.every(v => !v)) {
    record(WARN, 'DHW usage pattern', 'No pattern yet — relearning from tank draw. Expected for a cycle or two after a reset.');
    return;
  }

  const ranked = pattern
    .map((v, hour) => ({ hour, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 5)
    .sort((a, b) => a.hour - b.hour);
  const peaks = ranked.map(r => r.hour);
  const peakStr = peaks.join(', ');

  const spread = Math.max(...pattern) / (Math.min(...pattern.filter(v => v > 0)) || 1);

  // Overnight hours (23-05) are when nobody draws hot water but the tank cools undisturbed, so a
  // profile concentrated there means standing loss is being read as draw rather than the
  // household being nocturnal. This is the failure the first draw estimator actually produced:
  // peaks at 02/04/05 with the real morning peak buried.
  const overnight = peaks.filter(h => h >= 23 || h <= 5).length;
  const hasMorning = peaks.some(h => h >= 6 && h <= 9);
  const hasEvening = peaks.some(h => h >= 17 && h <= 22);

  if (overnight >= 3) {
    record(FAIL, 'DHW peak hours', `${peakStr} — ${overnight} of 5 peaks fall overnight (23-05). Standing loss is very likely being read as draw; check standingLossCPerHourUsed.`);
  } else if (!hasMorning && !hasEvening) {
    record(WARN, 'DHW peak hours', `${peakStr} — no morning or evening peak, which is unusual for a household.`);
  } else if (!Number.isFinite(spread) || spread > 100) {
    record(WARN, 'DHW peak hours', `${peakStr} — spread ${spread.toExponential(1)}x is degenerate; the profile rests on very few intervals.`);
  } else {
    record(PASS, 'DHW peak hours', `${peakStr} (spread ${spread.toFixed(1)}x)`);
  }
}

function checkSeason(snapshot) {
  const control = snapshot?.smartSavingsDisplay?.seasonMode;
  const weather = snapshot?.seasonalMode;

  if (control && weather && control !== weather) {
    record(WARN, 'Season detectors', `control="${control}" vs weather="${weather}" — known open issue (R12), see the branch doc.`);
  } else if (control) {
    record(PASS, 'Season', `${control}`);
  }
}

function checkSavingsDisplay(snapshot) {
  const d = snapshot?.smartSavingsDisplay;
  if (!d) return;

  const history = Array.isArray(d.history) ? d.history : [];
  const today = history[history.length - 1];
  if (!today) return;

  // Known defect R8: the writer stores savings in `optimizedMinor`, the reader then computes
  // baseline - optimized. If `today` tracks optimizedMajor rather than valueMajor, it is unfixed.
  if (typeof today.optimizedMajor === 'number' && d.today === today.optimizedMajor
      && today.valueMajor !== today.optimizedMajor) {
    record(WARN, 'Savings display', `today=${d.today} reads optimizedMajor while last7 sums valueMajor (${today.valueMajor}) — R8 still unfixed (Phase 2).`);
  } else {
    record(PASS, 'Savings display', `today=${d.today}, last7=${d.last7}`);
  }
}

async function main() {
  let snapshot;
  try {
    snapshot = await fetchSnapshot();
  } catch (error) {
    console.error('Could not reach the app.');
    console.error(String(error.message ?? error).split('\n')[0]);
    console.error('\nCheck that the Homey CLI is authenticated and this machine is on the same network.');
    console.error('Note: most endpoints throw "Optimizer service not initialized" until the first hourly cron run.');
    process.exit(2);
  }

  const adaptive = snapshot.adaptiveParameters ?? {};

  checkPriceWeights(adaptive);
  checkStrategyParameters(adaptive);
  checkThermalModel(snapshot.thermalModel);
  checkHotWaterPattern(snapshot.hotWaterPatterns);
  checkSeason(snapshot);
  checkSavingsDisplay(snapshot);

  const width = Math.max(...results.map(r => r.name.length));
  console.log(`\nOptimizer health — learningCycles ${adaptive.learningCycles ?? 'n/a'}, last updated ${adaptive.lastUpdated ?? 'n/a'}\n`);
  for (const { status, name, detail } of results) {
    console.log(`  [${status}] ${name.padEnd(width)}  ${detail}`);
  }

  const fails = results.filter(r => r.status === FAIL).length;
  const warns = results.filter(r => r.status === WARN).length;
  console.log(`\n${results.length - fails - warns} pass, ${warns} warn, ${fails} fail\n`);

  process.exit(fails > 0 ? 1 : 0);
}

main();
