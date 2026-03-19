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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;
const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY;

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

// ============================================
// DATA SOURCE 1: FINNHUB (quotes, news, insider, congress, technicals)
// ============================================
async function finnhubGet(endpoint, params = {}) {
  const url = new URL(`${FINNHUB_BASE}${endpoint}`);
  url.searchParams.set("token", FINNHUB_KEY);
  for (const [key, val] of Object.entries(params)) url.searchParams.set(key, val);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  return res.json();
}

async function getQuote(symbol) {
  const d = await finnhubGet("/quote", { symbol });
  if (!d || !d.c) return null;
  return { current_price: d.c, open: d.o, high: d.h, low: d.l, previous_close: d.pc, change: d.d, change_percent: d.dp };
}

async function getProfile(symbol) {
  const d = await finnhubGet("/stock/profile2", { symbol });
  return { name: d?.name || symbol, industry: d?.finnhubIndustry || "Unknown", market_cap: d?.marketCapitalization || 0 };
}

async function getNews(symbol) {
  const to = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const d = await finnhubGet("/company-news", { symbol, from, to });
  return (d || []).slice(0, 3).map((n) => n.headline).join("; ") || "No recent news";
}

async function getMarketNews() {
  const d = await finnhubGet("/news", { category: "general" });
  return (d || []).slice(0, 5).map((n) => n.headline).join("; ") || "No market news";
}

async function getFinancials(symbol) {
  const d = await finnhubGet("/stock/metric", { symbol, metric: "all" });
  const m = d?.metric || {};
  return { week52High: m["52WeekHigh"], week52Low: m["52WeekLow"], beta: m["beta"], peRatio: m["peBasicExclExtraTTM"], avgVolume10d: m["10DayAverageTradingVolume"] };
}

async function getTechnicals(symbol) {
  try {
    const d = await finnhubGet("/scan/technical-indicator", { symbol, resolution: "D" });
    return { signal: d?.technicalAnalysis?.signal || "neutral", buy: d?.technicalAnalysis?.count?.buy || 0, sell: d?.technicalAnalysis?.count?.sell || 0 };
  } catch { return { signal: "unknown", buy: 0, sell: 0 }; }
}

async function getInsiderSummary(symbol) {
  try {
    const d = await finnhubGet("/stock/insider-transactions", { symbol });
    const txns = d?.data || [];
    return `Buys: ${txns.filter((t) => t.transactionType === "P - Purchase").length}, Sells: ${txns.filter((t) => t.transactionType === "S - Sale").length}`;
  } catch { return "N/A"; }
}

async function getCongressSummary(symbol) {
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];
    const d = await finnhubGet("/stock/congressional-trading", { symbol, from, to });
    const count = (d?.data || []).length;
    return count > 0 ? `${count} congressional trade(s)` : "None";
  } catch { return "N/A"; }
}

