import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, AccountLayout, getMint } from "@solana/spl-token";
import dotenv from "dotenv";
import fetch from "node-fetch";

// Load environment variables
dotenv.config();

// Get wallets and RPC URL from environment variables
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || clusterApiUrl("mainnet-beta");
const WALLET_ADDRESSES = process.env.WALLET_ADDRESSES?.split(",") || [];

// Solana Token List URL (Solana's official token list)
const SOLANA_TOKEN_LIST_URL = "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json";

if (WALLET_ADDRESSES.length === 0) {
  console.error("No wallet addresses provided in .env file.");
  process.exit(1);
}

// Fetch token list from Solana Token List (for automatic mapping)
async function fetchTokenList() {
  const response = await fetch(SOLANA_TOKEN_LIST_URL);
  const data = await response.json();
  const tokenList = data.tokens.reduce((acc: { [key: string]: { name: string, ticker: string } }, token: any) => {
    acc[token.address] = { name: token.name, ticker: token.symbol };
    return acc;
  }, {});

  return tokenList;
}

(async () => {
  const tokenList = await fetchTokenList();
  let totalSolBalance = 0;
  let totalTokenBalances: { [key: string]: number } = {};

  try {
    const connection = new Connection(QUICKNODE_RPC, "confirmed");

    // Iterate over each wallet address
    for (const walletAddress of WALLET_ADDRESSES) {
      console.log(`\nFetching balances for wallet: ${walletAddress}`);

      const publicKey = new PublicKey(walletAddress);

      // Fetch SOL balance
      const solBalance = await connection.getBalance(publicKey);
      const solInSOL = solBalance / 1_000_000_000; // Convert Lamports to SOL
      totalSolBalance += solInSOL; // Add to total SOL balance

      console.log(`
        -----------------------------------
        Wallet: ${walletAddress}
        Token: Solana (SOL)
        Balance: ${solInSOL.toFixed(4)} SOL
        -----------------------------------
      `);

      // Fetch all token accounts owned by the wallet
      const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      if (tokenAccounts.value.length === 0) {
        console.log(`No token accounts found for wallet: ${walletAddress}`);
        continue;
      }

      // Iterate over each token account and decode its data
      for (const { pubkey, account } of tokenAccounts.value) {
        const accountInfo = AccountLayout.decode(account.data);

        const mintAddress = new PublicKey(accountInfo.mint);

        // Fetch the token name and ticker from the token list
        const tokenInfo = tokenList[mintAddress.toBase58()] || { name: mintAddress.toBase58(), ticker: mintAddress.toBase58() };

        // Fetch token metadata to get decimals (if available)
        const mintInfo = await getMint(connection, mintAddress);
        const tokenDecimals = mintInfo.decimals;

        // Convert token balance to decimal format
        const tokenBalance = Number(accountInfo.amount) / Math.pow(10, tokenDecimals);

        // Add to the total token balance
        totalTokenBalances[tokenInfo.name] = (totalTokenBalances[tokenInfo.name] || 0) + tokenBalance;

        // Print in a prettier format
        console.log(`
          -----------------------------------
          Wallet: ${walletAddress}
          Token: ${tokenInfo.name} (${tokenInfo.ticker})
          Balance: ${tokenBalance.toFixed(4)} ${tokenInfo.ticker}
          Mint Address: ${mintAddress.toBase58()}
          -----------------------------------
        `);
      }
    }

    // Print the total balances
    console.log("\nTotal Balances Across All Wallets:");
    console.log(`Total SOL: ${totalSolBalance.toFixed(4)} SOL`);
    for (const [tokenName, balance] of Object.entries(totalTokenBalances)) {
      console.log(`${tokenName}: ${balance.toFixed(4)} ${tokenList[tokenName]?.ticker || "TKN"}`);
    }
  } catch (error) {
    console.error("Error fetching token balances:", error.message);
  }
})();
