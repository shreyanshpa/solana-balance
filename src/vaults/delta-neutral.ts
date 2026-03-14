/**
 * Delta-Neutral Vault Engine
 *
 * The core strategy: deposit USDC → buy spot asset → short equivalent perp
 * The spot and perp positions cancel out (delta = 0), so you have no
 * directional price exposure. Your yield comes from:
 *
 * 1. Funding rate payments (shorts receive funding when rate is positive)
 * 2. Spot staking yield (if the spot asset is an LST like JitoSOL)
 * 3. Basis spread (perp typically trades at premium to spot)
 *
 * This is exactly how Ethena (USDe) works, and how Reflect won $50K at
 * Solana Radar. We build it on Pacifica's perp DEX.
 *
 * Risk factors:
 * - Negative funding rates (shorts PAY instead of receive)
 * - Liquidation risk on the short perp leg
 * - Basis risk (spot/perp divergence during volatility)
 * - Smart contract / exchange risk
 */

import { PacificaClient } from "../common/pacifica-client";
import type { VaultConfig, VaultState, VaultPosition } from "../common/types";
import { annualizeFundingRate, mean } from "../common/math";

interface DepositRecord {
  depositor: string;
  shares: number;
  depositAmount: number;
  depositTime: number;
}

interface RebalanceEvent {
  timestamp: number;
  reason: string;
  action: string;
  details: Record<string, number>;
}

export class DeltaNeutralVault {
  private client: PacificaClient;
  private config: VaultConfig;
  private state: VaultState;
  private deposits: Map<string, DepositRecord> = new Map();
  private rebalanceHistory: RebalanceEvent[] = [];

  // Performance tracking
  private dailyNavHistory: Array<{ timestamp: number; nav: number }> = [];
  private cumulativeFunding: number = 0;
  private totalFees: number = 0;

  // Fee structure
  private managementFeePct = 0.02;  // 2% annualized
  private performanceFeePct = 0.10; // 10% of profits
  private highWaterMark = 1.0;

  constructor(client: PacificaClient, config: VaultConfig) {
    this.client = client;
    this.config = config;
    this.state = {
      totalDeposits: 0,
      totalShares: 0,
      nav: 1.0, // start at $1 per share
      apy: 0,
      positions: [],
      lastRebalance: Date.now(),
      pnl: 0,
      fundingEarned: 0,
    };
  }

  /**
   * Deposit USDC into the vault. Returns shares minted.
   */
  deposit(depositor: string, amount: number): { shares: number; nav: number } {
    if (amount <= 0) throw new Error("Deposit must be positive");

    // Shares = deposit / NAV (first depositor gets 1:1)
    const sharesToMint = this.state.totalShares === 0
      ? amount
      : amount / this.state.nav;

    this.state.totalDeposits += amount;
    this.state.totalShares += sharesToMint;

    // Record deposit
    const existing = this.deposits.get(depositor);
    if (existing) {
      existing.shares += sharesToMint;
      existing.depositAmount += amount;
    } else {
      this.deposits.set(depositor, {
        depositor,
        shares: sharesToMint,
        depositAmount: amount,
        depositTime: Date.now(),
      });
    }

    return { shares: sharesToMint, nav: this.state.nav };
  }

  /**
   * Withdraw from the vault. Burns shares and returns USDC value.
   */
  withdraw(depositor: string, sharesToBurn: number): { amount: number; fee: number } {
    const record = this.deposits.get(depositor);
    if (!record) throw new Error("No deposit found");
    if (sharesToBurn > record.shares) throw new Error("Insufficient shares");

    const grossAmount = sharesToBurn * this.state.nav;

    // Performance fee on profits above high water mark
    const costBasis = (record.depositAmount / record.shares) * sharesToBurn;
    const profit = Math.max(0, grossAmount - costBasis);
    const perfFee = profit * this.performanceFeePct;

    const netAmount = grossAmount - perfFee;
    this.totalFees += perfFee;

    // Update state
    record.shares -= sharesToBurn;
    record.depositAmount -= costBasis;
    this.state.totalShares -= sharesToBurn;
    this.state.totalDeposits -= costBasis;

    if (record.shares <= 0) {
      this.deposits.delete(depositor);
    }

    return { amount: netAmount, fee: perfFee };
  }

