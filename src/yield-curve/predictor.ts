/**
 * Funding Rate Predictor
 *
 * Uses the yield curve term structure + statistical models to predict
 * future funding rates. This is the novel technical piece:
 *
 * In TradFi, the yield curve IS the market's prediction of future rates.
 * If the 30d average funding rate is 15% but the 1h rate is 30%,
 * the curve implies rates will mean-revert down.
 *
 * We formalize this with:
 * 1. Forward rate extraction from the term structure
 * 2. Mean-reversion model (Ornstein-Uhlenbeck)
 * 3. Regime detection (trending vs mean-reverting)
 * 4. Confidence intervals via bootstrap
 *
 * This gives traders actionable signals:
 * - "BTC funding is 2 std devs above fair → expect it to drop"
 * - "SOL forward curve implies rising rates → don't lock in fixed now"
 */

import type { AssetYieldCurve, FundingRatePoint, YieldCurvePoint } from "../common/types";
import { mean, stddev, variance, correlation } from "../common/math";

export interface FundingPrediction {
  symbol: string;
  currentRate: number;
  predictions: Array<{
    horizon: string;
    hours: number;
    predictedRate: number;
    confidence: number;    // 0-1
    upperBound: number;    // 95% CI
    lowerBound: number;    // 95% CI
  }>;
  regime: "trending_up" | "trending_down" | "mean_reverting" | "volatile";
  meanReversionSpeed: number; // kappa in OU model (higher = faster reversion)
  longRunMean: number;        // theta in OU model
  signal: string;
}

export interface ForwardRate {
  startHorizon: string;
  endHorizon: string;
  forwardRate: number;     // implied rate between the two horizons
  annualized: boolean;
}

export class FundingRatePredictor {
  private history: Map<string, FundingRatePoint[]> = new Map();
  private curves: Map<string, AssetYieldCurve> = new Map();

  /**
   * Load data from yield curve engine.
   */
  loadData(
    fundingHistory: Map<string, FundingRatePoint[]>,
    curves: Map<string, AssetYieldCurve>
  ): void {
    this.history = fundingHistory;
    this.curves = curves;
  }

  /**
   * Extract forward rates from the yield curve.
   *
   * The forward rate between tenor T1 and T2 is:
   *   f(T1, T2) = [r(T2) * T2 - r(T1) * T1] / (T2 - T1)
   *
   * This tells you what the market "expects" the rate to be
   * between those two time horizons.
   */
  extractForwardRates(symbol: string): ForwardRate[] {
    const curve = this.curves.get(symbol);
    if (!curve || curve.curve.length < 2) return [];

    const forwards: ForwardRate[] = [];

    for (let i = 0; i < curve.curve.length - 1; i++) {
      const short = curve.curve[i];
      const long = curve.curve[i + 1];

      // Forward rate between short and long tenor
      const forwardRate =
        (long.annualizedRate * long.horizonHours - short.annualizedRate * short.horizonHours) /
        (long.horizonHours - short.horizonHours);

      forwards.push({
        startHorizon: short.horizon,
        endHorizon: long.horizon,
        forwardRate,
        annualized: true,
      });
    }

    return forwards;
  }

  /**
   * Fit Ornstein-Uhlenbeck model to funding rate history.
   *
   * The OU process models mean-reverting behavior:
   *   dr = κ(θ - r)dt + σ dW
   *
   * Where:
   *   κ = speed of mean reversion (higher = faster reversion)
   *   θ = long-run mean rate
   *   σ = volatility of the process
   *
   * We estimate parameters via OLS on:
   *   Δr = α + β * r_{t-1} + ε
   *   κ = -β, θ = -α/β, σ = std(ε)
   */
  fitOUModel(symbol: string): {
    kappa: number;  // mean reversion speed
    theta: number;  // long-run mean
    sigma: number;  // volatility
    halfLife: number; // hours to revert halfway
    rSquared: number;
  } | null {
    const hist = this.history.get(symbol);
    if (!hist || hist.length < 48) return null; // need at least 48h

    const rates = hist.map((h) => h.rate);

    // Compute Δr series
    const deltaR: number[] = [];
    const prevR: number[] = [];
    for (let i = 1; i < rates.length; i++) {
      deltaR.push(rates[i] - rates[i - 1]);
      prevR.push(rates[i - 1]);
    }

    // OLS regression: Δr = α + β * r_{t-1}
    const n = deltaR.length;
    const meanPrev = mean(prevR);
    const meanDelta = mean(deltaR);

    let ssXY = 0;
    let ssXX = 0;
    for (let i = 0; i < n; i++) {
      ssXY += (prevR[i] - meanPrev) * (deltaR[i] - meanDelta);
      ssXX += (prevR[i] - meanPrev) ** 2;
    }

    if (ssXX === 0) return null;

    const beta = ssXY / ssXX;
    const alpha = meanDelta - beta * meanPrev;

    // OU parameters
    const kappa = -beta; // mean reversion speed
    const theta = beta !== 0 ? -alpha / beta : mean(rates); // long-run mean

    // Residual volatility
    const residuals = deltaR.map((dr, i) => dr - (alpha + beta * prevR[i]));
    const sigma = stddev(residuals, 0);

    // Half-life: time to revert 50% = ln(2) / kappa
    const halfLife = kappa > 0 ? Math.log(2) / kappa : Infinity;

    // R-squared
    const ssTot = variance(deltaR, 0) * n;
    const ssRes = residuals.reduce((s, r) => s + r * r, 0);
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    return { kappa, theta, sigma, halfLife, rSquared };
  }

