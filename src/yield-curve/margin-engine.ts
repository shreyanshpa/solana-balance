/**
 * Margin Engine for Interest Rate Swaps
 *
 * Implements TradFi-grade margin infrastructure for on-chain rate swaps:
 *
 * 1. INITIAL MARGIN (IM): Posted at trade inception. Sized by tenor, notional,
 *    and rate volatility. Inspired by ISDA SIMM (Standard Initial Margin Model).
 *
 * 2. VARIATION MARGIN (VM): Daily mark-to-market settlement. The unrealized P&L
 *    is settled daily so counterparty exposure resets to zero each day.
 *    This is the "Settled-to-Market" (STM) model used by all major CCPs.
 *
 * 3. MARGIN CALLS: When a party's margin account drops below maintenance level,
 *    they must post additional collateral or face liquidation.
 *
 * 4. DEFAULT WATERFALL: If a party fails to meet a margin call:
 *    defaulter's IM → clearing fund contribution → insurance fund → mutualized loss
 *
 * Why this matters:
 * - Your rate swaps were previously unsecured (counterparty can walk away)
 * - Real IRS requires IM of 1-5% of notional depending on tenor
 * - Daily VM settlement limits max counterparty exposure to 1 day of rate moves
 * - This is what separates a toy from institutional-grade infrastructure
 */

import type { RateSwap } from "../common/types";
import { mean, stddev } from "../common/math";

// ============================================================
// Types
// ============================================================

export interface MarginAccount {
  owner: string;
  balance: number;           // current USDC balance in margin account
  initialDeposit: number;    // total deposited over lifetime
  lockedIM: number;          // locked as initial margin across swaps
  availableBalance: number;  // balance - lockedIM (available for new trades or withdrawal)
}

export interface SwapMarginRequirement {
  swapId: string;
  initialMargin: number;     // IM required at inception
  maintenanceMargin: number; // minimum margin to avoid liquidation (typically 60-75% of IM)
  currentExposure: number;   // current MTM exposure
  marginExcess: number;      // how much above maintenance (negative = margin call)
}

export interface VMSettlement {
  swapId: string;
  timestamp: number;
  priorMTM: number;          // previous day's MTM
  currentMTM: number;        // today's MTM
  settlementAmount: number;  // currentMTM - priorMTM (positive = payer owes, negative = payer receives)
  payerAccount: string;
  receiverAccount: string;
}

export interface MarginCall {
  account: string;
  swapId: string;
  amountRequired: number;
  deadline: number;          // timestamp by which margin must be posted
  status: "pending" | "met" | "failed";
}

export interface ClearingFundState {
  totalFund: number;
  contributions: Map<string, number>;  // per-participant contributions
  insuranceFund: number;               // mutualized backstop
}

// ============================================================
// Margin Engine
// ============================================================

export class MarginEngine {
  private accounts: Map<string, MarginAccount> = new Map();
  private swapMargins: Map<string, SwapMarginRequirement> = new Map();
  private vmHistory: VMSettlement[] = [];
  private marginCalls: MarginCall[] = [];
  private lastMTM: Map<string, number> = new Map(); // swapId -> last settled MTM

  // Clearing fund
  private clearingFund: ClearingFundState = {
    totalFund: 0,
    contributions: new Map(),
    insuranceFund: 0,
  };

  // Parameters (inspired by ISDA SIMM)
  private imSchedule: Record<string, number> = {
    // IM as % of notional, scaled by tenor
    "1d": 0.005,   // 0.5% for 1-day swaps
    "3d": 0.008,   // 0.8%
    "7d": 0.012,   // 1.2%
    "14d": 0.018,  // 1.8%
    "30d": 0.030,  // 3.0%
  };
  private maintenanceRatio = 0.65;  // maintenance = 65% of IM
  private clearingFundPct = 0.002;  // 0.2% of notional contributed to clearing fund
  private marginCallDeadlineHours = 4;

  // Rate volatility for dynamic IM scaling
  private rateVolHistory: number[] = [];

  /**
   * Create or top up a margin account.
   */
  depositMargin(owner: string, amount: number): MarginAccount {
    const existing = this.accounts.get(owner);
    if (existing) {
      existing.balance += amount;
      existing.initialDeposit += amount;
      existing.availableBalance = existing.balance - existing.lockedIM;
      return existing;
    }

    const account: MarginAccount = {
      owner,
      balance: amount,
      initialDeposit: amount,
      lockedIM: 0,
      availableBalance: amount,
    };
    this.accounts.set(owner, account);
    return account;
  }

