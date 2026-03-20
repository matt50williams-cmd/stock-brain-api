import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ============================================
// CLIENTS & KEYS
// ============================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const FMP_KEY     = process.env.FMP_API_KEY;
const AV_KEY      = process.env.ALPHA_VANTAGE_API_KEY;

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FMP_BASE     = "https://financialmodelingprep.com/api/v3";

// ============================================
// UTILITIES
// ============================================
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function safeParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim()); }
  catch { return null; }
}

function getTier(price) {
  if (price <= 3)  return "low";
  if (price <= 50) return "mid";
  return "high";
}

// Clean and validate ticker symbols
// Removes anything that isn't letters (A-Z)
// Rejects tickers with numbers, spaces, or longer than 5 chars
function cleanTicker(ticker) {
  if (!ticker || typeof ticker !== "string") return null;
  // Remove any non-letter characters
  const cleaned = ticker.replace(/[^A-Z]/gi, "").toUpperCase();
  // Valid US tickers are 1-5 capital letters only
  if (cleaned.length < 1 || cleaned.length > 5) return null;
  // Reject if original had numbers mixed in (like GOOGL9, NVDA1)
  if (/\d/.test(ticker)) return null;
  return cleaned;
}

// Filter and deduplicate a list of tickers
function validateTickers(tickers) {
  if (!Array.isArray(tickers)) return [];
  const seen = new Set();
  const valid = [];
  for (const t of tickers) {
    const clean = cleanTicker(t);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      valid.push(clean);
    }
  }
  return valid;
}

function getTierWeights(tier) {
  if (tier === "low")  return "Momentum(25) Volume(25) Catalyst(20) Sentiment(15) Risk(15)";
  if (tier === "mid")  return "Momentum(20) Volume(20) Catalyst(20) Technical(20) Sentiment(20)";
  return "Trend(25) Earnings(20) Institutional(20) Technical(20) Sector(15)";
}

// Always ensure low_range < high_range — swap if needed
function fixPriceRange(buyPrice, sellPrice) {
  const low  = Math.min(buyPrice || 0, sellPrice || 0);
  const high = Math.max(buyPrice || 0, sellPrice || 0);
  return { low_range: low, high_range: high };
}

// MA signal interpreter — gives plain-English context
function interpretMAs(price, ma20, ma50, ma200) {
  const signals = [];
  if (!price) return { label: "unknown", signals: [] };

  if (ma20 && ma50) {
    if (price > ma20 && price > ma50) signals.push("above 20MA & 50MA — short/medium uptrend");
    else if (price < ma20 && price < ma50) signals.push("below 20MA & 50MA — short/medium downtrend");
    else if (price > ma20 && price < ma50) signals.push("above 20MA but below 50MA — recovering");
    else if (price < ma20 && price > ma50) signals.push("below 20MA but above 50MA — pullback in uptrend");
  }

  if (ma50 && ma200) {
    if (ma50 > ma200) signals.push("50MA above 200MA — Golden Cross (bullish long term)");
    else signals.push("50MA below 200MA — Death Cross (bearish long term)");
  }

  if (ma200) {
    if (price > ma200) signals.push("above 200MA — long term uptrend");
    else signals.push("below 200MA — long term downtrend");
  }

  // Best entry signal
  let label = "neutral";
  if (ma50 && price <= ma50 * 1.02 && price >= ma50 * 0.98) label = "at 50MA support — key entry zone";
  else if (ma20 && price <= ma20 * 1.01) label = "near 20MA — short term entry";
  else if (ma200 && price <= ma200 * 1.02 && price >= ma200 * 0.96) label = "at 200MA — major support";
  else if (ma20 && ma50 && ma200 && price > ma20 && price > ma50 && price > ma200) label = "bullish — above all 3 MAs";
  else if (ma20 && ma50 && ma200 && price < ma20 && price < ma50 && price < ma200) label = "bearish — below all 3 MAs";

  return { label, signals };
}

