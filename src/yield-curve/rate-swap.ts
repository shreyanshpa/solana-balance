/**
 * Rate Swap Market
 *
 * A simulated on-chain market for Interest Rate Swaps on crypto funding rates.
 *
 * In TradFi, IRS is a $500T+ market. The concept:
 * - Party A pays FIXED rate (e.g., 15% annualized)
 * - Party B pays FLOATING rate (actual Pacifica funding rate)
 * - At settlement, net payment = (floating - fixed) * notional * time
 *
 * Use cases:
 * 1. Hedge: You're earning funding as a short. Lock in a fixed rate via swap.
 * 2. Speculate: You think funding will spike. Buy floating (pay fixed).
 * 3. Arb: If swap rate diverges from curve-implied rate, arb it.
 *
 * This module simulates the swap market with automated market making
 * based on the yield curve engine's fair rates.
 */

import type { RateSwap, SwapQuote, FundingRatePoint } from "../common/types";
import { annualizeFundingRate, mean, stddev } from "../common/math";
import { YieldCurveEngine } from "./engine";

// Tenor -> hours mapping
const TENOR_HOURS: Record<string, number> = {
  "1d": 24,
  "3d": 72,
  "7d": 168,
  "14d": 336,
  "30d": 720,
};

let swapIdCounter = 0;

export class RateSwapMarket {
  private yieldEngine: YieldCurveEngine;
  private activeSwaps: Map<string, RateSwap> = new Map();
  private settledSwaps: RateSwap[] = [];
  private spreadBps: number; // bid-ask spread in bps

  constructor(yieldEngine: YieldCurveEngine, spreadBps: number = 100) {
    this.yieldEngine = yieldEngine;
    this.spreadBps = spreadBps;
  }

  /**
   * Generate a quote for a funding rate swap.
   * The mid-rate is derived from the yield curve (average funding rate over the tenor).
   * Bid/ask spread is added around the mid.
   */
  getQuote(symbol: string, tenor: string): SwapQuote | null {
    const curve = this.yieldEngine.getCurve(symbol);
    if (!curve) return null;

    // Find the curve point matching this tenor
    const tenorHours = TENOR_HOURS[tenor];
    if (!tenorHours) return null;

    // Interpolate from the curve
    const curvePoint = curve.curve.find((p) => p.horizonHours === tenorHours)
      || curve.curve.reduce((closest, p) =>
          Math.abs(p.horizonHours - tenorHours) < Math.abs(closest.horizonHours - tenorHours)
            ? p : closest
        );

    if (!curvePoint) return null;

    const midRate = curvePoint.annualizedRate;
    const halfSpread = this.spreadBps / 10000 / 2;

    // Adjust spread based on data quality (fewer samples = wider spread)
    const confidenceFactor = Math.min(curvePoint.sampleCount / 100, 1);
    const adjustedHalfSpread = halfSpread / Math.max(confidenceFactor, 0.3);

    return {
      symbol,
      tenor,
      fixedRateBid: midRate - adjustedHalfSpread,  // rate to receive fixed
      fixedRateAsk: midRate + adjustedHalfSpread,  // rate to pay fixed
      midRate,
      spread: adjustedHalfSpread * 2,
      confidence: Math.round(confidenceFactor * 100) / 100,
    };
  }

  /**
   * Get quotes for all available tenors for a symbol.
   */
  getQuoteSheet(symbol: string): SwapQuote[] {
    const quotes: SwapQuote[] = [];
    for (const tenor of Object.keys(TENOR_HOURS)) {
      const quote = this.getQuote(symbol, tenor);
      if (quote) quotes.push(quote);
    }
    return quotes;
  }

  /**
   * Execute a swap — one party pays fixed, other pays floating.
   * direction: "pay_fixed" = you pay the fixed rate, receive floating
   *            "receive_fixed" = you receive the fixed rate, pay floating
   */
  executeSwap(
    symbol: string,
    tenor: string,
    notional: number,
    direction: "pay_fixed" | "receive_fixed",
    counterparty: string = "market_maker"
  ): RateSwap | null {
    const quote = this.getQuote(symbol, tenor);
    if (!quote) return null;

    const tenorHours = TENOR_HOURS[tenor];
    if (!tenorHours) return null;

    // If you pay fixed, you get the ask rate (worse for you)
    // If you receive fixed, you get the bid rate (worse for you)
    const fixedRate = direction === "pay_fixed" ? quote.fixedRateAsk : quote.fixedRateBid;

    const now = Date.now();
    const swapId = `swap_${++swapIdCounter}_${symbol}_${tenor}`;

    const swap: RateSwap = {
      id: swapId,
      symbol,
      fixedRate,
      notional,
      startTime: now,
      maturityTime: now + tenorHours * 3600 * 1000,
      payer: direction === "pay_fixed" ? "user" : counterparty,
      receiver: direction === "pay_fixed" ? counterparty : "user",
      status: "active",
    };

    this.activeSwaps.set(swapId, swap);
    return swap;
  }

