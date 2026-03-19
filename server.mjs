import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

// CORS - Allow Base44 and other apps
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ============================================
// AI CLIENTS
// ============================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Claude (Anthropic) - uses fetch directly
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;

// Gemini (Google) - uses fetch directly
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Grok (xAI) - compatible with OpenAI SDK
const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

// Finnhub
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = "https://finnhub.io/api/v1";

// ============================================
// FINNHUB DATA HELPERS
// ============================================

async function finnhubGet(endpoint, params = {}) {
  const url = new URL(`${FINNHUB_BASE}${endpoint}`);
  url.searchParams.set("token", FINNHUB_KEY);
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub ${endpoint}: ${res.status}`);
  return res.json();
}

async function getQuote(symbol) {
  const d = await finnhubGet("/quote", { symbol });
  return {
    current_price: d.c, open: d.o, high: d.h, low: d.l,
    previous_close: d.pc, change: d.d, change_percent: d.dp,
  };
}

async function getProfile(symbol) {
  const d = await finnhubGet("/stock/profile2", { symbol });
  return { name: d.name || symbol, industry: d.finnhubIndustry || "Unknown", market_cap: d.marketCapitalization || 0 };
}

async function getNews(symbol) {
  const to = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  const d = await finnhubGet("/company-news", { symbol, from, to });
  return (d || []).slice(0, 5).map((n) => ({ headline: n.headline, summary: n.summary, source: n.source }));
}

async function getMarketNews() {
  const d = await finnhubGet("/news", { category: "general" });
  return (d || []).slice(0, 10).map((n) => ({ headline: n.headline, summary: n.summary, source: n.source }));
}

async function getBasicFinancials(symbol) {
  const d = await finnhubGet("/stock/metric", { symbol, metric: "all" });
  const m = d.metric || {};
  return {
    week52High: m["52WeekHigh"], week52Low: m["52WeekLow"], beta: m["beta"],
    peRatio: m["peBasicExclExtraTTM"], avgVolume10d: m["10DayAverageTradingVolume"],
    avgVolume3m: m["3MonthAverageTradingVolume"],
  };
}

async function getTechnicalIndicators(symbol) {
  try {
    const d = await finnhubGet("/scan/technical-indicator", { symbol, resolution: "D" });
    return {
      signal: d.technicalAnalysis?.signal || "neutral",
      trending: d.trend?.trending || false,
      buy_count: d.technicalAnalysis?.count?.buy || 0,
      sell_count: d.technicalAnalysis?.count?.sell || 0,
    };
  } catch { return { signal: "unknown", trending: false, buy_count: 0, sell_count: 0 }; }
}

// INSIDER TRADING (free on Finnhub)
async function getInsiderTrading(symbol) {
  try {
    const d = await finnhubGet("/stock/insider-transactions", { symbol });
    const txns = (d.data || []).slice(0, 5);
    return txns.map((t) => ({
      name: t.name, share: t.share, change: t.change,
      transactionType: t.transactionType, transactionDate: t.transactionDate,
    }));
  } catch { return []; }
}

// INSIDER SENTIMENT (free on Finnhub)
async function getInsiderSentiment(symbol) {
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];
    const d = await finnhubGet("/stock/insider-sentiment", { symbol, from, to });
    return (d.data || []).slice(0, 3).map((s) => ({ month: s.month, year: s.year, mspr: s.mspr, change: s.change }));
  } catch { return []; }
}

// CONGRESSIONAL TRADING (free on Finnhub)
async function getCongressionalTrading(symbol) {
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];
    const d = await finnhubGet("/stock/congressional-trading", { symbol, from, to });
    return (d.data || []).slice(0, 5).map((t) => ({
      name: t.name, amount: t.amount, transactionType: t.transactionType,
      transactionDate: t.transactionDate, asset: t.assetDescription,
    }));
  } catch { return []; }
}

// EARNINGS CALENDAR (free on Finnhub)
async function getEarningsCalendar() {
  try {
    const from = new Date().toISOString().split("T")[0];
    const to = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const d = await finnhubGet("/calendar/earnings", { from, to });
    return (d.earningsCalendar || []).slice(0, 15).map((e) => ({
      symbol: e.symbol, date: e.date, hour: e.hour,
      epsEstimate: e.epsEstimate, revenueEstimate: e.revenueEstimate,
    }));
  } catch { return []; }
}

// ECONOMIC CALENDAR (free on Finnhub)
async function getEconomicCalendar() {
  try {
    const from = new Date().toISOString().split("T")[0];
    const to = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
    const d = await finnhubGet("/calendar/economic", { from, to });
    return (d.economicCalendar || []).slice(0, 10).map((e) => ({
      event: e.event, country: e.country, impact: e.impact, time: e.time,
    }));
  } catch { return []; }
}

// ============================================
// GOVERNMENT NEWS via OpenAI Web Search
// ============================================
async function getGovernmentNews() {
  try {
    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search" }],
      input: "Search for the latest US government news affecting the stock market today. Include: White House, Federal Reserve, Treasury, SEC, tariffs, trade policy, executive orders, sanctions, regulations. Return the top 5 most market-relevant items, each 1-2 sentences. Numbered list only.",
    });
    return r.output_text.trim();
  } catch (err) {
    console.error("Gov news error:", err.message);
    return "Government news unavailable.";
  }
}

// ============================================
// GROK - X/TWITTER SENTIMENT
// ============================================
async function getXSentiment(tickers) {
  try {
    const tickerList = tickers.join(", ");
    const r = await grok.responses.create({
      model: "grok-3-fast",
      tools: [{ type: "web_search" }],
      input: `Search X (Twitter) for the latest sentiment and buzz about these stock tickers: ${tickerList}. For each ticker, give a 1-sentence summary of what traders on X are saying. Also note if any are trending or have unusual social buzz. Return as a numbered list.`,
    });
    return r.output_text.trim();
  } catch (err) {
    console.error("Grok X sentiment error:", err.message);
    return "X/Twitter sentiment unavailable.";
  }
}

// ============================================
// AI ANALYSIS FUNCTIONS
// ============================================

// OpenAI - Main analyst with web search
async function openaiAnalyze(dataPackage, tier) {
  const r = await openai.responses.create({
    model: "gpt-4o-mini",
    tools: [{ type: "web_search" }],
    input: `You are a professional stock analyst. Analyze this stock data and return a JSON score and analysis.

Stock data: ${JSON.stringify(dataPackage)}
Tier: ${tier}
Scoring weights: ${getTierWeights(tier)}

Search the web for any breaking news about ${dataPackage.ticker} that could affect the price today.

Return ONLY valid JSON: {"score": 0, "summary": "", "reasons": [], "sentiment": "", "risk_note": ""}`,
  });
  return safeParseJSON(r.output_text);
}

// Claude - Deep reasoning analyst
async function claudeAnalyze(dataPackage, tier) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `You are a cautious, detail-oriented stock analyst. Analyze this data and challenge the bull case. Look for risks others might miss.

Stock data: ${JSON.stringify(dataPackage)}
Tier: ${tier}
Scoring weights: ${getTierWeights(tier)}

Return ONLY valid JSON: {"score": 0, "summary": "", "reasons": [], "risk_analysis": "", "confidence": ""}`,
        }],
      }),
    });
    const d = await r.json();
    const text = d.content?.[0]?.text || "{}";
    return safeParseJSON(text);
  } catch (err) {
    console.error("Claude error:", err.message);
    return null;
  }
}

// Gemini - Cross-checker and validator
async function geminiAnalyze(dataPackage, tier) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a stock market validator. Cross-check this analysis and verify the data makes sense. Look for inconsistencies.

Stock data: ${JSON.stringify(dataPackage)}
Tier: ${tier}
Scoring weights: ${getTierWeights(tier)}

Return ONLY valid JSON: {"score": 0, "summary": "", "validation_notes": "", "data_quality": "", "adjusted_score": 0}`,
            }],
          }],
        }),
      }
    );
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return safeParseJSON(text);
  } catch (err) {
    console.error("Gemini error:", err.message);
    return null;
  }
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
  try {
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean);
  } catch { return null; }
}

