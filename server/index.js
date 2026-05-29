require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;

// ── CONSTANTS ────────────────────────────────────────────────────────────────

const WATCHLIST = [
  {t:'RKLB',n:'Rocket Lab',theme:'space'},
  {t:'ASTS',n:'AST SpaceMobile',theme:'space'},
  {t:'MNTS',n:'Momentus',theme:'space'},
  {t:'RDW',n:'Redwire Corp.',theme:'space'},
  {t:'LUNR',n:'Intuitive Machines',theme:'space'},
  {t:'KTOS',n:'Kratos Defense',theme:'space'},
  {t:'LMT',n:'Lockheed Martin',theme:'space'},
  {t:'NVDA',n:'NVIDIA',theme:'chips'},
  {t:'AMD',n:'AMD',theme:'chips'},
  {t:'AVGO',n:'Broadcom',theme:'chips'},
  {t:'PLTR',n:'Palantir',theme:'ai'},
  {t:'AI',n:'C3.ai',theme:'ai'},
  {t:'IONQ',n:'IonQ',theme:'ai'},
  {t:'SOUN',n:'SoundHound AI',theme:'ai'},
  {t:'BBAI',n:'BigBear.ai',theme:'ai'},
  {t:'SMCI',n:'Super Micro Computer',theme:'datacenter'},
  {t:'VRT',n:'Vertiv Holdings',theme:'datacenter'},
  {t:'EQIX',n:'Equinix',theme:'datacenter'},
];

const PHI = {
  maxPos: 0.30, stopLoss: 0.08, tpBase: 0.10,
  tpMax: 0.30, trailStop: 0.08, maxOpen: 5, minCash: 0.20
};

// ── IN-MEMORY PRICE STATE ────────────────────────────────────────────────────

const priceCache = {};
const priceHist  = {};
const prevClose  = {};

// ── HELPERS ──────────────────────────────────────────────────────────────────

const nf = n => (n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const $f = n => '$' + nf(Math.abs(n||0));

async function fetchPrice(sym) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    if (d && d.c > 0) {
      priceCache[sym] = d.c;
      prevClose[sym]  = d.pc;
      if (!priceHist[sym]) priceHist[sym] = [];
      priceHist[sym].push(d.c);
      if (priceHist[sym].length > 120) priceHist[sym].shift();
    }
  } catch(e) {}
}

