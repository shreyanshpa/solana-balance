/**
 * Risk Manager for Delta-Neutral Vaults
 *
 * Handles the risks that kill real DN strategies:
 *
 * 1. NEGATIVE FUNDING: When funding flips negative, shorts PAY instead of earn.
 *    Ethena handles this with a reserve fund + insurance. We do the same.
 *
 * 2. LIQUIDATION RISK: If prices move fast enough, the perp margin gets eaten.
 *    We monitor margin ratios and force-deleverage before liquidation.
 *
 * 3. BASIS RISK: Spot and perp can diverge temporarily (especially during volatility).
 *    We track basis and can close positions if divergence exceeds threshold.
 *
 * 4. CONCENTRATION RISK: Too much capital in one asset = single point of failure.
 *    We enforce allocation limits.
 *
 * 5. EXCHANGE/SMART CONTRACT RISK: If the exchange gets exploited, capital is lost.
 *    We diversify across venues (when available).
 */

import type { VaultPosition, VaultConfig } from "../common/types";
import { mean, stddev, percentile } from "../common/math";

export interface RiskMetrics {
  // Per-position risk
  positions: PositionRisk[];
  // Vault-level risk
  totalCollateralRatio: number;     // total margin / total notional
  weightedAvgFunding: number;       // portfolio-weighted funding rate
  maxSingleAssetPct: number;        // largest position as % of total
  negativeFundingExposure: number;  // how much we'd lose if all rates flip to -5bps
  reserveFundRatio: number;         // reserve / total AUM
  // Risk scores (0-100, higher = more risk)
  liquidationRiskScore: number;
  fundingRiskScore: number;
  concentrationRiskScore: number;
  overallRiskScore: number;
}

export interface PositionRisk {
  symbol: string;
  marginRatio: number;          // margin / notional
  distanceToLiquidation: number; // % price move to liquidation
  currentFundingRate: number;
  fundingRateVolatility: number; // std dev of recent funding
  basisSpread: number;          // perp price - spot price (bps)
  maxDrawdown24h: number;       // worst case from recent vol
}

export interface RiskAlert {
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  action: string;
  timestamp: number;
}

export class RiskManager {
  private config: VaultConfig;
  private alerts: RiskAlert[] = [];
  private reserveFund: number = 0;
  private fundingRateHistory: Map<string, number[]> = new Map();

  // Thresholds
  private maxConcentrationPct = 0.40;        // no single asset > 40%
  private minMarginRatio = 0.15;             // minimum 15% margin ratio
  private liquidationWarningPct = 0.25;      // warn at 25% distance to liq
  private negativeFundingThresholdHours = 8; // deleverage after 8h negative
  private reserveTargetPct = 0.05;           // target 5% reserve fund

  constructor(config: VaultConfig) {
    this.config = config;
  }

  /**
   * Record a funding rate observation for risk monitoring.
   */
  recordFundingRate(symbol: string, rate: number): void {
    if (!this.fundingRateHistory.has(symbol)) {
      this.fundingRateHistory.set(symbol, []);
    }
    const history = this.fundingRateHistory.get(symbol)!;
    history.push(rate);
    // Keep last 720 observations (30 days hourly)
    if (history.length > 720) history.shift();
  }

  /**
   * Compute comprehensive risk metrics for the vault.
   */
  computeRiskMetrics(
    positions: VaultPosition[],
    fundingRates: Map<string, number>,
    totalAUM: number
  ): RiskMetrics {
    const positionRisks: PositionRisk[] = [];
    let totalNotional = 0;
    let totalMargin = 0;
    let maxPositionPct = 0;

    for (const pos of positions) {
      const notional = pos.size * pos.markPrice;
      totalNotional += notional;
      totalMargin += pos.margin;

      const pctOfAUM = totalAUM > 0 ? notional / totalAUM : 0;
      maxPositionPct = Math.max(maxPositionPct, pctOfAUM);

      const marginRatio = notional > 0 ? pos.margin / notional : 1;

      // Distance to liquidation: how much price must move to wipe margin
      // For a short, price going UP eats margin
      // Liquidation when: margin + PnL = 0
      // PnL = -(price - entry) * size
      // 0 = margin - (liq_price - entry) * size
      // liq_price = entry + margin / size
      const liqPrice = pos.entryPrice + pos.margin / pos.size;
      const distToLiq = (liqPrice - pos.markPrice) / pos.markPrice;

      // Funding rate stats
      const fundingHistory = this.fundingRateHistory.get(pos.symbol) || [];
      const currentFunding = fundingRates.get(pos.symbol) || 0;
      const fundingVol = fundingHistory.length > 1 ? stddev(fundingHistory) : 0;

      // Basis spread (would come from comparing spot vs perp oracle)
      // For now, estimate from funding rate (high funding ≈ perp trading at premium)
      const basisBps = currentFunding * 10000;

      // Max drawdown estimate from 24h realized vol
      const recentFunding = fundingHistory.slice(-24);
      const maxDD = recentFunding.length > 0
        ? Math.abs(Math.min(...recentFunding)) * notional * 24
        : 0;

      positionRisks.push({
        symbol: pos.symbol,
        marginRatio,
        distanceToLiquidation: distToLiq,
        currentFundingRate: currentFunding,
        fundingRateVolatility: fundingVol,
        basisSpread: basisBps,
        maxDrawdown24h: maxDD,
      });

      // Generate alerts
      if (distToLiq < this.liquidationWarningPct) {
        this.addAlert("critical", "liquidation",
          `${pos.symbol}: Only ${(distToLiq * 100).toFixed(1)}% from liquidation!`,
          `Reduce position or add margin for ${pos.symbol}`
        );
      }

      if (marginRatio < this.minMarginRatio) {
        this.addAlert("warning", "margin",
          `${pos.symbol}: Margin ratio ${(marginRatio * 100).toFixed(1)}% below minimum ${this.minMarginRatio * 100}%`,
          `Add margin or reduce size for ${pos.symbol}`
        );
      }

      if (currentFunding < 0) {
        // Count consecutive negative funding periods
        const negativeStreak = this.countNegativeStreak(pos.symbol);
        if (negativeStreak >= this.negativeFundingThresholdHours) {
          this.addAlert("warning", "negative_funding",
            `${pos.symbol}: Negative funding for ${negativeStreak}h. Shorts are PAYING.`,
            `Consider reducing ${pos.symbol} position or hedging funding exposure`
          );
        }
      }
    }

    // Concentration check
    if (maxPositionPct > this.maxConcentrationPct) {
      this.addAlert("warning", "concentration",
        `Largest position is ${(maxPositionPct * 100).toFixed(0)}% of AUM (max: ${this.maxConcentrationPct * 100}%)`,
        "Rebalance to reduce concentration risk"
      );
    }

    // Compute risk scores (0-100)
    const liquidationRiskScore = this.computeLiquidationScore(positionRisks);
    const fundingRiskScore = this.computeFundingScore(positionRisks);
    const concentrationRiskScore = Math.min(100, (maxPositionPct / this.maxConcentrationPct) * 100);
    const overallRiskScore = Math.round(
      liquidationRiskScore * 0.4 + fundingRiskScore * 0.35 + concentrationRiskScore * 0.25
    );

    // Negative funding stress test: what if all rates go to -5bps?
    const stressRate = -0.0005;
    const negativeFundingExposure = totalNotional * Math.abs(stressRate) * 24; // per day

    return {
      positions: positionRisks,
      totalCollateralRatio: totalNotional > 0 ? totalMargin / totalNotional : 1,
      weightedAvgFunding: this.computeWeightedFunding(positions, fundingRates),
      maxSingleAssetPct: maxPositionPct,
      negativeFundingExposure,
      reserveFundRatio: totalAUM > 0 ? this.reserveFund / totalAUM : 0,
      liquidationRiskScore,
      fundingRiskScore,
      concentrationRiskScore,
      overallRiskScore,
    };
  }

