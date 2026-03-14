// ============================================================
// Pacifica API Types
// ============================================================

export interface MarketInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  minOrderSize: number;
  maxLeverage: number;
  tickSize: number;
  stepSize: number;
  status: string;
}

export interface FundingRateEntry {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  markPrice: number;
}

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
}

export interface PriceData {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  timestamp: number;
}

// ============================================================
// Yield Curve Types
// ============================================================

export interface FundingRatePoint {
  symbol: string;
  rate: number;
  annualizedRate: number;
  timestamp: number;
}

export interface YieldCurvePoint {
  horizon: string;
  horizonHours: number;
  averageRate: number;
  annualizedRate: number;
  sampleCount: number;
}

export interface AssetYieldCurve {
  symbol: string;
  curve: YieldCurvePoint[];
  currentRate: number;
  lastUpdated: number;
}

export interface CrossAssetSpread {
  assetA: string;
  assetB: string;
  spreadBps: number;
  horizon: string;
  signal: "long_A_short_B" | "long_B_short_A" | "neutral";
}

export interface YieldCurveShape {
  type: "normal" | "inverted" | "flat" | "humped";
  steepness: number; // bps difference between shortest and longest tenor
  description: string;
}

// ============================================================
// Rate Swap Types
// ============================================================

export interface RateSwap {
  id: string;
  symbol: string;
  fixedRate: number;        // annualized fixed rate (what the fixed payer pays)
  notional: number;         // USDC notional
  startTime: number;
  maturityTime: number;
  payer: string;            // address paying fixed
  receiver: string;         // address receiving fixed (paying floating)
  status: "active" | "settled" | "cancelled";
  realizedFloatingRate?: number;
  settlementAmount?: number;
}

export interface SwapQuote {
  symbol: string;
  tenor: string;
  fixedRateBid: number;    // rate to receive fixed
  fixedRateAsk: number;    // rate to pay fixed
  midRate: number;
  spread: number;
  confidence: number;       // 0-1 based on data quality
}

// ============================================================
// Vault Types
// ============================================================

export interface VaultConfig {
  name: string;
  strategy: "delta_neutral" | "funding_rate_arb" | "variance_swap";
  targetAssets: string[];
  maxLeverage: number;
  rebalanceThresholdPct: number;
  maxDrawdownPct: number;
}

export interface VaultState {
  totalDeposits: number;
  totalShares: number;
  nav: number;                // net asset value per share
  apy: number;                // trailing APY
  positions: VaultPosition[];
  lastRebalance: number;
  pnl: number;
  fundingEarned: number;
}

export interface VaultPosition {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  margin: number;
}

// ============================================================
// Variance Swap Types
// ============================================================

export interface VarianceSwapContract {
  id: string;
  symbol: string;
  strikeVariance: number;          // annualized variance strike
  strikeVolatility: number;        // sqrt of strike variance (more intuitive)
  notional: number;                // vega notional
  observationPeriodDays: number;
  startTime: number;
  endTime: number;
  observations: number[];          // log returns observed so far
  realizedVariance: number;        // running realized variance
  realizedVolatility: number;      // sqrt of realized variance
  status: "active" | "settled";
  payoff?: number;
}

export interface VarianceSwapQuote {
  symbol: string;
  tenor: string;
  impliedVolBid: number;
  impliedVolAsk: number;
  midVol: number;
  historicalVol: number;
  varianceRiskPremium: number;    // implied - realized (usually positive)
}
