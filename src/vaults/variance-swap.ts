/**
 * Variance Swap Engine
 *
 * A variance swap is a derivative where one party pays the difference between
 * realized variance and a pre-agreed strike variance.
 *
 * In TradFi, this is a ~$50B market. In DeFi, it doesn't exist yet.
 * We build it using Pacifica's candle data to compute realized volatility.
 *
 * How it works:
 * 1. Two parties agree on a "variance strike" (e.g., 60% annualized vol)
 * 2. Over the observation period, we measure actual realized variance from price data
 * 3. At settlement: payoff = vega_notional * (realized_var - strike_var) / (2 * sqrt(strike_var))
 *
 * Key insight: Variance swaps give you PURE volatility exposure.
 * - Long variance = you profit when markets are volatile (regardless of direction)
 * - Short variance = you profit in calm markets (collect premium)
 *
 * The "variance risk premium" (VRP) is typically positive — implied vol > realized vol.
 * This means short variance is a profitable carry trade, similar to selling options.
 */

import { PacificaClient } from "../common/pacifica-client";
import type { VarianceSwapContract, VarianceSwapQuote, CandleData } from "../common/types";
import {
  logReturns,
  realizedVariance,
  realizedVolatility,
  rollingVolatility,
  fairVarianceStrike,
  varianceSwapPayoff,
  volToVar,
  varToVol,
  mean,
  stddev,
  percentile,
} from "../common/math";

let contractIdCounter = 0;

