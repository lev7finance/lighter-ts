/**
 * Order-sizing arithmetic: the book, the slippage bound, quote↔base sizing, and leverage↔margin.
 *
 * A **module-local** barrel — it is not the `./client` barrel and it does not re-export anything
 * outside this directory (`docs/decisions.md` D8: one owner per file).
 *
 * Everything reachable from here is a pure function over its arguments. No I/O, no clock, no
 * module-level state, no mutation of an argument; importing this file does nothing observable. That
 * is what lets the same code size an order from a REST snapshot, from a book maintained over the
 * WebSocket, or from a fixture in a test — and it is the property that makes this layer, the one
 * that decides what price and size an order is actually submitted at, verifiable at all.
 */

export {
  bestPrice,
  type BookLevel,
  bookFromLevels,
  bookFromRestOrders,
  type BookSnapshot,
  type ExecutionEstimate,
  type Fraction,
  potentialExecutionPrice,
  reduceFraction,
} from "./book.js";
export {
  leverageToImf,
  type LeverageInput,
  type LeverageResult,
  MARGIN_FRACTION_TICK,
  MAX_INITIAL_MARGIN_FRACTION,
  MIN_INITIAL_MARGIN_FRACTION,
} from "./leverage.js";
export {
  type BaseSizing,
  baseOrderIfSlippage,
  MAX_ORDER_BASE_AMOUNT,
  MIN_ORDER_BASE_AMOUNT,
  type QuoteSizing,
  quoteToBase,
  type SizingOptions,
} from "./quote.js";
export {
  MAX_ORDER_PRICE,
  MIN_ORDER_PRICE,
  parseSlippage,
  roundingFor,
  slippageBound,
  type SlippageMode,
} from "./slippage.js";
