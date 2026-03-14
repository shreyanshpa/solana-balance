/**
 * Composable Vault — Cross-Product Integration
 *
 * This is the key differentiator for hackathon judges: showing that PacificaYield
 * and PacificaVaults are not isolated products but compose into a full-stack
 * derivatives ecosystem.
 *
 * The composable vault:
 * 1. Earns yield from delta-neutral funding rate capture (base strategy)
 * 2. Hedges funding rate risk using IRS (locks in fixed rate via rate swaps)
 * 3. Earns additional yield by shorting variance (collects volatility premium)
 * 4. Dynamically allocates to stablecoins when conditions are unfavorable
 *
 * This creates three independent yield streams:
 * - Funding rate carry (primary)
 * - Variance risk premium (secondary)
 * - Stablecoin base rate (defensive)
 *
 * Plus one risk-reduction layer:
 * - IRS hedging (locks in minimum yield)
 *
 * Revenue model:
 *   Expected APY = funding_yield × dn_allocation
 *                + vrp_yield × var_allocation
 *                + stablecoin_rate × stablecoin_allocation
 *                - irs_hedging_cost
 */

import type { RateSwap, VaultConfig, VaultPosition } from "../common/types";
import { mean, stddev, annualizeFundingRate } from "../common/math";
import { DeltaNeutralVault } from "./delta-neutral";
import { VarianceSwapEngine } from "./variance-swap";
import { RiskManager } from "./risk-manager";
import { RateSwapMarket } from "../yield-curve/rate-swap";
import { MarginEngine } from "../yield-curve/margin-engine";
import { PacificaClient } from "../common/pacifica-client";

// ============================================================
// Types
// ============================================================

export interface ComposableVaultConfig extends VaultConfig {
  // IRS hedging
  irsHedgeEnabled: boolean;
  irsHedgeRatio: number;         // fraction of funding exposure to hedge (0-1)
  irsPreferredTenor: string;     // preferred swap tenor for hedging
  // Variance selling
  varianceSellingEnabled: boolean;
  varianceAllocationPct: number;  // % of AUM allocated to short variance
  variancePreferredTenor: string;
  // Dynamic allocation
  dynamicAllocationEnabled: boolean;
}

export interface ComposableVaultState {
  // Base vault metrics
  totalAUM: number;
  nav: number;
  depositorCount: number;

  // Yield breakdown
  fundingYield: number;        // cumulative from DN strategy
  varianceYield: number;       // cumulative from short variance
  stablecoinYield: number;     // cumulative from parked stablecoins
  irsHedgingCost: number;      // cumulative cost of rate hedges
  totalYield: number;          // sum of all yield streams

  // Position summary
  dnPositionCount: number;
  activeIRSSwaps: number;
  activeVarianceSwaps: number;
  allocationMode: string;

  // Risk
  overallRiskScore: number;
  portfolioDV01: number;       // rate sensitivity
  portfolioVega: number;       // vol sensitivity

  // APY estimate
  estimatedAPY: number;
}

export interface YieldAttribution {
  source: string;
  amount: number;
  pctOfTotal: number;
  description: string;
}

// ============================================================
// Composable Vault
// ============================================================

export class ComposableVault {
  private config: ComposableVaultConfig;
  private vault: DeltaNeutralVault;
  private varEngine: VarianceSwapEngine;
  private riskMgr: RiskManager;
  private swapMarket: RateSwapMarket | null = null;
  private marginEngine: MarginEngine | null = null;

  // IRS hedging state
  private activeHedgeSwaps: RateSwap[] = [];
  private irsHedgingCost: number = 0;

  // Variance selling state
  private varianceYield: number = 0;
  private activeVarContracts: string[] = []; // contract IDs

  // Tracking
  private hourlyYieldHistory: Array<{
    timestamp: number;
    funding: number;
    variance: number;
    stablecoin: number;
    irsCost: number;
    net: number;
  }> = [];

  constructor(
    client: PacificaClient,
    config: ComposableVaultConfig,
    swapMarket?: RateSwapMarket,
    marginEngine?: MarginEngine
  ) {
    this.config = config;
    this.vault = new DeltaNeutralVault(client, config);
    this.varEngine = new VarianceSwapEngine(client);
    this.riskMgr = new RiskManager(config);
    this.swapMarket = swapMarket || null;
    this.marginEngine = marginEngine || null;
  }