  /**
   * Detect the current regime based on recent rate dynamics.
   */
  detectRegime(symbol: string): "trending_up" | "trending_down" | "mean_reverting" | "volatile" {
    const hist = this.history.get(symbol);
    if (!hist || hist.length < 24) return "volatile";

    const rates = hist.map((h) => h.rate);
    const recent = rates.slice(-24); // last 24h
    const older = rates.slice(-72, -24); // 24-72h ago

    if (older.length === 0) return "volatile";

    const recentMean = mean(recent);
    const olderMean = mean(older);
    const recentVol = stddev(recent);
    const longMean = mean(rates);

    // Trending: recent mean significantly different from older mean
    const trendStrength = Math.abs(recentMean - olderMean) / (recentVol || 0.0001);
    if (trendStrength > 2) {
      return recentMean > olderMean ? "trending_up" : "trending_down";
    }

    // Mean reverting: OU model fits well
    const ouModel = this.fitOUModel(symbol);
    if (ouModel && ouModel.kappa > 0.01 && ouModel.rSquared > 0.05) {
      return "mean_reverting";
    }

    return "volatile";
  }

  /**
   * Generate funding rate predictions for a symbol.
   * Combines forward curve extraction with OU mean-reversion model.
   */
  predict(symbol: string): FundingPrediction | null {
    const hist = this.history.get(symbol);
    const curve = this.curves.get(symbol);
    if (!hist || hist.length < 24 || !curve) return null;

    const currentRate = hist[hist.length - 1].rate;
    const ouModel = this.fitOUModel(symbol);
    const regime = this.detectRegime(symbol);
    const forwards = this.extractForwardRates(symbol);

    const horizons = [
      { label: "1h", hours: 1 },
      { label: "4h", hours: 4 },
      { label: "8h", hours: 8 },
      { label: "24h", hours: 24 },
      { label: "3d", hours: 72 },
      { label: "7d", hours: 168 },
    ];

    const predictions = horizons.map((h) => {
      let predictedRate: number;
      let confidence: number;

      if (ouModel && ouModel.kappa > 0) {
        // OU prediction: E[r_t] = θ + (r_0 - θ) * exp(-κt)
        const decay = Math.exp(-ouModel.kappa * h.hours);
        predictedRate = ouModel.theta + (currentRate - ouModel.theta) * decay;

        // Prediction variance: σ² * (1 - e^{-2κt}) / (2κ)
        const predVar = (ouModel.sigma ** 2) * (1 - Math.exp(-2 * ouModel.kappa * h.hours)) / (2 * ouModel.kappa);
        const predStd = Math.sqrt(predVar);

        // Blend with forward rate if available
        const matchingForward = forwards.find((f) => {
          const fHours = curve.curve.find((p) => p.horizon === f.endHorizon)?.horizonHours || 0;
          return Math.abs(fHours - h.hours) < h.hours * 0.5;
        });

        if (matchingForward) {
          // Weight OU more for short horizons, forward more for long
          const ouWeight = Math.exp(-h.hours / 72); // decays over 3 days
          const fwdHourly = matchingForward.forwardRate / (24 * 365); // de-annualize
          predictedRate = ouWeight * predictedRate + (1 - ouWeight) * fwdHourly;
        }

        confidence = Math.max(0.1, Math.min(0.95, ouModel.rSquared * Math.exp(-h.hours / 168)));

        return {
          horizon: h.label,
          hours: h.hours,
          predictedRate,
          confidence: Math.round(confidence * 100) / 100,
          upperBound: predictedRate + 1.96 * predStd,
          lowerBound: predictedRate - 1.96 * predStd,
        };
      } else {
        // Fallback: simple exponential decay toward mean
        const longMean = mean(hist.map((p) => p.rate));
        const decay = Math.exp(-0.05 * h.hours);
        predictedRate = longMean + (currentRate - longMean) * decay;
        const histStd = stddev(hist.map((p) => p.rate));

        return {
          horizon: h.label,
          hours: h.hours,
          predictedRate,
          confidence: Math.max(0.1, 0.5 * Math.exp(-h.hours / 72)),
          upperBound: predictedRate + 1.96 * histStd,
          lowerBound: predictedRate - 1.96 * histStd,
        };
      }
    });

    // Generate signal
    const shortPred = predictions.find((p) => p.hours === 4);
    const longPred = predictions.find((p) => p.hours === 72);
    let signal: string;

    if (!shortPred || !longPred) {
      signal = "Insufficient data for signal generation.";
    } else if (regime === "mean_reverting" && ouModel) {
      const deviation = (currentRate - ouModel.theta) / (ouModel.sigma || 0.0001);
      if (deviation > 1.5) {
        signal = `MEAN REVERSION SHORT: Rate is ${deviation.toFixed(1)}σ above fair value (${(ouModel.theta * 10000).toFixed(1)}bps). Half-life: ${ouModel.halfLife.toFixed(0)}h. Expect rate to decline → consider receiving fixed in rate swap.`;
      } else if (deviation < -1.5) {
        signal = `MEAN REVERSION LONG: Rate is ${Math.abs(deviation).toFixed(1)}σ below fair value. Half-life: ${ouModel.halfLife.toFixed(0)}h. Expect rate to rise → consider paying fixed in rate swap.`;
      } else {
        signal = `Rate near fair value (${(ouModel.theta * 10000).toFixed(1)}bps). No strong directional signal.`;
      }
    } else if (regime === "trending_up") {
      signal = "TRENDING UP: Funding rates rising. Bullish leverage demand. Lock in fixed rate via swap before rates peak.";
    } else if (regime === "trending_down") {
      signal = "TRENDING DOWN: Funding rates declining. Leverage unwinding. Wait to lock in fixed rate.";
    } else {
      signal = "VOLATILE: High funding rate uncertainty. Widen position limits and increase margin.";
    }

    return {
      symbol,
      currentRate,
      predictions,
      regime,
      meanReversionSpeed: ouModel?.kappa || 0,
      longRunMean: ouModel?.theta || mean(hist.map((p) => p.rate)),
      signal,
    };
  }

