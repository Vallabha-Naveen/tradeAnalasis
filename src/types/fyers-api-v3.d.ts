/**
 * Type declarations for fyers-api-v3 v2.0.0.
 *
 * IMPORTANT: The SDK mixes snake_case and camelCase method names.
 * - snake_case: generate_access_token, get_profile, get_funds, get_holdings,
 *               get_orders, get_positions, get_tradebook, place_order,
 *               cancel_order, modify_order, exit_position, convert_position,
 *               market_status, logout_user
 * - camelCase:  getQuotes, getMarketDepth, getOptionChain, getHistory,
 *               getPriceAlert, createPriceAlert, etc.
 *
 * All methods take a single req object (or array for getQuotes).
 * Most "get" methods accept {} (empty object) when no params are needed.
 */

declare module 'fyers-api-v3' {
  export class fyersModel {
    constructor(config: { path?: string; enableLogging?: boolean });

    setAppId(appId: string): void;
    setRedirectUrl(redirectUrl: string): void;
    setAccessToken(accessToken: string): void;

    // Auth (snake_case)
    generateAuthCode(req: any): any;
    generate_access_token(req: {
      client_id: string;
      secret_key: string;
      auth_code: string;
    }): Promise<any>;

    // Account / portfolio (snake_case) — all take a req object, {} is fine
    get_profile(req?: any): Promise<any>;
    get_funds(req?: any): Promise<any>;
    get_holdings(req?: any): Promise<any>;
    logout_user(req?: any): Promise<any>;

    // Orders (snake_case)
    get_orders(req?: any): Promise<any>;
    get_gtt_orders(req?: any): Promise<any>;
    get_filtered_orders(req?: any): Promise<any>;
    get_positions(req?: any): Promise<any>;
    get_tradebook(req?: any): Promise<any>;
    place_order(req: any): Promise<any>;
    place_gtt_order(req: any): Promise<any>;
    place_multileg_order(req: any): Promise<any>;
    place_multi_order(req: any): Promise<any>;
    modify_order(req: any): Promise<any>;
    cancel_order(req: { id: string }): Promise<any>;
    exit_position(req: any): Promise<any>;
    convert_position(req: any): Promise<any>;

    // Market data (camelCase)
    market_status(req?: any): Promise<any>;
    getHistory(req: any): Promise<any>;

    /**
     * Get quotes for one or more symbols.
     * @param req Array of symbol strings, e.g. ['NSE:NIFTY-INDEX']
     */
    getQuotes(req: string[]): Promise<any>;

    /**
     * Get market depth for symbols.
     * @param req { symbol: string[], ohlcv_flag: number }
     */
    getMarketDepth(req: { symbol: string[]; ohlcv_flag: number }): Promise<any>;

    /**
     * Get the option chain for an underlying.
     * @param req { symbol: string, strikecount?: number, timestamp?: number }
     *             (note: strikecount is one word, no underscore)
     */
    getOptionChain(req: {
      symbol: string;
      strikecount?: number;
      timestamp?: number;
    }): Promise<any>;

    // Price alerts (camelCase)
    getPriceAlert(req?: any): Promise<any>;
    createPriceAlert(req: any): Promise<any>;
    modifyPriceAlert(req: any): Promise<any>;
    togglePriceAlert(req: any): Promise<any>;
    deletePriceAlert(req: any): Promise<any>;

    // History (camelCase + snake_case mix)
    get_order_history(req: any): Promise<any>;
    get_trade_history(req: any): Promise<any>;
    get_charges_history(req: any): Promise<any>;
    get_realised_profit_history(req: any): Promise<any>;
    get_tax_pnl_history(req: any): Promise<any>;
    get_ledger_history(req: any): Promise<any>;
  }

  export class fyersOrderSocket {
    constructor(config: any);
    connect(): void;
    subscribe(orderIds: string[]): void;
    on(event: string, callback: (data: any) => void): void;
    close(): void;
  }

  export class fyersDataSocket {
    constructor(config: any);
    connect(): void;
    subscribe(symbols: string[]): void;
    on(event: string, callback: (data: any) => void): void;
    close(): void;
  }

  export class fyersTbtSocket {
    constructor(config: any);
    connect(): void;
    subscribe(symbols: string[]): void;
    on(event: string, callback: (data: any) => void): void;
    close(): void;
  }
}