// ============================================
// DATA SOURCE 2: FMP (market movers - gainers, losers, active)
// ============================================
async function fmpGet(endpoint) {
  try {
    const res = await fetch(`${FMP_BASE}${endpoint}?apikey=${FMP_KEY}`);
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

async function getTopGainers() {
  const data = await fmpGet("/stock_market/gainers");
  return (data || []).slice(0, 15).map((s) => ({
    ticker: s.symbol, name: s.name, price: s.price, change_pct: s.changesPercentage,
  }));
}

async function getTopLosers() {
  const data = await fmpGet("/stock_market/losers");
  return (data || []).slice(0, 10).map((s) => ({
    ticker: s.symbol, name: s.name, price: s.price, change_pct: s.changesPercentage,
  }));
}

async function getMostActive() {
  const data = await fmpGet("/stock_market/actives");
  return (data || []).slice(0, 15).map((s) => ({
    ticker: s.symbol, name: s.name, price: s.price, change_pct: s.changesPercentage,
  }));
}

async function getSectorPerformance() {
  const data = await fmpGet("/sector-performance");
  return (data || []).slice(0, 11).map((s) => ({
    sector: s.sector, change_pct: s.changesPercentage,
  }));
}

// ============================================
// DATA SOURCE 3: ALPHA VANTAGE (technical indicators backup)
// ============================================
async function getAlphaVantageSMA(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=SMA&symbol=${symbol}&interval=daily&time_period=20&series_type=close&apikey=${AV_KEY}`;
    const res = await fetch(url);
    const d = await res.json();
    const smaData = d?.["Technical Analysis: SMA"];
    if (!smaData) return null;
    const latest = Object.values(smaData)[0];
    return { sma20: parseFloat(latest?.SMA) || null };
  } catch { return null; }
}

async function getAlphaVantageRSI(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${AV_KEY}`;
    const res = await fetch(url);
    const d = await res.json();
    const rsiData = d?.["Technical Analysis: RSI"];
    if (!rsiData) return null;
    const latest = Object.values(rsiData)[0];
    return { rsi14: parseFloat(latest?.RSI) || null };
  } catch { return null; }
}

// ============================================
// HELPERS
// ============================================
function getTier(price) {
  if (price <= 3) return "low";
  if (price <= 50) return "mid";
  return "high";
}

function getTierWeights(tier) {
  if (tier === "low") return "Momentum(25) Volume(25) Catalyst(20) Sentiment(15) Risk(15)";
  if (tier === "mid") return "Momentum(20) Volume(20) Catalyst(20) Technical(20) Sentiment(20)";
  return "Trend(25) Earnings(20) Institutional(20) Technical(20) Sector(15)";
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function safeParseJSON(text) {
  try { return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim()); }
  catch { return null; }
}

async function geminiCall(prompt) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
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

// Collect all data for one stock from all 3 sources
async function collectStockData(symbol) {
  const quote = await getQuote(symbol);
  if (!quote) return null;

  const [profile, news, financials, technicals, insider, congress] = await Promise.all([
    getProfile(symbol), getNews(symbol), getFinancials(symbol),
    getTechnicals(symbol), getInsiderSummary(symbol), getCongressSummary(symbol),
  ]);

  // Alpha Vantage for extra technicals (only if key exists, rate limited)
  let avData = {};
  if (AV_KEY) {
    try {
      const [sma, rsi] = await Promise.all([getAlphaVantageSMA(symbol), getAlphaVantageRSI(symbol)]);
      avData = { sma20: sma?.sma20 || null, rsi14: rsi?.rsi14 || null };
    } catch { avData = {}; }
  }

  return {
    ticker: symbol, company_name: profile.name, industry: profile.industry,
    current_price: quote.current_price, change_percent: quote.change_percent,
    open: quote.open, high: quote.high, low: quote.low,
    week52High: financials.week52High, week52Low: financials.week52Low,
    peRatio: financials.peRatio, beta: financials.beta, avgVolume10d: financials.avgVolume10d,
    technical_signal: technicals.signal, technical_buys: technicals.buy, technical_sells: technicals.sell,
    sma20: avData.sma20 || null, rsi14: avData.rsi14 || null,
    recent_news: news, insider: insider, congressional: congress,
    tier: getTier(quote.current_price),
  };
}

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({ status: "Stock Brain API v6.0 — 3 Data Sources + 2 AIs", version: "6.0.0" });
});