// ============================================
// FINNHUB HELPERS
// ============================================
async function finnhubGet(endpoint, params = {}) {
  try {
    const url = new URL(`${FINNHUB_BASE}${endpoint}`);
    url.searchParams.set("token", FINNHUB_KEY);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function getQuote(symbol) {
  const d = await finnhubGet("/quote", { symbol });
  if (!d || !d.c) return null;
  return {
    current_price: d.c, open: d.o, high: d.h, low: d.l,
    previous_close: d.pc, change: d.d, change_percent: d.dp
  };
}

async function getProfile(symbol) {
  const d = await finnhubGet("/stock/profile2", { symbol });
  return {
    name: d?.name || symbol,
    industry: d?.finnhubIndustry || "Unknown",
    market_cap: d?.marketCapitalization || 0,
    exchange: d?.exchange || ""
  };
}

async function getNews(symbol) {
  const to   = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const d    = await finnhubGet("/company-news", { symbol, from, to });
  return (d || []).slice(0, 4).map((n) => n.headline).join("; ") || "No recent news";
}

async function getMarketNews() {
  const d = await finnhubGet("/news", { category: "general" });
  return (d || []).slice(0, 6).map((n) => n.headline).join("; ") || "No market news";
}

async function getFinancials(symbol) {
  const d = await finnhubGet("/stock/metric", { symbol, metric: "all" });
  const m = d?.metric || {};
  return {
    week52High:    m["52WeekHigh"],
    week52Low:     m["52WeekLow"],
    beta:          m["beta"],
    peRatio:       m["peBasicExclExtraTTM"],
    avgVolume10d:  m["10DayAverageTradingVolume"],
    avgVolume3m:   m["3MonthAverageTradingVolume"],
    revenueGrowth: m["revenueGrowthTTMYoy"],
    epsGrowth:     m["epsGrowth3Y"],
  };
}

async function getTechnicals(symbol) {
  try {
    const d = await finnhubGet("/scan/technical-indicator", { symbol, resolution: "D" });
    return {
      signal: d?.technicalAnalysis?.signal || "neutral",
      buy:    d?.technicalAnalysis?.count?.buy    || 0,
      sell:   d?.technicalAnalysis?.count?.sell   || 0,
    };
  } catch { return { signal: "unknown", buy: 0, sell: 0 }; }
}

async function getInsiderSummary(symbol) {
  try {
    const d    = await finnhubGet("/stock/insider-transactions", { symbol });
    const txns = d?.data || [];
    const buys  = txns.filter((t) => t.transactionType === "P - Purchase").length;
    const sells = txns.filter((t) => t.transactionType === "S - Sale").length;
    return `Buys: ${buys}, Sells: ${sells}`;
  } catch { return "N/A"; }
}

async function getCongressSummary(symbol) {
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
    const to   = new Date().toISOString().split("T")[0];
    const d    = await finnhubGet("/stock/congressional-trading", { symbol, from, to });
    const count = (d?.data || []).length;
    return count > 0 ? `${count} congressional trade(s) in last 90 days` : "None";
  } catch { return "N/A"; }
}

// Unusual options activity — smart money signal
async function getOptionsActivity(symbol) {
  try {
    const d = await finnhubGet("/stock/option-chain", { symbol });
    if (!d || !d.data) return null;

    // Look for unusual volume vs open interest
    const unusual = [];
    for (const option of (d.data || []).slice(0, 50)) {
      if (option.volume && option.openInterest && option.volume > option.openInterest * 2) {
        unusual.push({
          type:         option.type,         // call or put
          strike:       option.strike,
          expiration:   option.expirationDate,
          volume:       option.volume,
          openInterest: option.openInterest,
          ratio:        Math.round((option.volume / option.openInterest) * 10) / 10,
        });
      }
    }

    if (unusual.length === 0) return { signal: "normal", unusual_count: 0 };

    const calls = unusual.filter((o) => o.type === "call").length;
    const puts  = unusual.filter((o) => o.type === "put").length;
    return {
      signal:         calls > puts ? "unusual_call_buying" : puts > calls ? "unusual_put_buying" : "mixed_unusual",
      unusual_count:  unusual.length,
      calls:          calls,
      puts:           puts,
      smart_money:    calls > puts ? "bullish positioning" : "bearish positioning",
      top_activity:   unusual.slice(0, 3),
    };
  } catch { return null; }
}

// ============================================
// MOVING AVERAGES — 20MA, 50MA, 200MA
// All from Finnhub candles (free)
// ============================================
async function getMovingAverages(symbol) {
  try {
    const to   = Math.floor(Date.now() / 1000);
    // 400 days back to ensure enough data for 200MA
    const from = Math.floor((Date.now() - 400 * 86400000) / 1000);

    const d = await finnhubGet("/stock/candle", { symbol, resolution: "D", from, to });
    if (!d) { console.log(`MA ${symbol}: no Finnhub response`); return null; }
    if (d.s !== "ok") { console.log(`MA ${symbol}: status=${d.s}`); return null; }
    if (!d.c || d.c.length < 20) { console.log(`MA ${symbol}: only ${d.c?.length} candles`); return null; }

    const closes = d.c;
    const n      = closes.length;
    console.log(`MA ${symbol}: ${n} candles received`);

    const calcMA = (period) => {
      if (n < period) return null;
      const slice = closes.slice(n - period);
      return Math.round((slice.reduce((s, p) => s + p, 0) / period) * 100) / 100;
    };

    const ma20  = calcMA(20);
    const ma50  = calcMA(50);
    const ma200 = calcMA(200);
    const currentPrice = closes[n - 1];

    const interpretation = interpretMAs(currentPrice, ma20, ma50, ma200);

    return {
      ma20,
      ma50,
      ma200,
      ma_label:   interpretation.label,
      ma_signals: interpretation.signals,
      pct_from_ma20:  ma20  ? Math.round(((currentPrice - ma20)  / ma20)  * 10000) / 100 : null,
      pct_from_ma50:  ma50  ? Math.round(((currentPrice - ma50)  / ma50)  * 10000) / 100 : null,
      pct_from_ma200: ma200 ? Math.round(((currentPrice - ma200) / ma200) * 10000) / 100 : null,
    };
  } catch (err) {
    console.error(`MA ${symbol} error:`, err.message);
    return null;
  }
}

// ============================================
// RSI from Alpha Vantage (best effort)
// ============================================
async function getRSI(symbol) {
  if (!AV_KEY) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${AV_KEY}`;
    const res = await fetch(url);
    const d   = await res.json();
    const rsiData = d?.["Technical Analysis: RSI"];
    if (!rsiData) return null;
    const latest = Object.values(rsiData)[0];
    const rsi = parseFloat(latest?.RSI);
    return {
      rsi14:       rsi,
      rsi_signal:  rsi > 70 ? "overbought" : rsi < 30 ? "oversold" : "neutral",
      rsi_note:    rsi > 70 ? "caution — extended" : rsi < 30 ? "potential entry — oversold" : "normal range",
    };
  } catch { return null; }
}

// ============================================
// FMP — Market movers & index levels
// ============================================
async function fmpGet(endpoint) {
  try {
    const res = await fetch(`${FMP_BASE}${endpoint}?apikey=${FMP_KEY}`);
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

async function getTopGainers()  {
  const d = await fmpGet("/stock_market/gainers");
  return (d || []).slice(0, 15).map((s) => ({ ticker: s.symbol, name: s.name, price: s.price, change_pct: s.changesPercentage }));
}

async function getMostActive()  {
  const d = await fmpGet("/stock_market/actives");
  return (d || []).slice(0, 15).map((s) => ({ ticker: s.symbol, name: s.name, price: s.price, change_pct: s.changesPercentage }));
}

async function getSectorPerformance() {
  const d = await fmpGet("/sector-performance");
  return (d || []).map((s) => ({ sector: s.sector, change_pct: s.changesPercentage }));
}

// Real index levels for market outlook
async function getIndexLevels() {
  try {
    const tickers = ["^GSPC", "^IXIC", "^DJI", "^VIX"]; // S&P, Nasdaq, Dow, VIX
    const results = {};
    for (const t of tickers) {
      await delay(150);
      const q = await getQuote(t);
      if (q) results[t] = q;
    }
    return {
      sp500:  results["^GSPC"]  ? { price: results["^GSPC"].current_price,  change_pct: results["^GSPC"].change_percent  } : null,
      nasdaq: results["^IXIC"]  ? { price: results["^IXIC"].current_price,  change_pct: results["^IXIC"].change_percent  } : null,
      dow:    results["^DJI"]   ? { price: results["^DJI"].current_price,   change_pct: results["^DJI"].change_percent   } : null,
      vix:    results["^VIX"]   ? { price: results["^VIX"].current_price,   change_pct: results["^VIX"].change_percent   } : null,
    };
  } catch { return {}; }
}

async function getEconomicCalendar() {
  try {
    const from = new Date().toISOString().split("T")[0];
    const to   = new Date(Date.now() + 5 * 86400000).toISOString().split("T")[0];
    const d    = await finnhubGet("/calendar/economic", { from, to });
    return (d?.economicCalendar || []).slice(0, 8).map((e) => ({
      event: e.event, impact: e.impact, time: e.time, country: e.country
    }));
  } catch { return []; }
}

// ============================================
// GROK — X/Twitter sentiment on picks
// Single call, all tickers at once
// ============================================
async function getGrokSentiment(tickers) {
  if (!process.env.GROK_API_KEY) return null;
  try {
    const tickerList = tickers.join(", ");
    const response = await grok.chat.completions.create({
      model: "grok-3-fast",
      messages: [{
        role: "user",
        content: `Search X (Twitter/social) RIGHT NOW for sentiment on these stocks: ${tickerList}.
For each ticker give: sentiment (bullish/bearish/neutral), buzz level (high/medium/low), and one key thing traders are saying.
Return ONLY JSON: {"tickers": {"AAPL": {"sentiment": "bullish", "buzz": "medium", "note": "..."}, ...}}`
      }],
    });
    return safeParseJSON(response.choices?.[0]?.message?.content || "");
  } catch (err) {
    console.error("Grok error:", err.message);
    return null;
  }
}

// ============================================
// GEMINI — Free AI calls
// ============================================
async function geminiCall(prompt) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const d = await r.json();
    return safeParseJSON(d.candidates?.[0]?.content?.parts?.[0]?.text || "");
  } catch { return null; }
}

// ============================================
// COLLECT ALL DATA FOR ONE STOCK
// ============================================
async function collectStockData(symbol) {
  const quote = await getQuote(symbol);
  if (!quote) return null;

  // Run all data fetches in parallel
  const [profile, news, financials, technicals, insider, congress, maData, optionsData, rsiData] =
    await Promise.all([
      getProfile(symbol),
      getNews(symbol),
      getFinancials(symbol),
      getTechnicals(symbol),
      getInsiderSummary(symbol),
      getCongressSummary(symbol),
      getMovingAverages(symbol),
      getOptionsActivity(symbol),
      getRSI(symbol),
    ]);

  return {
    ticker:          symbol,
    company_name:    profile.name,
    industry:        profile.industry,
    market_cap:      profile.market_cap,
    exchange:        profile.exchange,
    current_price:   quote.current_price,
    change_percent:  quote.change_percent,
    open:            quote.open,
    high:            quote.high,
    low:             quote.low,
    previous_close:  quote.previous_close,
    week52High:      financials.week52High,
    week52Low:       financials.week52Low,
    peRatio:         financials.peRatio,
    beta:            financials.beta,
    avgVolume10d:    financials.avgVolume10d,
    revenueGrowth:   financials.revenueGrowth,
    epsGrowth:       financials.epsGrowth,
    technical_signal:  technicals.signal,
    technical_buys:    technicals.buy,
    technical_sells:   technicals.sell,
    // Moving averages
    ma20:            maData?.ma20   || null,
    ma50:            maData?.ma50   || null,
    ma200:           maData?.ma200  || null,
    ma_label:        maData?.ma_label   || null,
    ma_signals:      maData?.ma_signals || [],
    pct_from_ma20:   maData?.pct_from_ma20  || null,
    pct_from_ma50:   maData?.pct_from_ma50  || null,
    pct_from_ma200:  maData?.pct_from_ma200 || null,
    // RSI
    rsi14:           rsiData?.rsi14      || null,
    rsi_signal:      rsiData?.rsi_signal || null,
    rsi_note:        rsiData?.rsi_note   || null,
    // Smart money
    options_signal:  optionsData?.signal       || null,
    options_smart:   optionsData?.smart_money  || null,
    options_unusual: optionsData?.unusual_count || 0,
    // Context
    recent_news:  news,
    insider:      insider,
    congressional: congress,
    tier: getTier(quote.current_price),
  };
}

// ============================================
// IN-MEMORY STORAGE
// ============================================
let lastScanResults = { low: [], mid: [], high: [], all: [], updated_at: null };

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({
    status:   "Stock Brain API v7.0 — Professional Grade",
    version:  "7.0.0",
    features: [
      "20MA + 50MA + 200MA with signals",
      "Unusual options activity (smart money)",
      "Grok X/Twitter sentiment on picks",
      "Full market outlook with index levels + VIX",
      "AI morning briefing",
      "FMP real movers discovery",
      "OpenAI + Gemini parallel analysis",
      "Live price endpoints"
    ]
  });
});

// ============================================
// LIVE PRICE — Single ticker
// ============================================
app.get("/price/:ticker", async (req, res) => {
  try {
    const symbol = req.params.ticker.toUpperCase();
    const [quote, maData] = await Promise.all([getQuote(symbol), getMovingAverages(symbol)]);
    if (!quote) return res.status(404).json({ error: `No price data for ${symbol}` });

    return res.json({
      ticker:          symbol,
      current_price:   quote.current_price,
      change:          quote.change,
      change_percent:  quote.change_percent,
      open:            quote.open,
      high:            quote.high,
      low:             quote.low,
      previous_close:  quote.previous_close,
      ma20:            maData?.ma20   || null,
      ma50:            maData?.ma50   || null,
      ma200:           maData?.ma200  || null,
      ma_label:        maData?.ma_label || null,
      pct_from_ma20:   maData?.pct_from_ma20  || null,
      pct_from_ma50:   maData?.pct_from_ma50  || null,
      pct_from_ma200:  maData?.pct_from_ma200 || null,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Price fetch failed", details: err.message });
  }
});

// ============================================
// BATCH PRICES — Poll every 60 seconds for live feel
// ============================================
app.post("/prices", async (req, res) => {
  try {
    const { tickers } = req.body;
    if (!tickers || !Array.isArray(tickers)) return res.status(400).json({ error: "Send tickers array" });

    const results = [];
    for (const ticker of tickers.slice(0, 20)) {
      try {
        await delay(150);
        const q = await getQuote(ticker.toUpperCase());
        if (!q) continue;
        results.push({
          ticker:         ticker.toUpperCase(),
          current_price:  q.current_price,
          change:         q.change,
          change_percent: q.change_percent,
          high:           q.high,
          low:            q.low,
          updated_at:     new Date().toISOString(),
        });
      } catch { continue; }
    }

    return res.json({ count: results.length, prices: results, updated_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Batch price failed", details: err.message });
  }
});

// ============================================
// MARKET OUTLOOK — Full professional briefing
// Runs at top of /check-market
// Also available standalone
// ============================================
async function buildMarketOutlook() {
  const [indexes, sectors, econ, marketNews] = await Promise.all([
    getIndexLevels(),
    getSectorPerformance(),
    getEconomicCalendar(),
    getMarketNews(),
  ]);

  // Sort sectors
  const sortedSectors = [...sectors].sort((a, b) =>
    parseFloat(b.change_pct) - parseFloat(a.change_pct)
  );
  const leadingSectors  = sortedSectors.slice(0, 3);
  const laggingSectors  = sortedSectors.slice(-3).reverse();
  const highImpactEvents = econ.filter((e) => e.impact === "high");

  // VIX interpretation
  let vixNote = "";
  if (indexes.vix?.price) {
    const v = indexes.vix.price;
    if      (v < 15) vixNote = "VIX below 15 — market is calm, low fear";
    else if (v < 20) vixNote = "VIX 15-20 — normal volatility";
    else if (v < 30) vixNote = "VIX 20-30 — elevated fear, caution warranted";
    else             vixNote = `VIX above 30 — high fear, volatile market`;
  }

  // OpenAI writes the actual morning briefing
  const briefingPrompt = `You are a professional market strategist writing a morning briefing for a stock trader.

Market data right now:
S&P 500: ${indexes.sp500 ? `$${indexes.sp500.price} (${indexes.sp500.change_pct}%)` : "unavailable"}
Nasdaq:  ${indexes.nasdaq ? `$${indexes.nasdaq.price} (${indexes.nasdaq.change_pct}%)` : "unavailable"}
Dow:     ${indexes.dow ? `$${indexes.dow.price} (${indexes.dow.change_pct}%)` : "unavailable"}
VIX:     ${indexes.vix ? `${indexes.vix.price} — ${vixNote}` : "unavailable"}

Leading sectors today: ${leadingSectors.map((s) => `${s.sector} (${s.change_pct}%)`).join(", ")}
Lagging sectors today: ${laggingSectors.map((s) => `${s.sector} (${s.change_pct}%)`).join(", ")}

High-impact macro events this week: ${highImpactEvents.length > 0 ? highImpactEvents.map((e) => `${e.event} (${e.time})`).join(", ") : "None scheduled"}

Market headlines: ${marketNews}

Write a 3-4 sentence professional morning briefing. Tell the trader: what the market is doing, why, what to watch for, and overall tone (risk-on or risk-off). Be direct and specific. No fluff.

Return ONLY JSON: {
  "outlook": "Bullish|Neutral|Bearish",
  "briefing": "your 3-4 sentence briefing here",
  "risk_tone": "risk-on|risk-off|mixed",
  "key_watch": "the single most important thing to watch today"
}`;

  const briefingResult = await openai.responses.create({
    model: "gpt-4o-mini",
    tools: [{ type: "web_search" }],
    input: briefingPrompt,
  }).then((r) => safeParseJSON(r.output_text)).catch(() => null);

  return {
    outlook:          briefingResult?.outlook    || "Neutral",
    briefing:         briefingResult?.briefing   || "Market data unavailable.",
    risk_tone:        briefingResult?.risk_tone  || "mixed",
    key_watch:        briefingResult?.key_watch  || "",
    indexes: {
      sp500:  indexes.sp500,
      nasdaq: indexes.nasdaq,
      dow:    indexes.dow,
      vix:    indexes.vix,
      vix_note: vixNote,
    },
    sectors: {
      leading:  leadingSectors,
      lagging:  laggingSectors,
      all:      sectors,
    },
    macro_events:    highImpactEvents,
    all_events:      econ,
    updated_at:      new Date().toISOString(),
  };
}

app.get("/market-outlook", async (req, res) => {
  try {
    const outlook = await buildMarketOutlook();
    return res.json(outlook);
  } catch (err) {
    return res.status(500).json({ error: "Market outlook failed", details: err.message });
  }
});

// ============================================
// RESEARCH ONE STOCK — Full professional analysis
// ============================================
app.post("/research-stock", async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker is required" });

    const symbol = ticker.toUpperCase();
    const data   = await collectStockData(symbol);
    if (!data) return res.status(404).json({ error: `No data found for ${symbol}` });

    const maContext = data.ma50
      ? `MA Analysis: ${data.ma_label} | 20MA:$${data.ma20}(${data.pct_from_ma20}%) 50MA:$${data.ma50}(${data.pct_from_ma50}%) 200MA:$${data.ma200 || "N/A"}(${data.pct_from_ma200 || "N/A"}%)`
      : "Moving averages: insufficient data";

    const optionsContext = data.options_signal !== "normal" && data.options_signal
      ? `Options: ${data.options_signal} — ${data.options_smart} (${data.options_unusual} unusual strikes)`
      : "Options: normal activity";

    const context = `STOCK: ${data.ticker} (${data.company_name}) | ${data.industry}
Price: $${data.current_price} (${data.change_percent}%) | Open:$${data.open} High:$${data.high} Low:$${data.low}
52wk: $${data.week52Low} - $${data.week52High} | PE:${data.peRatio} | Beta:${data.beta}
${maContext}
RSI: ${data.rsi14 || "N/A"} — ${data.rsi_note || "N/A"}
Technical signal: ${data.technical_signal} (${data.technical_buys} buy / ${data.technical_sells} sell indicators)
${optionsContext}
Insider activity: ${data.insider}
Congressional trades: ${data.congressional}
News: ${data.recent_news}
Tier: ${data.tier} | Scoring weights: ${getTierWeights(data.tier)}`;

    const [oaiResult, gemResult] = await Promise.all([
      openai.responses.create({
        model:  "gpt-4o-mini",
        tools:  [{ type: "web_search" }],
        input:  `You are the LEAD stock analyst. Search the web for breaking news about ${symbol}.
${context}
Key MA rules: if price is near 50MA support that's a buy zone. If below 200MA, extra caution needed.
If RSI is oversold (<30) near support, that's a strong entry signal.
If unusual call buying detected, that's a bullish smart money signal.
Calculate buy_price and sell_price based on MA levels and support/resistance. NO stop_price.
Return ONLY JSON: {"score":0,"buy_price":0,"sell_price":0,"summary":"","reasons":[],"full_research":"","news_summary":"","technical_summary":"","sentiment_summary":""}`,
      }).then((r) => safeParseJSON(r.output_text)).catch(() => null),

      geminiCall(`Independent stock analyst. Full fundamental + technical analysis.
${context}
Focus on: is the MA setup bullish or bearish? Is RSI giving an entry signal? What does smart money options activity say?
Return ONLY JSON: {"score":0,"buy_price":0,"sell_price":0,"summary":"","reasons":[],"risk_analysis":"","confidence":"low|medium|high"}`),
    ]);

    if (!oaiResult && !gemResult) return res.status(500).json({ error: "Both AIs failed" });

    const oS = oaiResult?.score || 0;
    const gS = gemResult?.score  || 0;
    const avg = (a, b) => (a && b) ? Math.round(((a + b) / 2) * 100) / 100 : (a || b || 0);
    const finalScore = (oS && gS) ? Math.round(oS * 0.6 + gS * 0.4) : (oS || gS);

    return res.json({
      ticker:          symbol,
      company_name:    data.company_name,
      industry:        data.industry,
      current_price:   data.current_price,
      change_percent:  data.change_percent,
      open:            data.open,
      high:            data.high,
      low:             data.low,
      week52High:      data.week52High,
      week52Low:       data.week52Low,
      buy_price:   avg(oaiResult?.buy_price,  gemResult?.buy_price),
      sell_price:  avg(oaiResult?.sell_price, gemResult?.sell_price),
      // NO stop_price
      ma20:            data.ma20,
      ma50:            data.ma50,
      ma200:           data.ma200,
      ma_label:        data.ma_label,
      ma_signals:      data.ma_signals,
      pct_from_ma20:   data.pct_from_ma20,
      pct_from_ma50:   data.pct_from_ma50,
      pct_from_ma200:  data.pct_from_ma200,
      rsi14:           data.rsi14,
      rsi_signal:      data.rsi_signal,
      rsi_note:        data.rsi_note,
      options_signal:  data.options_signal,
      options_smart:   data.options_smart,
      options_unusual: data.options_unusual,
      score:        finalScore,
      summary:      [oaiResult?.summary,   gemResult?.summary].filter(Boolean).join(" | "),
      reasons:      [...(oaiResult?.reasons || []), ...(gemResult?.reasons || [])].slice(0, 6),
      full_research: `OPENAI: ${oaiResult?.full_research || oaiResult?.summary || "N/A"}\n\nGEMINI: ${gemResult?.summary || "N/A"}\nRisk: ${gemResult?.risk_analysis || "None flagged"}`,
      news_summary:       oaiResult?.news_summary      || "N/A",
      sentiment_summary:  oaiResult?.sentiment_summary || "N/A",
      technical_summary:  `${data.technical_signal} | ${data.ma_label} | RSI:${data.rsi14 || "N/A"} (${data.rsi_signal || "N/A"}) | Options:${data.options_signal || "normal"}`,
      tier:         data.tier,
      is_hot_pick:  finalScore >= 95,
      openai_score: oS,
      gemini_score: gS,
      updated_at:   new Date().toISOString(),
    });
  } catch (err) {
    console.error("Research error:", err.message);
    return res.status(500).json({ error: "Research failed", details: err.message });
  }
});

// ============================================
// CHECK MARKET — Full professional scan
// ============================================
app.post("/check-market", async (req, res) => {
  try {
    // STEP 1: Market context + discovery in parallel
    const [gainers, active, marketOutlook, aiDiscovery] = await Promise.all([
      getTopGainers(),
      getMostActive(),
      buildMarketOutlook(),
      openai.responses.create({
        model: "gpt-4o-mini",
        tools: [{ type: "web_search" }],
        input: `Find today's best US stock opportunities RIGHT NOW. Search for: pre-market movers, unusual volume, breaking catalysts, momentum stocks, insider buying activity, earnings plays, government policy winners.
Return ONLY JSON: {"low":["T1","T2","T3","T4","T5","T6"],"mid":["T1","T2","T3","T4","T5","T6"],"high":["T1","T2","T3","T4","T5","T6"]}
LOW=$0.10-$3, MID=$3.01-$50, HIGH=$50.01+. Real US tickers only.`,
      }).then((r) => safeParseJSON(r.output_text)).catch(() => null),
    ]);

    // STEP 2: Build candidate lists
    const candidates = { low: [], mid: [], high: [] };
    const allMovers  = [...gainers, ...active];
    const seen       = new Set();

    for (const stock of allMovers) {
      const clean = cleanTicker(stock.ticker);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      const tier = getTier(stock.price);
      if (candidates[tier].length < 8) candidates[tier].push(clean);
    }

    if (aiDiscovery) {
      for (const tier of ["low", "mid", "high"]) {
        const validAITickers = validateTickers(aiDiscovery[tier] || []);
        for (const t of validAITickers) {
          if (!candidates[tier].includes(t) && candidates[tier].length < 12) {
            candidates[tier].push(t);
          }
        }
      }
    }

    const fallback = {
      low:  ["SNDL", "CLOV", "TELL", "HIMS", "GSAT", "SENS", "BNGO", "IDEX", "NNDM", "ZOM"],
      mid:  ["PLTR", "SOFI", "HOOD", "RIVN", "NIO",  "SNAP", "PINS", "RBLX", "DKNG", "CHPT"],
      high: ["NVDA", "AAPL", "MSFT", "TSLA", "META", "AMD",  "GOOGL", "AMZN", "NFLX", "CRM"],
    };
    for (const tier of ["low", "mid", "high"]) {
      if (candidates[tier].length < 4) {
        console.log(`Tier ${tier} had only ${candidates[tier].length} candidates — using fallback`);
        candidates[tier] = fallback[tier];
      }
    }

    const results = { low: [], mid: [], high: [] };

    // STEP 3: Collect real data + score each tier
    for (const tier of ["low", "mid", "high"]) {
      const stockDataList = [];

      for (const symbol of candidates[tier].slice(0, 10)) {
        try {
          await delay(300);
          const data = await collectStockData(symbol);
          if (data) stockDataList.push(data);
        } catch { continue; }
      }

      if (stockDataList.length === 0) continue;

      const stockSummary = JSON.stringify(stockDataList.map((s) => ({
        ticker:          s.ticker,
        company:         s.company_name,
        price:           s.current_price,
        change:          s.change_percent,
        signal:          s.technical_signal,
        ma_label:        s.ma_label,
        pct_from_ma20:   s.pct_from_ma20,
        pct_from_ma50:   s.pct_from_ma50,
        pct_from_ma200:  s.pct_from_ma200,
        rsi:             s.rsi14,
        rsi_signal:      s.rsi_signal,
        options_signal:  s.options_signal,
        options_smart:   s.options_smart,
        news:            s.recent_news,
        insider:         s.insider,
        congress:        s.congressional,
        pe:              s.peRatio,
        beta:            s.beta,
        w52h:            s.week52High,
        w52l:            s.week52Low,
      })));

      const [oaiPicks, gemPicks] = await Promise.all([
        openai.responses.create({
          model: "gpt-4o-mini",
          tools: [{ type: "web_search" }],
          input: `Pick TOP 5 ${tier} tier stocks. Score 0-100 using ${getTierWeights(tier)}.
MA rules: prefer stocks near 50MA support, above 200MA, with RSI not overbought. Unusual call buying = extra points.
Market context: ${marketOutlook.briefing}
Stocks: ${stockSummary}
Return ONLY JSON array of exactly 5:
[{"ticker":"","company_name":"","current_price":0,"buy_price":0,"sell_price":0,"score":0,"summary":"","reasons":[],"full_research":"","news_summary":"","sentiment_summary":"","technical_summary":"","tier":"${tier}","is_hot_pick":false}]`,
        }).then((r) => safeParseJSON(r.output_text)).catch(() => []),

        geminiCall(`Independent analyst. Pick YOUR top 5 ${tier} stocks. Score 0-100.
Focus: MA positioning, RSI entry signals, options smart money, insider/congressional activity.
Stocks: ${stockSummary}
Return ONLY JSON: [{"ticker":"","score":0,"buy_price":0,"sell_price":0,"risk":""}]`),
      ]);

      let tierPicks = Array.isArray(oaiPicks) ? oaiPicks : [];
      const gemArray = Array.isArray(gemPicks) ? gemPicks : [];

      for (const stock of tierPicks) {
        const real = stockDataList.find((s) => s.ticker === stock.ticker);
        if (real) {
          // Inject all real data — this is what fixes the detail page
          stock.current_price    = real.current_price;
          stock.change_percent   = real.change_percent;
          stock.company_name     = real.company_name;
          stock.industry         = real.industry;
          stock.week52High       = real.week52High;
          stock.week52Low        = real.week52Low;
          stock.ma20             = real.ma20;
          stock.ma50             = real.ma50;
          stock.ma200            = real.ma200;
          stock.ma_label         = real.ma_label;
          stock.ma_signals       = real.ma_signals;
          stock.pct_from_ma20    = real.pct_from_ma20;
          stock.pct_from_ma50    = real.pct_from_ma50;
          stock.pct_from_ma200   = real.pct_from_ma200;
          stock.rsi14            = real.rsi14;
          stock.rsi_signal       = real.rsi_signal;
          stock.rsi_note         = real.rsi_note;
          stock.options_signal   = real.options_signal;
          stock.options_smart    = real.options_smart;
          stock.options_unusual  = real.options_unusual;
          stock.insider          = real.insider;
          stock.congressional    = real.congressional;
          stock.peRatio          = real.peRatio;
          stock.beta             = real.beta;
        }

        const gem = gemArray.find((g) => g.ticker === stock.ticker);
        if (gem?.score) {
          stock.score     = Math.round(stock.score * 0.6 + gem.score * 0.4);
          if (gem.buy_price)  stock.buy_price  = Math.round(((stock.buy_price  + gem.buy_price)  / 2) * 100) / 100;
          if (gem.sell_price) stock.sell_price = Math.round(((stock.sell_price + gem.sell_price) / 2) * 100) / 100;
          if (gem.risk)       stock.risk_flag  = gem.risk;
        }

        // Force price range so low_range is always lower number
        const priceRange = fixPriceRange(stock.buy_price, stock.sell_price);
        stock.buy_price  = priceRange.low_range;
        stock.sell_price = priceRange.high_range;
        delete stock.stop_price;
        stock.tier        = tier;
        stock.is_hot_pick = stock.score >= 95;
        stock.updated_at  = new Date().toISOString();
      }

      results[tier] = tierPicks.slice(0, 5);
    }

    const allStocks = [...results.low, ...results.mid, ...results.high];
    const hotPicks  = allStocks.filter((s) => s.is_hot_pick);

    // STEP 4: Grok X/Twitter sentiment on the final picks (one call, all 15)
    const allTickers = allStocks.map((s) => s.ticker).filter(Boolean);
    const grokSentiment = allTickers.length > 0 ? await getGrokSentiment(allTickers) : null;

    // Attach Grok sentiment to each stock
    if (grokSentiment?.tickers) {
      for (const stock of allStocks) {
        const gs = grokSentiment.tickers[stock.ticker];
        if (gs) {
          stock.x_sentiment   = gs.sentiment;
          stock.x_buzz        = gs.buzz;
          stock.x_note        = gs.note;
        }
      }
    }

    // Save to memory
    lastScanResults = {
      low: results.low, mid: results.mid, high: results.high,
      all: allStocks, hot_picks: hotPicks,
      updated_at: new Date().toISOString(),
    };

    return res.json({
      market_outlook:   marketOutlook,
      sector_performance: marketOutlook.sectors.all,
      discovery_sources: {
        fmp_gainers:  gainers.length,
        fmp_active:   active.length,
        ai_discovery: aiDiscovery ? true : false,
      },
      x_sentiment:  grokSentiment,
      updated_at:   new Date().toISOString(),
      stocks:       allStocks,
      hot_picks:    hotPicks,
      low:          results.low,
      mid:          results.mid,
      high:         results.high,
    });
  } catch (err) {
    console.error("Market scan error:", err.message);
    return res.status(500).json({ error: "Market scan failed", details: err.message });
  }
});

// ============================================
// ADD & RESEARCH — Any ticker
// ============================================
app.post("/add-stock", async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker is required" });

    const symbol = ticker.toUpperCase();
    const data   = await collectStockData(symbol);
    if (!data) return res.status(404).json({ error: `No data for ${symbol}` });

    const maInfo = data.ma50
      ? `MA: ${data.ma_label} | 20MA:$${data.ma20} 50MA:$${data.ma50} 200MA:$${data.ma200 || "N/A"}`
      : "MA: insufficient data";

    const [oai, gem] = await Promise.all([
      openai.responses.create({
        model: "gpt-4o-mini",
        tools: [{ type: "web_search" }],
        input: `Analyze ${symbol}. ${maInfo}, RSI:${data.rsi14 || "N/A"} (${data.rsi_note || "N/A"}), Options:${data.options_signal || "normal"}, Signal:${data.technical_signal}, News:${data.recent_news}. Tier:${data.tier}, Weights:${getTierWeights(data.tier)}. Search for news. Return ONLY JSON: {"score":0,"buy_price":0,"sell_price":0,"summary":"","reasons":[]}`,
      }).then((r) => safeParseJSON(r.output_text)).catch(() => null),
      geminiCall(`Score ${symbol}. ${maInfo}, RSI:${data.rsi14 || "N/A"}, Options:${data.options_signal || "normal"}, Signal:${data.technical_signal}. Return ONLY JSON: {"score":0,"buy_price":0,"sell_price":0}`),
    ]);

    const avg = (a, b) => (a && b) ? Math.round(((a + b) / 2) * 100) / 100 : (a || b || 0);
    const score = (oai?.score && gem?.score) ? Math.round(oai.score * 0.6 + gem.score * 0.4) : (oai?.score || gem?.score || 50);

    return res.json({
      ticker:          symbol,
      company_name:    data.company_name,
      industry:        data.industry,
      current_price:   data.current_price,
      change_percent:  data.change_percent,
      buy_price:       avg(oai?.buy_price,  gem?.buy_price),
      sell_price:      avg(oai?.sell_price, gem?.sell_price),
      ma20:            data.ma20,
      ma50:            data.ma50,
      ma200:           data.ma200,
      ma_label:        data.ma_label,
      ma_signals:      data.ma_signals,
      pct_from_ma20:   data.pct_from_ma20,
      pct_from_ma50:   data.pct_from_ma50,
      pct_from_ma200:  data.pct_from_ma200,
      rsi14:           data.rsi14,
      rsi_signal:      data.rsi_signal,
      rsi_note:        data.rsi_note,
      options_signal:  data.options_signal,
      options_smart:   data.options_smart,
      score,
      summary:         oai?.summary || "Analysis complete",
      reasons:         oai?.reasons || [],
      full_research:   oai?.summary || "",
      news_summary:    data.recent_news,
      technical_summary: `${data.technical_signal} | ${data.ma_label} | RSI:${data.rsi14 || "N/A"}`,
      tier:            data.tier,
      is_hot_pick:     score >= 95,
      updated_at:      new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed", details: err.message });
  }
});

// ============================================
// LIGHT CHECK — Gemini + Finnhub (free)
// ============================================
app.post("/light-check", async (req, res) => {
  try {
    const { stocks } = req.body;
    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
      return res.status(400).json({ error: "Send stocks array" });
    }

    const results       = [];
    const surgeTriggered = [];

    for (const stock of stocks) {
      try {
        await delay(200);
        const symbol = stock.ticker.toUpperCase();
        const quote  = await getQuote(symbol);
        if (!quote) continue;

        const prevPrice   = stock.previous_price || quote.previous_close || 0;
        const priceChange = prevPrice > 0 ? ((quote.current_price - prevPrice) / prevPrice) * 100 : 0;

        let hasNews = false;
        try {
          const today = new Date().toISOString().split("T")[0];
          const news  = await finnhubGet("/company-news", { symbol, from: today, to: today });
          hasNews = (news || []).length >= 2;
        } catch {}

        const shouldSurge = Math.abs(priceChange) >= 3 || hasNews;
        let status = "watching";
        if (stock.buy_price  && quote.current_price <= stock.buy_price  * 1.02) status = "in_buy_zone";
        if (stock.sell_price && quote.current_price >= stock.sell_price * 0.98) status = "near_sell_target";

        results.push({
          ticker:                symbol,
          current_price:         quote.current_price,
          change:                quote.change,
          change_percent:        quote.change_percent,
          price_change_from_pick: Math.round(priceChange * 100) / 100,
          breaking_news:         hasNews,
          surge_triggered:       shouldSurge,
          previous_score:        stock.previous_score || null,
          status,
          updated_at:            new Date().toISOString(),
        });

        if (shouldSurge) surgeTriggered.push(symbol);
      } catch { continue; }
    }

    let geminiInsight = "";
    try {
      const sum = results.map((r) => `${r.ticker}:$${r.current_price}(${r.change_percent}%)`).join(",");
      const gem = await geminiCall(`Quick market pulse on these stocks: ${sum}. Any unusual moves or concerns? 2 sentences. Return JSON: {"pulse":"","alert":"none|watch|urgent"}`);
      geminiInsight = gem?.pulse || "";
    } catch {}

    return res.json({
      checked:         results.length,
      surge_triggered: surgeTriggered,
      surge_count:     surgeTriggered.length,
      gemini_insight:  geminiInsight,
      stocks:          results,
      updated_at:      new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Light check failed", details: err.message });
  }
});

// ============================================
// SCHEDULED LIGHT CHECK — Cron triggered
// ============================================
app.get("/scheduled-light-check", async (req, res) => {
  try {
    if (lastScanResults.all.length === 0) {
      return res.json({ message: "No scan results stored yet. Run /check-market first.", checked: 0 });
    }

    const stocks = lastScanResults.all.map((s) => ({
      ticker:         s.ticker,
      previous_price: s.current_price,
      previous_score: s.score,
      buy_price:      s.buy_price,
      sell_price:     s.sell_price,
    }));

    const results        = [];
    const surgeTriggered = [];

    for (const stock of stocks) {
      try {
        await delay(200);
        const symbol = stock.ticker.toUpperCase();
        const quote  = await getQuote(symbol);
        if (!quote) continue;

        const prevPrice   = stock.previous_price || quote.previous_close || 0;
        const priceChange = prevPrice > 0 ? ((quote.current_price - prevPrice) / prevPrice) * 100 : 0;

        let hasNews = false;
        try {
          const today = new Date().toISOString().split("T")[0];
          const news  = await finnhubGet("/company-news", { symbol, from: today, to: today });
          hasNews = (news || []).length >= 2;
        } catch {}

        const shouldSurge = Math.abs(priceChange) >= 3 || hasNews;
        let status = "watching";
        if (stock.buy_price  && quote.current_price <= stock.buy_price  * 1.02) status = "in_buy_zone";
        if (stock.sell_price && quote.current_price >= stock.sell_price * 0.98) status = "near_sell_target";

        results.push({
          ticker:                 symbol,
          current_price:          quote.current_price,
          change:                 quote.change,
          change_percent:         quote.change_percent,
          price_change_from_pick: Math.round(priceChange * 100) / 100,
          breaking_news:          hasNews,
          surge_triggered:        shouldSurge,
          previous_score:         stock.previous_score,
          status,
          updated_at:             new Date().toISOString(),
        });

        if (shouldSurge) surgeTriggered.push(symbol);
      } catch { continue; }
    }

    let geminiInsight = "";
    try {
      const sum = results.map((r) => `${r.ticker}:$${r.current_price}(${r.change_percent}%)`).join(",");
      const gem = await geminiCall(`Pulse check: ${sum}. Any urgent moves? Return JSON: {"pulse":"","alert":"none|watch|urgent"}`);
      geminiInsight = gem?.pulse || "";
    } catch {}

    // Auto surge checks
    const surgeResults = [];
    for (const symbol of surgeTriggered.slice(0, 3)) {
      try {
        const quote = await getQuote(symbol);
        if (!quote) continue;
        const news = await getNews(symbol);
        const r = await openai.responses.create({
          model: "gpt-4o-mini",
          tools: [{ type: "web_search" }],
          input: `URGENT: ${symbol} flagged. Price:$${quote.current_price}(${quote.change_percent}%). News:${news}. Search web. Real or noise? Return JSON: {"ticker":"${symbol}","alert_level":"low|medium|high|critical","what_happened":"","recommendation":""}`,
        });
        const sr = safeParseJSON(r.output_text);
        if (sr) surgeResults.push(sr);
      } catch { continue; }
    }

    return res.json({
      checked:         results.length,
      surge_triggered: surgeTriggered,
      surge_count:     surgeTriggered.length,
      surge_results:   surgeResults,
      gemini_insight:  geminiInsight,
      stocks:          results,
      updated_at:      new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Scheduled light check failed", details: err.message });
  }
});

// ============================================
// SURGE CHECK
// ============================================
app.post("/surge-check", async (req, res) => {
  try {
    const { ticker, reason } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker required" });
    const symbol = ticker.toUpperCase();
    const quote  = await getQuote(symbol);
    if (!quote) return res.status(404).json({ error: `No data for ${symbol}` });
    const news = await getNews(symbol);

    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search" }],
      input: `URGENT: ${symbol} surge detected. Reason: ${reason || "auto"}. Price:$${quote.current_price}(${quote.change_percent}%). News:${news}. Search web RIGHT NOW. Real move or noise? Return JSON: {"ticker":"${symbol}","current_price":${quote.current_price},"alert_level":"low|medium|high|critical","what_happened":"","recommendation":"","new_buy_price":0,"new_sell_price":0}`,
    });
    const result = safeParseJSON(r.output_text) || {
      ticker: symbol, current_price: quote.current_price,
      alert_level: "medium", what_happened: "Analysis unavailable", recommendation: "Monitor manually"
    };
    result.updated_at = new Date().toISOString();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Surge check failed", details: err.message });
  }
});

// ============================================
// INDEXES — Always-on S&P500, Nasdaq, Dow, VIX
// ============================================
app.get("/indexes", async (req, res) => {
  try {
    const [sp500, nasdaq, dow, vix] = await Promise.all([
      getQuote("^GSPC"),
      getQuote("^IXIC"),
      getQuote("^DJI"),
      getQuote("^VIX"),
    ]);
    return res.json({
      sp500:  sp500  ? { price: sp500.current_price,  change_pct: sp500.change_percent,  change: sp500.change  } : null,
      nasdaq: nasdaq ? { price: nasdaq.current_price, change_pct: nasdaq.change_percent, change: nasdaq.change } : null,
      dow:    dow    ? { price: dow.current_price,    change_pct: dow.change_percent,    change: dow.change    } : null,
      vix:    vix    ? { price: vix.current_price,    change_pct: vix.change_percent,    change: vix.change,
        note: vix.current_price < 15 ? "Low fear" :
              vix.current_price < 20 ? "Normal volatility" :
              vix.current_price < 30 ? "Elevated fear" : "High fear" } : null,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Index fetch failed", details: err.message });
  }
});

// ============================================
// LATEST RESULTS
// ============================================
app.get("/latest", (req, res) => {
  if (!lastScanResults.updated_at) {
    return res.json({ message: "No scan results yet. Run /check-market first." });
  }
  return res.json(lastScanResults);
});

// ============================================
// START
// ============================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Stock Brain API v7.0 running on port ${port}`);
  console.log(`MAs: 20MA + 50MA + 200MA with signals`);
  console.log(`Smart money: Unusual options activity`);
  console.log(`Sentiment: Grok X/Twitter on final picks`);
  console.log(`Market: Full outlook with indexes + VIX + briefing`);
  console.log(`Endpoints: /check-market /research-stock /add-stock /light-check /surge-check /scheduled-light-check /latest /market-outlook /price/:ticker /prices`);
});

