import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import Binance, { CandleChartInterval, CandleChartInterval_LT, OrderType } from 'binance-api-node';
import { ATR, BollingerBands, EMA, MACD, RSI, Stochastic, StochasticRSI } from 'technicalindicators';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import WebSocket from 'ws';
import axios from "axios";

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
  QUANTITY = '0.0001',
  CHECK_INTERVAL = '60000',
  STOP_LOSS_PERCENT = '0.2',
  TAKE_PROFIT_PERCENT = '0.05',
  STOCHRSI_RSI_PERIOD = '14',
  STOCHRSI_STOCH_PERIOD = '9',
  STOCHRSI_K = '3',
  STOCHRSI_D = '3',
  STOCHRSI_BUY_LIMIT = '30',
  STOCHRSI_SELL_LIMIT = '70',
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
  await db.exec(`CREATE TABLE IF NOT EXISTS transactions
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
  await db.exec(`CREATE TABLE IF NOT EXISTS status
                 (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     position TEXT NOT NULL,
                     entryPrice REAL,
                     lastSignal TEXT NOT NULL,
                     balance_USD REAL NOT NULL,
                     balance_BTC REAL NOT NULL
                 );
  `);

  // language=SQL format=false
  await db.exec(`CREATE TABLE IF NOT EXISTS analytics
                (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    indicator TEXT NOT NULL,
                    value REAL NOT NULL,
                    timestamp TEXT NOT NULL
                );
  `);
}

// Variables de estado
let position: 'LONG' | 'FLAT' = 'FLAT';
let entryPrice: number | null = null;
let balance_USD = 300;
let balance_BTC = 0;
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

async function saveStatus(position = 'FLAT', entryPrice = null, lastSignal = 'HOLD', balance = balance_USD, balance2 = balance_BTC) {
  await db.run(`INSERT INTO status (position, entryPrice, lastSignal, balance_USD, balance_BTC)
                VALUES (?, ?, ?, ?, ?)`, [ position, entryPrice, lastSignal, balance, balance2 ]);
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
function generateSignal(indicators: any) {
  const { rsiValues, macdValues, bbValues, stochValues, stochRsiValues, atrValues } = indicators;

  if (!rsiValues || !macdValues || !bbValues || !stochValues || atrValues.length === 0) return 'HOLD';

  const latestRSI = rsiValues[rsiValues.length - 1];
  const latestMACD = macdValues[macdValues.length - 1];
  const latestBB = bbValues[bbValues.length - 1];

  const recentATRValues = atrValues.slice(-10);
  const avgATR = recentATRValues.reduce((sum, value) => sum + value, 0) / recentATRValues.length;
  const atrFactor = Math.max(1, avgATR / 50);

  const dynamicBuyLimit = 40 + atrFactor;
  const dynamicSellLimit = 70 - atrFactor;

  if (!latestRSI || !latestMACD || !latestBB) return 'HOLD';

  const macdHistogram = latestMACD.MACD - latestMACD.signal;
  const macdThreshold = 0.5 * Math.abs(latestMACD.MACD);

  if (latestRSI < dynamicBuyLimit && macdHistogram > macdThreshold) {
    console.log(`\x1b[32m Dynamic BUY signal: RSI ${ latestRSI } < ${ dynamicBuyLimit } and MACD Histogram ${ macdHistogram } > Threshold ${ macdThreshold } \x1b[0m`);
    return 'BUY';
  }

  if (latestRSI > dynamicSellLimit && macdHistogram < -macdThreshold) {
    console.log(`\x1b[31m Dynamic SELL signal: RSI ${ latestRSI } > ${ dynamicSellLimit } and MACD Histogram ${ macdHistogram } < -Threshold ${ macdThreshold } \x1b[0m`);
    return 'SELL';
  }

  console.log(`\x1b[33m HOLD: RSI ${ latestRSI } [buy ${ dynamicBuyLimit.toFixed(2) }] - [sell ${ dynamicSellLimit.toFixed(2) }], MACD Histogram ${ macdHistogram } [> ${ macdThreshold } or < -${ macdThreshold }] \x1b[0m`);
  return 'HOLD';
}

// Ejecutar orden de compra real en Binance (opcional)
async function realBuy(price: number) {
  if (SIMULATE_TRADES) {
    const order = {
      symbol: SYMBOL,
      side: 'BUY',
      quantity: balance_BTC.toString(),
      type: OrderType.MARKET,
    }

    console.log(`\x1b[42m Simulated BUY executed: ${ JSON.stringify(order) } \x1b[0m`);
    return;
  }
  try {
    const order = await client.order({
      symbol: SYMBOL,
      side: 'BUY',
      quantity: balance_BTC.toString(),
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
    console.log(`\x1b[41m Simulated SELL executed: ${ JSON.stringify({ symbol: SYMBOL, side: 'SELL', quantity: balance_BTC }) } \x1b[0m`);
    return;
  }
  try {
    const order = await client.order({
      symbol: SYMBOL,
      side: 'SELL',
      quantity: balance_BTC.toString(),
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
  balance_BTC = balance_USD / price;
  balance_USD = 0;

  await realBuy(price);
  await saveTransaction('BUY', price, parseFloat(balance_USD.toString()), balance_USD, 0);

  console.log(`Opened position at ${ price }`);

  await saveStatus(position, entryPrice, 'BUY', balance_USD, balance_BTC);
}

// Cerrar posición (simulado o real)
async function closePosition(price: number) {
  if (!entryPrice) return;

  const pnl = (price - entryPrice) * parseFloat(balance_BTC.toString());
  balance_USD = price * parseFloat(balance_BTC.toString());

  await saveTransaction('SELL', price, balance_BTC, balance_USD, pnl);
  await realSell(price);

  balance_BTC = 0;
  position = 'FLAT';
  entryPrice = null;

  console.log(`Closed position at ${ price } with PnL: ${ pnl }`);

  await saveStatus(position, entryPrice, 'SELL', balance_USD, balance_BTC);
}


// Estructura global del order book
interface OrderBook {
  bids: { [price: string]: number };
  asks: { [price: string]: number };
}

const orderBook: OrderBook = {
  bids: {},
  asks: {}
};

let lastUpdateId: number | null = null;
let connected = false;
let updatesBuffer: any[] = [];

// Conectarse al stream de profundidad de Binance
async function getSnapshot() {
  const limit = 1000;
  const url = `https://api.binance.com/api/v3/depth?symbol=${ SYMBOL }&limit=${ limit }`;
  const response = await axios.get(url);
  const data = response.data;

  // Reset orderBook
  orderBook.bids = {};
  orderBook.asks = {};

  data.bids.forEach(([ price, quantity ]: [ string, string ]) => {
    orderBook.bids[price] = parseFloat(quantity);
  });

  data.asks.forEach(([ price, quantity ]: [ string, string ]) => {
    orderBook.asks[price] = parseFloat(quantity);
  });

  lastUpdateId = data.lastUpdateId;
}

function applyUpdate(bidUpdates: [ string, string ][], askUpdates: [ string, string ][]) {
  // Actualizar bids
  bidUpdates.forEach(([ price, quantity ]) => {
    const qty = parseFloat(quantity);
    if (qty === 0) {
      delete orderBook.bids[price];
    } else {
      orderBook.bids[price] = qty;
    }
  });

  // Actualizar asks
  askUpdates.forEach(([ price, quantity ]) => {
    const qty = parseFloat(quantity);
    if (qty === 0) {
      delete orderBook.asks[price];
    } else {
      orderBook.asks[price] = qty;
    }
  });
}

function processBufferedUpdates() {
  updatesBuffer.sort((a, b) => a.u - b.u);

  for ( const update of updatesBuffer ) {
    if (lastUpdateId && update.U <= lastUpdateId + 1 && update.u >= lastUpdateId + 1) {
      // Ahora podemos aplicar esta actualización
      applyUpdate(update.b, update.a);
      lastUpdateId = update.u;
    } else if (lastUpdateId && update.u < lastUpdateId) {
      // Update viejo, ignorar
      continue;
    } else if (lastUpdateId && update.U > lastUpdateId + 1) {
      // Hay un gap, necesitamos re-sincronizar
      console.log('Gap detected, resyncing order book...');
      return resyncOrderBook();
    }
  }

  // Limpiar el buffer
  updatesBuffer = [];
}

async function resyncOrderBook() {
  console.log('Resyncing order book...');
  await getSnapshot();
  processBufferedUpdates();
}

function connectOrderBookStream() {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${ SYMBOL.toLowerCase() }@depth`);

  ws.on('open', async () => {
    console.log('Connected to order book stream. Getting initial snapshot...');
    await getSnapshot();
    connected = true;
    // Intentar procesar updates que llegaron antes del snapshot
    processBufferedUpdates();
  });

  ws.on('message', (data) => {
    const depthUpdate = JSON.parse(data.toString());

    // depthUpdate tendrá campos como:
    // U: firstUpdateId
    // u: finalUpdateId
    // pu: previousUpdateId
    // b: [ [price, qty], ...]
    // a: [ [price, qty], ...]
    const { U, u, pu, b, a } = depthUpdate;

    // Si aún no tenemos el snapshot listo, agregar al buffer
    if (!connected || lastUpdateId === null) {
      updatesBuffer.push({ U, u, pu, b, a });
      return;
    }

    // Si u <= lastUpdateId, significa que es una actualización antigua. Ignorar.
    if (u <= lastUpdateId) {
      return;
    }

    // Si hay un gap
    if (U > lastUpdateId + 1) {
      console.log('Gap detected, resyncing order book...');
      updatesBuffer.push({ U, u, pu, b, a });
      return resyncOrderBook();
    }

    // Ahora sí, podemos aplicar la actualización
    applyUpdate(b, a);
    lastUpdateId = u;
  });

  ws.on('error', (err) => {
    console.error('Order book stream error:', err);
  });

  ws.on('close', () => {
    console.log('Order book stream closed. Reconnecting...');
    connected = false;
    setTimeout(connectOrderBookStream, 1000);
  });
}

function analyzeOrderBookRefined(atrValues: number[]): 'BUY' | 'SELL' | 'HOLD' {
  // Número de niveles a analizar
  const LEVELS_TO_ANALYZE = 10;

  // Calcular volatilidad (ATR) promedio reciente para dinamizar el umbral
  const recentATR = atrValues.slice(-10); // últimos 10 valores de ATR, por ejemplo
  const avgATR = recentATR.reduce((sum, val) => sum + val, 0) / recentATR.length || 1;

  // Umbral base
  let baseThreshold = 1.5;
  // Ajustamos el umbral inversamente proporcional a la volatilidad: mayor ATR, mayor el umbral
  const dynamicThreshold = baseThreshold + (avgATR / 100);
  // Este es un ejemplo arbitrario. Podrías afinar esta fórmula según tu criterio.

  // Extraer los mejores precios
  const bidPrices = Object.keys(orderBook.bids).map(p => parseFloat(p)).sort((a, b) => b - a);
  const askPrices = Object.keys(orderBook.asks).map(p => parseFloat(p)).sort((a, b) => a - b);

  if (bidPrices.length === 0 || askPrices.length === 0) {
    return 'HOLD';
  }

  const bestBid = bidPrices[0];
  const bestAsk = askPrices[0];

  // Tomar los primeros N niveles de cada lado
  const topBidPrices = bidPrices.slice(0, LEVELS_TO_ANALYZE);
  const topAskPrices = askPrices.slice(0, LEVELS_TO_ANALYZE);

  // Ponderar volumen por cercanía al mejor precio
  // A menor distancia al mejor bid/ask, mayor peso
  let weightedBidsVolume = 0;
  for ( let i = 0; i < topBidPrices.length; i++ ) {
    const price = topBidPrices[i];
    const volume = orderBook.bids[price.toFixed(8)];
    const distance = (bestAsk - price) / bestAsk;

    const weight = 1 - distance;
    weightedBidsVolume += volume * Math.max(weight, 0.1);
  }

  let weightedAsksVolume = 0;
  for ( let i = 0; i < topAskPrices.length; i++ ) {
    const price = topAskPrices[i];
    const volume = orderBook.asks[price.toFixed(8)];
    const distance = (price - bestBid) / bestBid;

    const weight = 1 - distance;
    weightedAsksVolume += volume * Math.max(weight, 0.1);
  }

  // Agregar trailing stop para evitar pérdidas excesivas
  let trailingStopPrice: number | null = null;

  function updateTrailingStop(currentPrice: number) {
    const stopLossBuffer = avgATR * 2; // Ejemplo: 2x ATR
    if (trailingStopPrice === null || currentPrice - stopLossBuffer > trailingStopPrice) {
      trailingStopPrice = currentPrice - stopLossBuffer;
    }
  }

  const currentPrice = (bestBid + bestAsk) / 2; // Precio promedio actual
  updateTrailingStop(currentPrice);

  if (trailingStopPrice !== null && currentPrice < trailingStopPrice) {
    return 'SELL';
  }

  // usamos el volumen ponderado
  // Si weightedBidsVolume > dynamicThreshold * weightedAsksVolume => BUY
  // Si weightedAsksVolume > dynamicThreshold * weightedBidsVolume => SELL
  // De lo contrario HOLD.

  if (weightedBidsVolume > dynamicThreshold * weightedAsksVolume) {
    console.log(`\x1b[32m Order book signal: BUY. Weighted Bids: ${ weightedBidsVolume.toFixed(2) }, Weighted Asks: ${ weightedAsksVolume.toFixed(2) }, Threshold: ${ dynamicThreshold.toFixed(2) } \x1b[0m`);
    return 'BUY';
  } else if (weightedAsksVolume > dynamicThreshold * weightedBidsVolume) {
    console.log(`\x1b[31m Order book signal: SELL. Weighted Bids: ${ weightedBidsVolume.toFixed(2) }, Weighted Asks: ${ weightedAsksVolume.toFixed(2) }, Threshold: ${ dynamicThreshold.toFixed(2) } \x1b[0m`);
    return 'SELL';
  } else {
    console.log('\x1b[33m Order book signal: HOLD \x1b[0m');
    return 'HOLD';
  }
}

async function analyzeMarket() {
  console.log('\x1b[2mAnalyzing market...\x1b[0m');
  const candles = await getCandleData();
  const indicators = calculateIndicators(candles);

  lastPrice = candles[candles.length - 1]?.close;

  // Señal basada en indicadores técnicos
  const signal = generateSignal(indicators);

  // Señal basada en order book (volumen y liquidez)
  const orderBookSignal = analyzeOrderBookRefined(indicators.atrValues);

  // Combinar señales:
  // Por ejemplo, solo entrar en BUY si tanto indicadores como orderbook dan BUY
  let finalSignal = orderBookSignal;
  if (signal === 'BUY' || signal === 'HOLD') {
    if (orderBookSignal === 'BUY') {
      finalSignal = 'BUY';
    }
  } else if (signal === 'SELL' || signal === 'HOLD') {
    if (orderBookSignal === 'SELL') {
      finalSignal = 'SELL';
    }
  }

  // Lógica de Stop Loss y Take Profit
  if (position === 'LONG' && entryPrice) {
    const currentPrice = lastPrice;
    const stopLossPrice = entryPrice * (1 - parseFloat(STOP_LOSS_PERCENT));
    const takeProfitPrice = entryPrice * (1 + parseFloat(TAKE_PROFIT_PERCENT));

    // Si el precio actual cae por debajo del Stop Loss, cerramos la posición
    if (currentPrice <= stopLossPrice) {
      console.log(`\x1b[31m Stop Loss alcanzado. Cerrando posición. Precio actual: ${ currentPrice }, Stop Loss: ${ stopLossPrice } \x1b[0m`);
      await closePosition(currentPrice);
      return; // Importante salir de la función después de cerrar la posición
    }

    // Si el precio actual sube por encima del Take Profit, cerramos la posición
    if (currentPrice >= takeProfitPrice) {
      console.log(`\x1b[32m Take Profit alcanzado. Cerrando posición. Precio actual: ${ currentPrice }, Take Profit: ${ takeProfitPrice } \x1b[0m`);
      await closePosition(currentPrice);
      return; // Salimos de la función después de cerrar la posición
    }
  }

  // Si no se disparó ni Stop Loss ni Take Profit, seguimos con la lógica normal
  lastSignal = finalSignal;
  if (finalSignal === 'BUY' && position === 'FLAT') {
    await openPosition(lastPrice);
  } else if (finalSignal === 'SELL' && position === 'LONG') {
    await closePosition(lastPrice);
  } else {
    lastSignal = 'HOLD';
  }
}

// Servidor Koa
const app = new Koa();
const router = new Router();

router.get('/status', async (ctx) => {
  let profitability = await db.all(`
      WITH hourlyData AS (SELECT strftime('%Y-%m-%d %H:00:00', time) AS hour, SUM (pnl) AS profitPerHour
      FROM transactions
      WHERE operation = 'SELL'
      GROUP BY strftime('%Y-%m-%d %H:00:00', time)
          ),
          initialBalanceData AS (
      SELECT
          strftime('%Y-%m-%d %H:00:00', time) AS hour, MIN (balance) AS initialBalance
      FROM transactions
      WHERE operation = 'SELL'
      GROUP BY strftime('%Y-%m-%d %H:00:00', time)
          ),
          finalBalanceData AS (
      SELECT
          strftime('%Y-%m-%d %H:00:00', time) AS hour, MAX (balance) AS finalBalance
      FROM transactions
      WHERE operation = 'SELL'
      GROUP BY strftime('%Y-%m-%d %H:00:00', time)
          )
      SELECT hd.hour,
             hd.profitPerHour,
             ibd.initialBalance,
             fbd.finalBalance,
             CASE
                 WHEN ibd.initialBalance > 0 THEN (hd.profitPerHour / ibd.initialBalance) * 100
                 ELSE NULL
                 END                                               AS profitPercentage,
             (SELECT AVG(pnl)
              FROM transactions
              WHERE operation = 'SELL'
                AND pnl > 0
                AND strftime('%Y-%m-%d %H:00:00', time) = hd.hour) AS averagePositive,
             (SELECT AVG(pnl)
              FROM transactions
              WHERE operation = 'SELL'
                AND pnl < 0
                AND strftime('%Y-%m-%d %H:00:00', time) = hd.hour) AS averageNegative
      FROM hourlyData hd
               LEFT JOIN initialBalanceData ibd
                         ON hd.hour = ibd.hour
               LEFT JOIN finalBalanceData fbd
                         ON hd.hour = fbd.hour
      ORDER BY hd.hour;
  `)

  profitability = profitability.map((profit => ({
    hour: new Date(profit.hour).toLocaleString(),
    ...profit
  })))
  ctx.body = { position, entryPrice, lastSignal, balance: balance_USD, btc: balance_BTC, profitability };
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

function extractIp() {
  const { exec } = require('child_process');
  exec('curl ifconfig.me', (err, stdout, stderr) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`Public IP: ${ stdout }`);
  });
}

app
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods());

const PORT = 3002;
app.listen(PORT, async () => {
  extractIp();
  connectOrderBookStream();

  await initializeDatabase();

  if (justOpened) {
    justOpened = false;
    const status = await db.all(`SELECT *
                                 FROM status
                                 ORDER BY id DESC LIMIT 1`);

    if (status?.length > 0) {
      position = status[0].position;
      entryPrice = status[0].entryPrice;
      lastSignal = status[0].lastSignal;
      balance_USD = status[0].balance_USD;
      balance_BTC = status[0].balance_BTC;
    } else {
      console.log('No previous status found');
    }
  }

  // Cargar balances desde binance
  const accountInfo = await client.accountInfo();
  balance_BTC = parseFloat(accountInfo.balances.find((b) => b.asset === 'BTC')?.free || '0');
  balance_USD = parseFloat(accountInfo.balances.find((b) => b.asset === 'USDT')?.free || '0');

  console.log('Current balances:', balance_BTC, 'BTC', balance_USD, 'USD');

  console.log(`Bot running on http://localhost:${ PORT }`);
  setInterval(analyzeMarket, parseInt(CHECK_INTERVAL, 10));
});
