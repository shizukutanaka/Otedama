// Payment and financial interface definitions
// Ensuring accuracy and transparency in financial operations

export interface IPaymentConfig {
  paymentInterval: number;
  minPayout: number;
  maxPayout?: number;
  feePercent: number;
  feeAddress?: string;
  paymentMethod: 'PPLNS' | 'PPS' | 'PROP' | 'SOLO';
  confirmations: number;
  enableBatching: boolean;
  maxBatchSize?: number;
  txFeeHandling: 'pool' | 'miner';
}

// Payment processor interfaces
export interface IPaymentProcessor {
  initialize(config: IPaymentConfig): Promise<void>;
  processPayments(): Promise<IPaymentBatch>;
  calculateRewards(shares: IShare[], blockReward: number): Map<string, number>;
  createPaymentBatch(rewards: Map<string, number>): IPaymentBatch;
  executeBatch(batch: IPaymentBatch): Promise<IPaymentResult>;
  validatePayment(payment: IPayment): Promise<boolean>;
  getPaymentStatus(paymentId: string): Promise<IPaymentStatus>;
  cancelPayment(paymentId: string, reason: string): Promise<void>;
}

export interface IPaymentBatch {
  id: string;
  payments: IPaymentItem[];
  totalAmount: number;
  feeAmount: number;
  recipientCount: number;
  createdAt: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'partial';
  txid?: string;
  error?: string;
}

export interface IPaymentItem {
  address: string;
  amount: number;
  shares: number;
  blocks?: string[];
  userId?: string;
}

export interface IPaymentResult {
  success: boolean;
  batchId: string;
  txid?: string;
  fee?: number;
  processed: number;
  failed: number;
  errors?: Array<{ address: string; error: string }>;
}

export interface IPaymentStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  amount: number;
  confirmations?: number;
  requiredConfirmations: number;
  txid?: string;
  error?: string;
  updatedAt: Date;
}

// Fee calculation interfaces
export interface IFeeCalculator {
  setFeeStructure(structure: IFeeStructure): void;
  calculateFee(amount: number, miner?: IMiner): number;
  calculateNetAmount(grossAmount: number, miner?: IMiner): number;
  getFeeBreakdown(amount: number, miner?: IMiner): IFeeBreakdown;
  getTotalFeesCollected(period?: IPeriod): Promise<number>;
  distributePoolFees(totalFees: number): Promise<IFeeDistribution>;
}

export interface IFeeStructure {
  type: 'percentage' | 'fixed' | 'tiered' | 'dynamic';
  baseRate: number;
  tiers?: Array<{
    minAmount: number;
    maxAmount?: number;
    rate: number;
  }>;
  minerDiscounts?: Array<{
    condition: 'volume' | 'loyalty' | 'performance';
    threshold: number;
    discount: number;
  }>;
  dynamicFactors?: {
    networkDifficulty?: boolean;
    poolHashrate?: boolean;
    marketPrice?: boolean;
  };
}

export interface IFeeBreakdown {
  grossAmount: number;
  baseFee: number;
  discounts: Array<{ type: string; amount: number }>;
  additionalFees: Array<{ type: string; amount: number }>;
  totalFee: number;
  netAmount: number;
  effectiveRate: number;
}

export interface IFeeDistribution {
  totalFees: number;
  distributions: Array<{
    category: 'operations' | 'development' | 'reserves' | 'rewards';
    amount: number;
    percentage: number;
    recipient?: string;
  }>;
  timestamp: Date;
}

// Wallet integration interfaces
export interface IWalletService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getBalance(address?: string): Promise<IBalance>;
  getAddress(index?: number): Promise<string>;
  generateAddress(label?: string): Promise<IAddressInfo>;
  sendTransaction(tx: ITransaction): Promise<string>;
  getTransaction(txid: string): Promise<ITransactionInfo>;
  listTransactions(count?: number, skip?: number): Promise<ITransactionInfo[]>;
  estimateFee(numBlocks?: number): Promise<number>;
  validateAddress(address: string): Promise<IAddressValidation>;
  signMessage(address: string, message: string): Promise<string>;
  verifyMessage(address: string, signature: string, message: string): Promise<boolean>;
}

export interface IBalance {
  confirmed: number;
  unconfirmed: number;
  immature: number;
  total: number;
  locked?: number;
}

export interface IAddressInfo {
  address: string;
  publicKey?: string;
  label?: string;
  index?: number;
  createdAt: Date;
}