// ============================================
// BACKGROUND PRICE REFRESH — 30 sec during market hours
// One Finnhub call per stock regardless of user count
// ============================================
function isMarketHours() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const timeUTC = now.getUTCHours() * 60 + now.getUTCMinutes();
  return timeUTC >= 810 && timeUTC <= 1200; // 13:30-20:00 UTC = 6:30am-1pm PT
}

async function refreshPricesInBackground() {
  if (!lastScanResults.all || lastScanResults.all.length === 0) return;
  if (!isMarketHours()) return;
  try {
    const tickers = lastScanResults.all.map((s) => s.ticker).filter(Boolean);
    const updatedPrices = {};
    for (const ticker of tickers) {
      try {
        await delay(200);
        const quote = await getQuote(ticker);
        if (quote) updatedPrices[ticker] = { ...quote, updated_at: new Date().toISOString() };
      } catch { continue; }
    }
    // Update all stocks in memory
    for (const stock of lastScanResults.all) {
      if (updatedPrices[stock.ticker]) {
        stock.current_price  = updatedPrices[stock.ticker].current_price;
        stock.change         = updatedPrices[stock.ticker].change;
        stock.change_percent = updatedPrices[stock.ticker].change_percent;
        stock.price_updated_at = updatedPrices[stock.ticker].updated_at;
      }
    }
    for (const tier of ["low", "mid", "high"]) {
      for (const stock of (lastScanResults[tier] || [])) {
        if (updatedPrices[stock.ticker]) {
          stock.current_price  = updatedPrices[stock.ticker].current_price;
          stock.change         = updatedPrices[stock.ticker].change;
          stock.change_percent = updatedPrices[stock.ticker].change_percent;
          stock.price_updated_at = updatedPrices[stock.ticker].updated_at;
        }
      }
    }
    lastScanResults.prices_refreshed_at = new Date().toISOString();
    console.log(`[${new Date().toISOString()}] Prices refreshed for ${tickers.length} stocks`);
  } catch (err) {
    console.error("Price refresh error:", err.message);
  }
}

// Start the 30-second background refresh
setInterval(refreshPricesInBackground, 30000);
console.log("Background price refresh armed — every 30 seconds during market hours");
