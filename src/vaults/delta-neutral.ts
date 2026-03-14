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
  personalHWM: number; // per-depositor high water mark (NAV at last fee crystallization)
}

interface RebalanceEvent {
  timestamp: number;
  reason: string;
  action: string;
  details: Record<string, number>;
}

// Tracks the full delta-neutral position (both legs)
interface DNPosition {
  symbol: string;
  // Spot leg
  spotSize: number;       // quantity of base asset held
  spotEntryPrice: number; // weighted avg entry price for spot
  // Perp leg (short)
  perpSize: number;       // quantity shorted on perp
  perpEntryPrice: number; // weighted avg entry price for perp
  perpMargin: number;     // USDC collateral posted for short
  // Combined
  leverage: number;
  capitalAllocated: number;
}

// ============================================================
// Dynamic Allocation — Ethena-style stablecoin rotation
// ============================================================

export type AllocationMode = "full_dn" | "partial_stablecoin" | "defensive";

export interface AllocationState {
  mode: AllocationMode;
  dnAllocationPct: number;          // % of capital in delta-neutral positions
  stablecoinAllocationPct: number;  // % parked in stablecoins earning base yield
  stablecoinBalance: number;        // USDC parked in stablecoin yield
  stablecoinYieldAPR: number;       // base rate earned on idle capital (e.g., 4.5% T-bill proxy)
  accruedStablecoinYield: number;   // total yield earned from stablecoin parking
  rollingFundingAvg24h: number;     // 24h rolling average funding rate
  fundingHistory: number[];         // recent hourly funding rates for rolling window
  lastModeChange: number;           // timestamp of last allocation mode change
}

export interface AllocationEvent {
  timestamp: number;
  fromMode: AllocationMode;
  toMode: AllocationMode;
  capitalShifted: number;
  reason: string;
}

export class DeltaNeutralVault {
  private client: PacificaClient;
  private config: VaultConfig;
  private state: VaultState;
  private deposits: Map<string, DepositRecord> = new Map();
  private dnPositions: DNPosition[] = [];
  private rebalanceHistory: RebalanceEvent[] = [];

  // Performance tracking
  private dailyNavHistory: Array<{ timestamp: number; nav: number }> = [];
  private cumulativeFunding: number = 0;
  private totalFees: number = 0;
  private realizedPnl: number = 0; // P&L realized during rebalances

  // Fee structure
  private managementFeePct = 0.02;  // 2% annualized
  private performanceFeePct = 0.10; // 10% of profits above HWM
  private highWaterMark = 1.0;      // global HWM for NAV

  // Dynamic allocation state (Ethena-style)
  private allocation: AllocationState = {
    mode: "full_dn",
    dnAllocationPct: 1.0,
    stablecoinAllocationPct: 0,
    stablecoinBalance: 0,
    stablecoinYieldAPR: 0.045,   // 4.5% base rate (T-bill / lending proxy)
    accruedStablecoinYield: 0,
    rollingFundingAvg24h: 0,
    fundingHistory: [],
    lastModeChange: Date.now(),
  };
  private allocationEvents: AllocationEvent[] = [];

  // Dynamic allocation thresholds
  private fundingThresholdNegative = -0.00002;    // shift to stablecoins when 24h avg below this
  private fundingThresholdRecovery = 0.00005;      // shift back when 24h avg above this
  private partialStablecoinPct = 0.30;             // park 30% in stablecoins during partial mode
  private defensiveStablecoinPct = 0.60;           // park 60% in stablecoins during defensive mode
  private defensiveFundingThreshold = -0.0001;     // deep negative triggers defensive mode

