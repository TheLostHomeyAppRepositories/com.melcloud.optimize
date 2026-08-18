(function(global) {
  if (global.ModelConfidenceShared) {
    return;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function toPct(value) {
    if (value == null || isNaN(value)) {
      return null;
    }
    return Math.round(clamp(Number(value), 0, 1) * 100);
  }

  function statusFrom(pct) {
    if (pct == null) return 'Learning';
    if (pct < 25) return 'Learning';
    if (pct < 60) return 'Improving';
    if (pct < 85) return 'Reliable';
    return 'Highly reliable';
  }

  function getConfidenceStatus(pct) {
    return statusFrom(pct);
  }

  function priceStatusFromAdaptive(adaptive) {
    if (adaptive && typeof adaptive.confidence === 'number') {
      return statusFrom(toPct(adaptive.confidence));
    }
    if (adaptive && typeof adaptive.learningCycles === 'number') {
      const cycles = adaptive.learningCycles;
      let approxConfidence;
      if (cycles < 10) {
        approxConfidence = cycles / 40;
      } else if (cycles < 50) {
        approxConfidence = 0.25 + ((cycles - 10) / 100);
      } else if (cycles < 100) {
        approxConfidence = 0.6 + ((cycles - 50) / 200);
      } else {
        approxConfidence = 0.85 + (Math.min(cycles - 100, 100) / 667);
      }
      return statusFrom(toPct(approxConfidence));
    }
    return 'Learning';
  }

  function hotWaterStatusFromPatterns(patterns) {
    if (patterns && typeof patterns.confidence === 'number') {
      const pct = patterns.confidence > 1 ? patterns.confidence : toPct(patterns.confidence);
      return statusFrom(pct);
    }
    return 'Learning';
  }

  function safeDateLabel(value) {
    if (!value) {
      return null;
    }
    try {
      const date = new Date(value);
      if (isNaN(Number(date))) {
        return value;
      }
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (err) {
      return value;
    }
  }

  function buildTemperatureDetail(snapshot) {
    const totalPoints = (snapshot?.dataRetention?.thermalRawPoints || 0) +
      (snapshot?.dataRetention?.thermalAggPoints || 0);
    const lastUpdated = snapshot?.thermalModel?.lastUpdated;

    if (totalPoints > 0) {
      const updatedText = lastUpdated ? safeDateLabel(lastUpdated) || 'Recently' : 'Recently';
      return `${totalPoints} data points • Last updated: ${updatedText}`;
    }
    if (lastUpdated) {
      const updatedText = safeDateLabel(lastUpdated) || lastUpdated;
      return `No samples yet • Model last run: ${updatedText}`;
    }
    return 'Collecting data...';
  }

  function buildPriceDetail(snapshot, status) {
    if (!snapshot || !snapshot.adaptiveParameters) {
      return 'No optimization runs yet';
    }

    const cycles = snapshot.adaptiveParameters.learningCycles || 0;
    const cyclesText = cycles > 0 ? `${cycles} learning cycles` : 'No cycles';
    let savingsText = '';

    if (snapshot.savingsMetrics && snapshot.savingsMetrics.averageDailySavings !== null) {
      const avgSavings = Number(snapshot.savingsMetrics.averageDailySavings);
      if (!isNaN(avgSavings)) {
        // Currency per day, not a percentage. This previously rendered a "%" suffix after a
        // Math.round(x * 100) / 100 that is a 2-decimal rounding idiom, not a ratio conversion -
        // the x100 and /100 cancel. A figure of 0.8 SEK/day was displayed as "0.8%".
        const currency = (snapshot.priceData && snapshot.priceData.currencySymbol)
          || (snapshot.smartSavingsDisplay && snapshot.smartSavingsDisplay.currencySymbol)
          || '';
        savingsText = ` • Avg savings: ${avgSavings.toFixed(2)}${currency ? ' ' + currency : ''}/day`;
      }
    }

    if (status === 'Learning' && cycles === 0) {
      return 'No optimization runs yet';
    }
    return `${cyclesText}${savingsText}`;
  }

  function buildHotWaterDetail(snapshot) {
    const patterns = snapshot?.hotWaterPatterns;
    const status = hotWaterStatusFromPatterns(patterns);

    if (!patterns) {
      return {
        status,
        detail: 'Collecting usage data',
        peakRanges: []
      };
    }

    const confidence = patterns.confidence;
    const confidencePct = confidence != null
      ? (confidence > 1 ? Math.round(confidence) : toPct(confidence))
      : null;
    let detail = confidencePct != null ? `${confidencePct}% confidence` : 'Collecting usage data';
    const peakRanges = [];

    if (Array.isArray(patterns.hourlyUsagePattern)) {
      const pattern = patterns.hourlyUsagePattern;
      const avgUsage = pattern.reduce((sum, val) => sum + val, 0) / (pattern.length || 1);
      const peakHours = pattern
        .map((usage, hour) => ({ hour, usage }))
        .filter(item => item.usage > avgUsage * 1.3)
        .sort((a, b) => a.hour - b.hour)
        .map(item => item.hour);

      if (peakHours.length > 0) {
        let start = peakHours[0];
        let end = peakHours[0];
        for (let i = 1; i <= peakHours.length; i++) {
          const current = peakHours[i];
          if (current === end + 1) {
            end = current;
          } else {
            peakRanges.push(start === end ? `${start}` : `${start}-${end}`);
            start = current;
            end = current;
          }
        }
        if (peakRanges.length > 0) {
          detail = `${detail} • Peak hours: ${peakRanges.join(', ')}`;
        }
      }
    }

    return {
      status,
      detail,
      peakRanges
    };
  }

  function buildSystemLearningSummary(snapshot) {
    const temperatureStatus = snapshot?.thermalModel?.confidence != null
      ? statusFrom(toPct(snapshot.thermalModel.confidence))
      : 'Learning';
    const priceStatus = priceStatusFromAdaptive(snapshot?.adaptiveParameters);
    const hotWaterSummary = buildHotWaterDetail(snapshot);

    return {
      temperature: {
        status: temperatureStatus,
        detail: buildTemperatureDetail(snapshot),
        totalPoints: (snapshot?.dataRetention?.thermalRawPoints || 0) +
          (snapshot?.dataRetention?.thermalAggPoints || 0),
        lastUpdated: snapshot?.thermalModel?.lastUpdated || null
      },
      price: {
        status: priceStatus,
        detail: buildPriceDetail(snapshot, priceStatus),
        learningCycles: snapshot?.adaptiveParameters?.learningCycles || 0
      },
      hotWater: hotWaterSummary
    };
  }

  function buildSmartSavingsSummary(snapshot) {
    const smart = snapshot?.smartSavingsDisplay || {};
    const todayMajor = smart.todayMajor ?? smart.today ?? null;
    const last7Major = smart.last7Major ?? smart.last7 ?? null;
    const projectionMajor = smart.monthlyProjectionMajor ?? smart.projection ?? null;
    const history = Array.isArray(smart.history)
      ? smart.history.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      : [];
    let note;

    if (!history.length && todayMajor === null && last7Major === null) {
      note = 'Optimizer is learning your baseline; savings will appear after a few hourly runs.';
    } else if (!history.length) {
      note = 'No savings history yet.';
    } else if (projectionMajor === null) {
      note = 'Monthly projection appears once a few days of smart savings history are collected.';
    } else {
      // The baseline is a flat kWh table: calculateHeatingEnergy and calculateHotWaterEnergy in
      // fixed-baseline-calculator.ts accept COP parameters and never read them. Do not restore
      // the "seasonal COP adjustments" wording unless that is actually wired up.
      note = 'Estimates compare the optimizer to a constant-temperature heating baseline.';
    }

    return {
      todayMajor,
      last7Major,
      projectionMajor,
      seasonMode: smart.seasonMode || snapshot?.seasonalMode || null,
      currencySymbol: smart.currencySymbol || smart.currency || snapshot?.priceData?.currencySymbol || snapshot?.priceData?.currency || 'SEK',
      decimals: typeof smart.decimals === 'number' ? smart.decimals : 2,
      averageSpotPrice: typeof snapshot?.averageSpotPrice === 'number' ? snapshot.averageSpotPrice : null,
      priceDataPoints: typeof snapshot?.priceDataPoints === 'number' ? snapshot.priceDataPoints : 0,
      history,
      note
    };
  }

  function formatMoney(value, currencySymbol, decimals) {
    if (value == null || isNaN(value)) {
      return '—';
    }
    const precision = typeof decimals === 'number' && decimals >= 0 ? decimals : 2;
    const symbol = (currencySymbol || '').trim();
    const formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: precision
    });
    const formatted = formatter.format(Number(value));
    return symbol ? `${formatted} ${symbol}` : formatted;
  }

  function buildSnapshot(data) {
    const thermalModel = data?.thermalModel || {};
    const adaptiveParameters = data?.adaptiveParameters || {};
    const dataRetention = data?.dataRetention || {};
    const confidencePct = typeof thermalModel.confidence === 'number'
      ? toPct(thermalModel.confidence)
      : null;

    return {
      raw: data,
      success: data?.success !== false,
      thermalModel,
      adaptiveParameters,
      dataRetention,
      hotWaterPatterns: data?.hotWaterPatterns || null,
      savingsMetrics: data?.savingsMetrics || null,
      smartSavingsDisplay: data?.smartSavingsDisplay || {},
      seasonalMode: data?.seasonalMode || data?.smartSavingsDisplay?.seasonMode || null,
      averageSpotPrice: typeof data?.averageSpotPrice === 'number' ? data.averageSpotPrice : null,
      priceDataPoints: typeof data?.priceDataPoints === 'number' ? data.priceDataPoints : null,
      lastDecision: data?.lastDecision || null,
      confidencePct,
      confidenceStatus: getConfidenceStatus(confidencePct),
      systemLearning: buildSystemLearningSummary(data),
      smartSavingsSummary: buildSmartSavingsSummary(data)
    };
  }

  function fetchViaCallbackApi(Homey) {
    return new Promise((resolve, reject) => {
      try {
        Homey.api('GET', '/getModelConfidence', {}, (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(result);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function resolveResult(result) {
    if (result && typeof result.then === 'function') {
      return result;
    }
    return Promise.resolve(result);
  }

  function fetchViaPromiseApi(Homey) {
    try {
      const maybePromise = Homey.api('GET', '/getModelConfidence', {});
      if (maybePromise && typeof maybePromise.then === 'function') {
        return maybePromise;
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return null;
  }

  function fetchSnapshot(Homey) {
    if (!Homey) {
      return Promise.reject(new Error('Homey API not available'));
    }

    let fetchPromise;

    if (Homey.widgetApi && typeof Homey.widgetApi.getModelConfidence === 'function') {
      try {
        fetchPromise = resolveResult(Homey.widgetApi.getModelConfidence());
      } catch (err) {
        fetchPromise = Promise.reject(err);
      }
    } else if (typeof Homey.api === 'function') {
      fetchPromise = fetchViaPromiseApi(Homey);
      if (!fetchPromise) {
        fetchPromise = fetchViaCallbackApi(Homey);
      }
    } else if (typeof Homey.apiGet === 'function') {
      try {
        fetchPromise = resolveResult(Homey.apiGet('/getModelConfidence'));
      } catch (err) {
        fetchPromise = Promise.reject(err);
      }
    } else if (Homey.api && typeof Homey.api.get === 'function') {
      try {
        fetchPromise = resolveResult(Homey.api.get('/getModelConfidence'));
      } catch (err) {
        fetchPromise = Promise.reject(err);
      }
    } else {
      fetchPromise = Promise.reject(new Error('Homey API not available'));
    }

    return fetchPromise.then((result) => {
      if (!result || result.success === false) {
        throw new Error((result && result.error) || 'Failed to load model confidence');
      }
      return buildSnapshot(result);
    });
  }

  global.ModelConfidenceShared = {
    toPct,
    statusFrom,
    getConfidenceStatus,
    priceStatusFromAdaptive,
    hotWaterStatusFromPatterns,
    buildSnapshot,
    buildSystemLearningSummary,
    buildSmartSavingsSummary,
    fetchSnapshot,
    formatMoney
  };
})(typeof window !== 'undefined' ? window : globalThis);
