import type {
  MarketInfo,
  FundingRateEntry,
  CandleData,
  Orderbook,
  PriceData,
} from "./types";

const DEFAULT_BASE_URL = "https://api.pacifica.fi";
const DEFAULT_TESTNET_URL = "https://test-api.pacifica.fi";

interface PacificaClientConfig {
  baseUrl?: string;
  testnet?: boolean;
  apiKey?: string;
}

export class PacificaClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: PacificaClientConfig = {}) {
    if (config.baseUrl) {
      this.baseUrl = config.baseUrl;
    } else {
      this.baseUrl = config.testnet ? DEFAULT_TESTNET_URL : DEFAULT_BASE_URL;
    }

    this.headers = {
      "Content-Type": "application/json",
    };

    if (config.apiKey) {
      this.headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
  }

  private async request<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const response = await fetch(url.toString(), { headers: this.headers });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Pacifica API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  // ========== Market Data ==========

  async getMarkets(): Promise<MarketInfo[]> {
    const data = await this.request<any>("/api/v1/markets");
    return data.markets || data.data || data || [];
  }

  async getMarketInfo(symbol: string): Promise<MarketInfo> {
    return this.request<MarketInfo>(`/api/v1/markets/${symbol}`);
  }

  async getPrices(symbol?: string): Promise<PriceData[]> {
    const endpoint = symbol ? `/api/v1/prices/${symbol}` : "/api/v1/prices";
    const data = await this.request<any>(endpoint);
    return Array.isArray(data) ? data : data.data || [data];
  }

  async getCandles(
    symbol: string,
    interval: string = "1h",
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<CandleData[]> {
    const params: Record<string, string> = {
      interval,
      limit: limit.toString(),
    };
    if (startTime) params.startTime = startTime.toString();
    if (endTime) params.endTime = endTime.toString();

    const data = await this.request<any>(`/api/v1/candles/${symbol}`, params);
    return data.candles || data.data || data || [];
  }

  async getOrderbook(symbol: string, depth: number = 20): Promise<Orderbook> {
    return this.request<Orderbook>(`/api/v1/orderbook/${symbol}`, {
      depth: depth.toString(),
    });
  }

  // ========== Funding Rates ==========

  async getCurrentFundingRate(symbol: string): Promise<FundingRateEntry> {
    const data = await this.request<any>(`/api/v1/funding_rate/${symbol}`);
    return data.data || data;
  }

  async getFundingRateHistory(
    symbol: string,
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<FundingRateEntry[]> {
    const params: Record<string, string> = {
      limit: limit.toString(),
    };
    if (startTime) params.startTime = startTime.toString();
    if (endTime) params.endTime = endTime.toString();

    const data = await this.request<any>(`/api/v1/funding_rate/history/${symbol}`, params);
    return data.history || data.data || data || [];
  }

  // ========== Recent Trades ==========

  async getRecentTrades(symbol: string, limit: number = 50): Promise<any[]> {
    const data = await this.request<any>(`/api/v1/trades/${symbol}`, {
      limit: limit.toString(),
    });
    return data.trades || data.data || data || [];
  }
}

export function createClient(testnet: boolean = false): PacificaClient {
  return new PacificaClient({ testnet });
}