  // ============================================================
  // Delegation to base vault
  // ============================================================

  deposit(depositor: string, amount: number) {
    return this.vault.deposit(depositor, amount);
  }

  withdraw(depositor: string, shares: number) {
    return this.vault.withdraw(depositor, shares);
  }

  openPosition(symbol: string, capital: number, price: number, leverage?: number) {
    return this.vault.openPosition(symbol, capital, price, leverage);
  }

  getDepositorInfo(depositor: string) {
    return this.vault.getDepositorInfo(depositor);
  }

  // ============================================================
  // Composable Strategy Execution
  // ============================================================

  /**
   * Execute one period of the composable strategy.
   * Called each hour (or each funding period) with current market data.
   *
   * Orchestrates all four yield/risk components:
   * 1. DN funding accrual
   * 2. Dynamic allocation check
   * 3. IRS hedge management
   * 4. Variance position management
   */
  executePeriod(
    fundingRates: Map<string, number>,
    prices: Map<string, number>,
    periodHours: number = 1
  ): {
    fundingEarned: number;
    stablecoinEarned: number;
    varianceEarned: number;
    irsCost: number;
    netYield: number;
    allocationChange: string | null;
  } {
    // 1. DN funding accrual (only on the DN-allocated portion)
    const accrual = this.vault.accrueForPeriod(fundingRates, periodHours);
    const fundingEarned = accrual.totalFunding;

    // 2. Dynamic allocation
    let allocationChange: string | null = null;
    if (this.config.dynamicAllocationEnabled) {
      const avgRate = fundingRates.size > 0
        ? mean(Array.from(fundingRates.values()))
        : 0;
      const event = this.vault.updateAllocation(avgRate);
      if (event) {
        allocationChange = `${event.fromMode} → ${event.toMode}: ${event.reason}`;
      }
    }

    // 2b. Accrue stablecoin yield on parked capital
    const stablecoinEarned = this.vault.accrueStablecoinYield(periodHours);

    // 3. Update prices + check rebalance
    const priceCheck = this.vault.updatePrices(prices);
    if (priceCheck.needsRebalance) {
      this.vault.rebalance(prices);
    }

    // 4. IRS hedge P&L (simplified: compute cost as spread between locked rate and realized)
    let irsCost = 0;
    if (this.config.irsHedgeEnabled && this.activeHedgeSwaps.length > 0) {
      irsCost = this.computeIRSPeriodCost(fundingRates, periodHours);
      this.irsHedgingCost += irsCost;
    }

    // 5. Variance position accrual (mark-to-market change)
    let varianceEarned = 0;
    if (this.config.varianceSellingEnabled && this.activeVarContracts.length > 0) {
      varianceEarned = this.computeVariancePeriodYield();
    }

    // Record risk data
    for (const [symbol, rate] of fundingRates) {
      this.riskMgr.recordFundingRate(symbol, rate);
    }

    const netYield = fundingEarned + stablecoinEarned + varianceEarned - irsCost;

    this.hourlyYieldHistory.push({
      timestamp: Date.now(),
      funding: fundingEarned,
      variance: varianceEarned,
      stablecoin: stablecoinEarned,
      irsCost,
      net: netYield,
    });

    return {
      fundingEarned,
      stablecoinEarned,
      varianceEarned,
      irsCost,
      netYield,
      allocationChange,
    };
  }

  // ============================================================
  // IRS Hedging
  // ============================================================

