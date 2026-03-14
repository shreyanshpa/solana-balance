/**
 * PacificaVaults — Entry Point
 *
 * Demonstrates the Delta-Neutral Vault + Variance Swap system.
 *
 * Usage: bun run src/vaults/index.ts [--testnet] [--live]
 */

import { PacificaClient } from "../common/pacifica-client";
import { DeltaNeutralVault } from "./delta-neutral";
import { VarianceSwapEngine } from "./variance-swap";
import { RiskManager } from "./risk-manager";
import type { VaultConfig } from "../common/types";

// ============================================================
// Simulation Helpers
// ============================================================

function simulateFundingRates(
  symbols: string[],
  hours: number
): Array<Map<string, number>> {
  const rates: Array<Map<string, number>> = [];
  const baseRates: Record<string, number> = {
    "BTC-PERP": 0.0001,
    "ETH-PERP": 0.00015,
    "SOL-PERP": 0.0002,
  };

  for (let h = 0; h < hours; h++) {
    const hourlyRates = new Map<string, number>();
    for (const symbol of symbols) {
      const base = baseRates[symbol] || 0.0001;
      // Mean-reverting funding rate with noise
      const noise = (Math.random() - 0.5) * base * 2;
      const rate = base + noise;
      hourlyRates.set(symbol, rate);
    }
    rates.push(hourlyRates);
  }
  return rates;
}

