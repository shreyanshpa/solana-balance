/**
 * Yield Curve Engine
 *
 * Collects funding rate data across all Pacifica markets and constructs
 * a term structure (yield curve) from funding rates at different time horizons.
 *
 * Key concepts:
 * - Short end: current/1h funding rate (most volatile)
 * - Mid curve: 24h-7d average funding rate
 * - Long end: 30d average funding rate (most stable)
 * - The "shape" of this curve tells you market expectations about future rates
 * - Normal curve (short < long): market expects rates to rise / bullish sentiment
 * - Inverted curve (short > long): overheated leverage, expect correction
 * - Flat: uncertainty or balanced positioning
 */

import { PacificaClient } from "../common/pacifica-client";
import type {
  FundingRateEntry,
  AssetYieldCurve,
  YieldCurvePoint,
  YieldCurveShape,
  CrossAssetSpread,
  FundingRatePoint,
} from "../common/types";
import {
  annualizeFundingRate,
  mean,
  stddev,
  median,
  fundingRateZScore,
  classifyCurveShape,
  fundingSpreadBps,
  weightedAverageFundingRate,
} from "../common/math";

// Tenor definitions for the yield curve (in hours)
const TENORS = [
  { label: "1h", hours: 1 },
  { label: "4h", hours: 4 },
  { label: "8h", hours: 8 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "14d", hours: 336 },
  { label: "30d", hours: 720 },
];

export class YieldCurveEngine {
  private client: PacificaClient;
  private fundingHistory: Map<string, FundingRatePoint[]> = new Map();
  private curves: Map<string, AssetYieldCurve> = new Map();

  constructor(client: PacificaClient) {
    this.client = client;
  }