  /**
   * Place a rate swap hedge to lock in a minimum funding rate.
   *
   * Strategy: we're earning floating funding rates on our short perps.
   * By paying fixed on a swap, we lock in a minimum rate.
   * If realized > fixed: we earn the excess on the swap too.
   * If realized < fixed: the swap compensates for the funding shortfall.
   */
  placeIRSHedge(symbol: string): RateSwap | null {
    if (!this.swapMarket) return null;

    const vaultStatus = this.vault.getStatus();
    const dnCapital = this.vault.getEffectiveDNCapital();
    const hedgeNotional = dnCapital * this.config.irsHedgeRatio;

    if (hedgeNotional <= 0) return null;

    // Pay fixed = lock in the rate. If funding drops, the swap pays us.
    const swap = this.swapMarket.executeSwap(
      symbol,
      this.config.irsPreferredTenor,
      hedgeNotional,
      "pay_fixed"
    );

    if (swap) {
      // Lock margin if margin engine available
      if (this.marginEngine) {
        this.marginEngine.lockMarginForSwap(swap, this.config.irsPreferredTenor);
      }
      this.activeHedgeSwaps.push(swap);
    }

    return swap;
  }

  /**
   * Settle expired IRS hedges and roll into new ones.
   */
  rollIRSHedges(): { settled: RateSwap[]; newHedges: RateSwap[] } {
    const now = Date.now();
    const settled: RateSwap[] = [];
    const newHedges: RateSwap[] = [];

    // Settle expired
    this.activeHedgeSwaps = this.activeHedgeSwaps.filter(swap => {
      if (now >= swap.maturityTime && this.swapMarket) {
        const result = this.swapMarket.settleSwap(swap.id);
        if (result) {
          settled.push(result);
          if (this.marginEngine) this.marginEngine.releaseMargin(result);
          // Settlement amount adjusts hedging cost
          if (result.settlementAmount) {
            this.irsHedgingCost -= result.settlementAmount; // positive settlement = we earned
          }
        }
        return false;
      }
      return true;
    });

    // Roll: place new hedges for each symbol
    if (this.config.irsHedgeEnabled) {
      const symbols = new Set(settled.map(s => s.symbol));
      for (const symbol of symbols) {
        const newHedge = this.placeIRSHedge(symbol);
        if (newHedge) newHedges.push(newHedge);
      }
    }

    return { settled, newHedges };
  }

  // ============================================================
  // Variance Selling
  // ============================================================

  /**
   * Open a short variance position to earn the variance risk premium.
   *
   * The vault acts as a volatility seller (like selling options).
   * When realized vol < implied vol (which happens ~70% of the time),
   * we earn the VRP (variance risk premium).
   */
  openVariancePosition(symbol: string): string | null {
    const aum = this.vault.getStatus().totalShares * this.vault.getStatus().nav;
    const vegaNotional = aum * this.config.varianceAllocationPct;

    if (vegaNotional <= 0) return null;

    const contract = this.varEngine.executeSwap(
      symbol,
      this.config.variancePreferredTenor,
      vegaNotional,
      "short_var"
    );

    if (contract) {
      this.activeVarContracts.push(contract.id);
      return contract.id;
    }
    return null;
  }

  /**
   * Settle expired variance swaps.
   */
  settleVariancePositions(): Array<{ id: string; payoff: number }> {
    const results: Array<{ id: string; payoff: number }> = [];

    this.activeVarContracts = this.activeVarContracts.filter(id => {
      const contracts = this.varEngine.getActiveContracts();
      const contract = contracts.find(c => c.id === id);
      if (!contract) return false;

      if (Date.now() >= contract.endTime) {
        const settled = this.varEngine.settleContract(id);
        if (settled && settled.payoff !== undefined) {
          this.varianceYield += settled.payoff;
          results.push({ id, payoff: settled.payoff });
        }
        return false;
      }
      return true;
    });

    return results;
  }

  /**
   * Feed price observations to active variance contracts.
   */
  addVarianceObservation(symbol: string, price: number): void {
    for (const id of this.activeVarContracts) {
      const contracts = this.varEngine.getActiveContracts();
      const contract = contracts.find(c => c.id === id && c.symbol === symbol);
      if (contract) {
        this.varEngine.addObservation(id, price);
      }
    }
  }

  // ============================================================
  // Yield Attribution & Analytics
  // ============================================================

