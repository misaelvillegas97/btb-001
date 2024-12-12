import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import Binance, { CandleChartInterval, CandleChartInterval_LT, OrderType } from 'binance-api-node';
import { BollingerBands, EMA, MACD, RSI } from 'technicalindicators';
import dotenv from 'dotenv';

dotenv.config();

// ======================================================
// CARGA DE CONFIGURACIONES DESDE .env
// ======================================================
const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  SYMBOL = 'BTCUSDT',
  INTERVAL = CandleChartInterval.ONE_MINUTE,
  EMA_PERIOD = '14',
  RSI_PERIOD = '14',
  MACD_FAST = '12',
  MACD_SLOW = '26',
  MACD_SIGNAL = '9',
  BB_PERIOD = '20',
  BB_STDDEV = '2',
  QUANTITY = '0.001',
  CHECK_INTERVAL = '60000',
  MAX_RETRIES = '3',
  RETRY_DELAY = '2000',
  STOP_LOSS_PERCENT = '0.02',
  TAKE_PROFIT_PERCENT = '0.05',
  SIMULATE_TRADES = 'false',
  INITIAL_BALANCE = '1000'
} = process.env;

// Convertir a tipos adecuados
const emaPeriod = parseInt(EMA_PERIOD, 10);
const rsiPeriod = parseInt(RSI_PERIOD, 10);
const macdFast = parseInt(MACD_FAST, 10);
const macdSlow = parseInt(MACD_SLOW, 10);
const macdSignal = parseInt(MACD_SIGNAL, 10);
const bbPeriod = parseInt(BB_PERIOD, 10);
const bbStdDev = parseFloat(BB_STDDEV);
const checkInterval = parseInt(CHECK_INTERVAL, 10);
const maxRetries = parseInt(MAX_RETRIES, 10);
const retryDelay = parseInt(RETRY_DELAY, 10);
const stopLossPercent = parseFloat(STOP_LOSS_PERCENT);
const takeProfitPercent = parseFloat(TAKE_PROFIT_PERCENT);
const simulateTrades = (SIMULATE_TRADES.toLowerCase() === 'true');
let balance = parseFloat(INITIAL_BALANCE);

// Tipos para velas
interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Estado del bot
type Position = 'LONG' | 'FLAT';

// Logs
interface LogEntry {
  time: string;
  level: 'INFO' | 'ERROR' | 'DEBUG' | 'TRADE';
  message: string;

  [key: string]: any;
}

// ======================================================
// INICIALIZACIÓN DE CLIENTE BINANCE (Modo Spot para ejemplo)
// Puedes adaptar a Futuros si lo deseas.
// ======================================================
const client = (!simulateTrades && BINANCE_API_KEY && BINANCE_API_SECRET)
  ? Binance({ apiKey: BINANCE_API_KEY, apiSecret: BINANCE_API_SECRET })
  : Binance();

let position: Position = 'FLAT';
let entryPrice: number | null = null;
let lastSignal: string = 'HOLD';
let lastPrice: number | null = null;
let logs: LogEntry[] = [];

// ======================================================
// FUNCIONES DE LOGGING
// ======================================================
function log(level: 'INFO' | 'ERROR' | 'DEBUG' | 'TRADE', message: string, extra: Record<string, any> = {}) {
  const entry: LogEntry = { time: new Date().toISOString(), level, message, ...extra };
  logs.push(entry);
  if (level === 'ERROR') {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

// ======================================================
// FUNCIONES DE API Y RETRY
// ======================================================
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempts = 0;
  while ( attempts < maxRetries ) {
    try {
      return await fn();
    } catch ( error: any ) {
      attempts++;
      log('ERROR', `Error attempt ${ attempts }: ${ error.message }`);
      if (attempts >= maxRetries) {
        throw error;
      }
      await new Promise(res => setTimeout(res, retryDelay));
    }
  }
  // Nunca debería llegar aquí
  throw new Error('Max retries reached');
}

async function getCandleData(symbol: string = SYMBOL, interval: string = INTERVAL, limit: number = 200): Promise<Candle[]> {
  const rawCandles = await withRetry(() => client.candles({ symbol, interval: interval as CandleChartInterval_LT, limit }));
  return rawCandles.map(c => ({
    openTime: c.openTime,
    closeTime: c.closeTime,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume)
  }));
}

