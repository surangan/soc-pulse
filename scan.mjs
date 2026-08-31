// SoC Pulse server-side scanner
// Runs in GitHub Actions (Node 20+). Scans public sources and writes data/mentions.json.
// Reddit needs REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET; Bluesky works best with
// BSKY_HANDLE / BSKY_APP_PASSWORD. Both are optional - see SETUP.md.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const RETAIN_DAYS = 30;
const CUTOFF = Date.now() - RETAIN_DAYS * 86400000;
const MAX_ITEMS = 300;
const KEYWORDS = ['computing', 'computer science', 'coursereg', 'cs1101s', 'cs2030s', 'fyp', 'soc'];
const OUT = 'data/mentions.json';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function classify(text) {
  const t = text.toLowerCase();
  if (/(depress|anxi|suicid|self[- ]?harm|burn[t ]?out|burnout|overwhelm|mental health|hopeless|lonely|breaking down)/.test(t))
    return { sev: 'attn', tag: 'Possible wellbeing signal \u00b7 route to wellbeing team \u2014 no automated reply' };
  if (/(complain|fail|worst|angry|disappoint|frustrat|scam|broken|can'?t get|cannot get|no job|jobless|reject|retrench|unfair|rant|struggl|regret|stress|toxic|waste)/.test(t))
    return { sev: 'attn', tag: 'Negative sentiment \u00b7 review &amp; monitor' };
  if (/(congrat|award|win\b|won\b|proud|launch|welcome|love|amazing|best|excit|achiev|grateful|thank|top \d|breakthrough|scholarship)/.test(t))
    return { sev: 'good', tag: 'Positive mention \u00b7 consider amplifying' };
  return { sev: 'neutral', tag: 'Community chatter \u00b7 monitor' };
}

async function fetchJSON(url, opts = {}, ms = 15000) {
  const c = new AbortController();
  const to = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) { clearTimeout(to); throw e; }
}

const kwMatch = low => KEYWORDS.some(k => low.includes(k)) || /\bsoc\b|school of computing|comp\s?sci/.test(low);

async function scanNUSWhispers() {
  const out = [];
  const addConf = c => {
    const ts = c.created_at || c.status_updated_at || '';
    if (!ts) return;
    const when = new Date(String(ts).replace(' ', 'T') + '+08:00'); // API times are SGT
    if (isNaN(when) || when.getTime() < CUTOFF) return;
    const body = (c.content || '').replace(/\s+/g, ' ').trim();
    if (!body) return;
    const cls = classify(body);
    out.push({
      id: 'w' + c.confession_id, sev: cls.sev, src: 'NUSWhispers', time: when.toISOString(),
      reach: 'Confession #' + c.confession_id + ' \u00b7 ' + (c.views || 0) + ' views' + (c.fb_like_count ? ' \u00b7 ' + c.fb_like_count + ' likes' : ''),
      text: esc(body.length > 240 ? body.slice(0, 240) + '\u2026' : body),
      tag: cls.tag, url: 'https://www.nuswhispers.com/confession/' + c.confession_id
    });
  };
  const recent = await fetchJSON('https://www.nuswhispers.com/api/confessions/recent?count=60');
  for (const c of recent.data?.confessions || []) {
    if (kwMatch((c.content || '').toLowerCase())) addConf(c);
  }
  for (const kw of KEYWORDS.slice(0, 4)) {
    try {
      const j = await fetchJSON('https://www.nuswhispers.com/api/confessions/search/' + encodeURIComponent(kw) + '?count=10');
      for (const c of j.data?.confessions || []) addConf(c);
    } catch (e) { /* keep going */ }
  }
  return out;
}

async function scanHackerNews() {
  const out = [];
  const j = await fetchJSON('https://hn.algolia.com/api/v1/search_by_date?query=' + encodeURIComponent('"NUS" computing') + '&tags=story&hitsPerPage=20');
  for (const h of j.hits || []) {
    const when = new Date(h.created_at);
    if (isNaN(when) || when.getTime() < CUTOFF) continue;
    const title = (h.title || '').trim();
    if (!title) continue;
    if (!(/\bnus\b/i.test(title) || kwMatch(title.toLowerCase()))) continue;
    const cls = classify(title);
    out.push({
      id: 'hn' + h.objectID, sev: cls.sev, src: 'Hacker News', time: when.toISOString(),
      reach: (h.points || 0) + ' points \u00b7 ' + (h.num_comments || 0) + ' comments',
      text: esc(title), tag: cls.tag,
      url: h.url || 'https://news.ycombinator.com/item?id=' + h.objectID
    });
  }
  return out;
}

async function scanBluesky() {
  const out = [];
  const q = encodeURIComponent('NUS computing');
  const handle = process.env.BSKY_HANDLE, pw = process.env.BSKY_APP_PASSWORD;
  let j;
  if (handle && pw) {
    // Authenticated: Bluesky's public AppView rejects datacenter IPs, but a logged-in
    // session through the user's PDS is allowed. App passwords are revocable and read-only here.
    const sess = await fetchJSON('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password: pw })
    });
    j = await fetchJSON('https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=' + q + '&limit=25', {
      headers: { 'Authorization': 'Bearer ' + sess.accessJwt }
    });
  } else {
    try {
      j = await fetchJSON('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=' + q + '&limit=25');
    } catch (e) {
      throw new Error('no credentials (see SETUP.md) - public API returned ' + e.message);
    }
  }
  for (const p of j.posts || []) {
    const rkey = (p.uri || '').split('/').pop();
    const when = new Date(p.record?.createdAt);
    if (isNaN(when) || when.getTime() < CUTOFF) continue;
    const body = (p.record?.text || '').replace(/\s+/g, ' ').trim();
    if (!/\bnus\b/i.test(body)) continue;
    const cls = classify(body);
    out.push({
      id: 'b' + rkey, sev: cls.sev, src: 'Bluesky', time: when.toISOString(),
      reach: (p.likeCount || 0) + ' likes \u00b7 ' + (p.repostCount || 0) + ' reposts',
      text: esc(body.length > 240 ? body.slice(0, 240) + '\u2026' : body),
      tag: cls.tag, url: 'https://bsky.app/profile/' + (p.author?.handle || '') + '/post/' + rkey
    });
  }
  return out;
}