  /**
   * Withdraw available margin (not locked as IM).
   */
  withdrawMargin(owner: string, amount: number): number {
    const account = this.accounts.get(owner);
    if (!account) return 0;

    const withdrawable = Math.min(amount, account.availableBalance);
    account.balance -= withdrawable;
    account.availableBalance = account.balance - account.lockedIM;
    return withdrawable;
  }

  /**
   * Compute and lock initial margin for a new swap.
   * IM = base_schedule[tenor] × notional × vol_scaling
   *
   * Vol scaling: if recent rate volatility is elevated, IM increases.
   * This prevents under-margining during volatile periods.
   */
  computeInitialMargin(swap: RateSwap, tenor: string): SwapMarginRequirement {
    const baseIM = this.imSchedule[tenor] || 0.02;

    // Dynamic scaling based on rate volatility
    const volScale = this.computeVolScaling();

    const im = swap.notional * baseIM * volScale;
    const maintenance = im * this.maintenanceRatio;

    const req: SwapMarginRequirement = {
      swapId: swap.id,
      initialMargin: im,
      maintenanceMargin: maintenance,
      currentExposure: 0,
      marginExcess: im - maintenance, // starts with full excess
    };

    this.swapMargins.set(swap.id, req);
    return req;
  }

  /**
   * Lock IM from both counterparties when a swap is executed.
   * Returns true if both parties have sufficient margin.
   */
  lockMarginForSwap(swap: RateSwap, tenor: string): {
    success: boolean;
    reason?: string;
    marginRequired?: number;
  } {
    const req = this.computeInitialMargin(swap, tenor);

    // Both payer and receiver must post IM
    const payerAccount = this.accounts.get(swap.payer);
    const receiverAccount = this.accounts.get(swap.receiver);

    if (!payerAccount) {
      return { success: false, reason: `No margin account for payer: ${swap.payer}`, marginRequired: req.initialMargin };
    }
    if (!receiverAccount) {
      return { success: false, reason: `No margin account for receiver: ${swap.receiver}`, marginRequired: req.initialMargin };
    }

    if (payerAccount.availableBalance < req.initialMargin) {
      return {
        success: false,
        reason: `Payer ${swap.payer} has $${payerAccount.availableBalance.toFixed(2)} available, needs $${req.initialMargin.toFixed(2)}`,
        marginRequired: req.initialMargin,
      };
    }
    if (receiverAccount.availableBalance < req.initialMargin) {
      return {
        success: false,
        reason: `Receiver ${swap.receiver} has $${receiverAccount.availableBalance.toFixed(2)} available, needs $${req.initialMargin.toFixed(2)}`,
        marginRequired: req.initialMargin,
      };
    }

    // Lock IM from both parties
    payerAccount.lockedIM += req.initialMargin;
    payerAccount.availableBalance = payerAccount.balance - payerAccount.lockedIM;

    receiverAccount.lockedIM += req.initialMargin;
    receiverAccount.availableBalance = receiverAccount.balance - receiverAccount.lockedIM;

    // Clearing fund contribution
    const clearingContrib = swap.notional * this.clearingFundPct;
    this.addToClearingFund(swap.payer, clearingContrib / 2);
    this.addToClearingFund(swap.receiver, clearingContrib / 2);

    // Initialize MTM at zero
    this.lastMTM.set(swap.id, 0);

    return { success: true, marginRequired: req.initialMargin };
  }