async function pollAllPrices(userTickers = []) {
  const all = [...new Set([...WATCHLIST.map(s=>s.t), ...userTickers])];
  for (const sym of all) {
    await fetchPrice(sym);
    await sleep(1100);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ALGO ENGINE ──────────────────────────────────────────────────────────────

function runAlgo(cash, positions, intelligence, mirrorEnabled, dynamicUniverse) {
  const newTrades = [];
  const pos = JSON.parse(JSON.stringify(positions));
  let cash_ = cash;

  const tv = () => cash_ + Object.entries(pos).reduce((s,[t,p]) => s + (priceCache[t]||p.avg_cost)*p.qty, 0);

  // Exits
  Object.entries(pos).forEach(([ticker, p]) => {
    const price = priceCache[ticker];
    if (!price) return;
    const ret = (price - p.avg_cost) / p.avg_cost;
    const newHigh = Math.max(p.high_water||price, price);
    pos[ticker].high_water = newHigh;
    const posVal = price * p.qty;

    if (ret <= -PHI.stopLoss) {
      cash_ += posVal;
      newTrades.push({action:'SELL',ticker,qty:p.qty,price,pos_value:posVal,pnl:(price-p.avg_cost)*p.qty,reason:`Stop loss at ${(ret*100).toFixed(1)}%`,lane:p.lane,theme:p.theme});
      delete pos[ticker]; return;
    }
    if (p.partial_taken && price < newHigh*(1-PHI.trailStop)) {
      cash_ += posVal;
      newTrades.push({action:'SELL',ticker,qty:p.qty,price,pos_value:posVal,pnl:(price-p.avg_cost)*p.qty,reason:`Trailing stop — peak $${nf(newHigh)}`,lane:p.lane,theme:p.theme});
      delete pos[ticker]; return;
    }
    if (ret >= PHI.tpBase && !p.partial_taken && p.qty >= 2) {
      const sq = Math.max(1, Math.floor(p.qty*0.5));
      cash_ += sq*price;
      pos[ticker] = {...p, qty:p.qty-sq, partial_taken:true, high_water:price};
      newTrades.push({action:'SELL',ticker,qty:sq,price,pos_value:sq*price,pnl:(price-p.avg_cost)*sq,reason:`Partial exit +${(ret*100).toFixed(1)}% — trailing remainder`,lane:p.lane,theme:p.theme});
      return;
    }
    if (ret >= PHI.tpMax) {
      cash_ += posVal;
      newTrades.push({action:'SELL',ticker,qty:p.qty,price,pos_value:posVal,pnl:(price-p.avg_cost)*p.qty,reason:`30% ceiling hit — full exit`,lane:p.lane,theme:p.theme});
      delete pos[ticker];
    }
  });

  // Lane 1 entries
  const lane1Tickers = Object.entries(pos).filter(([,p])=>p.lane===1).map(([t])=>t);
  if (mirrorEnabled && mirrorEnabled.length > 0) {
    mirrorEnabled.forEach(stock => {
      if (pos[stock.t] || lane1Tickers.includes(stock.t) || Object.keys(pos).length >= PHI.maxOpen) return;
      const price = priceCache[stock.t];
      const h = priceHist[stock.t]||[];
      if (!price || h.length < 20) return;
      const ma10 = h.slice(-10).reduce((a,b)=>a+b,0)/10;
      const ma20 = h.slice(-20).reduce((a,b)=>a+b,0)/20;
      const mom5 = h.length>=5?(price-h[h.length-5])/h[h.length-5]:0;
      const boost = intelligence&&intelligence.toLowerCase().includes(stock.t.toLowerCase())?1.4:1.0;
      const signal = ((ma10/ma20-1)*2+mom5*3)*boost;
      if (signal > 0.003 && cash_/tv() > PHI.minCash) {
        const conv = Math.min(signal/0.010, 1.0);
        const qty = Math.floor(Math.min(tv()*PHI.maxPos*(0.4+conv*0.4), cash_*0.9)/price);
        if (qty > 0 && price*qty <= cash_) {
          cash_ -= qty*price;
          pos[stock.t] = {qty,avg_cost:price,high_water:price,partial_taken:false,lane:1,theme:stock.theme||'portfolio'};
          newTrades.push({action:'BUY',ticker:stock.t,qty,price,pos_value:qty*price,pnl:null,reason:`L1 mirror — signal ${(signal*100).toFixed(1)}% | MA ${((ma10/ma20-1)*100).toFixed(2)}% | mom ${(mom5*100).toFixed(2)}%`,lane:1,theme:stock.theme||'portfolio'});
        }
      }
    });
  }

  // Lane 2 scout entries
  const scoutUniverse = dynamicUniverse || [];
  const openCnt = Object.keys(pos).length;
  if (openCnt < PHI.maxOpen && cash_/tv() > PHI.minCash) {
    const lane1T = Object.entries(pos).filter(([,p])=>p.lane===1).map(([t])=>t);
    scoutUniverse.forEach(stock => {
      if (pos[stock.t] || lane1T.includes(stock.t) || Object.keys(pos).length >= PHI.maxOpen) return;
      const price = priceCache[stock.t];
      const h = priceHist[stock.t]||[];
      if (!price || h.length < 20) return;
      const ma10 = h.slice(-10).reduce((a,b)=>a+b,0)/10;
      const ma20 = h.slice(-20).reduce((a,b)=>a+b,0)/20;
      const mom5 = h.length>=5?(price-h[h.length-5])/h[h.length-5]:0;
      const boost = intelligence&&intelligence.toLowerCase().includes(stock.t.toLowerCase())?1.6:1.0;
      const signal = ((ma10/ma20-1)*2+mom5*3)*boost;
      const posCap = 0.15;
      if (signal > 0.004) {
        const conv = Math.min(signal/0.012, 1.0);
        const qty = Math.floor(Math.min(tv()*posCap*(0.5+conv*0.5), cash_*0.9)/price);
        if (qty > 0 && price*qty <= cash_) {
          cash_ -= qty*price;
          pos[stock.t] = {qty,avg_cost:price,high_water:price,partial_taken:false,lane:2,theme:stock.theme||'scout',is_scout:true};
          newTrades.push({action:'BUY',ticker:stock.t,qty,price,pos_value:qty*price,pnl:null,reason:`MA signal ${(signal*100).toFixed(1)}% | scout discovery`,lane:2,theme:stock.theme||'scout',is_scout:true});
        }
      }
    });
  }

  return { newTrades, positions: pos, cash: cash_ };
}

// ── WHATSAPP SIGNAL ──────────────────────────────────────────────────────────

async function sendWhatsApp(to, message) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !to) return;
  const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: `whatsapp:${to}`, From: 'whatsapp:+14155238886', Body: message }).toString()
    });
  } catch(e) { console.error('WhatsApp failed:', e.message); }
}