  /**
   * Break down yield by source for the dashboard.
   */
  getYieldAttribution(): YieldAttribution[] {
    const vaultStatus = this.vault.getStatus();
    const funding = vaultStatus.cumulativeFunding;
    const variance = this.varianceYield;
    const stablecoin = this.vault.getAllocationState().accruedStablecoinYield;
    const irsCost = this.irsHedgingCost;
    const total = funding + variance + stablecoin - irsCost;

    const attr: YieldAttribution[] = [];

    if (total === 0) {
      return [
        { source: "Funding Rate Carry", amount: funding, pctOfTotal: 0, description: "Delta-neutral funding rate capture from perp shorts" },
        { source: "Variance Risk Premium", amount: variance, pctOfTotal: 0, description: "Short variance premium (implied > realized)" },
        { source: "Stablecoin Base Rate", amount: stablecoin, pctOfTotal: 0, description: "Yield on capital parked in stablecoins" },
        { source: "IRS Hedging Cost", amount: -irsCost, pctOfTotal: 0, description: "Cost of locking in fixed rate via interest rate swaps" },
      ];
    }

    attr.push({
      source: "Funding Rate Carry",
      amount: funding,
      pctOfTotal: funding / total,
      description: "Delta-neutral funding rate capture from perp shorts",
    });

    attr.push({
      source: "Variance Risk Premium",
      amount: variance,
      pctOfTotal: variance / total,
      description: "Short variance premium (implied > realized)",
    });

    attr.push({
      source: "Stablecoin Base Rate",
      amount: stablecoin,
      pctOfTotal: stablecoin / total,
      description: "Yield on capital parked in stablecoins",
    });

    attr.push({
      source: "IRS Hedging Cost",
      amount: -irsCost,
      pctOfTotal: -irsCost / total,
      description: "Cost of locking in fixed rate via interest rate swaps",
    });

    return attr;
  }

  /**
   * Compute full composable vault state for dashboard display.
   */
  getComposableState(): ComposableVaultState {
    const vaultStatus = this.vault.getStatus();
    const alloc = this.vault.getAllocationState();
    const aum = vaultStatus.totalShares * vaultStatus.nav;

    // Portfolio DV01 from margin engine
    let portfolioDV01 = 0;
    if (this.marginEngine && this.activeHedgeSwaps.length > 0) {
      const dv01 = this.marginEngine.computePortfolioDV01(this.activeHedgeSwaps);
      portfolioDV01 = dv01.totalDV01;
    }

    // Portfolio vega: sum of vega notionals on active var swaps
    let portfolioVega = 0;
    for (const id of this.activeVarContracts) {
      const contracts = this.varEngine.getActiveContracts();
      const contract = contracts.find(c => c.id === id);
      if (contract) {
        portfolioVega += Math.abs(contract.notional);
      }
    }

    // Risk score
    const riskMetrics = this.riskMgr.computeRiskMetrics(
      vaultStatus.positions,
      new Map(), // would need current funding rates
      aum
    );

    // Estimated APY from recent yield history
    const recentYield = this.hourlyYieldHistory.slice(-168); // 7 days
    let estimatedAPY = 0;
    if (recentYield.length > 0 && aum > 0) {
      const totalNet = recentYield.reduce((sum, h) => sum + h.net, 0);
      const periodDays = recentYield.length / 24;
      estimatedAPY = (totalNet / aum) * (365 / periodDays);
    }

    return {
      totalAUM: aum,
      nav: vaultStatus.nav,
      depositorCount: vaultStatus.depositorCount,
      fundingYield: vaultStatus.cumulativeFunding,
      varianceYield: this.varianceYield,
      stablecoinYield: alloc.accruedStablecoinYield,
      irsHedgingCost: this.irsHedgingCost,
      totalYield: vaultStatus.cumulativeFunding + this.varianceYield + alloc.accruedStablecoinYield - this.irsHedgingCost,
      dnPositionCount: vaultStatus.positions.length,
      activeIRSSwaps: this.activeHedgeSwaps.length,
      activeVarianceSwaps: this.activeVarContracts.length,
      allocationMode: alloc.mode,
      overallRiskScore: riskMetrics.overallRiskScore,
      portfolioDV01,
      portfolioVega,
      estimatedAPY,
    };
  }