  /**
   * Daily variation margin settlement (STM model).
   *
   * Computes the change in MTM since last settlement and transfers
   * the difference between counterparties. This resets exposure to zero daily.
   *
   * currentMTM > 0 means the swap is in-the-money for the fixed payer
   * (floating rate realized higher than fixed).
   */
  settleVariationMargin(swap: RateSwap, currentMTM: number): VMSettlement | null {
    const priorMTM = this.lastMTM.get(swap.id) ?? 0;
    const settlementAmount = currentMTM - priorMTM;

    // Determine who pays whom
    // Positive settlement = payer benefits (floating > fixed)
    // So receiver owes payer
    const fromAccount = settlementAmount > 0 ? swap.receiver : swap.payer;
    const toAccount = settlementAmount > 0 ? swap.payer : swap.receiver;
    const absAmount = Math.abs(settlementAmount);

    const from = this.accounts.get(fromAccount);
    const to = this.accounts.get(toAccount);

    if (!from || !to) return null;

    // Transfer the settlement
    if (from.balance >= absAmount) {
      from.balance -= absAmount;
      to.balance += absAmount;
    } else {
      // Partial settlement — triggers margin call for the remainder
      const shortfall = absAmount - from.balance;
      to.balance += from.balance;
      from.balance = 0;

      this.issueMarginCall(fromAccount, swap.id, shortfall);
    }

    // Update available balances
    from.availableBalance = from.balance - from.lockedIM;
    to.availableBalance = to.balance - to.lockedIM;

    // Update margin requirement with current exposure
    const req = this.swapMargins.get(swap.id);
    if (req) {
      req.currentExposure = 0; // reset after settlement
      req.marginExcess = (from.balance - from.lockedIM) > 0
        ? from.balance - req.maintenanceMargin
        : -(req.maintenanceMargin - from.balance);
    }

    // Record settlement
    this.lastMTM.set(swap.id, currentMTM);

    const settlement: VMSettlement = {
      swapId: swap.id,
      timestamp: Date.now(),
      priorMTM,
      currentMTM,
      settlementAmount,
      payerAccount: fromAccount,
      receiverAccount: toAccount,
    };

    this.vmHistory.push(settlement);
    return settlement;
  }

  /**
   * Check all active swaps for margin adequacy.
   * Issues margin calls for any account below maintenance.
   */
  checkMarginAdequacy(activeSwaps: RateSwap[], mtmValues: Map<string, number>): MarginCall[] {
    const newCalls: MarginCall[] = [];

    for (const swap of activeSwaps) {
      const req = this.swapMargins.get(swap.id);
      if (!req) continue;

      const currentMTM = mtmValues.get(swap.id) ?? 0;
      const priorMTM = this.lastMTM.get(swap.id) ?? 0;
      const unsettledExposure = Math.abs(currentMTM - priorMTM);

      // Check both counterparties
      for (const party of [swap.payer, swap.receiver]) {
        const account = this.accounts.get(party);
        if (!account) continue;

        // The party who is losing money needs margin check
        const isLoser = (currentMTM > priorMTM && party === swap.receiver) ||
                        (currentMTM < priorMTM && party === swap.payer);

        if (isLoser) {
          const effectiveBalance = account.balance - unsettledExposure;
          if (effectiveBalance < req.maintenanceMargin) {
            const shortfall = req.maintenanceMargin - effectiveBalance;
            const call = this.issueMarginCall(party, swap.id, shortfall);
            newCalls.push(call);
          }
        }
      }
    }

    return newCalls;
  }

  /**
   * Release locked IM when a swap is settled or cancelled.
   */
  releaseMargin(swap: RateSwap): void {
    const req = this.swapMargins.get(swap.id);
    if (!req) return;

    for (const party of [swap.payer, swap.receiver]) {
      const account = this.accounts.get(party);
      if (account) {
        account.lockedIM = Math.max(0, account.lockedIM - req.initialMargin);
        account.availableBalance = account.balance - account.lockedIM;
      }
    }

    this.swapMargins.delete(swap.id);
    this.lastMTM.delete(swap.id);
  }

