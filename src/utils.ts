import {
    Connection,
    PublicKey,
    clusterApiUrl,
    LAMPORTS_PER_SOL,
  } from "@solana/web3.js";
  import { NetworkType, BalanceResult, CheckBalanceOptions } from "./types";
  
  export function validateSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
  
  export async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  export async function getAddressBalance(
    connection: Connection,
    address: string,
    retryCount: number = 3
  ): Promise<BalanceResult> {
    let lastError: Error | null = null;
    
    for (let i = 0; i < retryCount; i++) {
      try {
        if (!validateSolanaAddress(address)) {
          throw new Error("Invalid Solana address");
        }
  
        const publicKey = new PublicKey(address);
        const balanceInLamports = await connection.getBalance(publicKey);
        const balanceInSOL = balanceInLamports / LAMPORTS_PER_SOL;
  
        return {
          address,
          balanceInSOL,
          balanceInLamports,
        };
      } catch (error) {
        lastError = error as Error;
        if (i < retryCount - 1) {
          await delay(1000 * (i + 1)); // Exponential backoff
        }
      }
    }
  
    return {
      address,
      balanceInSOL: 0,
      balanceInLamports: 0,
      error: lastError?.message || "Unknown error occurred",
    };
  }