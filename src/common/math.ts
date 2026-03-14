/**
 * Financial math utilities for funding rate analysis, variance calculations,
 * and yield curve construction.
 */

// ============================================================
// Statistical Functions
// ============================================================

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function variance(values: number[], ddof: number = 1): number {
  if (values.length <= ddof) return 0;
  const m = mean(values);
  const squaredDiffs = values.map((v) => (v - m) ** 2);
  return squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - ddof);
}

export function stddev(values: number[], ddof: number = 1): number {
  return Math.sqrt(variance(values, ddof));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

// ============================================================
// Return Calculations
// ============================================================

export function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return returns;
}

export function simpleReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  return returns;
}

// ============================================================
// Variance & Volatility
// ============================================================

/**
 * Compute realized variance from a series of log returns.
 * This is the core calculation for variance swaps.
 * Annualized by default assuming periodsPerYear observations per year.
 */
export function realizedVariance(
  logReturnValues: number[],
  periodsPerYear: number = 365 * 24 // hourly observations
): number {
  if (logReturnValues.length === 0) return 0;
  const sumSquaredReturns = logReturnValues.reduce((sum, r) => sum + r * r, 0);
  return (sumSquaredReturns / logReturnValues.length) * periodsPerYear;
}

/**
 * Realized volatility = sqrt(realized variance)
 */
export function realizedVolatility(
  logReturnValues: number[],
  periodsPerYear: number = 365 * 24
): number {
  return Math.sqrt(realizedVariance(logReturnValues, periodsPerYear));
}

/**
 * Rolling realized volatility over a window of observations.
 */
export function rollingVolatility(
  logReturnValues: number[],
  window: number,
  periodsPerYear: number = 365 * 24
): number[] {
  const result: number[] = [];
  for (let i = window; i <= logReturnValues.length; i++) {
    const windowReturns = logReturnValues.slice(i - window, i);
    result.push(realizedVolatility(windowReturns, periodsPerYear));
  }
  return result;
}

// ============================================================
// Funding Rate Calculations
// ============================================================

/**
 * Annualize a per-period funding rate using compound formula.
 * Pacifica settles funding hourly.
 * For small rates (<0.1%), compound ≈ linear, but this is correct at all scales.
 */
export function annualizeFundingRate(
  hourlyRate: number,
  periodsPerDay: number = 24
): number {
  const periodsPerYear = periodsPerDay * 365;
  // Use compound formula: (1 + r)^n - 1
  // For very small rates, clamp to avoid floating point issues
  if (Math.abs(hourlyRate) < 1e-12) return 0;
  return Math.pow(1 + hourlyRate, periodsPerYear) - 1;
}

/**
 * Compute weighted average funding rate over a time window.
 */
export function weightedAverageFundingRate(
  rates: { rate: number; timestamp: number }[]
): number {
  if (rates.length <= 1) return rates[0]?.rate || 0;

  let totalWeight = 0;
  let weightedSum = 0;

  for (let i = 0; i < rates.length - 1; i++) {
    const duration = rates[i + 1].timestamp - rates[i].timestamp;
    weightedSum += rates[i].rate * duration;
    totalWeight += duration;
  }

  // Add last rate with average duration
  const avgDuration = totalWeight / (rates.length - 1);
  weightedSum += rates[rates.length - 1].rate * avgDuration;
  totalWeight += avgDuration;

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Compute funding rate z-score relative to historical distribution.
 * Used for mean-reversion signals.
 */
export function fundingRateZScore(
  currentRate: number,
  historicalRates: number[]
): number {
  const m = mean(historicalRates);
  const s = stddev(historicalRates);
  return s > 0 ? (currentRate - m) / s : 0;
}

// ============================================================
// Yield Curve Helpers
// ============================================================

/**
 * Determine yield curve shape from a series of rates at increasing tenors.
 */
export function classifyCurveShape(
  rates: number[]
): "normal" | "inverted" | "flat" | "humped" {
  if (rates.length < 2) return "flat";

  const first = rates[0];
  const last = rates[rates.length - 1];
  const spreadBps = (last - first) * 10000;

  // Check for hump: is the max rate at an interior point?
  const maxRate = Math.max(...rates);
  const maxIdx = rates.indexOf(maxRate);
  const isInteriorMax = maxIdx > 0 && maxIdx < rates.length - 1;
  const humpMagnitude = (maxRate - Math.max(first, last)) * 10000;

  if (Math.abs(spreadBps) < 50 && humpMagnitude < 50) return "flat";
  if (isInteriorMax && humpMagnitude > 50) return "humped";
  if (last > first) return "normal";
  return "inverted";
}

/**
 * Compute spread between two assets' funding rates in basis points.
 */
export function fundingSpreadBps(rateA: number, rateB: number): number {
  return (rateA - rateB) * 10000;
}

// ============================================================
// Variance Swap Pricing
// ============================================================

/**
 * Fair variance strike based on historical realized variance.
 * Adds a variance risk premium (VRP) which is typically positive
 * (implied > realized).
 */
export function fairVarianceStrike(
  historicalRealizedVol: number,
  vrpMultiplier: number = 1.15 // 15% premium over realized
): number {
  return (historicalRealizedVol * vrpMultiplier) ** 2;
}

/**
 * Variance swap payoff at settlement.
 * Positive = long variance wins (realized > strike).
 * Negative = short variance wins.
 */
export function varianceSwapPayoff(
  realizedVar: number,
  strikeVar: number,
  vegaNotional: number
): number {
  if (strikeVar <= 0) return 0;
  return vegaNotional * (realizedVar - strikeVar) / (2 * Math.sqrt(strikeVar));
}

/**
 * Convert between volatility (%) and variance.
 */
export function volToVar(vol: number): number {
  return vol * vol;
}

export function varToVol(variance: number): number {
  return Math.sqrt(variance);
}

// ============================================================
// Correlation
// ============================================================

export function correlation(xValues: number[], yValues: number[]): number {
  const n = Math.min(xValues.length, yValues.length);
  if (n < 2) return 0;

  const xMean = mean(xValues.slice(0, n));
  const yMean = mean(yValues.slice(0, n));

  let numerator = 0;
  let xDenominator = 0;
  let yDenominator = 0;

  for (let i = 0; i < n; i++) {
    const dx = xValues[i] - xMean;
    const dy = yValues[i] - yMean;
    numerator += dx * dy;
    xDenominator += dx * dx;
    yDenominator += dy * dy;
  }

  const denominator = Math.sqrt(xDenominator * yDenominator);
  return denominator > 0 ? numerator / denominator : 0;
}