// ============================================
// RESEARCH ONE STOCK — OpenAI + Gemini full parallel analysis
// ============================================
app.post("/research-stock", async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker is required" });

    const symbol = ticker.toUpperCase();
    const data = await collectStockData(symbol);
    if (!data) return res.status(404).json({ error: `No data found for ${symbol}` });

    const context = `REAL DATA: ${data.ticker} (${data.company_name}) | ${data.industry}
Price: $${data.current_price} (${data.change_percent}%) | Open: $${data.open} | High: $${data.high} | Low: $${data.low}
52wk: $${data.week52Low}-$${data.week52High} | PE: ${data.peRatio} | Beta: ${data.beta} | Vol10d: ${data.avgVolume10d}M
Technical: ${data.technical_signal} (Buy:${data.technical_buys} Sell:${data.technical_sells})
${data.sma20 ? `SMA20: $${data.sma20}` : ""} ${data.rsi14 ? `RSI14: ${data.rsi14}` : ""}
News: ${data.recent_news}
Insider: ${data.insider} | Congress: ${data.congressional}
Tier: ${data.tier} | Weights: ${getTierWeights(data.tier)}`;

    const [oaiResult, gemResult] = await Promise.all([
      openai.responses.create({
        model: "gpt-4o-mini",
        tools: [{ type: "web_search" }],
        input: `You are the LEAD analyst. Search the web for breaking news about ${symbol} and government/policy news.
${context}
Calculate buy_price, sell_price, stop_price. Return ONLY JSON:
{"score":0,"buy_price":0,"sell_price":0,"stop_price":0,"summary":"","reasons":[],"full_research":"","news_summary":"","sentiment_summary":"","technical_summary":""}`,
      }).then((r) => safeParseJSON(r.output_text)).catch(() => null),

      geminiCall(`Independent analyst. Full analysis with focus on fundamentals and risk.
${context}
Return ONLY JSON:
{"score":0,"buy_price":0,"sell_price":0,"stop_price":0,"summary":"","reasons":[],"risk_analysis":"","confidence":"low|medium|high"}`),
    ]);

    if (!oaiResult && !gemResult) return res.status(500).json({ error: "Both AIs failed" });

    const oS = oaiResult?.score || 0, gS = gemResult?.score || 0;
    const avg = (a, b) => (a && b) ? Math.round(((a + b) / 2) * 100) / 100 : (a || b || 0);

    return res.json({
      ticker: symbol, company_name: data.company_name, current_price: data.current_price,
      buy_price: avg(oaiResult?.buy_price, gemResult?.buy_price),
      sell_price: avg(oaiResult?.sell_price, gemResult?.sell_price),
      stop_price: avg(oaiResult?.stop_price, gemResult?.stop_price),
      score: (oS && gS) ? Math.round(oS * 0.6 + gS * 0.4) : (oS || gS),
      summary: [oaiResult?.summary, gemResult?.summary].filter(Boolean).join(" | "),
      reasons: [...(oaiResult?.reasons || []), ...(gemResult?.reasons || [])].slice(0, 6),
      full_research: `OPENAI: ${oaiResult?.full_research || oaiResult?.summary || "N/A"}\n\nGEMINI: ${gemResult?.summary || "N/A"}\nRisk: ${gemResult?.risk_analysis || "None flagged"}`,
      news_summary: oaiResult?.news_summary || "N/A",
      sentiment_summary: oaiResult?.sentiment_summary || "N/A",
      technical_summary: oaiResult?.technical_summary || `Signal: ${data.technical_signal}${data.rsi14 ? `, RSI: ${data.rsi14}` : ""}${data.sma20 ? `, SMA20: $${data.sma20}` : ""}`,
      tier: data.tier, is_hot_pick: ((oS && gS) ? Math.round(oS * 0.6 + gS * 0.4) : (oS || gS)) >= 95,
      openai_score: oS, gemini_score: gS, gemini_confidence: gemResult?.confidence || "unknown",
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Research error:", err.message);
    return res.status(500).json({ error: "Research failed", details: err.message });
  }
});