  /**
   * Force-close a swap when margin call is not met.
   * Follows the default waterfall:
   * 1. Defaulter's remaining margin
   * 2. Defaulter's clearing fund contribution
   * 3. Insurance fund
   */
  liquidateSwap(swap: RateSwap, finalMTM: number): {
    recoveredAmount: number;
    lossToCounterparty: number;
    waterfall: string[];
  } {
    const waterfall: string[] = [];
    let amountOwed = Math.abs(finalMTM);
    let recovered = 0;

    // Determine the defaulter (the party who owes money)
    const defaulter = finalMTM > 0 ? swap.receiver : swap.payer;
    const beneficiary = finalMTM > 0 ? swap.payer : swap.receiver;

    // Step 1: Defaulter's margin
    const defaulterAccount = this.accounts.get(defaulter);
    if (defaulterAccount && defaulterAccount.balance > 0) {
      const fromMargin = Math.min(amountOwed, defaulterAccount.balance);
      defaulterAccount.balance -= fromMargin;
      recovered += fromMargin;
      amountOwed -= fromMargin;
      waterfall.push(`Defaulter margin: $${fromMargin.toFixed(2)}`);
    }

    // Step 2: Defaulter's clearing fund contribution
    if (amountOwed > 0) {
      const contrib = this.clearingFund.contributions.get(defaulter) || 0;
      const fromClearing = Math.min(amountOwed, contrib);
      this.clearingFund.contributions.set(defaulter, contrib - fromClearing);
      this.clearingFund.totalFund -= fromClearing;
      recovered += fromClearing;
      amountOwed -= fromClearing;
      waterfall.push(`Clearing fund contribution: $${fromClearing.toFixed(2)}`);
    }

    // Step 3: Insurance fund
    if (amountOwed > 0) {
      const fromInsurance = Math.min(amountOwed, this.clearingFund.insuranceFund);
      this.clearingFund.insuranceFund -= fromInsurance;
      recovered += fromInsurance;
      amountOwed -= fromInsurance;
      waterfall.push(`Insurance fund: $${fromInsurance.toFixed(2)}`);
    }

    // Credit beneficiary
    const beneficiaryAccount = this.accounts.get(beneficiary);
    if (beneficiaryAccount) {
      beneficiaryAccount.balance += recovered;
      beneficiaryAccount.availableBalance = beneficiaryAccount.balance - beneficiaryAccount.lockedIM;
    }

    // Release margin requirements
    this.releaseMargin(swap);

    return {
      recoveredAmount: recovered,
      lossToCounterparty: amountOwed, // any remaining shortfall
      waterfall,
    };
  }

  /**
   * Feed rate volatility data for dynamic IM scaling.
   */
  updateRateVolatility(recentRates: number[]): void {
    if (recentRates.length >= 2) {
      const vol = stddev(recentRates);
      this.rateVolHistory.push(vol);
      if (this.rateVolHistory.length > 100) this.rateVolHistory.shift();
    }
  }

  /**
   * Compute portfolio-level DV01: dollar value of a 1bp rate move.
   * DV01 = notional × duration_years × 0.0001
   */
  computePortfolioDV01(swaps: RateSwap[]): {
    totalDV01: number;
    bySwap: Array<{ swapId: string; dv01: number; direction: string }>;
  } {
    const bySwap: Array<{ swapId: string; dv01: number; direction: string }> = [];
    let totalDV01 = 0;

    for (const swap of swaps) {
      const durationYears = (swap.maturityTime - swap.startTime) / (365 * 24 * 3600 * 1000);
      const remainingYears = Math.max(0, (swap.maturityTime - Date.now()) / (365 * 24 * 3600 * 1000));
      const dv01 = swap.notional * remainingYears * 0.0001;

      // Fixed payer benefits from rate increases (positive DV01)
      // Fixed receiver benefits from rate decreases (negative DV01)
      const signedDV01 = swap.payer === "user" ? dv01 : -dv01;

      bySwap.push({
        swapId: swap.id,
        dv01: signedDV01,
        direction: swap.payer === "user" ? "pay_fixed" : "receive_fixed",
      });

      totalDV01 += signedDV01;
    }

    return { totalDV01, bySwap };
  }

  /**
   * Net margin requirement across a portfolio of swaps.
   * Netting reduces total margin by recognizing offsetting positions.
   */
  computeNetMarginRequirement(swaps: RateSwap[]): {
    grossMargin: number;
    netMargin: number;
    nettingBenefit: number;
  } {
    let grossMargin = 0;
    let netExposure = 0;

    for (const swap of swaps) {
      const req = this.swapMargins.get(swap.id);
      if (req) {
        grossMargin += req.initialMargin;
      }

      // Net exposure: pay_fixed and receive_fixed on same asset offset
      const durationYears = Math.max(0, (swap.maturityTime - Date.now()) / (365 * 24 * 3600 * 1000));
      const exposure = swap.notional * durationYears * swap.fixedRate;
      netExposure += swap.payer === "user" ? exposure : -exposure;
    }

    // Net margin = margin on net exposure (with a floor of 40% of gross, capped at gross)
    const netMargin = Math.min(grossMargin, Math.max(grossMargin * 0.4, Math.abs(netExposure) * 0.02));
    const nettingBenefit = grossMargin - netMargin;

    return { grossMargin, netMargin, nettingBenefit };
  }