  /**
   * Open delta-neutral position for an asset.
   * Allocates capital: 50% to spot (simulated), 50% to short perp margin.
   */
  openPosition(
    symbol: string,
    capitalAllocation: number,
    currentPrice: number,
    leverage: number = 2
  ): VaultPosition {
    if (leverage > this.config.maxLeverage) {
      throw new Error(`Leverage ${leverage}x exceeds max ${this.config.maxLeverage}x`);
    }

    // Size = capital allocated to this position
    // Half goes to "spot" (simulated buy), half to short perp margin
    const spotCapital = capitalAllocation / 2;
    const perpMargin = capitalAllocation / 2;
    const positionSize = spotCapital / currentPrice; // quantity of base asset

    const position: VaultPosition = {
      symbol,
      side: "short", // the perp side is short
      size: positionSize,
      entryPrice: currentPrice,
      markPrice: currentPrice,
      unrealizedPnl: 0,
      leverage,
      margin: perpMargin,
    };

    this.state.positions.push(position);
    return position;
  }

  /**
   * Simulate funding rate accrual on all short positions.
   * In production, this would be called after each funding settlement.
   */
  accrueForPeriod(fundingRates: Map<string, number>, periodHours: number = 1): {
    totalFunding: number;
    byAsset: Record<string, number>;
  } {
    let totalFunding = 0;
    const byAsset: Record<string, number> = {};

    for (const position of this.state.positions) {
      const rate = fundingRates.get(position.symbol);
      if (rate === undefined) continue;

      // Short positions RECEIVE funding when rate is positive
      // funding payment = rate * position_notional * periods
      const notional = position.size * position.markPrice;
      const funding = rate * notional * periodHours; // rate is per hour

      // Positive rate = shorts receive, negative = shorts pay
      const netFunding = position.side === "short" ? funding : -funding;

      totalFunding += netFunding;
      byAsset[position.symbol] = netFunding;
    }

    this.cumulativeFunding += totalFunding;
    this.state.fundingEarned += totalFunding;

    // Update NAV
    if (this.state.totalShares > 0) {
      this.state.nav += totalFunding / this.state.totalShares;
    }

    // Management fee accrual (hourly portion of annual fee)
    const mgmtFee = (this.state.totalDeposits * this.managementFeePct * periodHours) / (365 * 24);
    this.totalFees += mgmtFee;
    if (this.state.totalShares > 0) {
      this.state.nav -= mgmtFee / this.state.totalShares;
    }

    return { totalFunding, byAsset };
  }

  /**
   * Update mark prices and check if rebalancing is needed.
   */
  updatePrices(prices: Map<string, number>): {
    needsRebalance: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];

    for (const position of this.state.positions) {
      const newPrice = prices.get(position.symbol);
      if (newPrice === undefined) continue;

      const oldPrice = position.markPrice;
      position.markPrice = newPrice;

      // Delta-neutral P&L: spot leg + perp leg
      // Spot leg: long position gains when price rises
      const spotPnl = (newPrice - position.entryPrice) * position.size;
      // Perp leg: short position gains when price drops
      const perpPnl = -(newPrice - position.entryPrice) * position.size;
      // Net P&L is ~0 (delta neutral) — any residual is from execution slippage
      position.unrealizedPnl = spotPnl + perpPnl; // should be ~0

      // Check if leverage has drifted beyond threshold on the perp leg
      const notional = position.size * newPrice;
      const equity = position.margin + perpPnl;
      const effectiveLeverage = equity > 0 ? notional / equity : 999;
      const leverageDrift = Math.abs(effectiveLeverage - position.leverage) / position.leverage;

      if (leverageDrift > this.config.rebalanceThresholdPct / 100) {
        reasons.push(`${position.symbol}: leverage drifted to ${effectiveLeverage.toFixed(1)}x (target: ${position.leverage}x)`);
      }

      // Check drawdown
      const drawdown = -position.unrealizedPnl / position.margin;
      if (drawdown > this.config.maxDrawdownPct / 100) {
        reasons.push(`${position.symbol}: drawdown ${(drawdown * 100).toFixed(1)}% exceeds max ${this.config.maxDrawdownPct}%`);
      }
    }