// ============================================
// CHECK MARKET — Real market movers from FMP + AI discovery + scoring
// ============================================
app.post("/check-market", async (req, res) => {
  try {
    // STEP 1: Pull REAL market movers from FMP + AI discovery in parallel
    const [gainers, active, sectors, marketNews, aiDiscovery] = await Promise.all([
      getTopGainers(),
      getMostActive(),
      getSectorPerformance(),
      getMarketNews(),

      // OpenAI searches web for opportunities FMP might miss
      openai.responses.create({
        model: "gpt-4o-mini",
        tools: [{ type: "web_search" }],
        input: `Find today's best stock opportunities. Search for: pre-market movers, unusual volume, breaking catalysts, trending tickers, insider buying.
Return ONLY JSON: {"low":["T1","T2","T3","T4","T5"],"mid":["T1","T2","T3","T4","T5"],"high":["T1","T2","T3","T4","T5"]}
LOW=$0.10-$3, MID=$3.01-$50, HIGH=$50.01+. Use REAL US tickers.`,
      }).then((r) => safeParseJSON(r.output_text)).catch(() => null),
    ]);

    // STEP 2: Build candidate lists from REAL data + AI suggestions
    const candidates = { low: [], mid: [], high: [] };

    // Sort FMP market movers into tiers
    const allMovers = [...gainers, ...active];
    const seen = new Set();
    for (const stock of allMovers) {
      if (seen.has(stock.ticker)) continue;
      seen.add(stock.ticker);
      const tier = getTier(stock.price);
      if (candidates[tier].length < 8) candidates[tier].push(stock.ticker);
    }

    // Add AI-discovered tickers that FMP didn't find
    if (aiDiscovery) {
      for (const tier of ["low", "mid", "high"]) {
        for (const t of (aiDiscovery[tier] || [])) {
          const upper = t.toUpperCase();
          if (!candidates[tier].includes(upper) && candidates[tier].length < 12) {
            candidates[tier].push(upper);
          }
        }
      }
    }

    // Fallback if any tier is empty
    const fallback = {
      low: ["SNDL", "CLOV", "TELL", "HIMS", "GSAT", "SENS"],
      mid: ["PLTR", "SOFI", "HOOD", "RIVN", "NIO", "SNAP"],
      high: ["NVDA", "AAPL", "MSFT", "TSLA", "META", "AMD"],
    };
    for (const tier of ["low", "mid", "high"]) {
      if (candidates[tier].length < 4) candidates[tier] = fallback[tier];
    }

    const results = { low: [], mid: [], high: [] };

    // STEP 3: For each tier, collect real data and have both AIs score
    for (const tier of ["low", "mid", "high"]) {
      const stockDataList = [];

      for (const symbol of candidates[tier].slice(0, 10)) {
        try {
          await delay(250);
          const data = await collectStockData(symbol);
          if (data) stockDataList.push(data);
        } catch { continue; }
      }

      if (stockDataList.length === 0) continue;

      const stockSummary = JSON.stringify(stockDataList.map((s) => ({
        ticker: s.ticker, company: s.company_name, price: s.current_price,
        change: s.change_percent, signal: s.technical_signal, news: s.recent_news,
        insider: s.insider, pe: s.peRatio, beta: s.beta, rsi: s.rsi14,
        w52h: s.week52High, w52l: s.week52Low,
      })));

      // Both AIs score in parallel
      const [oaiPicks, gemPicks] = await Promise.all([
        openai.responses.create({
          model: "gpt-4o-mini",
          tools: [{ type: "web_search" }],
          input: `Pick TOP 5 ${tier} tier stocks. Score 0-100 using ${getTierWeights(tier)}.
Stocks: ${stockSummary}
Market: ${marketNews}
Sectors: ${JSON.stringify(sectors)}
Return ONLY JSON array:
[{"ticker":"","company_name":"","current_price":0,"buy_price":0,"sell_price":0,"stop_price":0,"score":0,"summary":"","reasons":[],"full_research":"","news_summary":"","sentiment_summary":"","technical_summary":"","tier":"${tier}","is_hot_pick":false}]`,
        }).then((r) => safeParseJSON(r.output_text)).catch(() => []),

        geminiCall(`Independent analyst. Pick YOUR top 5 ${tier} stocks. Score 0-100. Focus on fundamentals and risk.
Stocks: ${stockSummary}
Return ONLY JSON: [{"ticker":"","score":0,"buy_price":0,"sell_price":0,"stop_price":0,"risk":""}]`),
      ]);

      let tierPicks = oaiPicks || [];
      const gemArray = Array.isArray(gemPicks) ? gemPicks : [];

      for (const stock of tierPicks) {
        const real = stockDataList.find((s) => s.ticker === stock.ticker);
        if (real) { stock.current_price = real.current_price; stock.company_name = real.company_name; }

        const gem = gemArray.find((g) => g.ticker === stock.ticker);
        if (gem?.score) {
          stock.score = Math.round(stock.score * 0.6 + gem.score * 0.4);
          if (gem.buy_price) stock.buy_price = Math.round(((stock.buy_price + gem.buy_price) / 2) * 100) / 100;
          if (gem.sell_price) stock.sell_price = Math.round(((stock.sell_price + gem.sell_price) / 2) * 100) / 100;
          if (gem.stop_price) stock.stop_price = Math.round(((stock.stop_price + gem.stop_price) / 2) * 100) / 100;
          if (gem.risk) stock.risk_flag = gem.risk;
        }
        stock.tier = tier;
        stock.is_hot_pick = stock.score >= 95;
        stock.updated_at = new Date().toISOString();
      }

      results[tier] = tierPicks.slice(0, 5);
    }

    const allStocks = [...results.low, ...results.mid, ...results.high];
    const hotPicks = allStocks.filter((s) => s.is_hot_pick);

    // SAVE results in memory so scheduled light checks can use them
    lastScanResults = {
      low: results.low, mid: results.mid, high: results.high,
      all: allStocks, hot_picks: hotPicks, updated_at: new Date().toISOString(),
    };

    const outlookR = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `Market: ${marketNews}\nSectors: ${JSON.stringify(sectors)}\nReply ONLY: Bullish, Neutral, or Bearish`,
    });

    return res.json({
      market_outlook: outlookR.output_text.trim(),
      sector_performance: sectors,
      discovery_sources: {
        fmp_gainers: gainers.length,
        fmp_active: active.length,
        ai_discovery: aiDiscovery ? true : false,
      },
      updated_at: new Date().toISOString(),
      stocks: allStocks, hot_picks: hotPicks,
      low: results.low, mid: results.mid, high: results.high,
    });
  } catch (err) {
    console.error("Market scan error:", err.message);
    return res.status(500).json({ error: "Market scan failed", details: err.message });
  }
});