export interface ITransaction {
  to: string | Array<{ address: string; amount: number }>;
  amount?: number;
  fee?: number;
  feeRate?: number;
  changeAddress?: string;
  memo?: string;
  replaceable?: boolean;
  locktime?: number;
}

export interface ITransactionInfo {
  txid: string;
  amount: number;
  fee: number;
  confirmations: number;
  blockhash?: string;
  blockheight?: number;
  timestamp?: number;
  category: 'send' | 'receive' | 'generate' | 'immature';
  address?: string;
  label?: string;
  vout?: number;
}

export interface IAddressValidation {
  isValid: boolean;
  address?: string;
  scriptPubKey?: string;
  isScript?: boolean;
  isWitness?: boolean;
  witnessVersion?: number;
  witnessProgram?: string;
}

// Accounting interfaces
export interface IAccountingService {
  recordIncome(income: IIncomeRecord): Promise<void>;
  recordExpense(expense: IExpenseRecord): Promise<void>;
  getBalance(currency?: string): Promise<IAccountBalance>;
  getProfitLoss(period: IPeriod): Promise<IProfitLossStatement>;
  getIncomeStatement(period: IPeriod): Promise<IIncomeStatement>;
  getCashFlow(period: IPeriod): Promise<ICashFlowStatement>;
  exportReport(type: 'pdf' | 'csv' | 'json', period: IPeriod): Promise<string>;
}

export interface IIncomeRecord {
  type: 'mining_reward' | 'transaction_fee' | 'pool_fee' | 'other';
  amount: number;
  currency: string;
  description: string;
  reference?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface IExpenseRecord {
  type: 'electricity' | 'hardware' | 'maintenance' | 'transaction_fee' | 'salary' | 'other';
  amount: number;
  currency: string;
  description: string;
  reference?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface IAccountBalance {
  currency: string;
  available: number;
  pending: number;
  locked: number;
  total: number;
  lastUpdated: Date;
}

export interface IProfitLossStatement {
  period: IPeriod;
  revenue: {
    miningRewards: number;
    transactionFees: number;
    poolFees: number;
    other: number;
    total: number;
  };
  expenses: {
    electricity: number;
    hardware: number;
    maintenance: number;
    transactionFees: number;
    salaries: number;
    other: number;
    total: number;
  };
  grossProfit: number;
  netProfit: number;
  profitMargin: number;
}

export interface IIncomeStatement {
  period: IPeriod;
  revenue: Array<{ category: string; amount: number }>;
  costOfGoodsSold: Array<{ category: string; amount: number }>;
  operatingExpenses: Array<{ category: string; amount: number }>;
  otherIncome: Array<{ category: string; amount: number }>;
  otherExpenses: Array<{ category: string; amount: number }>;
  ebitda: number;
  depreciation: number;
  ebit: number;
  interestExpense: number;
  taxExpense: number;
  netIncome: number;
}

export interface ICashFlowStatement {
  period: IPeriod;
  operatingActivities: {
    netIncome: number;
    adjustments: Array<{ item: string; amount: number }>;
    workingCapitalChanges: Array<{ item: string; amount: number }>;
    total: number;
  };
  investingActivities: {
    purchases: Array<{ item: string; amount: number }>;
    sales: Array<{ item: string; amount: number }>;
    total: number;
  };
  financingActivities: {
    items: Array<{ item: string; amount: number }>;
    total: number;
  };
  netCashFlow: number;
  beginningCash: number;
  endingCash: number;
}

export interface IPeriod {
  start: Date;
  end: Date;
  timezone?: string;
}

// Payout customization interfaces
export interface IPayoutStrategy {
  name: string;
  description: string;
  calculate(miners: IMiner[], shares: IShare[], blockReward: number): Map<string, number>;
  validate(config: any): boolean;
}

export interface IPayoutSchedule {
  id: string;
  name: string;
  enabled: boolean;
  schedule: 'interval' | 'daily' | 'weekly' | 'threshold' | 'manual';
  intervalMinutes?: number;
  dailyTime?: string;
  weeklyDay?: number;
  weeklyTime?: string;
  thresholdAmount?: number;
  minPayout: number;
  maxPayout?: number;
  addresses?: string[];
}

export interface IPayoutRule {
  id: string;
  name: string;
  priority: number;
  condition: {
    type: 'address' | 'amount' | 'shares' | 'time' | 'custom';
    operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'regex';
    value: any;
  };
  action: {
    type: 'adjust_fee' | 'delay' | 'priority' | 'route' | 'custom';
    parameters: Record<string, any>;
  };
  enabled: boolean;
}
