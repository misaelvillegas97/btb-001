import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import Binance, { CandleChartInterval, CandleChartInterval_LT, OrderType } from 'binance-api-node';
import { ATR, BollingerBands, EMA, MACD, RSI, Stochastic, StochasticRSI } from 'technicalindicators';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

dotenv.config();

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
  STOP_LOSS_PERCENT = '0.02',
  TAKE_PROFIT_PERCENT = '0.05',
  STOCHRSI_RSI_PERIOD = '14',
  STOCHRSI_STOCH_PERIOD = '9',
  STOCHRSI_K = '3',
  STOCHRSI_D = '3',
  STOCHRSI_BUY_LIMIT = '20',
  STOCHRSI_SELL_LIMIT = '80',
  SIMULATE_TRADES = 'true',
} = process.env;

const client = Binance({
  apiKey: BINANCE_API_KEY,
  apiSecret: BINANCE_API_SECRET,
});

// Configuración SQLite
let db;

async function initializeDatabase() {
  db = await open({
    filename: 'trading_bot.db',
    driver: sqlite3.Database,
  });

  // Unificamos el schema, incluyendo todos los campos necesarios.
  // Mantendremos la tabla transactions y analytics del primer bot.
  // language=SQL format=false
  await db.exec(`
      CREATE TABLE IF NOT EXISTS transactions
      (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation TEXT NOT NULL, -- BUY o SELL
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          quantity REAL NOT NULL,
          balance REAL NOT NULL,
          pnl REAL NOT NULL,
          time TEXT NOT NULL
      );
  `);

  // language=SQL format=false
  await db.exec(`
      CREATE TABLE IF NOT EXISTS analytics
      (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          indicator TEXT NOT NULL,
          value REAL NOT NULL,
          timestamp TEXT NOT NULL
      );
  `);

  await db.exec(`
      CREATE TABLE IF NOT EXISTS status
      (
          id
          INTEGER
          PRIMARY
          KEY
          AUTOINCREMENT,
          position
          TEXT
          NOT
          NULL,
          entryPrice
          REAL,
          lastSignal
          TEXT
          NOT
          NULL,
          balance
          REAL
          NOT
          NULL
      );
  `);
}

// Variables de estado
let position: 'LONG' | 'FLAT' = 'FLAT';
let entryPrice: number | null = null;
let balance = 1000;
let lastSignal = 'HOLD';
let lastPrice: number | null = null;
let justOpened = true;