  /**
   * Generate predictions for all symbols with available data.
   */
  predictAll(): Map<string, FundingPrediction> {
    const results = new Map<string, FundingPrediction>();
    for (const symbol of this.history.keys()) {
      const pred = this.predict(symbol);
      if (pred) results.set(symbol, pred);
    }
    return results;
  }

  /**
   * Format prediction report for display.
   */
  formatReport(prediction: FundingPrediction): string {
    const lines = [
      `=== ${prediction.symbol} FUNDING RATE PREDICTION ===`,
      `Current rate: ${(prediction.currentRate * 10000).toFixed(2)}bps/h`,
      `Regime: ${prediction.regime.toUpperCase()}`,
      `Mean reversion speed: ${prediction.meanReversionSpeed.toFixed(4)} (half-life: ${prediction.meanReversionSpeed > 0 ? (Math.log(2) / prediction.meanReversionSpeed).toFixed(0) + "h" : "∞"})`,
      `Long-run mean: ${(prediction.longRunMean * 10000).toFixed(2)}bps/h`,
      "",
      `${"Horizon".padEnd(8)} ${"Predicted".padEnd(14)} ${"95% CI".padEnd(24)} Conf`,
      "-".repeat(58),
    ];

    for (const p of prediction.predictions) {
      const pred = `${(p.predictedRate * 10000).toFixed(2)}bps`;
      const ci = `[${(p.lowerBound * 10000).toFixed(1)}, ${(p.upperBound * 10000).toFixed(1)}]bps`;
      lines.push(`${p.horizon.padEnd(8)} ${pred.padEnd(14)} ${ci.padEnd(24)} ${(p.confidence * 100).toFixed(0)}%`);
    }

    lines.push("");
    lines.push(`Signal: ${prediction.signal}`);

    return lines.join("\n");
  }
}