// Observation periods
const TENOR_DAYS: Record<string, number> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export class VarianceSwapEngine {
  private client: PacificaClient;
  private priceHistory: Map<string, number[]> = new Map(); // close prices
  private activeContracts: Map<string, VarianceSwapContract> = new Map();
  private settledContracts: VarianceSwapContract[] = [];

  // Vol surface cache
  private volSurface: Map<string, Map<string, { realized: number; implied: number }>> = new Map();

  constructor(client: PacificaClient) {
    this.client = client;
  }

  /**
   * Fetch price history for variance computation.
   * Uses hourly candles for granular realized vol measurement.
   */
  async loadPriceHistory(symbol: string, days: number = 30): Promise<number[]> {
    try {
      const candles = await this.client.getCandles(symbol, "1h", days * 24);
      const closes = candles.map((c: CandleData) => c.close);
      this.priceHistory.set(symbol, closes);
      return closes;
    } catch (error) {
      console.error(`Failed to load price history for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * Load simulated price data for demo mode.
   */
  loadDemoPrices(symbol: string, basePrice: number, annualVol: number, days: number = 30): number[] {
    const hourlyVol = annualVol / Math.sqrt(365 * 24);
    const prices: number[] = [basePrice];

    for (let i = 1; i < days * 24; i++) {
      const returns = (Math.random() - 0.5) * 2 * hourlyVol * 2; // rough approximation
      const drift = -0.5 * hourlyVol * hourlyVol; // vol drag
      const newPrice = prices[i - 1] * Math.exp(drift + returns);
      prices.push(Math.max(newPrice, basePrice * 0.01)); // floor
    }

    this.priceHistory.set(symbol, prices);
    return prices;
  }

  /**
   * Compute realized volatility for a symbol over a given window.
   */
  computeRealizedVol(symbol: string, windowHours?: number): number {
    const prices = this.priceHistory.get(symbol);
    if (!prices || prices.length < 2) return 0;

    const relevantPrices = windowHours
      ? prices.slice(-windowHours)
      : prices;

    const returns = logReturns(relevantPrices);
    return realizedVolatility(returns, 365 * 24); // annualized from hourly
  }

  /**
   * Build a volatility term structure (vol at different lookback windows).
   */
  buildVolTermStructure(symbol: string): Array<{
    tenor: string;
    realizedVol: number;
    impliedVol: number;
    vrp: number;
  }> {
    const structure: Array<{
      tenor: string;
      realizedVol: number;
      impliedVol: number;
      vrp: number;
    }> = [];

    for (const [tenor, days] of Object.entries(TENOR_DAYS)) {
      const realVol = this.computeRealizedVol(symbol, days * 24);
      // Implied vol = realized + VRP (variance risk premium)
      // VRP is typically 10-20% of realized vol
      const vrpMultiplier = 1.0 + 0.15 * Math.sqrt(days / 7); // VRP increases with tenor
      const impliedVol = realVol * vrpMultiplier;

      structure.push({
        tenor,
        realizedVol: Math.round(realVol * 10000) / 10000,
        impliedVol: Math.round(impliedVol * 10000) / 10000,
        vrp: Math.round((impliedVol - realVol) * 10000) / 10000,
      });

      // Cache in vol surface
      if (!this.volSurface.has(symbol)) {
        this.volSurface.set(symbol, new Map());
      }
      this.volSurface.get(symbol)!.set(tenor, {
        realized: realVol,
        implied: impliedVol,
      });
    }

    return structure;
  }

  /**
   * Get a quote for a variance swap.
   * The strike is set based on implied vol (which includes VRP).
   */
  getQuote(symbol: string, tenor: string): VarianceSwapQuote | null {
    const volData = this.volSurface.get(symbol)?.get(tenor);
    if (!volData) {
      // Try building the term structure first
      this.buildVolTermStructure(symbol);
      const retryData = this.volSurface.get(symbol)?.get(tenor);
      if (!retryData) return null;
      return this.buildQuote(symbol, tenor, retryData);
    }
    return this.buildQuote(symbol, tenor, volData);
  }

  private buildQuote(
    symbol: string,
    tenor: string,
    volData: { realized: number; implied: number }
  ): VarianceSwapQuote {
    const spread = volData.realized * 0.05; // 5% bid-ask spread
    return {
      symbol,
      tenor,
      impliedVolBid: volData.implied - spread,
      impliedVolAsk: volData.implied + spread,
      midVol: volData.implied,
      historicalVol: volData.realized,
      varianceRiskPremium: volData.implied - volData.realized,
    };
  }

  /**
   * Execute a variance swap contract.
   * direction: "long_var" = you profit when realized > strike (buy volatility)
   *            "short_var" = you profit when realized < strike (sell volatility)
   */
  executeSwap(
    symbol: string,
    tenor: string,
    vegaNotional: number,
    direction: "long_var" | "short_var"
  ): VarianceSwapContract | null {
    const quote = this.getQuote(symbol, tenor);
    if (!quote) return null;

    const days = TENOR_DAYS[tenor];
    if (!days) return null;

    // Long var gets the ask (worse), short var gets the bid (worse)
    const strikeVol = direction === "long_var" ? quote.impliedVolAsk : quote.impliedVolBid;
    const strikeVar = volToVar(strikeVol);

    const now = Date.now();
    const contractId = `vs_${++contractIdCounter}_${symbol}_${tenor}`;

    const contract: VarianceSwapContract = {
      id: contractId,
      symbol,
      strikeVariance: strikeVar,
      strikeVolatility: strikeVol,
      notional: vegaNotional * (direction === "long_var" ? 1 : -1),
      observationPeriodDays: days,
      startTime: now,
      endTime: now + days * 24 * 3600 * 1000,
      observations: [],
      realizedVariance: 0,
      realizedVolatility: 0,
      status: "active",
    };

    this.activeContracts.set(contractId, contract);
    return contract;
  }

  /**
   * Add a price observation to an active contract.
   * Called periodically (e.g., hourly) during the observation period.
   */
  addObservation(contractId: string, price: number): void {
    const contract = this.activeContracts.get(contractId);
    if (!contract || contract.status !== "active") return;

    if (contract.observations.length > 0) {
      const prevPrice = contract.observations[contract.observations.length - 1];
      const logReturn = Math.log(price / prevPrice);

      // Update running realized variance
      const returns = [];
      for (let i = 1; i < contract.observations.length; i++) {
        returns.push(Math.log(contract.observations[i] / contract.observations[i - 1]));
      }
      returns.push(logReturn);

      contract.realizedVariance = realizedVariance(returns, 365 * 24);
      contract.realizedVolatility = Math.sqrt(contract.realizedVariance);
    }

    contract.observations.push(price);
  }

  /**
   * Settle a variance swap at maturity.
   */
  settleContract(contractId: string): VarianceSwapContract | null {
    const contract = this.activeContracts.get(contractId);
    if (!contract) return null;

    // Compute final realized variance from all observations
    if (contract.observations.length >= 2) {
      const returns = logReturns(contract.observations);
      contract.realizedVariance = realizedVariance(returns, 365 * 24);
      contract.realizedVolatility = Math.sqrt(contract.realizedVariance);
    }

    // Payoff = notional * (realized_var - strike_var) / (2 * sqrt(strike_var))
    const payoff = varianceSwapPayoff(
      contract.realizedVariance,
      contract.strikeVariance,
      Math.abs(contract.notional)
    );

    // If short variance (negative notional), flip the payoff
    contract.payoff = contract.notional > 0 ? payoff : -payoff;
    contract.status = "settled";

    this.activeContracts.delete(contractId);
    this.settledContracts.push(contract);

    return contract;
  }

  /**
   * Mark-to-market an active variance swap.
   */
  markToMarket(contractId: string): {
    unrealizedPnl: number;
    currentRealizedVol: number;
    strikeVol: number;
    percentComplete: number;
  } | null {
    const contract = this.activeContracts.get(contractId);
    if (!contract) return null;

    const elapsed = Date.now() - contract.startTime;
    const total = contract.endTime - contract.startTime;
    const percentComplete = Math.min(elapsed / total, 1);

    // Estimated payoff based on realized var so far
    const currentPayoff = varianceSwapPayoff(
      contract.realizedVariance,
      contract.strikeVariance,
      Math.abs(contract.notional)
    );

    return {
      unrealizedPnl: contract.notional > 0 ? currentPayoff : -currentPayoff,
      currentRealizedVol: contract.realizedVolatility,
      strikeVol: contract.strikeVolatility,
      percentComplete: Math.round(percentComplete * 100),
    };
  }

  /**
   * Compute the volatility cone — percentile ranges of realized vol
   * at different lookback windows. Shows "how volatile is this vol?"
   */
  computeVolCone(symbol: string): Array<{
    window: string;
    currentVol: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
  }> {
    const prices = this.priceHistory.get(symbol);
    if (!prices || prices.length < 48) return [];

    const returns = logReturns(prices);
    const cone: Array<{
      window: string;
      currentVol: number;
      p10: number;
      p25: number;
      p50: number;
      p75: number;
      p90: number;
    }> = [];

    const windows: Record<string, number> = {
      "24h": 24,
      "3d": 72,
      "7d": 168,
      "14d": 336,
    };

    for (const [label, windowSize] of Object.entries(windows)) {
      if (returns.length < windowSize) continue;

      const rollingVols = rollingVolatility(returns, windowSize, 365 * 24);
      if (rollingVols.length === 0) continue;

      cone.push({
        window: label,
        currentVol: rollingVols[rollingVols.length - 1],
        p10: percentile(rollingVols, 10),
        p25: percentile(rollingVols, 25),
        p50: percentile(rollingVols, 50),
        p75: percentile(rollingVols, 75),
        p90: percentile(rollingVols, 90),
      });
    }

    return cone;
  }

  /**
   * Find vol arb opportunities: assets where realized vol is significantly
   * different from implied, suggesting mispricing.
   */
  findVolArbOpportunities(): Array<{
    symbol: string;
    realized: number;
    implied: number;
    vrp: number;
    signal: string;
  }> {
    const opps: Array<{
      symbol: string;
      realized: number;
      implied: number;
      vrp: number;
      signal: string;
    }> = [];

    for (const [symbol, tenorMap] of this.volSurface) {
      const weeklyData = tenorMap.get("7d");
      if (!weeklyData) continue;

      const vrp = weeklyData.implied - weeklyData.realized;
      const vrpPct = weeklyData.realized > 0 ? vrp / weeklyData.realized : 0;

      if (Math.abs(vrpPct) > 0.15) { // >15% VRP divergence
        opps.push({
          symbol,
          realized: weeklyData.realized,
          implied: weeklyData.implied,
          vrp,
          signal: vrp > 0
            ? `HIGH VRP (${(vrpPct * 100).toFixed(0)}%): Short variance to capture premium`
            : `NEGATIVE VRP (${(vrpPct * 100).toFixed(0)}%): Long variance — vol is cheap`,
        });
      }
    }

    opps.sort((a, b) => Math.abs(b.vrp) - Math.abs(a.vrp));
    return opps;
  }

  // Accessors
  getActiveContracts(): VarianceSwapContract[] {
    return Array.from(this.activeContracts.values());
  }

  getSettledContracts(): VarianceSwapContract[] {
    return this.settledContracts;
  }
}