// ============================================
// ADD & RESEARCH — Type any ticker
// ============================================
app.post("/add-stock", async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker is required" });
    const symbol = ticker.toUpperCase();
    const data = await collectStockData(symbol);
    if (!data) return res.status(404).json({ error: `No data for ${symbol}` });

    const [oai, gem] = await Promise.all([
      openai.responses.create({
        model: "gpt-4o-mini", tools: [{ type: "web_search" }],
        input: `Analyze ${symbol}. Price:$${data.current_price}, ${data.change_percent}%, Signal:${data.technical_signal}, News:${data.recent_news}. Tier:${data.tier}, Weights:${getTierWeights(data.tier)}. Search web for news. Return ONLY JSON: {"score":0,"buy_price":0,"sell_price":0,"stop_price":0,"summary":"","reasons":[]}`,
      }).then((r) => safeParseJSON(r.output_text)).catch(() => null),
      geminiCall(`Score ${symbol}. Price:$${data.current_price}, ${data.change_percent}%, Signal:${data.technical_signal}. Return ONLY JSON: {"score":0,"buy_price":0,"sell_price":0,"stop_price":0}`),
    ]);

    const avg = (a, b) => (a && b) ? Math.round(((a + b) / 2) * 100) / 100 : (a || b || 0);
    const score = (oai?.score && gem?.score) ? Math.round(oai.score * 0.6 + gem.score * 0.4) : (oai?.score || gem?.score || 50);

    return res.json({
      ticker: symbol, company_name: data.company_name, current_price: data.current_price,
      buy_price: avg(oai?.buy_price, gem?.buy_price), sell_price: avg(oai?.sell_price, gem?.sell_price),
      stop_price: avg(oai?.stop_price, gem?.stop_price), score,
      summary: oai?.summary || "Analysis complete", reasons: oai?.reasons || [],
      full_research: oai?.summary || "", news_summary: "", sentiment_summary: "", technical_summary: `Signal: ${data.technical_signal}`,
      tier: data.tier, is_hot_pick: score >= 95, updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed", details: err.message });
  }
});