function simulatePrices(
  symbols: string[],
  startPrices: Record<string, number>,
  hours: number
): Array<Map<string, number>> {
  const prices: Array<Map<string, number>> = [];
  const currentPrices = { ...startPrices };
  const vols: Record<string, number> = {
    "BTC-PERP": 0.45,
    "ETH-PERP": 0.55,
    "SOL-PERP": 0.70,
  };

  for (let h = 0; h < hours; h++) {
    const hourlyPrices = new Map<string, number>();
    for (const symbol of symbols) {
      const annualVol = vols[symbol] || 0.55;
      const hourlyVol = annualVol / Math.sqrt(365 * 24);
      // Standard GBM: use Box-Muller for normal random
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const ret = -0.5 * hourlyVol * hourlyVol + hourlyVol * z;
      currentPrices[symbol] *= Math.exp(ret);
      hourlyPrices.set(symbol, currentPrices[symbol]);
    }
    prices.push(hourlyPrices);
  }
  return prices;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const useLive = args.includes("--live");

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       PACIFICA VAULTS — Delta-Neutral Yield Vault        ║");
  console.log("║              + Variance Swap Engine                      ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log();

  const client = new PacificaClient({ testnet: true });
  const symbols = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
  const startPrices: Record<string, number> = {
    "BTC-PERP": 95000,
    "ETH-PERP": 3400,
    "SOL-PERP": 180,
  };

  // ================================================================
  // PART 1: Delta-Neutral Vault
  // ================================================================

  console.log("━━━ PART 1: DELTA-NEUTRAL YIELD VAULT ━━━\n");

  const vaultConfig: VaultConfig = {
    name: "Pacifica DN Yield Vault",
    strategy: "delta_neutral",
    targetAssets: symbols,
    maxLeverage: 3,
    rebalanceThresholdPct: 20, // rebalance when leverage drifts >20%
    maxDrawdownPct: 15,
  };

  const vault = new DeltaNeutralVault(client, vaultConfig);

  // --- Deposits ---
  console.log("📥 Simulating deposits...\n");

  const depositors = [
    { name: "Alice", amount: 50000 },
    { name: "Bob", amount: 100000 },
    { name: "Charlie", amount: 25000 },
    { name: "DeFiWhale", amount: 500000 },
  ];

  for (const d of depositors) {
    const result = vault.deposit(d.name, d.amount);
    console.log(
      `  ${d.name}: deposited $${d.amount.toLocaleString()} → ${result.shares.toFixed(2)} shares @ $${result.nav.toFixed(4)}/share`
    );
  }

  const totalDeposited = depositors.reduce((sum, d) => sum + d.amount, 0);
  console.log(`\n  Total TVL: $${totalDeposited.toLocaleString()}`);

  // --- Open Positions ---
  console.log("\n📊 Opening delta-neutral positions...\n");

  const allocations: Record<string, number> = {
    "BTC-PERP": 0.50, // 50% of capital to BTC
    "ETH-PERP": 0.30, // 30% to ETH
    "SOL-PERP": 0.20, // 20% to SOL
  };

  for (const [symbol, pct] of Object.entries(allocations)) {
    const capital = totalDeposited * pct;
    const position = vault.openPosition(symbol, capital, startPrices[symbol], 2);
    console.log(
      `  ${symbol}: $${capital.toLocaleString()} allocated → ${position.size.toFixed(4)} units short @ $${position.entryPrice.toLocaleString()} (${position.leverage}x leverage)`
    );
  }

  // --- Simulate 7 Days of Funding + Price Action ---
  console.log("\n⏳ Simulating 7 days of funding accrual + price changes...\n");

  const simHours = 168; // 7 days
  const fundingRatesHistory = simulateFundingRates(symbols, simHours);
  const priceHistory = simulatePrices(symbols, startPrices, simHours);
  let totalFundingEarned = 0;
  let rebalanceCount = 0;

  for (let h = 0; h < simHours; h++) {
    // Accrue funding
    const accrual = vault.accrueForPeriod(fundingRatesHistory[h], 1);
    totalFundingEarned += accrual.totalFunding;

    // Update prices
    const priceCheck = vault.updatePrices(priceHistory[h]);

    // Rebalance if needed
    if (priceCheck.needsRebalance) {
      const events = vault.rebalance(priceHistory[h]);
      rebalanceCount += events.length;
    }

    // Daily NAV snapshot
    if (h % 24 === 0) {
      vault.snapshotNav();
    }
  }

  // --- Results ---
  console.log("  Simulation complete!\n");
  const status = vault.getStatus();

  console.log("  📈 Vault Performance:");
  console.log(`     NAV per share:     $${status.nav.toFixed(6)}`);
  console.log(`     Total funding:     $${status.fundingEarned.toFixed(2)}`);
  console.log(`     Position P&L:      $${status.pnl.toFixed(2)}`);
  console.log(`     Fees collected:    $${status.totalFees.toFixed(2)}`);
  console.log(`     Rebalances:        ${rebalanceCount}`);
  console.log(`     High water mark:   $${status.highWaterMark.toFixed(6)}`);
  // Compute APY from funding earned over simulated period
  const fundingAPY = (status.fundingEarned / totalDeposited) * (365 / 7) * 100;
  console.log(`     Estimated APY:     ${fundingAPY.toFixed(2)}% (from funding rate capture)`);
  console.log(`     Depositors:        ${status.depositorCount}`);

  // Individual depositor P&L
  console.log("\n  👤 Depositor Returns:");
  for (const d of depositors) {
    const info = vault.getDepositorInfo(d.name);
    if (info) {
      console.log(
        `     ${d.name.padEnd(12)} $${info.currentValue.toFixed(2).padStart(12)} (${info.pnl >= 0 ? "+" : ""}${info.pnl.toFixed(2)}, ${(info.pnlPct * 100).toFixed(2)}%)`
      );
    }
  }

  // --- Withdrawal Demo ---
  console.log("\n  💸 Withdrawal demo:");
  const aliceInfo = vault.getDepositorInfo("Alice");
  if (aliceInfo && aliceInfo.shares > 0) {
    const halfShares = aliceInfo.shares / 2;
    const withdrawal = vault.withdraw("Alice", halfShares);
    console.log(
      `     Alice withdraws ${halfShares.toFixed(2)} shares → $${withdrawal.amount.toFixed(2)} (fee: $${withdrawal.fee.toFixed(2)})`
    );
  }

  // ================================================================
  // PART 1.5: Risk Management
  // ================================================================

  console.log("\n\n━━━ RISK MANAGEMENT ANALYSIS ━━━\n");

  const riskMgr = new RiskManager(vaultConfig);

  // Feed funding rate history into risk manager
  for (let h = 0; h < simHours; h++) {
    for (const [symbol, rate] of fundingRatesHistory[h]) {
      riskMgr.recordFundingRate(symbol, rate);
    }
  }

  // Seed reserve fund (5% of AUM in production)
  riskMgr.addToReserve(totalDeposited * 0.05);

  // Compute risk metrics using final state
  const lastPrices = priceHistory[priceHistory.length - 1];
  const lastFunding = fundingRatesHistory[fundingRatesHistory.length - 1];
  const riskMetrics = riskMgr.computeRiskMetrics(
    status.positions,
    lastFunding,
    totalDeposited
  );

  console.log("  Risk Scores (0-100, higher = more risk):");
  console.log(`     Liquidation:      ${riskMetrics.liquidationRiskScore.toFixed(0)}/100`);
  console.log(`     Funding:          ${riskMetrics.fundingRiskScore.toFixed(0)}/100`);
  console.log(`     Concentration:    ${riskMetrics.concentrationRiskScore.toFixed(0)}/100`);
  console.log(`     OVERALL:          ${riskMetrics.overallRiskScore}/100`);
  console.log();
  console.log(`  Collateral ratio:     ${(riskMetrics.totalCollateralRatio * 100).toFixed(1)}%`);
  console.log(`  Avg weighted funding: ${(riskMetrics.weightedAvgFunding * 10000).toFixed(2)} bps/h`);
  console.log(`  Max concentration:    ${(riskMetrics.maxSingleAssetPct * 100).toFixed(0)}% of AUM`);
  console.log(`  Reserve fund:         $${riskMgr.getReserveFund().toLocaleString()}`);
  console.log(`  Negative funding stress (24h): -$${riskMetrics.negativeFundingExposure.toFixed(0)}`);

  // Show per-position risk
  console.log("\n  Per-Position Risk:");
  for (const pr of riskMetrics.positions) {
    console.log(`     ${pr.symbol}:`);
    console.log(`       Margin ratio: ${(pr.marginRatio * 100).toFixed(1)}% | Dist to liq: ${(pr.distanceToLiquidation * 100).toFixed(1)}% | Funding vol: ${(pr.fundingRateVolatility * 10000).toFixed(1)}bps`);

    const delev = riskMgr.shouldDeleverage(pr);
    if (delev.deleverage) {
      console.log(`       ⚠️  ${delev.reason} (reduce by ${(delev.targetReduction * 100).toFixed(0)}%)`);
    }
  }

  // Show alerts
  const alerts = riskMgr.getAlerts();
  if (alerts.length > 0) {
    console.log("\n  Active Alerts:");
    for (const alert of alerts.slice(0, 5)) {
      const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟡" : "🔵";
      console.log(`     ${icon} [${alert.type}] ${alert.message}`);
    }
  }

  // ================================================================
  // PART 2: Variance Swap Engine
  // ================================================================

  console.log("\n\n━━━ PART 2: VARIANCE SWAP ENGINE ━━━\n");

  const varEngine = new VarianceSwapEngine(client);

  // Load simulated price data
  console.log("Loading price data...\n");
  varEngine.loadDemoPrices("BTC-PERP", 95000, 0.55, 30);
  varEngine.loadDemoPrices("ETH-PERP", 3400, 0.65, 30);
  varEngine.loadDemoPrices("SOL-PERP", 180, 0.85, 30);
  varEngine.loadDemoPrices("WIF-PERP", 2.50, 1.20, 30);
  varEngine.loadDemoPrices("BONK-PERP", 0.000025, 1.50, 30);

  // --- Vol Term Structure ---
  console.log("📊 Volatility Term Structure:\n");

  for (const symbol of ["BTC-PERP", "ETH-PERP", "SOL-PERP", "WIF-PERP"]) {
    const structure = varEngine.buildVolTermStructure(symbol);
    console.log(`  ${symbol}:`);
    console.log(`  ${"Tenor".padEnd(8)} ${"Realized".padEnd(12)} ${"Implied".padEnd(12)} ${"VRP".padEnd(10)}`);
    console.log(`  ${"-".repeat(42)}`);
    for (const s of structure) {
      console.log(
        `  ${s.tenor.padEnd(8)} ${(s.realizedVol * 100).toFixed(1).padStart(8)}%   ${(s.impliedVol * 100).toFixed(1).padStart(8)}%   ${(s.vrp * 100).toFixed(1).padStart(6)}%`
      );
    }
    console.log();
  }

  // --- Variance Swap Quotes ---
  console.log("💹 Variance Swap Quotes:\n");

  for (const symbol of ["BTC-PERP", "SOL-PERP"]) {
    console.log(`  ${symbol}:`);
    console.log(`  ${"Tenor".padEnd(8)} ${"Bid Vol".padEnd(12)} ${"Mid Vol".padEnd(12)} ${"Ask Vol".padEnd(12)} ${"Hist Vol".padEnd(12)} VRP`);
    console.log(`  ${"-".repeat(68)}`);

    for (const tenor of ["1d", "3d", "7d", "14d", "30d"]) {
      const quote = varEngine.getQuote(symbol, tenor);
      if (!quote) continue;
      console.log(
        `  ${quote.tenor.padEnd(8)} ${(quote.impliedVolBid * 100).toFixed(1).padStart(8)}%   ${(quote.midVol * 100).toFixed(1).padStart(8)}%   ${(quote.impliedVolAsk * 100).toFixed(1).padStart(8)}%   ${(quote.historicalVol * 100).toFixed(1).padStart(8)}%   ${(quote.varianceRiskPremium * 100).toFixed(1)}%`
      );
    }
    console.log();
  }

  // --- Vol Arb Opportunities ---
  console.log("🎯 Volatility Arbitrage Opportunities:\n");

  const volArbs = varEngine.findVolArbOpportunities();
  if (volArbs.length === 0) {
    console.log("  No significant VRP divergences found.\n");
  } else {
    for (const arb of volArbs.slice(0, 5)) {
      console.log(`  ${arb.symbol}:`);
      console.log(`    Realized: ${(arb.realized * 100).toFixed(1)}% | Implied: ${(arb.implied * 100).toFixed(1)}% | VRP: ${(arb.vrp * 100).toFixed(1)}%`);
      console.log(`    Signal: ${arb.signal}\n`);
    }
  }

  // --- Vol Cone ---
  console.log("📐 Volatility Cone (SOL-PERP):\n");

  const cone = varEngine.computeVolCone("SOL-PERP");
  if (cone.length > 0) {
    console.log(`  ${"Window".padEnd(8)} ${"Current".padEnd(10)} ${"P10".padEnd(10)} ${"P25".padEnd(10)} ${"P50".padEnd(10)} ${"P75".padEnd(10)} P90`);
    console.log(`  ${"-".repeat(62)}`);
    for (const c of cone) {
      console.log(
        `  ${c.window.padEnd(8)} ${(c.currentVol * 100).toFixed(1).padStart(6)}%   ${(c.p10 * 100).toFixed(1).padStart(6)}%   ${(c.p25 * 100).toFixed(1).padStart(6)}%   ${(c.p50 * 100).toFixed(1).padStart(6)}%   ${(c.p75 * 100).toFixed(1).padStart(6)}%   ${(c.p90 * 100).toFixed(1).padStart(4)}%`
      );
    }
  }

  // --- Demo: Execute and Settle Variance Swap ---
  console.log("\n\n🔄 Demo: Execute Variance Swap on SOL-PERP (7d)\n");

  const vsContract = varEngine.executeSwap("SOL-PERP", "7d", 10000, "long_var");
  if (vsContract) {
    console.log(`  Contract: ${vsContract.id}`);
    console.log(`  Direction: LONG VARIANCE (profit from high volatility)`);
    console.log(`  Strike Vol: ${(vsContract.strikeVolatility * 100).toFixed(1)}%`);
    console.log(`  Vega Notional: $${vsContract.notional.toLocaleString()}`);
    console.log(`  Period: ${vsContract.observationPeriodDays} days`);

    // Simulate observations
    const solPrices = [180, 185, 172, 190, 168, 195, 175, 188];
    for (const price of solPrices) {
      varEngine.addObservation(vsContract.id, price);
    }

    // Mark to market
    const mtm = varEngine.markToMarket(vsContract.id);
    if (mtm) {
      console.log(`\n  Mark-to-Market:`);
      console.log(`    Realized Vol: ${(mtm.currentRealizedVol * 100).toFixed(1)}%`);
      console.log(`    Strike Vol:   ${(mtm.strikeVol * 100).toFixed(1)}%`);
      console.log(`    Unrealized:   $${mtm.unrealizedPnl.toFixed(2)}`);
      console.log(`    Progress:     ${mtm.percentComplete}%`);
    }

    // Settle
    const settled = varEngine.settleContract(vsContract.id);
    if (settled) {
      console.log(`\n  Settlement:`);
      console.log(`    Final Realized Vol: ${(settled.realizedVolatility * 100).toFixed(1)}%`);
      console.log(`    Strike Vol:         ${(settled.strikeVolatility * 100).toFixed(1)}%`);
      console.log(`    Payoff:             $${settled.payoff?.toFixed(2)}`);
      console.log(`    Result:             ${(settled.payoff || 0) > 0 ? "LONG VAR WINS (vol was higher)" : "SHORT VAR WINS (vol was lower)"}`);
    }
  }

  console.log("\n\n✅ PacificaVaults demo complete.");
  console.log("In production: vaults auto-compound, variance swaps settle on-chain with oracle data.");
}

main().catch(console.error);