  constructor(client: PacificaClient, config: VaultConfig) {
    this.client = client;
    this.config = config;
    this.state = {
      totalDeposits: 0,
      totalShares: 0,
      nav: 1.0,
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

    const sharesToMint = this.state.totalShares === 0
      ? amount
      : amount / this.state.nav;

    this.state.totalDeposits += amount;
    this.state.totalShares += sharesToMint;

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
        personalHWM: this.state.nav,
      });
    }

    return { shares: sharesToMint, nav: this.state.nav };
  }

  /**
   * Withdraw from the vault. Burns shares and returns USDC value.
   * Performance fee is charged only on gains above the depositor's high water mark.
   */
  withdraw(depositor: string, sharesToBurn: number): { amount: number; fee: number } {
    const record = this.deposits.get(depositor);
    if (!record) throw new Error("No deposit found");
    if (sharesToBurn > record.shares) throw new Error("Insufficient shares");

    const grossAmount = sharesToBurn * this.state.nav;
    const costBasisPerShare = record.depositAmount / record.shares;

    // Performance fee: only on gains above personal HWM
    const profitPerShare = Math.max(0, this.state.nav - Math.max(costBasisPerShare, record.personalHWM));
    const perfFee = profitPerShare * sharesToBurn * this.performanceFeePct;

    const netAmount = grossAmount - perfFee;
    this.totalFees += perfFee;

    // Update records
    const costBasis = costBasisPerShare * sharesToBurn;
    record.shares -= sharesToBurn;
    record.depositAmount -= costBasis;
    this.state.totalShares -= sharesToBurn;
    this.state.totalDeposits -= costBasis;

    if (record.shares <= 0) {
      this.deposits.delete(depositor);
    } else {
      // Update personal HWM to current NAV (crystallize gains)
      record.personalHWM = Math.max(record.personalHWM, this.state.nav);
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
    if (currentPrice <= 0) throw new Error("Price must be positive");
    if (capitalAllocation <= 0) throw new Error("Capital allocation must be positive");

    const spotCapital = capitalAllocation / 2;
    const perpMargin = capitalAllocation / 2;
    const positionSize = spotCapital / currentPrice;

    // Track the full DN position internally
    this.dnPositions.push({
      symbol,
      spotSize: positionSize,
      spotEntryPrice: currentPrice,
      perpSize: positionSize,
      perpEntryPrice: currentPrice,
      perpMargin,
      leverage,
      capitalAllocated: capitalAllocation,
    });

    // Also expose via the simplified VaultPosition interface
    const position: VaultPosition = {
      symbol,
      side: "short",
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
   * Accrue funding rate payments on all short perp positions.
   * In production, this would be called after each funding settlement.
   */
  accrueForPeriod(fundingRates: Map<string, number>, periodHours: number = 1): {
    totalFunding: number;
    byAsset: Record<string, number>;
  } {
    let totalFunding = 0;
    const byAsset: Record<string, number> = {};

    for (const dn of this.dnPositions) {
      const rate = fundingRates.get(dn.symbol);
      if (rate === undefined) continue;

      // Funding is paid on perp notional only
      const perpNotional = dn.perpSize * (this.state.positions.find(p => p.symbol === dn.symbol)?.markPrice || dn.perpEntryPrice);
      // Short positions RECEIVE funding when rate is positive
      const netFunding = rate * perpNotional * periodHours;

      totalFunding += netFunding;
      byAsset[dn.symbol] = netFunding;
    }

    this.cumulativeFunding += totalFunding;
    this.state.fundingEarned += totalFunding;

    // Update NAV with funding
    if (this.state.totalShares > 0) {
      this.state.nav += totalFunding / this.state.totalShares;
    }

    // Management fee accrual (hourly portion of annual fee)
    const aum = this.state.totalShares * this.state.nav;
    const mgmtFee = (aum * this.managementFeePct * periodHours) / (365 * 24);
    this.totalFees += mgmtFee;
    if (this.state.totalShares > 0) {
      this.state.nav -= mgmtFee / this.state.totalShares;
    }

    return { totalFunding, byAsset };
  }

  /**
   * Update mark prices and check if rebalancing is needed.
   * Computes proper delta-neutral P&L: spot gains + perp gains ≈ 0.
   */
  updatePrices(prices: Map<string, number>): {
    needsRebalance: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];

    for (let i = 0; i < this.dnPositions.length; i++) {
      const dn = this.dnPositions[i];
      const pos = this.state.positions[i];
      if (!pos) continue;

      const newPrice = prices.get(dn.symbol);
      if (newPrice === undefined) continue;

      pos.markPrice = newPrice;

      // Delta-neutral P&L: spot + perp legs cancel
      const spotPnl = (newPrice - dn.spotEntryPrice) * dn.spotSize;
      const perpPnl = -(newPrice - dn.perpEntryPrice) * dn.perpSize;
      pos.unrealizedPnl = spotPnl + perpPnl; // ≈0 when balanced

      // Check perp leg leverage drift (this determines rebalance need)
      const perpNotional = dn.perpSize * newPrice;
      const perpEquity = dn.perpMargin + perpPnl;
      const effectiveLeverage = perpEquity > 0 ? perpNotional / perpEquity : 999;
      const leverageDrift = Math.abs(effectiveLeverage - dn.leverage) / dn.leverage;

      if (leverageDrift > this.config.rebalanceThresholdPct / 100) {
        reasons.push(`${dn.symbol}: leverage drifted to ${effectiveLeverage.toFixed(1)}x (target: ${dn.leverage}x)`);
      }

      // Check liquidation risk on perp leg
      const liquidationThreshold = 0.9; // 90% margin used
      if (perpEquity > 0 && perpEquity < dn.perpMargin * (1 - liquidationThreshold)) {
        reasons.push(`${dn.symbol}: LIQUIDATION WARNING — perp equity at $${perpEquity.toFixed(0)} (${((perpEquity / dn.perpMargin) * 100).toFixed(1)}% of margin)`);
      }
    }

    this.state.pnl = this.state.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return { needsRebalance: reasons.length > 0, reasons };
  }

  /**
   * Rebalance positions to maintain target leverage and delta neutrality.
   * Realizes P&L into NAV before resetting position entries.
   */
  rebalance(prices: Map<string, number>): RebalanceEvent[] {
    const events: RebalanceEvent[] = [];

    for (let i = 0; i < this.dnPositions.length; i++) {
      const dn = this.dnPositions[i];
      const pos = this.state.positions[i];
      if (!pos) continue;

      const price = prices.get(dn.symbol) || pos.markPrice;
      const perpNotional = dn.perpSize * price;
      const perpPnl = -(price - dn.perpEntryPrice) * dn.perpSize;
      const perpEquity = dn.perpMargin + perpPnl;

      if (perpEquity <= 0) continue; // would be liquidated

      const currentLeverage = perpNotional / perpEquity;
      const drift = Math.abs(currentLeverage - dn.leverage) / dn.leverage;

      if (drift <= this.config.rebalanceThresholdPct / 100) continue;

      // Step 1: Realize the perp P&L into NAV
      // The spot P&L offsets (delta neutral), but margin needs updating
      const spotPnl = (price - dn.spotEntryPrice) * dn.spotSize;
      const netRealized = spotPnl + perpPnl; // should be ~0
      this.realizedPnl += netRealized;

      // Step 2: Compute new target size
      const targetNotional = perpEquity * dn.leverage;
      const newSize = targetNotional / price;

      const event: RebalanceEvent = {
        timestamp: Date.now(),
        reason: `Leverage drift: ${currentLeverage.toFixed(2)}x → ${dn.leverage}x`,
        action: newSize > dn.perpSize ? "increase_short" : "decrease_short",
        details: {
          oldSize: dn.perpSize,
          newSize,
          price,
          realizedPnl: netRealized,
        },
      };

      // Step 3: Reset both legs at current price with new size
      dn.spotSize = newSize;
      dn.spotEntryPrice = price;
      dn.perpSize = newSize;
      dn.perpEntryPrice = price;
      dn.perpMargin = perpEquity; // margin absorbs realized P&L

      // Update simplified position view
      pos.size = newSize;
      pos.entryPrice = price;
      pos.markPrice = price;
      pos.margin = perpEquity;
      pos.unrealizedPnl = 0;

      events.push(event);
      this.rebalanceHistory.push(event);
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

    const apy = Math.pow(endNav / startNav, 365 / periodDays) - 1;
    this.state.apy = apy;
    return apy;
  }

  /**
   * Record current NAV snapshot.
   */
  snapshotNav(): void {
    this.dailyNavHistory.push({ timestamp: Date.now(), nav: this.state.nav });

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
    realizedPnl: number;
    trailing7dAPY: number;
  } {
    return {
      ...this.state,
      depositorCount: this.deposits.size,
      cumulativeFunding: this.cumulativeFunding,
      totalFees: this.totalFees,
      highWaterMark: this.highWaterMark,
      realizedPnl: this.realizedPnl,
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

    return { shares: record.shares, currentValue, pnl, pnlPct };
  }

  /**
   * Get rebalance history.
   */
  getRebalanceHistory(): RebalanceEvent[] {
    return this.rebalanceHistory;
  }

  /**
   * Get internal DN position details (for debugging/display).
   */
  getDNPositions(): DNPosition[] {
    return this.dnPositions;
  }

  // ============================================================
  // Dynamic Stablecoin Allocation (Ethena-style)
  // ============================================================

  /**
   * Update allocation based on current funding rate conditions.
   * Called each period alongside accrueForPeriod().
   *
   * Logic mirrors Ethena's approach:
   * - When funding is healthy (positive): 100% in DN positions
   * - When funding turns mildly negative: shift 30% to stablecoins earning base rate
   * - When funding is deeply negative: shift 60% to stablecoins (defensive mode)
   * - When funding recovers: gradually shift back to DN
   */
  updateAllocation(avgFundingRate: number): AllocationEvent | null {
    // Track funding rate for rolling average
    this.allocation.fundingHistory.push(avgFundingRate);
    if (this.allocation.fundingHistory.length > 24) {
      this.allocation.fundingHistory.shift();
    }

    // Compute 24h rolling average
    this.allocation.rollingFundingAvg24h = this.allocation.fundingHistory.length > 0
      ? mean(this.allocation.fundingHistory)
      : avgFundingRate;

    const avg = this.allocation.rollingFundingAvg24h;
    const currentMode = this.allocation.mode;
    let newMode: AllocationMode = currentMode;

    // Determine target mode based on funding conditions
    if (avg <= this.defensiveFundingThreshold) {
      newMode = "defensive";
    } else if (avg <= this.fundingThresholdNegative) {
      newMode = "partial_stablecoin";
    } else if (avg >= this.fundingThresholdRecovery) {
      newMode = "full_dn";
    }
    // In between thresholds: stay in current mode (hysteresis)

    if (newMode === currentMode) return null;

    // Execute the allocation shift
    const aum = this.state.totalShares * this.state.nav;
    const prevStablecoinPct = this.allocation.stablecoinAllocationPct;
    let targetStablecoinPct = 0;

    switch (newMode) {
      case "full_dn":
        targetStablecoinPct = 0;
        break;
      case "partial_stablecoin":
        targetStablecoinPct = this.partialStablecoinPct;
        break;
      case "defensive":
        targetStablecoinPct = this.defensiveStablecoinPct;
        break;
    }

    const capitalShifted = Math.abs(targetStablecoinPct - prevStablecoinPct) * aum;

    // Update allocation state
    this.allocation.mode = newMode;
    this.allocation.dnAllocationPct = 1 - targetStablecoinPct;
    this.allocation.stablecoinAllocationPct = targetStablecoinPct;
    this.allocation.stablecoinBalance = aum * targetStablecoinPct;
    this.allocation.lastModeChange = Date.now();

    const event: AllocationEvent = {
      timestamp: Date.now(),
      fromMode: currentMode,
      toMode: newMode,
      capitalShifted,
      reason: newMode === "defensive"
        ? `Deep negative funding (24h avg: ${(avg * 10000).toFixed(2)}bps) — shifting ${(targetStablecoinPct * 100).toFixed(0)}% to stablecoins`
        : newMode === "partial_stablecoin"
          ? `Negative funding detected (24h avg: ${(avg * 10000).toFixed(2)}bps) — parking ${(targetStablecoinPct * 100).toFixed(0)}% in stablecoins`
          : `Funding recovered (24h avg: ${(avg * 10000).toFixed(2)}bps) — deploying 100% to DN positions`,
    };

    this.allocationEvents.push(event);
    return event;
  }

  /**
   * Accrue stablecoin yield on parked capital.
   * Called each period — stablecoin balance earns base APR.
   */
  accrueStablecoinYield(periodHours: number = 1): number {
    if (this.allocation.stablecoinBalance <= 0) return 0;

    const hourlyRate = this.allocation.stablecoinYieldAPR / (365 * 24);
    const yield_ = this.allocation.stablecoinBalance * hourlyRate * periodHours;

    this.allocation.accruedStablecoinYield += yield_;

    // Add yield to NAV
    if (this.state.totalShares > 0) {
      this.state.nav += yield_ / this.state.totalShares;
    }

    return yield_;
  }

  /**
   * Get the effective capital deployed in DN positions (after stablecoin parking).
   */
  getEffectiveDNCapital(): number {
    const aum = this.state.totalShares * this.state.nav;
    return aum * this.allocation.dnAllocationPct;
  }

  /**
   * Get allocation state for display.
   */
  getAllocationState(): AllocationState {
    return { ...this.allocation };
  }

  /**
   * Get allocation change history.
   */
  getAllocationEvents(): AllocationEvent[] {
    return this.allocationEvents;
  }
}