    // Update total PnL
    this.state.pnl = this.state.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    return { needsRebalance: reasons.length > 0, reasons };
  }

  /**
   * Rebalance positions to maintain target leverage and delta neutrality.
   */
  rebalance(prices: Map<string, number>): RebalanceEvent[] {
    const events: RebalanceEvent[] = [];

    for (const position of this.state.positions) {
      const price = prices.get(position.symbol) || position.markPrice;
      const notional = position.size * price;
      const perpPnl = -(price - position.entryPrice) * position.size;
      const equity = position.margin + perpPnl;
      if (equity <= 0) continue; // skip — would be liquidated in prod
      const currentLeverage = notional / equity;

      if (Math.abs(currentLeverage - position.leverage) / position.leverage > this.config.rebalanceThresholdPct / 100) {
        // Adjust position size to restore target leverage
        const targetNotional = equity * position.leverage;
        const sizeAdjustment = (targetNotional - notional) / price;

        const event: RebalanceEvent = {
          timestamp: Date.now(),
          reason: `Leverage drift: ${currentLeverage.toFixed(2)}x → ${position.leverage}x`,
          action: sizeAdjustment > 0 ? "increase_short" : "decrease_short",
          details: {
            symbol_idx: this.state.positions.indexOf(position),
            oldSize: position.size,
            newSize: position.size - sizeAdjustment, // short, so subtract
            adjustment: Math.abs(sizeAdjustment),
            price,
          },
        };

        // Apply rebalance — clamp size to prevent runaway growth
        const newSize = Math.max(position.size - sizeAdjustment, 0);
        position.size = newSize;
        position.entryPrice = price; // reset entry for clean accounting
        position.margin = newSize * price / position.leverage; // reset margin
        position.unrealizedPnl = 0;
        position.markPrice = price;

        events.push(event);
        this.rebalanceHistory.push(event);
      }
    }

    this.state.lastRebalance = Date.now();
    return events;
  }

  /**
   * Compute trailing APY based on NAV history.
   */
  computeTrailingAPY(lookbackDays: number = 7): number {
    if (this.dailyNavHistory.length < 2) return 0;

    const cutoff = Date.now() - lookbackDays * 24 * 3600 * 1000;
    const relevantNav = this.dailyNavHistory.filter((n) => n.timestamp >= cutoff);

    if (relevantNav.length < 2) return 0;

    const startNav = relevantNav[0].nav;
    const endNav = relevantNav[relevantNav.length - 1].nav;
    const periodDays = (relevantNav[relevantNav.length - 1].timestamp - relevantNav[0].timestamp) / (24 * 3600 * 1000);

    if (periodDays === 0 || startNav === 0) return 0;

    // Annualize: (endNav/startNav)^(365/days) - 1
    const apy = Math.pow(endNav / startNav, 365 / periodDays) - 1;
    this.state.apy = apy;
    return apy;
  }

  /**
   * Record current NAV snapshot.
   */
  snapshotNav(): void {
    this.dailyNavHistory.push({ timestamp: Date.now(), nav: this.state.nav });

    // Update high water mark
    if (this.state.nav > this.highWaterMark) {
      this.highWaterMark = this.state.nav;
    }
  }

  /**
   * Get full vault status.
   */
  getStatus(): VaultState & {
    depositorCount: number;
    cumulativeFunding: number;
    totalFees: number;
    highWaterMark: number;
    trailing7dAPY: number;
  } {
    return {
      ...this.state,
      depositorCount: this.deposits.size,
      cumulativeFunding: this.cumulativeFunding,
      totalFees: this.totalFees,
      highWaterMark: this.highWaterMark,
      trailing7dAPY: this.computeTrailingAPY(7),
    };
  }

  /**
   * Get a depositor's position.
   */
  getDepositorInfo(depositor: string): {
    shares: number;
    currentValue: number;
    pnl: number;
    pnlPct: number;
  } | null {
    const record = this.deposits.get(depositor);
    if (!record) return null;

    const currentValue = record.shares * this.state.nav;
    const pnl = currentValue - record.depositAmount;
    const pnlPct = record.depositAmount > 0 ? pnl / record.depositAmount : 0;

    return {
      shares: record.shares,
      currentValue,
      pnl,
      pnlPct,
    };
  }

  /**
   * Get rebalance history.
   */
  getRebalanceHistory(): RebalanceEvent[] {
    return this.rebalanceHistory;
  }
}