  /**
   * Fetch and store funding rate history for a symbol.
   * Attempts to get up to 30 days of hourly data (720 data points).
   */
  async collectFundingData(symbol: string, lookbackHours: number = 720): Promise<FundingRatePoint[]> {
    const now = Date.now();
    const startTime = now - lookbackHours * 3600 * 1000;

    try {
      const history = await this.client.getFundingRateHistory(
        symbol,
        Math.min(lookbackHours, 500),
        startTime
      );

      const points: FundingRatePoint[] = history.map((entry: FundingRateEntry) => ({
        symbol,
        rate: entry.fundingRate,
        annualizedRate: annualizeFundingRate(entry.fundingRate),
        timestamp: entry.fundingTime,
      }));

      // Sort by timestamp ascending
      points.sort((a, b) => a.timestamp - b.timestamp);
      this.fundingHistory.set(symbol, points);
      return points;
    } catch (error) {
      console.error(`Failed to collect funding data for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * Collect funding data for all active markets.
   */
  async collectAllMarkets(): Promise<Map<string, FundingRatePoint[]>> {
    const markets = await this.client.getMarkets();
    const symbols = markets.map((m) => m.symbol);

    console.log(`Collecting funding data for ${symbols.length} markets...`);

    // Fetch in parallel with concurrency limit
    const batchSize = 5;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await Promise.all(batch.map((s) => this.collectFundingData(s)));
      console.log(`  Collected ${Math.min(i + batchSize, symbols.length)}/${symbols.length}`);
    }

    return this.fundingHistory;
  }

  /**
   * Build the yield curve for a single asset.
   * The curve shows average funding rates at different time horizons.
   */
  buildCurve(symbol: string): AssetYieldCurve | null {
    const history = this.fundingHistory.get(symbol);
    if (!history || history.length === 0) return null;

    const now = Date.now();
    const curvePoints: YieldCurvePoint[] = [];

    for (const tenor of TENORS) {
      const cutoff = now - tenor.hours * 3600 * 1000;
      const relevantRates = history.filter((p) => p.timestamp >= cutoff);

      if (relevantRates.length === 0) continue;

      const avgRate = mean(relevantRates.map((r) => r.rate));
      const annualizedAvg = annualizeFundingRate(avgRate);

      curvePoints.push({
        horizon: tenor.label,
        horizonHours: tenor.hours,
        averageRate: avgRate,
        annualizedRate: annualizedAvg,
        sampleCount: relevantRates.length,
      });
    }

    const currentRate = history[history.length - 1]?.rate || 0;

    const curve: AssetYieldCurve = {
      symbol,
      curve: curvePoints,
      currentRate,
      lastUpdated: now,
    };

    this.curves.set(symbol, curve);
    return curve;
  }

  /**
   * Build curves for all collected assets.
   */
  buildAllCurves(): Map<string, AssetYieldCurve> {
    for (const symbol of this.fundingHistory.keys()) {
      this.buildCurve(symbol);
    }
    return this.curves;
  }

  /**
   * Analyze the shape of an asset's yield curve.
   */
  analyzeCurveShape(symbol: string): YieldCurveShape | null {
    const curve = this.curves.get(symbol);
    if (!curve || curve.curve.length < 2) return null;

    const rates = curve.curve.map((p) => p.annualizedRate);
    const type = classifyCurveShape(rates);
    const steepness = Math.abs(rates[rates.length - 1] - rates[0]) * 10000;

    const descriptions: Record<string, string> = {
      normal: `${symbol}: Rates increase with tenor — market expects higher future demand for leverage. Bullish positioning likely to persist.`,
      inverted: `${symbol}: Short-term rates exceed long-term — overcrowded longs, potential deleveraging ahead. Contrarian short signal.`,
      flat: `${symbol}: Flat curve — balanced positioning, no strong directional conviction in the market.`,
      humped: `${symbol}: Humped curve — medium-term rates peaked. Possible transition from bullish to neutral regime.`,
    };

    return { type, steepness, description: descriptions[type] };
  }

  /**
   * Compute cross-asset funding rate spreads.
   * These spreads are tradeable — if BTC funding >> ETH funding,
   * you can go short BTC perp + long ETH perp to capture the spread.
   */
  computeCrossAssetSpreads(horizon: string = "24h"): CrossAssetSpread[] {
    const spreads: CrossAssetSpread[] = [];
    const symbols = Array.from(this.curves.keys());

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const curveA = this.curves.get(symbols[i]);
        const curveB = this.curves.get(symbols[j]);
        if (!curveA || !curveB) continue;

        const pointA = curveA.curve.find((p) => p.horizon === horizon);
        const pointB = curveB.curve.find((p) => p.horizon === horizon);
        if (!pointA || !pointB) continue;

        const spreadBps = fundingSpreadBps(pointA.annualizedRate, pointB.annualizedRate);

        // Signal: if spread is significantly positive, short A + long B captures it
        let signal: CrossAssetSpread["signal"] = "neutral";
        if (spreadBps > 200) signal = "long_B_short_A"; // A is expensive
        if (spreadBps < -200) signal = "long_A_short_B"; // B is expensive

        spreads.push({
          assetA: symbols[i],
          assetB: symbols[j],
          spreadBps: Math.round(spreadBps),
          horizon,
          signal,
        });
      }
    }

    // Sort by absolute spread descending — biggest opportunities first
    spreads.sort((a, b) => Math.abs(b.spreadBps) - Math.abs(a.spreadBps));
    return spreads;
  }

  /**
   * Identify assets with extreme funding rates (z-score based).
   * These are mean-reversion opportunities.
   */
  findExtremeRates(zScoreThreshold: number = 2.0): Array<{
    symbol: string;
    currentRate: number;
    annualizedRate: number;
    zScore: number;
    signal: string;
  }> {
    const extremes: Array<{
      symbol: string;
      currentRate: number;
      annualizedRate: number;
      zScore: number;
      signal: string;
    }> = [];

    for (const [symbol, history] of this.fundingHistory) {
      if (history.length < 24) continue; // need at least 24h of data

      const rates = history.map((p) => p.rate);
      const currentRate = rates[rates.length - 1];
      const zScore = fundingRateZScore(currentRate, rates);

      if (Math.abs(zScore) >= zScoreThreshold) {
        extremes.push({
          symbol,
          currentRate,
          annualizedRate: annualizeFundingRate(currentRate),
          zScore: Math.round(zScore * 100) / 100,
          signal: zScore > 0
            ? "Funding rate unusually HIGH — expect mean reversion down. Short perp opportunity."
            : "Funding rate unusually LOW/NEGATIVE — expect mean reversion up. Long perp opportunity.",
        });
      }
    }

    extremes.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    return extremes;
  }

  /**
   * Generate a full yield curve report for all assets.
   */
  generateReport(): {
    curves: Map<string, AssetYieldCurve>;
    shapes: Map<string, YieldCurveShape>;
    spreads: CrossAssetSpread[];
    extremes: ReturnType<typeof this.findExtremeRates>;
    summary: string;
  } {
    const shapes = new Map<string, YieldCurveShape>();
    for (const symbol of this.curves.keys()) {
      const shape = this.analyzeCurveShape(symbol);
      if (shape) shapes.set(symbol, shape);
    }

    const spreads = this.computeCrossAssetSpreads("24h");
    const extremes = this.findExtremeRates(1.5);

    // Generate summary
    const normalCount = Array.from(shapes.values()).filter((s) => s.type === "normal").length;
    const invertedCount = Array.from(shapes.values()).filter((s) => s.type === "inverted").length;
    const totalAssets = shapes.size;

    let marketRegime = "neutral";
    if (normalCount > totalAssets * 0.6) marketRegime = "bullish";
    if (invertedCount > totalAssets * 0.6) marketRegime = "bearish/overleveraged";

    const topSpread = spreads[0];
    const topExtreme = extremes[0];

    const summary = [
      `=== PACIFICA FUNDING RATE YIELD CURVE REPORT ===`,
      `Assets analyzed: ${totalAssets}`,
      `Market regime: ${marketRegime.toUpperCase()}`,
      `  Normal curves: ${normalCount} | Inverted: ${invertedCount} | Other: ${totalAssets - normalCount - invertedCount}`,
      ``,
      topSpread
        ? `Top cross-asset spread: ${topSpread.assetA}/${topSpread.assetB} = ${topSpread.spreadBps}bps (${topSpread.signal})`
        : "No significant cross-asset spreads.",
      topExtreme
        ? `Most extreme rate: ${topExtreme.symbol} z-score=${topExtreme.zScore} (${topExtreme.annualizedRate > 0 ? "+" : ""}${(topExtreme.annualizedRate * 100).toFixed(1)}% annualized)`
        : "No extreme funding rates detected.",
    ].join("\n");

    return { curves: this.curves, shapes, spreads, extremes, summary };
  }

  // Accessors
  getCurve(symbol: string): AssetYieldCurve | undefined {
    return this.curves.get(symbol);
  }

  getAllCurves(): Map<string, AssetYieldCurve> {
    return this.curves;
  }

  /**
   * Load pre-computed funding data (for demo/testing without API).
   */
  loadFundingData(symbol: string, points: FundingRatePoint[]): void {
    this.fundingHistory.set(symbol, points);
  }

  getFundingHistory(symbol: string): FundingRatePoint[] {
    return this.fundingHistory.get(symbol) || [];
  }
}
