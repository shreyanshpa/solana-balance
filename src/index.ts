import { Connection, clusterApiUrl } from "@solana/web3.js";
import { getAddressBalance, delay } from "./utils";
import { CheckBalanceOptions, BalanceResult, NetworkType } from "./types";

async function checkBalances(
  addresses: string[],
  options: CheckBalanceOptions = {}
): Promise<BalanceResult[]> {
  const {
    network = "devnet",
    retryCount = 3,
    delayBetweenRequests = 100
  } = options;

  const connection = new Connection(clusterApiUrl(network as NetworkType));
  const results: BalanceResult[] = [];

  console.log(`🔍 Checking balances on ${network}...`);

  for (const address of addresses) {
    const result = await getAddressBalance(connection, address, retryCount);
    results.push(result);

    // Print result
    if (result.error) {
      console.error(`❌ Error for ${address}: ${result.error}`);
    } else {
      console.log(
        `✅ Balance for ${address}: ${result.balanceInSOL} SOL (${result.balanceInLamports} lamports)`
      );
    }

    if (delayBetweenRequests > 0 && addresses.indexOf(address) !== addresses.length - 1) {
      await delay(delayBetweenRequests);
    }
  }

  return results;
}

// Example usage
const addresses = [
  "GDTUkwJL7M4r8rCRu3cc9oFTwQkvmzogWSGf4ehWmGr4",
"8R1qMFNvsF7MkCAVPvDiqVnxo6rYmFeAGcuRB6jWh2nU", 
"A4TwuJhpLm3yoeHcXjja6YZT4JMAZbZvfWG4wngXVe9v",
"6Cvmq4udiXQz1D2cjtnk1iDyG7FmYRJh2wGtcRrJLoRa"
];

const options = {
  network: "mainnet-beta",
  retryCount: 3,
  delayBetweenRequests: 100
};

checkBalances(addresses, options).then(() => {
  console.log("✨ Balance check completed!");
}).catch((error) => {
  console.error("❌ Error:", error);
});