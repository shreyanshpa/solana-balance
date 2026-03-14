/**
 * Quick test to verify Pacifica API connectivity.
 * Usage: bun run src/common/api-test.ts [--testnet]
 */

import { PacificaClient } from "./pacifica-client";

async function main() {
  const testnet = process.argv.includes("--testnet");
  const client = new PacificaClient({ testnet });
  const baseUrl = testnet ? "test-api.pacifica.fi" : "api.pacifica.fi";

  console.log(`Testing Pacifica API (${baseUrl})...\n`);

  // Test 1: Markets
  try {
    const markets = await client.getMarkets();
    console.log(`✅ Markets: ${markets.length} available`);
    if (markets.length > 0) {
      console.log(`   First 5: ${markets.slice(0, 5).map((m) => m.symbol).join(", ")}`);
    }
  } catch (e: any) {
    console.log(`❌ Markets: ${e.message}`);
  }

  // Test 2: Prices
  try {
    const prices = await client.getPrices();
    console.log(`✅ Prices: ${prices.length} assets`);
  } catch (e: any) {
    console.log(`❌ Prices: ${e.message}`);
  }

  // Test 3: Funding rate
  try {
    const funding = await client.getCurrentFundingRate("BTC-PERP");
    console.log(`✅ BTC-PERP funding rate: ${funding.fundingRate}`);
  } catch (e: any) {
    console.log(`❌ Funding rate: ${e.message}`);
  }

  // Test 4: Candles
  try {
    const candles = await client.getCandles("BTC-PERP", "1h", 10);
    console.log(`✅ BTC-PERP candles: ${candles.length} hourly candles`);
  } catch (e: any) {
    console.log(`❌ Candles: ${e.message}`);
  }

  // Test 5: Orderbook
  try {
    const book = await client.getOrderbook("BTC-PERP", 5);
    console.log(`✅ BTC-PERP orderbook: ${book.bids?.length || 0} bids, ${book.asks?.length || 0} asks`);
  } catch (e: any) {
    console.log(`❌ Orderbook: ${e.message}`);
  }

  console.log("\nDone.");
}

main().catch(console.error);