// Combine scores from multiple AIs
function combineScores(openaiResult, claudeResult, geminiResult) {
  const scores = [];
  if (openaiResult?.score) scores.push({ score: openaiResult.score, weight: 0.4 });
  if (claudeResult?.score) scores.push({ score: claudeResult.score, weight: 0.35 });
  if (geminiResult?.adjusted_score || geminiResult?.score) {
    scores.push({ score: geminiResult.adjusted_score || geminiResult.score, weight: 0.25 });
  }

  if (scores.length === 0) return 50;

  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const weightedScore = scores.reduce((sum, s) => sum + s.score * (s.weight / totalWeight), 0);
  return Math.round(weightedScore);
}

// ============================================
// HEALTH CHECK
// ============================================
app.get("/", (req, res) => {
  res.json({ status: "Stock Brain API v4.0 — 4 AIs + Real Data", version: "4.0.0" });
});

// ============================================
// RESEARCH ONE STOCK
// ============================================
app.post("/research-stock", async (req, res) => {
  try {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker is required" });

    const symbol = ticker.toUpperCase();

    // Pull ALL real data
    const [quote, profile, news, financials, technicals, insider, insiderSent, congress, govNews, econ] =
      await Promise.all([
        getQuote(symbol),
        getProfile(symbol),
        getNews(symbol),
        getBasicFinancials(symbol),
        getTechnicalIndicators(symbol),
        getInsiderTrading(symbol),
        getInsiderSentiment(symbol),
        getCongressionalTrading(symbol),
        getGovernmentNews(),
        getEconomicCalendar(),
      ]);

    if (!quote.current_price || quote.current_price === 0) {
      return res.status(404).json({ error: `No data for ${symbol}` });
    }

    const tier = getTier(quote.current_price);

    // Get X sentiment for this stock
    const xSentiment = await getXSentiment([symbol]);

    const dataPackage = {
      ticker: symbol, company_name: profile.name, industry: profile.industry,
      market_cap_millions: profile.market_cap,
      ...quote, ...financials,
      technical_signal: technicals.signal, technical_trending: technicals.trending,
      technical_buy_signals: technicals.buy_count, technical_sell_signals: technicals.sell_count,
      recent_news: news, insider_trading: insider, insider_sentiment: insiderSent,
      congressional_trading: congress, government_news: govNews,
      economic_events: econ, x_sentiment: xSentiment, tier,
    };

    // Run all 3 AIs in parallel
    const [openaiResult, claudeResult, geminiResult] = await Promise.all([
      openaiAnalyze(dataPackage, tier),
      claudeAnalyze(dataPackage, tier),
      geminiAnalyze(dataPackage, tier),
    ]);

    const finalScore = combineScores(openaiResult, claudeResult, geminiResult);

    // Build buy/sell/stop using AI + real data
    const targetPrompt = `Based on this real stock data, calculate buy_price, sell_price, and stop_price.

Current: $${quote.current_price}, 52wk High: $${financials.week52High}, 52wk Low: $${financials.week52Low}
Open: $${quote.open}, High: $${quote.high}, Low: $${quote.low}
Technical signal: ${technicals.signal}

Return ONLY JSON: {"buy_price": 0, "sell_price": 0, "stop_price": 0}`;

    const targetResponse = await openai.responses.create({ model: "gpt-4o-mini", input: targetPrompt });
    const targets = safeParseJSON(targetResponse.output_text) || { buy_price: 0, sell_price: 0, stop_price: 0 };

    // Build research summaries
    const summaryParts = [];
    if (openaiResult?.summary) summaryParts.push(openaiResult.summary);
    if (claudeResult?.summary) summaryParts.push(claudeResult.summary);

    const reasons = [
      ...(openaiResult?.reasons || []),
      ...(claudeResult?.reasons || []),
    ].slice(0, 5);

    const result = {
      ticker: symbol,
      company_name: profile.name,
      current_price: quote.current_price,
      buy_price: targets.buy_price,
      sell_price: targets.sell_price,
      stop_price: targets.stop_price,
      score: finalScore,
      summary: summaryParts.join(" ") || "Analysis complete.",
      reasons: reasons.length > 0 ? reasons : ["Data analyzed across multiple AI models"],
      full_research: `OpenAI Analysis: ${openaiResult?.summary || "N/A"}\n\nClaude Analysis: ${claudeResult?.summary || "N/A"} ${claudeResult?.risk_analysis || ""}\n\nGemini Validation: ${geminiResult?.summary || "N/A"} ${geminiResult?.validation_notes || ""}`,
      news_summary: news.map((n) => n.headline).join(". ") || "No recent news.",
      sentiment_summary: `X/Twitter: ${xSentiment}\nInsider sentiment: ${JSON.stringify(insiderSent)}`,
      technical_summary: `Signal: ${technicals.signal}, Buy signals: ${technicals.buy_count}, Sell signals: ${technicals.sell_count}, Trending: ${technicals.trending}`,
      tier,
      is_hot_pick: finalScore >= 95,
      updated_at: new Date().toISOString(),
    };

    return res.json(result);
  } catch (err) {
    console.error("Research error:", err.message);
    return res.status(500).json({ error: "Research failed", details: err.message });
  }
});