async function placeOrder(side: 'BUY' | 'SELL', symbol: string = SYMBOL, quantity: string = QUANTITY): Promise<any> {
  if (simulateTrades) {
    log('INFO', `SIMULATION: ${ side } ${ quantity } ${ symbol }`);
    return { simulated: true, side, quantity, symbol };
  }
  return withRetry(() => client.order({
    symbol,
    side,
    type: OrderType.MARKET,
    quantity
  }));
}

// ======================================================
// CÁLCULO DE INDICADORES
// ======================================================
interface Indicators {
  emaValues?: number[];
  rsiValues?: number[];
  macdValues?: { MACD?: number, signal?: number, histogram?: number }[];
  bbValues?: { lower: number; middle: number; upper: number }[];
}

function calculateIndicators(closePrices: number[]): Indicators {
  const emaValues = EMA.calculate({ period: emaPeriod, values: closePrices });
  const rsiValues = RSI.calculate({ period: rsiPeriod, values: closePrices });
  const macdValues = MACD.calculate({
    fastPeriod: macdFast,
    slowPeriod: macdSlow,
    signalPeriod: macdSignal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
    values: closePrices
  });
  const bbValues = BollingerBands.calculate({
    period: bbPeriod,
    values: closePrices,
    stdDev: bbStdDev
  });

  return { emaValues, rsiValues, macdValues, bbValues };
}

function generateSignal(indicators: Indicators, closePrices: number[]): string {
  const { rsiValues, macdValues, bbValues } = indicators;
  if (!rsiValues || !macdValues || !bbValues) return 'HOLD';
  if (rsiValues.length < 1 || macdValues.length < 1 || bbValues.length < 1) return 'HOLD';

  const latestRSI = rsiValues[rsiValues.length - 1];
  const latestMACD = macdValues[macdValues.length - 1];
  const latestBB = bbValues[bbValues.length - 1];
  const latestClose = closePrices[closePrices.length - 1];

  log('DEBUG', `latestClose=${ latestClose }, lowerBB=${ latestBB.lower }, upperBB=${ latestBB.upper }, RSI=${ latestRSI }, MACD=${ latestMACD.MACD }, Signal=${ latestMACD.signal }`);


// Ejemplo de señal más sensible:
  if (!latestMACD || latestMACD.MACD === undefined || latestMACD.signal === undefined || !latestBB || latestRSI === undefined) {
    return 'HOLD';
  }

// Reducimos los umbrales de RSI a 40/60 y Bandas Bollinger más ajustadas (BB_STDDEV=1.5)
  if (latestClose < latestBB.lower && latestRSI < 40 && latestMACD.MACD > latestMACD.signal) {
    return 'BUY';
  }

  if (latestClose > latestBB.upper && latestRSI > 60 && latestMACD.MACD < latestMACD.signal) {
    return 'SELL';
  }

  return 'HOLD';
}