// ============================================
// LIGHT CHECK — Finnhub + Gemini (free)
// ============================================
app.post("/light-check", async (req, res) => {
  try {
    const { stocks } = req.body;
    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) return res.status(400).json({ error: "Send stocks array" });

    const results = [];
    const surgeTriggered = [];

    for (const stock of stocks) {
      try {
        await delay(200);
        const symbol = stock.ticker.toUpperCase();
        const quote = await getQuote(symbol);
        if (!quote) continue;
        const prevPrice = stock.previous_price || quote.previous_close || 0;
        const priceChange = prevPrice > 0 ? ((quote.current_price - prevPrice) / prevPrice) * 100 : 0;
        let hasNews = false;
        try {
          const today = new Date().toISOString().split("T")[0];
          const news = await finnhubGet("/company-news", { symbol, from: today, to: today });
          hasNews = (news || []).length >= 2;
        } catch {}
        const shouldSurge = Math.abs(priceChange) >= 3 || hasNews;
        results.push({
          ticker: symbol, current_price: quote.current_price, change: quote.change,
          change_percent: quote.change_percent, price_change_from_pick: Math.round(priceChange * 100) / 100,
          breaking_news: hasNews, surge_triggered: shouldSurge, previous_score: stock.previous_score || null,
          updated_at: new Date().toISOString(),
        });
        if (shouldSurge) surgeTriggered.push(symbol);
      } catch { continue; }
    }

    let geminiInsight = "";
    try {
      const sum = results.map((r) => `${r.ticker}:$${r.current_price}(${r.change_percent}%)`).join(",");
      const gem = await geminiCall(`Quick pulse: ${sum}. Any concerns? 2 sentences. Return JSON: {"pulse":"","alert":"none|watch|urgent"}`);
      geminiInsight = gem?.pulse || "";
      if (gem?.alert === "urgent" || gem?.alert === "watch") {
        // Gemini might catch something numbers missed
      }
    } catch {}

    return res.json({
      checked: results.length, surge_triggered: surgeTriggered, surge_count: surgeTriggered.length,
      gemini_insight: geminiInsight, stocks: results, updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Light check failed", details: err.message });
  }
});

// ============================================
// SURGE CHECK — Emergency analysis (OpenAI only, fast)
// ============================================
app.post("/surge-check", async (req, res) => {
  try {
    const { ticker, reason } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker required" });
    const symbol = ticker.toUpperCase();
    const quote = await getQuote(symbol);
    if (!quote) return res.status(404).json({ error: `No data for ${symbol}` });
    const news = await getNews(symbol);

    const r = await openai.responses.create({
      model: "gpt-4o-mini", tools: [{ type: "web_search" }],
      input: `URGENT: ${symbol} surged. Reason: ${reason || "auto"}. Price:$${quote.current_price}(${quote.change_percent}%). News:${news}. Search web NOW. Real or noise? Return JSON: {"ticker":"${symbol}","current_price":${quote.current_price},"alert_level":"low|medium|high|critical","what_happened":"","recommendation":"","new_buy_price":0,"new_sell_price":0,"new_stop_price":0}`,
    });
    const result = safeParseJSON(r.output_text) || { ticker: symbol, current_price: quote.current_price, alert_level: "medium", what_happened: "Analysis unavailable", recommendation: "Monitor" };
    result.updated_at = new Date().toISOString();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Surge check failed", details: err.message });
  }
});

// ============================================
// IN-MEMORY STORAGE — Brain remembers last scan results
// ============================================
let lastScanResults = { low: [], mid: [], high: [], all: [], updated_at: null };

// ============================================
// SCHEDULED LIGHT CHECK — Brain runs this on its own
// No request body needed — uses stored scan results
// ============================================
app.get("/scheduled-light-check", async (req, res) => {
  try {
    if (lastScanResults.all.length === 0) {
      return res.json({ message: "No scan results stored yet. Run /check-market first.", checked: 0 });
    }

    const stocks = lastScanResults.all.map((s) => ({
      ticker: s.ticker,
      previous_price: s.current_price,
      previous_score: s.score,
      buy_price: s.buy_price,
      sell_price: s.sell_price,
    }));

    const results = [];
    const surgeTriggered = [];

    for (const stock of stocks) {
      try {
        await delay(200);
        const symbol = stock.ticker.toUpperCase();
        const quote = await getQuote(symbol);
        if (!quote) continue;

        const prevPrice = stock.previous_price || quote.previous_close || 0;
        const priceChange = prevPrice > 0 ? ((quote.current_price - prevPrice) / prevPrice) * 100 : 0;

        let hasNews = false;
        try {
          const today = new Date().toISOString().split("T")[0];
          const news = await finnhubGet("/company-news", { symbol, from: today, to: today });
          hasNews = (news || []).length >= 2;
        } catch {}

        const shouldSurge = Math.abs(priceChange) >= 3 || hasNews;

        // Check if stock hit buy or sell zone
        let status = "watching";
        if (stock.buy_price && quote.current_price <= stock.buy_price * 1.02) status = "in_buy_zone";
        if (stock.sell_price && quote.current_price >= stock.sell_price * 0.98) status = "near_sell_target";

        results.push({
          ticker: symbol, current_price: quote.current_price,
          change: quote.change, change_percent: quote.change_percent,
          price_change_from_pick: Math.round(priceChange * 100) / 100,
          breaking_news: hasNews, surge_triggered: shouldSurge,
          previous_score: stock.previous_score, status,
          updated_at: new Date().toISOString(),
        });

        if (shouldSurge) surgeTriggered.push(symbol);
      } catch { continue; }
    }

    // Gemini quick pulse (free)
    let geminiInsight = "";
    try {
      const sum = results.map((r) => `${r.ticker}:$${r.current_price}(${r.change_percent}%)`).join(",");
      const gem = await geminiCall(`Quick pulse: ${sum}. Any concerns? 2 sentences. Return JSON: {"pulse":"","alert":"none|watch|urgent"}`);
      geminiInsight = gem?.pulse || "";
    } catch {}

    // Auto-trigger surge checks for flagged stocks
    const surgeResults = [];
    for (const symbol of surgeTriggered.slice(0, 3)) { // max 3 surge checks per light check
      try {
        const quote = await getQuote(symbol);
        if (!quote) continue;
        const news = await getNews(symbol);
        const r = await openai.responses.create({
          model: "gpt-4o-mini", tools: [{ type: "web_search" }],
          input: `URGENT: ${symbol} flagged during light check. Price:$${quote.current_price}(${quote.change_percent}%). News:${news}. Search web. Real move or noise? Return JSON: {"ticker":"${symbol}","alert_level":"low|medium|high|critical","what_happened":"","recommendation":""}`,
        });
        const surgeResult = safeParseJSON(r.output_text);
        if (surgeResult) surgeResults.push(surgeResult);
      } catch { continue; }
    }

    return res.json({
      checked: results.length,
      surge_triggered: surgeTriggered,
      surge_count: surgeTriggered.length,
      surge_results: surgeResults,
      gemini_insight: geminiInsight,
      stocks: results,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Scheduled light check failed", details: err.message });
  }
});

// ============================================
// GET LATEST RESULTS — Base44 can poll this for fresh data
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
  console.log(`Stock Brain API v6.0 running on port ${port}`);
  console.log(`Data: Finnhub + FMP + Alpha Vantage`);
  console.log(`AIs: OpenAI (web search) + Gemini (free)`);
  console.log(`Endpoints: /check-market, /research-stock, /add-stock, /light-check, /surge-check, /scheduled-light-check, /latest`);
});