// ============================================
// CHECK MARKET - Full scan
// ============================================
app.post("/check-market", async (req, res) => {
  try {
    const candidates = {
      low: ["SNDL","CLOV","TELL","HIMS","OPEN","SKLZ","WKHS","GSAT","SENS","BNGO","IDEX","ZOM","NNDM","MNMD","DRUG"],
      mid: ["PLTR","SOFI","HOOD","RIVN","LCID","NIO","SNAP","PINS","RBLX","DKNG","ROKU","CRSP","PLUG","CHPT","DNA"],
      high: ["NVDA","AAPL","MSFT","GOOGL","AMZN","TSLA","META","AMD","NFLX","CRM","AVGO","ORCL","ADBE","COIN","SHOP"],
    };

    // Get all context data first
    const [govNews, marketNews, econ, earnings] = await Promise.all([
      getGovernmentNews(), getMarketNews(), getEconomicCalendar(), getEarningsCalendar(),
    ]);

    // Get X sentiment for all candidates
    const allTickers = [...candidates.low, ...candidates.mid, ...candidates.high];
    const xSentiment = await getXSentiment(allTickers.slice(0, 20)); // limit to avoid huge prompt

    const results = { low: [], mid: [], high: [] };

    for (const tier of ["low", "mid", "high"]) {
      const stockDataList = [];

      for (const symbol of candidates[tier]) {
        try {
          await delay(300); // respect rate limit

          const [quote, profile, news, financials, technicals, insider, congress] =
            await Promise.all([
              getQuote(symbol), getProfile(symbol), getNews(symbol),
              getBasicFinancials(symbol), getTechnicalIndicators(symbol),
              getInsiderTrading(symbol), getCongressionalTrading(symbol),
            ]);

          if (!quote.current_price || quote.current_price === 0) continue;
          if (getTier(quote.current_price) !== tier) continue;

          stockDataList.push({
            ticker: symbol, company_name: profile.name, industry: profile.industry,
            ...quote, ...financials,
            technical_signal: technicals.signal,
            technical_buy_signals: technicals.buy_count,
            technical_sell_signals: technicals.sell_count,
            recent_news_count: news.length,
            top_headline: news[0]?.headline || "No recent news",
            insider_buys: insider.filter((t) => t.transactionType === "P - Purchase").length,
            insider_sells: insider.filter((t) => t.transactionType === "S - Sale").length,
            congressional_trades: congress.length,
            tier,
          });
        } catch (err) {
          console.error(`Error ${symbol}: ${err.message}`);
          continue;
        }
      }

      if (stockDataList.length === 0) continue;

      // Run all 3 AIs on this tier's data
      const aiPrompt = `Analyze these ${tier.toUpperCase()} tier stocks and pick the TOP 5.

Stocks: ${JSON.stringify(stockDataList)}
Market news: ${marketNews.map((n) => n.headline).join("; ")}
Government news: ${govNews}
Economic events: ${JSON.stringify(econ)}
Earnings this week: ${JSON.stringify(earnings.filter((e) => stockDataList.some((s) => s.ticker === e.symbol)))}
X/Twitter buzz: ${xSentiment}

Score each 0-100 using: ${getTierWeights(tier)}
Factor in: insider trading, congressional trades, government policy, social sentiment.

Return ONLY JSON array of 5 stocks:
[{"ticker":"","company_name":"","current_price":0,"buy_price":0,"sell_price":0,"stop_price":0,"score":0,"summary":"","reasons":[],"full_research":"","news_summary":"","sentiment_summary":"","technical_summary":"","tier":"${tier}","is_hot_pick":false}]`;

      // Run OpenAI, Claude, Gemini in parallel for this tier
      const [oaiRes, claudeRes, gemRes] = await Promise.all([
        openai.responses.create({ model: "gpt-4o-mini", tools: [{ type: "web_search" }], input: aiPrompt })
          .then((r) => safeParseJSON(r.output_text)),
        claudeAnalyzeTier(stockDataList, tier, govNews, xSentiment),
        geminiAnalyzeTier(stockDataList, tier, govNews),
      ]);

      // Use OpenAI as primary picks, adjust scores with Claude/Gemini
      let tierPicks = oaiRes || [];
      if (Array.isArray(tierPicks)) {
        for (const stock of tierPicks) {
          const realData = stockDataList.find((s) => s.ticker === stock.ticker);
          if (realData) stock.current_price = realData.current_price;

          // Adjust score with Claude/Gemini if available
          const claudeStock = claudeRes?.find?.((s) => s.ticker === stock.ticker);
          const gemStock = gemRes?.find?.((s) => s.ticker === stock.ticker);
          if (claudeStock?.score || gemStock?.score) {
            stock.score = combineScores(
              { score: stock.score },
              claudeStock ? { score: claudeStock.score } : null,
              gemStock ? { score: gemStock.score } : null
            );
          }

          stock.tier = tier;
          stock.updated_at = new Date().toISOString();
          stock.is_hot_pick = stock.score >= 95;
        }
      }
      results[tier] = tierPicks;
    }

    const allStocks = [...(results.low || []), ...(results.mid || []), ...(results.high || [])];
    const hotPicks = allStocks.filter((s) => s.is_hot_pick);

    // Market outlook
    const outlookR = await openai.responses.create({
      model: "gpt-4o-mini",
      input: `Market news: ${marketNews.map((n) => n.headline).join("; ")}\nGovernment: ${govNews}\nReply with ONLY: Bullish, Neutral, or Bearish`,
    });

    return res.json({
      market_outlook: outlookR.output_text.trim(),
      updated_at: new Date().toISOString(),
      government_news: govNews,
      x_sentiment: xSentiment,
      upcoming_earnings: earnings.slice(0, 10),
      economic_events: econ,
      stocks: allStocks,
      hot_picks: hotPicks,
      low: results.low,
      mid: results.mid,
      high: results.high,
    });
  } catch (err) {
    console.error("Market scan error:", err.message);
    return res.status(500).json({ error: "Market scan failed", details: err.message });
  }
});