// ── MAIN ALGO LOOP ────────────────────────────────────────────────────────────

let lastIntelScan = 0;
let lastScoutScan = 0;
let intelligenceCache = {};

async function algoTick() {
  try {
    // Get all users
    const { data: users } = await supabase.from('users').select('id');
    if (!users || users.length === 0) return;

    for (const user of users) {
      const uid = user.id;

      // Load state
      const [
        { data: algoState },
        { data: posRows },
        { data: portRows },
        { data: settingsRow },
        { data: scoutRows },
      ] = await Promise.all([
        supabase.from('algo_state').select('cash').eq('user_id', uid).single(),
        supabase.from('positions').select('*').eq('user_id', uid),
        supabase.from('portfolio').select('*').eq('user_id', uid),
        supabase.from('settings').select('*').eq('user_id', uid).single(),
        supabase.from('scout_watchlist').select('*').eq('user_id', uid),
      ]);

      const cash = algoState?.cash ?? 40000;
      const mirrorSet = settingsRow?.mirror_set || {};
      const userPhone = settingsRow?.phone || '';

      // Build positions map
      const positions = {};
      (posRows||[]).forEach(p => { positions[p.ticker] = { qty:p.qty, avg_cost:p.avg_cost, high_water:p.high_water, partial_taken:p.partial_taken, lane:p.lane, theme:p.theme }; });

      // Mirror enabled
      const portMirror = (portRows||[]).filter(h => mirrorSet[h.ticker] !== false).map(h => ({ t:h.ticker, theme:'portfolio' }));
      const wlMirror = WATCHLIST.filter(w => !portMirror.find(p=>p.t===w.t)).map(w => ({t:w.t, theme:w.theme}));
      const mirrorEnabled = [...portMirror, ...wlMirror];

      // Scout universe
      const dynamicUniverse = (scoutRows||[]).map(s => ({t:s.ticker, n:s.name, theme:s.theme, is_scout:true}));

      // Poll prices for this user's tickers
      const userTickers = [...new Set([...(portRows||[]).map(h=>h.ticker), ...(scoutRows||[]).map(s=>s.ticker)])];

      // Run algo
      const intel = intelligenceCache[uid] || '';
      const result = runAlgo(cash, positions, intel, mirrorEnabled, dynamicUniverse);

      if (result.newTrades.length > 0) {
        // Save trades
        const tradeInserts = result.newTrades.map(t => ({
          user_id: uid, action:t.action, ticker:t.ticker, qty:t.qty,
          price:t.price, pos_value:t.pos_value, pnl:t.pnl,
          reason:t.reason, lane:t.lane, theme:t.theme, is_scout:t.is_scout||false
        }));
        await supabase.from('trades').insert(tradeInserts);

        // Update cash
        await supabase.from('algo_state').upsert({ user_id: uid, cash: result.cash, updated_at: new Date() });

        // Update positions — delete all and reinsert
        await supabase.from('positions').delete().eq('user_id', uid);
        const posInserts = Object.entries(result.positions).map(([ticker, p]) => ({
          user_id: uid, ticker, qty:p.qty, avg_cost:p.avg_cost,
          high_water:p.high_water, partial_taken:p.partial_taken, lane:p.lane, theme:p.theme
        }));
        if (posInserts.length > 0) await supabase.from('positions').insert(posInserts);

        // P&L history
        const tv = result.cash + Object.entries(result.positions).reduce((s,[t,p])=>s+(priceCache[t]||p.avg_cost)*p.qty,0);
        await supabase.from('pnl_history').insert({ user_id:uid, label:new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'}), value:Math.round(tv-40000) });

        // Fire WhatsApp signals
        if (userPhone) {
          for (const trade of result.newTrades) {
            const dev = trade.action==='BUY' ? 0.03 : 0.05;
            const validMins = trade.action==='BUY' ? 15 : 30;
            const upper = nf(trade.price*(1+dev));
            const lower = nf(trade.price*(1-dev));
            const msg = trade.action==='BUY'
              ? `VIEWORB: BUY ${trade.ticker} @ $${nf(trade.price)} — Valid ${validMins}min — Skip if above $${upper} (+${(dev*100).toFixed(0)}%) or below $${lower} (-${(dev*100).toFixed(0)}%)`
              : `VIEWORB: SELL ${trade.ticker} @ $${nf(trade.price)} — Valid ${validMins}min — Skip if below $${lower} (-${(dev*100).toFixed(0)}%)`;
            await sendWhatsApp(userPhone, msg);

            // Save signal
            await supabase.from('signals').insert({
              user_id:uid, action:trade.action, ticker:trade.ticker, price:trade.price,
              pos_value:trade.pos_value, deviation:dev, valid_mins:validMins,
              expiry:new Date(Date.now()+validMins*60000), reason:trade.reason
            });
          }
        }
      }
    }
  } catch(e) {
    console.error('Algo tick error:', e.message);
  }
}

// ── INTELLIGENCE SCAN ────────────────────────────────────────────────────────

async function runIntelScan(uid, portRows, posRows, cash) {
  if (!ANTHROPIC_KEY) return;
  try {
    const portStr = (portRows||[]).map(h=>`${h.ticker} x${h.qty}`).join(', ') || 'none';
    const posStr  = (posRows||[]).map(p=>`${p.ticker} $${nf((priceCache[p.ticker]||p.avg_cost)*p.qty)} L${p.lane}`).join(', ') || 'none';
    const prompt  = `ViewOrb paper trader. Space/AI/chips thesis. Cash:$${nf(cash)} | Positions:${posStr} | Portfolio:${portStr}\n\nSearch latest space and AI stock news. Reply exactly:\nMARKET READ: (2 sentences)\nSIGNAL: (one ticker and why)\nPLAN: (what you'll do next 24h)\nADVICE: (one line based on your own algo trades only)`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:500, tools:[{type:'web_search_20250305',name:'web_search'}], messages:[{role:'user',content:prompt}] })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    intelligenceCache[uid] = text;
    await supabase.from('feed').insert({ user_id:uid, label:'Market Scan', text, type:'sig' });
    // Keep only last 30 feed entries
    const { data: feedRows } = await supabase.from('feed').select('id').eq('user_id', uid).order('ts', {ascending:false});
    if (feedRows && feedRows.length > 30) {
      const toDelete = feedRows.slice(30).map(r=>r.id);
      await supabase.from('feed').delete().in('id', toDelete);
    }
  } catch(e) { console.error('Intel scan error:', e.message); }
}