// ======================================================
// GESTIÓN DE POSICIONES Y RIESGOS
// ======================================================
async function executeStrategy(signal: string, currentPrice: number) {
  // Check stop-loss / take-profit
  if (position === 'LONG' && entryPrice) {
    const slPrice = entryPrice * (1 - stopLossPercent);
    const tpPrice = entryPrice * (1 + takeProfitPercent);
    if (currentPrice <= slPrice) {
      log('INFO', `Stop-loss triggered. CurrentPrice: ${ currentPrice }, SL: ${ slPrice }`);
      await closePosition(currentPrice, true); // Cierra posición, registrando pérdida
      return;
    } else if (currentPrice >= tpPrice) {
      log('INFO', `Take-profit triggered. CurrentPrice: ${ currentPrice }, TP: ${ tpPrice }`);
      await closePosition(currentPrice, true); // Cierra posición, registrando ganancia
      return;
    }
  }

  // Lógica de señal
  if (signal === 'BUY' && position !== 'LONG') {
    await openPosition(currentPrice);
  } else if (signal === 'SELL' && position === 'LONG') {
    // Cierra posición y calcula PnL
    await closePosition(currentPrice, true);
  } else {
    // HOLD: Si estamos en LONG, calcula PnL no realizado.
    if (position === 'LONG' && entryPrice) {
      const unrealizedPnL = (currentPrice - entryPrice) * parseFloat(QUANTITY);
      log('INFO', `HOLD: Unrealized PnL = ${ unrealizedPnL.toFixed(4) } USDT`, { currentPrice, entryPrice });
    } else {
      log('DEBUG', `Signal: ${ signal }, Position: ${ position }, No action taken`);
    }
  }
}

async function openPosition(currentPrice: number) {
  const order = await placeOrder('BUY', SYMBOL, QUANTITY);
  if (order) {
    position = 'LONG';
    entryPrice = currentPrice;
    log('TRADE', `Opened LONG`, { entryPrice, quantity: QUANTITY, balance });
  }
}

// closePosition calcula PnL si requested
async function closePosition(closePrice: number, recordPnL: boolean = false) {
  const order = await placeOrder('SELL', SYMBOL, QUANTITY);
  if (order) {
    let pnl = 0;
    if (recordPnL && entryPrice) {
      pnl = (closePrice - entryPrice) * parseFloat(QUANTITY);
      balance += pnl;
      log('TRADE', `Closed position`, { closePrice, entryPrice, quantity: QUANTITY, pnl: pnl.toFixed(4), newBalance: balance.toFixed(4) });
    } else {
      log('TRADE', `Closed position`, { closePrice });
    }

    position = 'FLAT';
    entryPrice = null;
  }
}

// ======================================================
// FUNCIÓN PRINCIPAL DE ANÁLISIS Y ACCIÓN
// ======================================================
async function analyzeMarket() {
  try {
    const candles = await getCandleData(SYMBOL, INTERVAL, 200);
    const closePrices = candles.map(c => c.close);
    lastPrice = closePrices[closePrices.length - 1];

    const indicators = calculateIndicators(closePrices);
    const signal = generateSignal(indicators, closePrices);
    lastSignal = signal;

    await executeStrategy(signal, lastPrice);
  } catch ( error: any ) {
    log('ERROR', `Error analyzing market: ${ error.message }`, { stack: error.stack });
  }
}

// ======================================================
// SERVIDOR KOA PARA MONITOREO Y CONTROL
// ======================================================
const app = new Koa();
const router = new Router();

router.get('/status', async (ctx) => {
  ctx.body = {
    symbol: SYMBOL,
    interval: INTERVAL,
    position,
    lastSignal,
    lastPrice,
    entryPrice,
    stopLossPercent,
    takeProfitPercent,
    simulation: simulateTrades,
    balance: balance.toFixed(4),
    logs: logs.slice(-50) // últimos 50
  };
});

router.post('/params', async (ctx) => {
  const body = ctx.request.body as Record<string, any>;
  // Ajustar parámetros dinámicamente si quieres
  ctx.body = { message: 'Parameters updated', params: body };
});

app
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods());

const PORT = 3001;
app.listen(PORT, () => {
  log('INFO', `Bot server running on http://localhost:${ PORT }`);
});

// ======================================================
// INICIO DEL BOT
// ======================================================
(async () => {
  log('INFO', 'Starting trading bot1...');
  await analyzeMarket(); // Llamada inicial
  setInterval(analyzeMarket, checkInterval);
})();