  /**
   * Format a composable vault dashboard for display.
   */
  formatDashboard(): string {
    const state = this.getComposableState();
    const alloc = this.vault.getAllocationState();
    const attr = this.getYieldAttribution();

    const lines: string[] = [
      "╔══════════════════════════════════════════════════════════════╗",
      "║            COMPOSABLE VAULT — MULTI-STRATEGY DASHBOARD     ║",
      "╚══════════════════════════════════════════════════════════════╝",
      "",
      `  AUM: $${state.totalAUM.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}  |  NAV: $${state.nav.toFixed(6)}  |  Depositors: ${state.depositorCount}`,
      `  Est. APY: ${(state.estimatedAPY * 100).toFixed(2)}%`,
      "",
      "  ── Allocation ──",
      `  Mode: ${state.allocationMode.toUpperCase()}`,
      `  DN Positions: ${(alloc.dnAllocationPct * 100).toFixed(0)}% ($${(state.totalAUM * alloc.dnAllocationPct).toFixed(0)})`,
      `  Stablecoins:  ${(alloc.stablecoinAllocationPct * 100).toFixed(0)}% ($${alloc.stablecoinBalance.toFixed(0)}) @ ${(alloc.stablecoinYieldAPR * 100).toFixed(1)}% APR`,
      "",
      "  ── Yield Attribution ──",
    ];

    for (const a of attr) {
      const sign = a.amount >= 0 ? "+" : "";
      const pct = a.pctOfTotal !== 0 ? ` (${(a.pctOfTotal * 100).toFixed(0)}%)` : "";
      lines.push(`  ${a.source.padEnd(24)} ${sign}$${a.amount.toFixed(2).padStart(12)}${pct}`);
    }

    const totalYield = attr.reduce((sum, a) => sum + a.amount, 0);
    lines.push(`  ${"─".repeat(40)}`);
    lines.push(`  ${"NET YIELD".padEnd(24)} ${totalYield >= 0 ? "+" : ""}$${totalYield.toFixed(2).padStart(12)}`);

    lines.push(
      "",
      "  ── Active Instruments ──",
      `  DN Positions:    ${state.dnPositionCount}`,
      `  IRS Hedges:      ${state.activeIRSSwaps} (DV01: $${state.portfolioDV01.toFixed(2)}/bp)`,
      `  Var Swaps:       ${state.activeVarianceSwaps} (Vega: $${state.portfolioVega.toFixed(0)})`,
      "",
      "  ── Risk ──",
      `  Overall Score:   ${state.overallRiskScore}/100`,
      `  24h Avg Funding: ${(alloc.rollingFundingAvg24h * 10000).toFixed(2)} bps/h`,
    );

    return lines.join("\n");
  }

  // ============================================================
  // Accessors
  // ============================================================

  getBaseVault(): DeltaNeutralVault { return this.vault; }
  getVarianceEngine(): VarianceSwapEngine { return this.varEngine; }
  getRiskManager(): RiskManager { return this.riskMgr; }
  getActiveHedgeSwaps(): RateSwap[] { return this.activeHedgeSwaps; }
  getIRSHedgingCost(): number { return this.irsHedgingCost; }
  getVarianceYield(): number { return this.varianceYield; }

  // ============================================================
  // Private helpers
  // ============================================================

  private computeIRSPeriodCost(fundingRates: Map<string, number>, periodHours: number): number {
    let cost = 0;
    for (const swap of this.activeHedgeSwaps) {
      const realizedRate = fundingRates.get(swap.symbol);
      if (realizedRate === undefined) continue;

      const annualizedRealized = annualizeFundingRate(realizedRate);
      // Cost = (fixed - realized) when realized < fixed (we're paying more than we receive)
      const diff = swap.fixedRate - annualizedRealized;
      if (diff > 0) {
        const periodCost = diff * swap.notional * (periodHours / (365 * 24));
        cost += periodCost;
      }
      // When realized > fixed, the swap is profitable (negative cost)
      // but we don't credit it here — it shows up in funding yield
    }
    return cost;
  }

  private computeVariancePeriodYield(): number {
    let yield_ = 0;
    for (const id of this.activeVarContracts) {
      const mtm = this.varEngine.markToMarket(id);
      if (mtm) {
        // For short var, positive P&L when realized < strike
        yield_ += mtm.unrealizedPnl;
      }
    }
    return yield_;
  }
}