// Función para registrar transacciones
async function saveTransaction(
  operation: 'BUY' | 'SELL',
  price: number,
  quantity: number,
  balance: number,
  pnl: number,
) {
  await db.run(
    `INSERT INTO transactions (operation, symbol, price, quantity, balance, pnl, time)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ operation, SYMBOL, price, quantity, balance, pnl, new Date().toISOString() ],
  );
}

// Función para guardar análisis
async function saveAnalytics(indicator: string, value: number) {
  await db.run(
    `INSERT INTO analytics (symbol, indicator, value, timestamp)
     VALUES (?, ?, ?, ?)`,
    [ SYMBOL, indicator, value, new Date().toISOString() ],
  );
}

async function saveStatus() {
  await db.run(`INSERT INTO status (position, entryPrice, lastSignal, balance)`)
}

// Obtener datos de velas
async function getCandleData(limit = 200) {
  const rawCandles = await client.candles({ symbol: SYMBOL, interval: INTERVAL as CandleChartInterval_LT, limit });
  return rawCandles.map((c) => ({
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
  }));
}

// Calcular indicadores
function calculateIndicators(candles: any[]) {
  const closePrices = candles.map((c) => c.close);
  const highPrices = candles.map((c) => c.high);
  const lowPrices = candles.map((c) => c.low);

  // Indicadores del primer bot
  const emaValues = EMA.calculate({ period: parseInt(EMA_PERIOD, 10), values: closePrices });
  const rsiValues = RSI.calculate({ period: parseInt(RSI_PERIOD, 10), values: closePrices });
  const macdValues = MACD.calculate({
    SimpleMAOscillator: false, SimpleMASignal: false,
    fastPeriod: parseInt(MACD_FAST, 10),
    slowPeriod: parseInt(MACD_SLOW, 10),
    signalPeriod: parseInt(MACD_SIGNAL, 10),
    values: closePrices
  });
  const bbValues = BollingerBands.calculate({
    period: parseInt(BB_PERIOD, 10),
    stdDev: parseFloat(BB_STDDEV),
    values: closePrices,
  });
  const stochValues = Stochastic.calculate({
    high: highPrices,
    low: lowPrices,
    close: closePrices,
    period: 14,
    signalPeriod: 3,
  });
  const atrValues = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });

  // Cálculo de StochasticRSI del segundo bot
  const stochRsiValues = StochasticRSI.calculate({
    values: closePrices,
    rsiPeriod: parseInt(STOCHRSI_RSI_PERIOD, 10),
    stochasticPeriod: parseInt(STOCHRSI_STOCH_PERIOD, 10),
    kPeriod: parseInt(STOCHRSI_K, 10),
    dPeriod: parseInt(STOCHRSI_D, 10),
  });

  return { emaValues, rsiValues, macdValues, bbValues, stochValues, atrValues, stochRsiValues };
}

// Generar señal integrando ambos bots
function generateSignal(indicators: any, latestClose: number) {
  const { rsiValues, macdValues, bbValues, stochValues, stochRsiValues } = indicators;

  if (!rsiValues || !macdValues || !bbValues || !stochValues) return 'HOLD';

  const latestRSI = rsiValues[rsiValues.length - 1];
  const latestMACD = macdValues[macdValues.length - 1];
  const latestBB = bbValues[bbValues.length - 1];

  // Stochastic RSI
  let latestStochRSI: number | null = null;
  if (stochRsiValues && stochRsiValues.length > 0) {
    const lastStochRSIValue = stochRsiValues[stochRsiValues.length - 1];
    latestStochRSI = lastStochRSIValue ? lastStochRSIValue.stochRSI : null;
  }

  // Guardar analytics
  if (latestStochRSI !== null) {
    saveAnalytics('StochasticRSI', latestStochRSI);
  }
  if (latestRSI !== undefined) {
    saveAnalytics('RSI', latestRSI);
  }

  if (!latestRSI || !latestMACD || !latestBB) return 'HOLD';

  // Lógica combinada:
  // Del primer bot: RSI < 40 + MACD > 0 => BUY; RSI > 70 + MACD < 0 => SELL
  // Del segundo bot: StochRSI < STOCHRSI_BUY_LIMIT => BUY; StochRSI > STOCHRSI_SELL_LIMIT => SELL
  // Podemos fusionar la lógica para confirmar la señal.

  // Señal base del primer bot
  let baseSignal = 'HOLD';

  console.log('RSI:', latestRSI, 'MACD:', latestMACD.MACD, 'Signal:', latestMACD.signal);
  if (latestRSI < 40 && latestMACD.MACD > latestMACD.signal) {
    console.log('BUY signal from bot 1');
    return 'BUY';
  }

  if (latestRSI > 60 && latestMACD.MACD < latestMACD.signal) {
    console.log('SELL signal from bot 1');
    return 'SELL';
  }

  // Incorporar la lógica StochRSI: si el StochRSI confirma la señal base, la aplicamos.
  // Si no hay confirmación, mantenemos HOLD.
  if (latestStochRSI !== null) {
    if (baseSignal === 'BUY' && latestStochRSI < parseFloat(STOCHRSI_BUY_LIMIT)) {
      console.log('BUY signal confirmed by StochRSI');
      return 'BUY';
    } else if (baseSignal === 'SELL' && latestStochRSI > parseFloat(STOCHRSI_SELL_LIMIT)) {
      console.log('SELL signal confirmed by StochRSI');
      return 'SELL';
    }
  }

  return 'HOLD';
}

// Ejecutar orden de compra real en Binance (opcional)
async function realBuy(price: number) {
  if (SIMULATE_TRADES) {
    const order = {
      symbol: SYMBOL,
      side: 'BUY',
      quantity: QUANTITY,
      type: OrderType.MARKET,
    }

    console.log('Simulated BUY executed:', order);
    return;
  }
  try {
    const order = await client.order({
      symbol: SYMBOL,
      side: 'BUY',
      quantity: QUANTITY,
      type: OrderType.MARKET,
    });
    console.log('Real BUY executed:', order);
  } catch ( err ) {
    console.error('Error executing real buy:', err);
  }
}

// Ejecutar orden de venta real en Binance (opcional)
async function realSell(price: number) {
  if (SIMULATE_TRADES) {
    console.log('Simulated SELL executed:', { symbol: SYMBOL, side: 'SELL', quantity: QUANTITY });
    return;
  }
  try {
    const order = await client.order({
      symbol: SYMBOL,
      side: 'SELL',
      quantity: QUANTITY,
      type: OrderType.MARKET,
    });
    console.log('Real SELL executed:', order);
  } catch ( err ) {
    console.error('Error executing real sell:', err);
  }
}

// Abrir posición (simulado o real)
async function openPosition(price: number) {
  position = 'LONG';
  entryPrice = price;
  // Opcionalmente ejecutar compra real
  await realBuy(price);

  await saveTransaction('BUY', price, parseFloat(QUANTITY), balance, 0);
  console.log(`Opened position at ${ price }`);

  // Persist status
  await saveStatus();
}

// Cerrar posición (simulado o real)
async function closePosition(price: number) {
  if (!entryPrice) return;

  const pnl = (price - entryPrice) * parseFloat(QUANTITY);
  balance += pnl;

  await saveTransaction('SELL', price, parseFloat(QUANTITY), balance, pnl);

  // Opcionalmente ejecutar venta real
  await realSell(price);

  position = 'FLAT';
  entryPrice = null;

  console.log(`Closed position at ${ price } with PnL: ${ pnl }`);

  await saveStatus();
}

// Análisis de mercado
async function analyzeMarket() {
  const candles = await getCandleData();
  const indicators = calculateIndicators(candles);

  lastPrice = candles[candles.length - 1]?.close;

  const signal = generateSignal(indicators, lastPrice);

  // Lógica de Stop Loss y Take Profit
  if (position === 'LONG' && entryPrice) {
    const currentPrice = lastPrice;
    const stopLossPrice = entryPrice * (1 - parseFloat(STOP_LOSS_PERCENT));
    const takeProfitPrice = entryPrice * (1 + parseFloat(TAKE_PROFIT_PERCENT));

    // Si el precio actual cae por debajo del Stop Loss, cerramos la posición
    if (currentPrice <= stopLossPrice) {
      console.log(`Stop Loss alcanzado. Cerrando posición. Precio actual: ${ currentPrice }, Stop Loss: ${ stopLossPrice }`);
      await closePosition(currentPrice);
      return; // Importante salir de la función después de cerrar la posición
    }

    // Si el precio actual sube por encima del Take Profit, cerramos la posición
    if (currentPrice >= takeProfitPrice) {
      console.log(`Take Profit alcanzado. Cerrando posición. Precio actual: ${ currentPrice }, Take Profit: ${ takeProfitPrice }`);
      await closePosition(currentPrice);
      return; // Salimos de la función después de cerrar la posición
    }
  }

  // Si no se disparó ni Stop Loss ni Take Profit, seguimos con la lógica normal
  lastSignal = signal;
  if (signal === 'BUY' && position === 'FLAT') {
    await openPosition(lastPrice);
  } else if (signal === 'SELL' && position === 'LONG') {
    await closePosition(lastPrice);
  }
}

// Servidor Koa
const app = new Koa();
const router = new Router();

router.get('/status', async (ctx) => {
  ctx.body = { position, entryPrice, lastSignal, balance };
});

router.get('/transactions', async (ctx) => {
  ctx.body = await db.all(`SELECT *
                           FROM transactions
                           ORDER BY time DESC LIMIT 50`);
});

router.get('/analytics', async (ctx) => {
  ctx.body = await db.all(`SELECT *
                           FROM analytics
                           ORDER BY timestamp DESC LIMIT 50`);
});

app
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods());

const PORT = 3002;
app.listen(PORT, async () => {
  // extract my public ip
  const { exec } = require('child_process');
  exec('curl ifconfig.me', (err, stdout, stderr) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`Public IP: ${ stdout }`);
  });

  await initializeDatabase();

  if (justOpened) {
    const status = await db.run(`SELECT *
                                 FROM status
                                 ORDER BY id DESC LIMIT 1`);

    if (status) {
      position = status.position;
      entryPrice = status.entryPrice;
      lastSignal = status.lastSignal;
      balance = status.balance;
    }
  }

  console.log(`Bot running on http://localhost:${ PORT }`);
  setInterval(analyzeMarket, parseInt(CHECK_INTERVAL, 10));
});
