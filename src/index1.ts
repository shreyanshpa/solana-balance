import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, AccountLayout, getMint } from "@solana/spl-token";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Get wallets and RPC URL from environment variables
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || clusterApiUrl("mainnet-beta");
const WALLET_ADDRESSES = process.env.WALLET_ADDRESSES?.split(",") || [];

// Token Mint Address to Token Name mapping (You can expand this)
const TOKEN_NAME_MAPPING: { [key: string]: string } = {
  "So11111111111111111111111111111111111111112": "Solana",
  "3m1K8LSukPtzyHHeaYn7JQrwuFSHYeLLZ7qij4Rupump": "abyss", // Replace with real token mint addresses
  "FwzpNxnabjZvc8QCnV6qPEBKxqLxSyjobc5Etdgxpump": "alris", // Replace with real token mint addresses
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "usdc",
  "EydktzNCykbs41L9psHaohZY7EoAhWWau2SdPXHv1XLE":"nora",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN":"trump"
};

// Check if there are wallet addresses provided
if (WALLET_ADDRESSES.length === 0) {
  console.error("No wallet addresses provided in .env file.");
  process.exit(1);
}

(async () => {
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
        const tokenName = TOKEN_NAME_MAPPING[mintAddress.toBase58()] || mintAddress.toBase58(); // Default to mint address if not found

        // Fetch token metadata to get decimals (if available)
        const mintInfo = await getMint(connection, mintAddress);
        const tokenDecimals = mintInfo.decimals;

        // Convert token balance to decimal format
        const tokenBalance = Number(accountInfo.amount) / Math.pow(10, tokenDecimals);

        // Add to the total token balance
        totalTokenBalances[tokenName] = (totalTokenBalances[tokenName] || 0) + tokenBalance;

        // Print in a prettier format
        console.log(`
          -----------------------------------
          Wallet: ${walletAddress}
          Token: ${tokenName}
          Balance: ${tokenBalance.toFixed(4)} ${tokenName}
          Mint Address: ${mintAddress.toBase58()}
          -----------------------------------
        `);
      }
    }

    // Print the total balances
    console.log("\nTotal Balances Across All Wallets:");
    console.log(`Total SOL: ${totalSolBalance.toFixed(4)} SOL`);
    for (const [tokenName, balance] of Object.entries(totalTokenBalances)) {
      console.log(`${tokenName}: ${balance.toFixed(4)} ${tokenName}`);
    }
  } catch (error) {
    console.error("Error fetching token balances:", error.message);
  }
})();
