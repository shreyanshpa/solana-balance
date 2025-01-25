export type NetworkType = "mainnet-beta" | "devnet" | "testnet";

export interface BalanceResult {
  address: string;
  balanceInSOL: number;
  balanceInLamports: number;
  error?: string;
}

export interface CheckBalanceOptions {
  network?: NetworkType;
  retryCount?: number;
  delayBetweenRequests?: number; // in milliseconds
}
