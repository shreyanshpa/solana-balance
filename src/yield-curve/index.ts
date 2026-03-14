/**
 * PacificaYield — Entry Point
 *
 * Demonstrates the full Funding Rate Yield Curve + Rate Swap Market system.
 *
 * Usage: bun run src/yield-curve/index.ts [--testnet] [--symbol BTC-PERP]
 */

import { PacificaClient } from "../common/pacifica-client";
import { annualizeFundingRate } from "../common/math";
import { YieldCurveEngine } from "./engine";
import { RateSwapMarket } from "./rate-swap";
import { FundingRatePredictor } from "./predictor";

// ============================================================
// Demo Data Generator (for when API is unavailable)
// ============================================================

function generateDemoFundingData(): Map<string, Array<{ rate: number; timestamp: number }>> {
  const data = new Map<string, Array<{ rate: number; timestamp: number }>>();
  const now = Date.now();
  const hourMs = 3600 * 1000;

  // Generate 30 days of hourly funding rates for major assets
  const assets: Record<string, { baseRate: number; volatility: number; trend: number }> = {
    "BTC-PERP": { baseRate: 0.0001, volatility: 0.00008, trend: 0.000001 },
    "ETH-PERP": { baseRate: 0.00015, volatility: 0.0001, trend: 0.0000015 },
    "SOL-PERP": { baseRate: 0.0002, volatility: 0.00015, trend: 0.000002 },
    "WIF-PERP": { baseRate: 0.0004, volatility: 0.0003, trend: -0.000001 },
    "JUP-PERP": { baseRate: 0.00012, volatility: 0.00012, trend: 0.0000008 },
    "BONK-PERP": { baseRate: 0.0005, volatility: 0.0004, trend: -0.000002 },
    "JTO-PERP": { baseRate: 0.00008, volatility: 0.00006, trend: 0.0000005 },
    "PYTH-PERP": { baseRate: 0.00018, volatility: 0.00014, trend: 0.000001 },
  };

  for (const [symbol, params] of Object.entries(assets)) {
    const rates: Array<{ rate: number; timestamp: number }> = [];

    for (let h = 720; h >= 0; h--) {
      // Mean-reverting process with trend
      const noise = (Math.random() - 0.5) * 2 * params.volatility;
      const trendComponent = params.trend * (720 - h);
      const meanReversion = -0.02 * ((rates.length > 0 ? rates[rates.length - 1].rate : params.baseRate) - params.baseRate);

      const prevRate = rates.length > 0 ? rates[rates.length - 1].rate : params.baseRate;
      const newRate = prevRate + noise + trendComponent / 720 + meanReversion;

      rates.push({
        rate: newRate,
        timestamp: now - h * hourMs,
      });
    }

    data.set(symbol, rates);
  }

  return data;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const useTestnet = args.includes("--testnet");
  const symbolIdx = args.indexOf("--symbol");
  const focusSymbol = symbolIdx >= 0 ? args[symbolIdx + 1] : undefined;
  const useLive = args.includes("--live");

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║          PACIFICA YIELD — Funding Rate Yield Curve        ║");
  console.log("║              + Interest Rate Swap Market                  ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log();

  const client = new PacificaClient({ testnet: useTestnet });
  const engine = new YieldCurveEngine(client);

  // ---- Step 1: Collect Funding Data ----
  if (useLive) {
    console.log(`Mode: LIVE (${useTestnet ? "testnet" : "mainnet"})`);
    if (focusSymbol) {
      await engine.collectFundingData(focusSymbol);
    } else {
      await engine.collectAllMarkets();
    }
  } else {
    console.log("Mode: DEMO (simulated data)");
    console.log("Use --live flag to fetch real Pacifica data\n");

    // Load demo data directly into engine
    const demoData = generateDemoFundingData();
    for (const [symbol, rates] of demoData) {
      const points = rates.map((r) => ({
        symbol,
        rate: r.rate,
        annualizedRate: annualizeFundingRate(r.rate),
        timestamp: r.timestamp,
      }));
      engine.loadFundingData(symbol, points);
    }
  }

  // ---- Step 2: Build Yield Curves ----
  console.log("\n━━━ BUILDING YIELD CURVES ━━━\n");
  engine.buildAllCurves();

  const curves = engine.getAllCurves();
  for (const [symbol, curve] of curves) {
    console.log(`\n📈 ${symbol} Yield Curve:`);
    console.log(`  ${"Tenor".padEnd(8)} ${"Avg Rate".padEnd(14)} ${"Annualized".padEnd(14)} Samples`);
    console.log(`  ${"-".repeat(50)}`);
    for (const point of curve.curve) {
      const rateStr = (point.averageRate * 100).toFixed(4) + "%";
      const annStr = (point.annualizedRate * 100).toFixed(2) + "%";
      console.log(
        `  ${point.horizon.padEnd(8)} ${rateStr.padStart(10)}     ${annStr.padStart(10)}     ${point.sampleCount}`
      );
    }

    // Curve shape analysis
    const shape = engine.analyzeCurveShape(symbol);
    if (shape) {
      console.log(`  Shape: ${shape.type.toUpperCase()} (steepness: ${shape.steepness.toFixed(0)}bps)`);
      console.log(`  ${shape.description}`);
    }
  }

  // ---- Step 3: Cross-Asset Spreads ----
  console.log("\n\n━━━ CROSS-ASSET FUNDING RATE SPREADS (24h) ━━━\n");
  const spreads = engine.computeCrossAssetSpreads("24h");
  const topSpreads = spreads.slice(0, 10);

  console.log(`${"Pair".padEnd(30)} ${"Spread".padEnd(12)} Signal`);
  console.log("-".repeat(65));
  for (const s of topSpreads) {
    const spreadStr = `${s.spreadBps > 0 ? "+" : ""}${s.spreadBps}bps`;
    console.log(
      `${(s.assetA + " / " + s.assetB).padEnd(30)} ${spreadStr.padEnd(12)} ${s.signal}`
    );
  }

  // ---- Step 4: Extreme Rate Detection ----
  console.log("\n\n━━━ EXTREME FUNDING RATES (Z-SCORE ALERTS) ━━━\n");
  const extremes = engine.findExtremeRates(1.5);

  if (extremes.length === 0) {
    console.log("No extreme funding rates detected (all within 1.5 std dev).");
  } else {
    for (const e of extremes) {
      const rateStr = `${e.annualizedRate > 0 ? "+" : ""}${(e.annualizedRate * 100).toFixed(1)}%`;
      console.log(`⚠️  ${e.symbol}: z-score=${e.zScore} (${rateStr} annualized)`);
      console.log(`   ${e.signal}\n`);
    }
  }

  // ---- Step 5: Rate Swap Market ----
  console.log("\n━━━ FUNDING RATE SWAP MARKET ━━━\n");
  const swapMarket = new RateSwapMarket(engine, 100);

  // Show quote sheets for top assets
  const quoteAssets = focusSymbol ? [focusSymbol] : ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
  for (const symbol of quoteAssets) {
    console.log(swapMarket.formatQuoteSheet(symbol));
    console.log();
  }

  // ---- Step 6: Demo Swap Execution ----
  console.log("\n━━━ DEMO: SWAP EXECUTION ━━━\n");

  const demoSwap = swapMarket.executeSwap("SOL-PERP", "7d", 100000, "pay_fixed");
  if (demoSwap) {
    console.log(`Executed swap: ${demoSwap.id}`);
    console.log(`  Direction: PAY FIXED ${(demoSwap.fixedRate * 100).toFixed(2)}%`);
    console.log(`  Notional: $${demoSwap.notional.toLocaleString()}`);
    console.log(`  Maturity: ${new Date(demoSwap.maturityTime).toISOString()}`);
    console.log(`  Thesis: Betting that realized funding > ${(demoSwap.fixedRate * 100).toFixed(2)}%`);

    // Mark to market
    const mtm = swapMarket.markToMarket(demoSwap.id);
    if (mtm) {
      console.log(`\n  Mark-to-Market:`);
      console.log(`    Current floating rate: ${(mtm.currentFloating * 100).toFixed(2)}%`);
      console.log(`    Unrealized P&L: $${mtm.unrealizedPnl.toFixed(2)}`);
    }
  }

  // ---- Step 7: Funding Rate Predictions (OU Model + Forward Curves) ----
  console.log("\n\n━━━ FUNDING RATE PREDICTIONS ━━━\n");

  const predictor = new FundingRatePredictor();
  // Build a Map from engine's funding history
  const allHistory = new Map<string, any[]>();
  for (const symbol of engine.getAllCurves().keys()) {
    allHistory.set(symbol, engine.getFundingHistory(symbol));
  }
  predictor.loadData(allHistory, engine.getAllCurves());

  const predictionAssets = focusSymbol ? [focusSymbol] : ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
  for (const symbol of predictionAssets) {
    const prediction = predictor.predict(symbol);
    if (prediction) {
      console.log(predictor.formatReport(prediction));
      console.log();
    }
  }

  // Show forward rate curve
  console.log("━━━ FORWARD RATE CURVES ━━━\n");
  for (const symbol of predictionAssets) {
    const forwards = predictor.extractForwardRates(symbol);
    if (forwards.length > 0) {
      console.log(`${symbol} implied forward rates:`);
      for (const f of forwards) {
        const sign = f.forwardRate >= 0 ? "+" : "";
        console.log(`  ${f.startHorizon} → ${f.endHorizon}: ${sign}${(f.forwardRate * 100).toFixed(2)}% annualized`);
      }
      console.log();
    }
  }

  // ---- Step 8: Full Report ----
  console.log("\n━━━ FULL REPORT SUMMARY ━━━\n");
  const report = engine.generateReport();
  console.log(report.summary);

  console.log("\n\n✅ PacificaYield demo complete.");
  console.log("In production, this runs continuously with WebSocket feeds and on-chain settlement.");
}

main().catch(console.error);