// ── PRICE + SCAN SCHEDULER ───────────────────────────────────────────────────

async function mainLoop() {
  console.log('ViewOrb server started');
  // Initial price poll
  await pollAllPrices();

  // Algo every 30s
  setInterval(algoTick, 30000);

  // Price poll every 30s
  setInterval(async () => {
    try {
      const { data: users } = await supabase.from('users').select('id');
      const { data: portAll } = await supabase.from('portfolio').select('ticker');
      const { data: scoutAll } = await supabase.from('scout_watchlist').select('ticker');
      const extra = [...new Set([...(portAll||[]).map(h=>h.ticker), ...(scoutAll||[]).map(s=>s.ticker)])];
      await pollAllPrices(extra);
    } catch(e) {}
  }, 30000);

  // Intel scan every 3 hours per user
  setInterval(async () => {
    const now = Date.now();
    if (now - lastIntelScan < 3*60*60*1000) return;
    lastIntelScan = now;
    try {
      const { data: users } = await supabase.from('users').select('id');
      for (const user of users||[]) {
        const [{ data: portRows }, { data: posRows }, { data: algoState }] = await Promise.all([
          supabase.from('portfolio').select('*').eq('user_id', user.id),
          supabase.from('positions').select('*').eq('user_id', user.id),
          supabase.from('algo_state').select('cash').eq('user_id', user.id).single(),
        ]);
        await runIntelScan(user.id, portRows, posRows, algoState?.cash||40000);
        await sleep(5000);
      }
    } catch(e) {}
  }, 30*60*1000);
}

mainLoop();

// ── REST API ─────────────────────────────────────────────────────────────────