  /**
   * Determine if we should deleverage a position (protective action).
   */
  shouldDeleverage(posRisk: PositionRisk): {
    deleverage: boolean;
    reason: string;
    targetReduction: number; // 0-1, fraction to reduce
  } {
    // Critical: near liquidation
    if (posRisk.distanceToLiquidation < 0.10) {
      return {
        deleverage: true,
        reason: `Emergency deleverage: ${(posRisk.distanceToLiquidation * 100).toFixed(1)}% from liquidation`,
        targetReduction: 0.5, // reduce by half
      };
    }

    // Warning: sustained negative funding
    const negStreak = this.countNegativeStreak(posRisk.symbol);
    if (negStreak >= this.negativeFundingThresholdHours * 2) { // 16h sustained negative
      return {
        deleverage: true,
        reason: `Sustained negative funding (${negStreak}h) — strategy is bleeding`,
        targetReduction: 0.3, // reduce by 30%
      };
    }

    // Warning: funding volatility is extreme
    if (posRisk.fundingRateVolatility > 0.001) { // vol > 10bps
      return {
        deleverage: true,
        reason: `Funding rate volatility too high (${(posRisk.fundingRateVolatility * 10000).toFixed(0)}bps std dev)`,
        targetReduction: 0.2,
      };
    }

    return { deleverage: false, reason: "Position within risk limits", targetReduction: 0 };
  }

  /**
   * Add to the reserve fund (skims from vault profits).
   */
  addToReserve(amount: number): void {
    this.reserveFund += amount;
  }

  /**
   * Draw from reserve to cover negative funding.
   */
  drawFromReserve(amount: number): number {
    const drawn = Math.min(amount, this.reserveFund);
    this.reserveFund -= drawn;
    return drawn;
  }

  getReserveFund(): number {
    return this.reserveFund;
  }

  getAlerts(): RiskAlert[] {
    return this.alerts;
  }

  clearAlerts(): void {
    this.alerts = [];
  }

  // --- Private helpers ---

  private addAlert(severity: RiskAlert["severity"], type: string, message: string, action: string): void {
    this.alerts.push({ severity, type, message, action, timestamp: Date.now() });
  }

  private countNegativeStreak(symbol: string): number {
    const history = this.fundingRateHistory.get(symbol) || [];
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] < 0) streak++;
      else break;
    }
    return streak;
  }

  private computeWeightedFunding(positions: VaultPosition[], rates: Map<string, number>): number {
    let totalNotional = 0;
    let weightedRate = 0;
    for (const pos of positions) {
      const notional = pos.size * pos.markPrice;
      const rate = rates.get(pos.symbol) || 0;
      weightedRate += rate * notional;
      totalNotional += notional;
    }
    return totalNotional > 0 ? weightedRate / totalNotional : 0;
  }

  private computeLiquidationScore(risks: PositionRisk[]): number {
    if (risks.length === 0) return 0;
    const minDist = Math.min(...risks.map(r => r.distanceToLiquidation));
    // 0% distance = score 100, 50%+ distance = score 0
    return Math.max(0, Math.min(100, (1 - minDist / 0.5) * 100));
  }

  private computeFundingScore(risks: PositionRisk[]): number {
    if (risks.length === 0) return 0;
    const negativeCount = risks.filter(r => r.currentFundingRate < 0).length;
    const avgVol = mean(risks.map(r => r.fundingRateVolatility));
    // Score based on % of positions with negative funding + overall vol
    const negPct = negativeCount / risks.length;
    return Math.min(100, negPct * 60 + avgVol * 40000);
  }
}