// Claude tier analysis helper
async function claudeAnalyzeTier(stockDataList, tier, govNews, xSentiment) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `Pick the top 5 ${tier} tier stocks from this data. Focus on risk analysis.
Stocks: ${JSON.stringify(stockDataList)}
Gov news: ${govNews}
X sentiment: ${xSentiment}
Return ONLY JSON array: [{"ticker":"","score":0,"risk_note":""}]`,
        }],
      }),
    });
    const d = await r.json();
    return safeParseJSON(d.content?.[0]?.text || "[]");
  } catch { return []; }
}

// Gemini tier analysis helper
async function geminiAnalyzeTier(stockDataList, tier, govNews) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Validate and pick top 5 ${tier} stocks. Cross-check for data issues.
Stocks: ${JSON.stringify(stockDataList)}
Gov news: ${govNews}
Return ONLY JSON array: [{"ticker":"","score":0,"validation":""}]`,
            }],
          }],
        }),
      }
    );
    const d = await r.json();
    return safeParseJSON(d.candidates?.[0]?.content?.parts?.[0]?.text || "[]");
  } catch { return []; }
}

// ============================================
// LIGHT CHECK - Cheap price/volume update for existing picks
// Runs every 2 hours during market hours
// Only uses Finnhub (free) - NO AI calls unless triggered
// ============================================
app.post("/light-check", async (req, res) => {
  try {
    const { stocks } = req.body;
    // stocks = array of objects like [{ticker: "AAPL", previous_score: 88, previous_price: 175.50}, ...]

    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
      return res.status(400).json({ error: "Send an array of stocks with ticker, previous_score, and previous_price" });
    }

    const results = [];
    const surgeTriggered = [];

    for (const stock of stocks) {
      try {
        await delay(200);

        const symbol = stock.ticker.toUpperCase();
        const quote = await getQuote(symbol);

        if (!quote.current_price || quote.current_price === 0) continue;

        const previousPrice = stock.previous_price || quote.previous_close || 0;
        const priceChange = previousPrice > 0
          ? ((quote.current_price - previousPrice) / previousPrice) * 100
          : 0;

        // Check for volume spike
        let volumeSpike = false;
        try {
          const fin = await getBasicFinancials(symbol);
          // Compare today's movement to average - rough proxy
          if (fin.avgVolume10d && fin.avgVolume3m) {
            volumeSpike = fin.avgVolume10d > fin.avgVolume3m * 1.5;
          }
        } catch {}

        // Check for breaking news
        let hasBreakingNews = false;
        try {
          const today = new Date().toISOString().split("T")[0];
          const news = await finnhubGet("/company-news", { symbol, from: today, to: today });
          hasBreakingNews = (news || []).length >= 2; // 2+ articles today = notable
        } catch {}

        // Determine if surge mode should trigger
        const shouldSurge =
          Math.abs(priceChange) >= 3 || // price moved 3%+
          volumeSpike ||                 // volume spiked
          hasBreakingNews;               // breaking news today

        const update = {
          ticker: symbol,
          current_price: quote.current_price,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          change: quote.change,
          change_percent: quote.change_percent,
          price_change_from_pick: Math.round(priceChange * 100) / 100,
          volume_spike: volumeSpike,
          breaking_news: hasBreakingNews,
          surge_triggered: shouldSurge,
          previous_score: stock.previous_score || null,
          status: getStockStatus(quote.current_price, stock),
          updated_at: new Date().toISOString(),
        };

        results.push(update);

        if (shouldSurge) {
          surgeTriggered.push(symbol);
        }
      } catch (err) {
        console.error(`Light check error ${stock.ticker}: ${err.message}`);
        continue;
      }
    }

    return res.json({
      checked: results.length,
      surge_triggered: surgeTriggered,
      surge_count: surgeTriggered.length,
      stocks: results,
      updated_at: new Date().toISOString(),
      message: surgeTriggered.length > 0
        ? `${surgeTriggered.length} stock(s) triggered surge mode: ${surgeTriggered.join(", ")}`
        : "All stocks stable. No surge triggers.",
    });
  } catch (err) {
    console.error("Light check error:", err.message);
    return res.status(500).json({ error: "Light check failed", details: err.message });
  }
});

// Helper: determine stock status relative to buy/sell targets
function getStockStatus(currentPrice, stock) {
  if (!stock.buy_price || !stock.sell_price) return "watching";
  if (currentPrice <= stock.buy_price * 1.02) return "in_buy_zone";
  if (currentPrice <= stock.buy_price * 1.05) return "near_buy_zone";
  if (currentPrice >= stock.sell_price * 0.98) return "near_sell_target";
  if (currentPrice >= stock.sell_price) return "at_sell_target";
  return "watching";
}

// ============================================
// SURGE MODE - Quick deep dive on 1 stock
// Only runs when light-check triggers it
// Uses 1 AI (OpenAI with web search) to keep cost low
// ============================================
app.post("/surge-check", async (req, res) => {
  try {
    const { ticker, reason } = req.body;
    if (!ticker) return res.status(400).json({ error: "Ticker is required" });

    const symbol = ticker.toUpperCase();

    // Pull fresh data
    const [quote, profile, news, technicals] = await Promise.all([
      getQuote(symbol),
      getProfile(symbol),
      getNews(symbol),
      getTechnicalIndicators(symbol),
    ]);

    if (!quote.current_price || quote.current_price === 0) {
      return res.status(404).json({ error: `No data for ${symbol}` });
    }

    const tier = getTier(quote.current_price);

    // Use ONLY OpenAI with web search (cheapest meaningful check)
    const prompt = `URGENT stock analysis needed for ${symbol} (${profile.name}).