async function scanReddit() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('no credentials (see SETUP.md)');
  const ua = process.env.REDDIT_USER_AGENT || 'soc-pulse-scanner/1.0 (NUS SoC comms monitoring)';
  const tok = await fetchJSON('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua
    },
    body: 'grant_type=client_credentials'
  });
  const j = await fetchJSON('https://oauth.reddit.com/r/nus/new?limit=50', {
    headers: { 'Authorization': 'Bearer ' + tok.access_token, 'User-Agent': ua }
  });
  const out = [];
  for (const k of j.data?.children || []) {
    const p = k.data || {};
    const when = new Date((p.created_utc || 0) * 1000);
    if (isNaN(when) || when.getTime() < CUTOFF) continue;
    const body = ((p.title || '') + '. ' + (p.selftext || '')).replace(/\s+/g, ' ').trim();
    if (!kwMatch(body.toLowerCase())) continue;
    const cls = classify(body);
    out.push({
      id: 'r' + p.id, sev: cls.sev, src: 'Reddit \u00b7 r/nus', time: when.toISOString(),
      reach: (p.ups || 0) + ' upvotes \u00b7 ' + (p.num_comments || 0) + ' comments',
      text: esc(body.length > 240 ? body.slice(0, 240) + '\u2026' : body),
      tag: cls.tag, url: 'https://www.reddit.com' + p.permalink
    });
  }
  return out;
}

// ---- run all scanners, merge with existing file, write ----
let existing = [];
try { existing = JSON.parse(readFileSync(OUT, 'utf8')).mentions || []; } catch (e) { /* first run */ }

const byId = new Map();
for (const m of existing) {
  const t = new Date(m.time).getTime();
  if (!isNaN(t) && t >= CUTOFF) byId.set(m.id, m);
}

const sources = [
  ['NUSWhispers', scanNUSWhispers],
  ['Reddit \u00b7 r/nus', scanReddit],
  ['Bluesky', scanBluesky],
  ['Hacker News', scanHackerNews]
];
const log = [];
for (const [name, fn] of sources) {
  try {
    const items = await fn();
    let fresh = 0;
    for (const m of items) { if (!byId.has(m.id)) fresh++; byId.set(m.id, m); }
    log.push(name + ': ' + fresh + ' new (' + items.length + ' in window)');
  } catch (e) {
    log.push(name + ': FAILED - ' + e.message);
  }
}

const mentions = [...byId.values()]
  .sort((a, b) => new Date(b.time) - new Date(a.time))
  .slice(0, MAX_ITEMS);

mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  retain_days: RETAIN_DAYS,
  log,
  mentions
}, null, 1));

console.log('SoC Pulse scan complete:');
for (const l of log) console.log('  ' + l);
console.log('  total in ' + OUT + ': ' + mentions.length);