  /**
   * Settle a swap — compute the payoff based on realized floating rate.
   * In production, this would settle on-chain using oracle data.
   */
  settleSwap(swapId: string): RateSwap | null {
    const swap = this.activeSwaps.get(swapId);
    if (!swap || swap.status !== "active") return null;

    // Get funding rate history during the swap period
    const history = this.yieldEngine.getFundingHistory(swap.symbol);
    const relevantRates = history.filter(
      (p) => p.timestamp >= swap.startTime && p.timestamp <= swap.maturityTime
    );

    if (relevantRates.length === 0) {
      console.warn(`No funding data available for swap ${swapId} settlement`);
      return null;
    }

    // Compute realized floating rate (annualized average of actual funding)
    const avgHourlyRate = mean(relevantRates.map((r) => r.rate));
    const realizedFloating = annualizeFundingRate(avgHourlyRate);

    // Duration in years
    const durationYears = (swap.maturityTime - swap.startTime) / (365 * 24 * 3600 * 1000);

    // Net settlement: (floating - fixed) * notional * duration
    // Positive = fixed payer wins (floating was higher than fixed)
    // Negative = fixed receiver wins (floating was lower than fixed)
    const netPayment = (realizedFloating - swap.fixedRate) * swap.notional * durationYears;

    swap.realizedFloatingRate = realizedFloating;
    swap.settlementAmount = netPayment;
    swap.status = "settled";

    this.activeSwaps.delete(swapId);
    this.settledSwaps.push(swap);

    return swap;
  }

  /**
   * Mark-to-market an active swap (current P&L estimate).
   */
  markToMarket(swapId: string): { unrealizedPnl: number; currentFloating: number } | null {
    const swap = this.activeSwaps.get(swapId);
    if (!swap) return null;

    const history = this.yieldEngine.getFundingHistory(swap.symbol);
    const relevantRates = history.filter((p) => p.timestamp >= swap.startTime);

    if (relevantRates.length === 0) return { unrealizedPnl: 0, currentFloating: 0 };

    const avgHourlyRate = mean(relevantRates.map((r) => r.rate));
    const currentFloating = annualizeFundingRate(avgHourlyRate);
    const elapsedYears = (Date.now() - swap.startTime) / (365 * 24 * 3600 * 1000);

    const unrealizedPnl = (currentFloating - swap.fixedRate) * swap.notional * elapsedYears;

    return {
      unrealizedPnl: swap.payer === "user" ? unrealizedPnl : -unrealizedPnl,
      currentFloating,
    };
  }

  /**
   * Find arbitrage opportunities between swap rates and yield curve.
   * If the swap mid-rate diverges from the curve-implied rate, it's an arb.
   */
  findArbOpportunities(): Array<{
    symbol: string;
    tenor: string;
    swapMid: number;
    curveImplied: number;
    diffBps: number;
    action: string;
  }> {
    const arbs: Array<{
      symbol: string;
      tenor: string;
      swapMid: number;
      curveImplied: number;
      diffBps: number;
      action: string;
    }> = [];

    for (const [symbol, curve] of this.yieldEngine.getAllCurves()) {
      for (const tenor of Object.keys(TENOR_HOURS)) {
        const quote = this.getQuote(symbol, tenor);
        if (!quote) continue;

        const tenorHours = TENOR_HOURS[tenor];
        const curvePoint = curve.curve.find((p) => p.horizonHours === tenorHours);
        if (!curvePoint) continue;

        const diffBps = Math.round((quote.midRate - curvePoint.annualizedRate) * 10000);

        if (Math.abs(diffBps) > 50) {
          arbs.push({
            symbol,
            tenor,
            swapMid: quote.midRate,
            curveImplied: curvePoint.annualizedRate,
            diffBps,
            action: diffBps > 0
              ? `Pay fixed on swap (${(quote.fixedRateAsk * 100).toFixed(1)}%), curve says fair is lower`
              : `Receive fixed on swap (${(quote.fixedRateBid * 100).toFixed(1)}%), curve says fair is higher`,
          });
        }
      }
    }

    arbs.sort((a, b) => Math.abs(b.diffBps) - Math.abs(a.diffBps));
    return arbs;
  }

  /**
   * Get all active swaps.
   */
  getActiveSwaps(): RateSwap[] {
    return Array.from(this.activeSwaps.values());
  }

  /**
   * Get settlement history.
   */
  getSettledSwaps(): RateSwap[] {
    return this.settledSwaps;
  }

  /**
   * Generate a formatted quote sheet string.
   */
  formatQuoteSheet(symbol: string): string {
    const quotes = this.getQuoteSheet(symbol);
    if (quotes.length === 0) return `No quotes available for ${symbol}`;

    const lines = [
      `=== ${symbol} FUNDING RATE SWAP QUOTES ===`,
      `${"Tenor".padEnd(8)} ${"Bid".padEnd(12)} ${"Mid".padEnd(12)} ${"Ask".padEnd(12)} ${"Spread".padEnd(10)} Conf`,
      "-".repeat(65),
    ];

    for (const q of quotes) {
      lines.push(
        `${q.tenor.padEnd(8)} ${(q.fixedRateBid * 100).toFixed(2).padStart(8)}%   ${(q.midRate * 100).toFixed(2).padStart(8)}%   ${(q.fixedRateAsk * 100).toFixed(2).padStart(8)}%   ${(q.spread * 10000).toFixed(0).padStart(6)}bps  ${(q.confidence * 100).toFixed(0)}%`
      );
    }

    return lines.join("\n");
  }
}