// Auth
app.post('/api/register', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({ phone, password_hash: hash }).select().single();
  if (error) return res.status(400).json({ error: 'Phone already registered' });
  await supabase.from('algo_state').insert({ user_id: data.id, cash: 40000 });
  await supabase.from('settings').insert({ user_id: data.id, phone });
  res.json({ user_id: data.id });
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ user_id: user.id });
});

// State sync
app.get('/api/state/:uid', async (req, res) => {
  const uid = req.params.uid;
  const [
    { data: algoState },
    { data: positions },
    { data: trades },
    { data: portfolio },
    { data: feed },
    { data: signals },
    { data: realMirror },
    { data: scoutWl },
    { data: pnlHist },
    { data: settings },
  ] = await Promise.all([
    supabase.from('algo_state').select('*').eq('user_id', uid).single(),
    supabase.from('positions').select('*').eq('user_id', uid),
    supabase.from('trades').select('*').eq('user_id', uid).order('ts', {ascending:false}).limit(500),
    supabase.from('portfolio').select('*').eq('user_id', uid),
    supabase.from('feed').select('*').eq('user_id', uid).order('ts', {ascending:false}).limit(30),
    supabase.from('signals').select('*').eq('user_id', uid).order('ts', {ascending:false}).limit(100),
    supabase.from('real_mirror').select('*').eq('user_id', uid).order('ts', {ascending:false}).limit(200),
    supabase.from('scout_watchlist').select('*').eq('user_id', uid),
    supabase.from('pnl_history').select('*').eq('user_id', uid).order('ts', {ascending:true}).limit(500),
    supabase.from('settings').select('*').eq('user_id', uid).single(),
  ]);

  res.json({
    cash: algoState?.cash ?? 40000,
    positions: positions || [],
    trades: trades || [],
    portfolio: portfolio || [],
    feed: feed || [],
    signals: signals || [],
    realMirror: realMirror || [],
    scoutWatchlist: scoutWl || [],
    pnlHistory: pnlHist || [],
    settings: settings || {},
    prices: priceCache,
    prevClose,
  });
});

// Portfolio
app.post('/api/portfolio/:uid', async (req, res) => {
  const { holdings } = req.body;
  await supabase.from('portfolio').delete().eq('user_id', req.params.uid);
  if (holdings.length > 0) await supabase.from('portfolio').insert(holdings.map(h=>({...h, user_id:req.params.uid})));
  res.json({ ok: true });
});

// Settings
app.post('/api/settings/:uid', async (req, res) => {
  await supabase.from('settings').upsert({ ...req.body, user_id: req.params.uid, updated_at: new Date() });
  res.json({ ok: true });
});

// Confirm signal
app.post('/api/signal-confirm/:uid', async (req, res) => {
  const { signal_id, confirmed } = req.body;
  await supabase.from('signals').update({ confirmed }).eq('id', signal_id);
  if (confirmed === 'yes') {
    const { data: sig } = await supabase.from('signals').select('*').eq('id', signal_id).single();
    if (sig) await supabase.from('real_mirror').insert({ user_id: req.params.uid, action:sig.action, ticker:sig.ticker, price:sig.price, confirmed:'yes' });
  }
  res.json({ ok: true });
});

// Reset algo
app.post('/api/reset/:uid', async (req, res) => {
  await Promise.all([
    supabase.from('algo_state').upsert({ user_id:req.params.uid, cash:40000 }),
    supabase.from('positions').delete().eq('user_id', req.params.uid),
    supabase.from('trades').delete().eq('user_id', req.params.uid),
    supabase.from('pnl_history').delete().eq('user_id', req.params.uid),
    supabase.from('feed').delete().eq('user_id', req.params.uid),
    supabase.from('signals').delete().eq('user_id', req.params.uid),
  ]);
  res.json({ ok: true });
});

// Force intel scan
app.post('/api/scan/:uid', async (req, res) => {
  const [{ data: portRows }, { data: posRows }, { data: algoState }] = await Promise.all([
    supabase.from('portfolio').select('*').eq('user_id', req.params.uid),
    supabase.from('positions').select('*').eq('user_id', req.params.uid),
    supabase.from('algo_state').select('cash').eq('user_id', req.params.uid).single(),
  ]);
  await runIntelScan(req.params.uid, portRows, posRows, algoState?.cash||40000);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ViewOrb server running on port ${PORT}`));