Trigger reason: ${reason || "Price/volume surge detected"}

Current data:
- Price: $${quote.current_price} (change: ${quote.change_percent}%)
- High: $${quote.high}, Low: $${quote.low}
- Technical signal: ${technicals.signal}
- Recent headlines: ${news.map((n) => n.headline).join("; ")}

Search the web NOW for any breaking news about ${symbol} in the last few hours.

Evaluate:
1. Is this move real or noise?
2. Should the score go UP or DOWN from current levels?
3. Has the buy/sell/stop target changed?
4. Is there new risk?

Return ONLY JSON:
{
  "ticker": "${symbol}",
  "current_price": ${quote.current_price},
  "score_adjustment": 0,
  "new_buy_price": 0,
  "new_sell_price": 0,
  "new_stop_price": 0,
  "alert_level": "low|medium|high|critical",
  "what_happened": "",
  "recommendation": "",
  "is_hot_pick": false,
  "updated_at": ""
}`;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search" }],
      input: prompt,
    });

    const data = safeParseJSON(response.output_text);

    if (data) {
      data.ticker = symbol;
      data.current_price = quote.current_price;
      data.tier = tier;
      data.surge_reason = reason || "auto-triggered";
      data.updated_at = new Date().toISOString();
      if (data.score_adjustment >= 10) data.is_hot_pick = true;
    }

    return res.json(data || {
      ticker: symbol,
      current_price: quote.current_price,
      alert_level: "medium",
      what_happened: "Surge detected but analysis unavailable",
      recommendation: "Monitor manually",
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Surge check error:", err.message);
    return res.status(500).json({ error: "Surge check failed", details: err.message });
  }
});

// ============================================
// START SERVER
// ============================================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Stock Brain API v4.0 running on port ${port}`);
  console.log(`4 AIs: OpenAI + Claude + Gemini + Grok`);
  console.log(`Data: Finnhub + Gov News + Insider + Congress + Earnings`);
  console.log(`Endpoints: /check-market, /research-stock, /light-check, /surge-check`);
});