  // ---- Accessors ----

  getAccount(owner: string): MarginAccount | undefined {
    return this.accounts.get(owner);
  }

  getSwapMargin(swapId: string): SwapMarginRequirement | undefined {
    return this.swapMargins.get(swapId);
  }

  getVMHistory(): VMSettlement[] {
    return this.vmHistory;
  }

  getPendingMarginCalls(): MarginCall[] {
    return this.marginCalls.filter(c => c.status === "pending");
  }

  getClearingFundState(): ClearingFundState {
    return this.clearingFund;
  }

  getAllAccounts(): MarginAccount[] {
    return Array.from(this.accounts.values());
  }

  // ---- Private helpers ----

  private computeVolScaling(): number {
    if (this.rateVolHistory.length < 2) return 1.0;
    const recentVol = mean(this.rateVolHistory.slice(-10));
    const longTermVol = mean(this.rateVolHistory);
    // Scale IM up when recent vol exceeds long-term (capped at 2x)
    return Math.min(2.0, Math.max(0.8, recentVol / Math.max(longTermVol, 1e-10)));
  }

  private issueMarginCall(account: string, swapId: string, amount: number): MarginCall {
    const call: MarginCall = {
      account,
      swapId,
      amountRequired: amount,
      deadline: Date.now() + this.marginCallDeadlineHours * 3600 * 1000,
      status: "pending",
    };
    this.marginCalls.push(call);
    return call;
  }

  private addToClearingFund(participant: string, amount: number): void {
    const existing = this.clearingFund.contributions.get(participant) || 0;
    this.clearingFund.contributions.set(participant, existing + amount);
    this.clearingFund.totalFund += amount;
    // 20% goes to insurance fund
    this.clearingFund.insuranceFund += amount * 0.2;
  }

  /**
   * Format a margin report for display.
   */
  formatReport(swaps: RateSwap[]): string {
    const lines: string[] = [
      "=== MARGIN ENGINE STATUS ===",
      "",
      "Accounts:",
    ];

    for (const account of this.accounts.values()) {
      lines.push(
        `  ${account.owner.padEnd(16)} Balance: $${account.balance.toFixed(2).padStart(12)} | Locked IM: $${account.lockedIM.toFixed(2).padStart(10)} | Available: $${account.availableBalance.toFixed(2).padStart(12)}`
      );
    }

    lines.push("", "Swap Margin Requirements:");
    for (const [swapId, req] of this.swapMargins) {
      lines.push(
        `  ${swapId.padEnd(30)} IM: $${req.initialMargin.toFixed(2).padStart(10)} | Maint: $${req.maintenanceMargin.toFixed(2).padStart(10)} | Excess: $${req.marginExcess.toFixed(2).padStart(10)}`
      );
    }

    // DV01
    const dv01 = this.computePortfolioDV01(swaps);
    lines.push("", `Portfolio DV01: $${dv01.totalDV01.toFixed(2)} per 1bp move`);

    // Netting
    if (swaps.length > 1) {
      const netting = this.computeNetMarginRequirement(swaps);
      lines.push(
        `Gross Margin: $${netting.grossMargin.toFixed(2)} | Net Margin: $${netting.netMargin.toFixed(2)} | Netting Benefit: $${netting.nettingBenefit.toFixed(2)}`
      );
    }

    // Clearing fund
    lines.push(
      "",
      `Clearing Fund: $${this.clearingFund.totalFund.toFixed(2)} | Insurance: $${this.clearingFund.insuranceFund.toFixed(2)}`
    );

    // Pending margin calls
    const pending = this.getPendingMarginCalls();
    if (pending.length > 0) {
      lines.push("", "PENDING MARGIN CALLS:");
      for (const call of pending) {
        lines.push(`  ${call.account}: $${call.amountRequired.toFixed(2)} required for ${call.swapId}`);
      }
    }

    // VM settlements
    const recentVM = this.vmHistory.slice(-5);
    if (recentVM.length > 0) {
      lines.push("", "Recent VM Settlements:");
      for (const vm of recentVM) {
        const direction = vm.settlementAmount > 0 ? "payer receives" : "receiver receives";
        lines.push(
          `  ${vm.swapId}: $${Math.abs(vm.settlementAmount).toFixed(2)} (${direction})`
        );
      }
    }

    return lines.join("\n");
  }
}
