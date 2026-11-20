/*
 * Bazaar Buzz local server — zero dependencies (only Node.js built-ins).
 * Run:  node server.js   then open http://localhost:3000
 *
 * Stores everything in data/db.json:
 *   users (passwords hashed with scrypt), sessions, deals, coupon claims, payments.
 * Admin page (see who signed up): http://localhost:3000/admin?key=YOUR_ADMIN_KEY
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------- CONFIG ---------------- */
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
const PORT = +(process.env.PORT || fileCfg.PORT || 3000);
const CFG = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || fileCfg.GOOGLE_CLIENT_ID || '',
  X_CLIENT_ID: process.env.X_CLIENT_ID || fileCfg.X_CLIENT_ID || '',
  X_CLIENT_SECRET: process.env.X_CLIENT_SECRET || fileCfg.X_CLIENT_SECRET || '',
  ADMIN_KEY: process.env.ADMIN_KEY || fileCfg.ADMIN_KEY || 'bazaarbuzz-admin',
  GOOGLE_VERIFY_FILE: process.env.GOOGLE_VERIFY_FILE || fileCfg.GOOGLE_VERIFY_FILE || '',
  GOOGLE_VERIFY_META: process.env.GOOGLE_VERIFY_META || fileCfg.GOOGLE_VERIFY_META || '',
  BASE_URL: (process.env.BASE_URL || fileCfg.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, ''),
  SUPABASE_URL: (process.env.SUPABASE_URL || fileCfg.SUPABASE_URL || '').replace(/\/$/, ''),
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || fileCfg.SUPABASE_SERVICE_KEY || '',
  // SMS one-time codes: SMS_PROVIDER = messagecentral | fast2sms | test
  SMS_PROVIDER: (process.env.SMS_PROVIDER || fileCfg.SMS_PROVIDER || '').toLowerCase(),
  MC_CUSTOMER_ID: process.env.MC_CUSTOMER_ID || fileCfg.MC_CUSTOMER_ID || '',
  MC_PASSWORD: process.env.MC_PASSWORD || fileCfg.MC_PASSWORD || '',
  FAST2SMS_API_KEY: process.env.FAST2SMS_API_KEY || fileCfg.FAST2SMS_API_KEY || '',
};
const CLOUD = !!(CFG.SUPABASE_URL && CFG.SUPABASE_SERVICE_KEY);

/* ---------------- DATABASE (JSON file) ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: [], sessions: {}, deals: [], claims: [], payments: [], reels: [], reviews: [], likes: {}, comments: {}, follows: {} };
const UPLOADS = path.join(__dirname, 'data', 'uploads');
const MAX_VIDEO = 30 * 1024 * 1024;
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { save(); }
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  if (CLOUD) pushCloud();
}

/* ---------------- CLOUD STORAGE (Supabase, optional) ----------------
   Free hosts (Render etc.) wipe local files on restart. If SUPABASE_URL + SUPABASE_SERVICE_KEY are set,
   the whole database is also kept in a Supabase table so nothing is lost.
   Create the table once in Supabase → SQL editor:
     create table paaspost_store (id text primary key, data jsonb not null);
     alter table paaspost_store enable row level security;            */
const sbHeaders = () => ({ apikey: CFG.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' });
async function loadCloud() {
  const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/paaspost_store?id=eq.main&select=data`, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase load failed: ' + r.status + ' ' + (await r.text()));
  const rows = await r.json();
  if (rows[0] && rows[0].data) db = { ...db, ...rows[0].data };
}
let cloudTimer = null, cloudBusy = false, cloudAgain = false;
function pushCloud() {
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(async () => {
    if (cloudBusy) { cloudAgain = true; return; }
    cloudBusy = true;
    try {
      const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/paaspost_store?on_conflict=id`, { method: 'POST', headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 'main', data: db }) });
      if (!r.ok) console.error('Supabase save failed:', r.status, await r.text());
    } catch (e) { console.error('Supabase save error:', e.message); }
    cloudBusy = false;
    if (cloudAgain) { cloudAgain = false; pushCloud(); }
  }, 400);
}

/* ---------------- HELPERS ---------------- */
const id = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
function hashPass(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPass(pw, user) {
  if (!user.hash) return false;
  const h = crypto.scryptSync(pw, user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}
const publicUser = (u) => (ensureHandle(u), { id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, provider: u.provider, createdAt: u.createdAt,
  handle: u.handle, bio: u.bio || '', city: u.city || '', phone: u.phone || '', avatar: u.avatar || '', mobile: u.mobile || '' });
function ensureHandle(u) {
  if (u.handle) return u.handle;
  const base = (String(u.name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'user').slice(0, 18);
  let h = base, n = 0;
  while (db.users.some((x) => x !== u && x.handle === h)) h = base + '_' + (++n < 5 ? Math.floor(10 + Math.random() * 90) : Math.floor(1000 + Math.random() * 9000));
  u.handle = h; save(); return h;
}
const MAX_AVATAR = 4 * 1024 * 1024;

/* ---------------- SMS one-time codes ---------------- */
const OTP = {}, OTP_LOG = {};
setInterval(() => { const t = Date.now(); for (const k in OTP) if (OTP[k].exp < t) delete OTP[k]; for (const k in OTP_LOG) if (!OTP_LOG[k].some((x) => t - x < 36e5)) delete OTP_LOG[k]; }, 10 * 60e3).unref();
function smsReady() {
  const p = CFG.SMS_PROVIDER;
  return (p === 'messagecentral' && !!(CFG.MC_CUSTOMER_ID && CFG.MC_PASSWORD)) || (p === 'fast2sms' && !!CFG.FAST2SMS_API_KEY) || p === 'test';
}
function normPhone(x) {
  let d = String(x || '').replace(/[^\d]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : null;
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const hashCode = (phone, code) => crypto.createHash('sha256').update(phone + ':' + code + ':' + CFG.ADMIN_KEY).digest('hex');
async function mcToken() {
  const q = new URLSearchParams({ customerId: CFG.MC_CUSTOMER_ID, key: Buffer.from(CFG.MC_PASSWORD).toString('base64'), scope: 'NEW', country: '91' });
  const r = await fetch('https://cpaas.messagecentral.com/auth/v1/authentication/token?' + q);
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('Message Central login failed (' + r.status + ')');
  return j.token;
}
async function sendSms(phone) {
  const local = phone.slice(3);
  if (CFG.SMS_PROVIDER === 'messagecentral') {
    const q = new URLSearchParams({ countryCode: '91', customerId: CFG.MC_CUSTOMER_ID, flowType: 'SMS', mobileNumber: local, otpLength: '6' });
    const r = await fetch('https://cpaas.messagecentral.com/verification/v3/send?' + q, { method: 'POST', headers: { authToken: await mcToken() } });
    const j = await r.json().catch(() => ({}));
    const vid = j.data && (j.data.verificationId || j.data.verficationId);
    if (!vid) throw new Error('Message Central send failed: ' + (j.message || r.status));
    return { vid: String(vid) };
  }
  const code = String(crypto.randomInt(100000, 1000000));
  if (CFG.SMS_PROVIDER === 'fast2sms') {
    const q = new URLSearchParams({ authorization: CFG.FAST2SMS_API_KEY, route: 'otp', variables_values: code, numbers: local, flash: '0' });
    const r = await fetch('https://www.fast2sms.com/dev/bulkV2?' + q);
    const j = await r.json().catch(() => ({}));
    if (!j.return) throw new Error('Fast2SMS send failed: ' + JSON.stringify(j.message || r.status));
  } else {
    console.log(`  📱 [SMS test mode] code for ${phone}: ${code}`);
  }
  return { hash: hashCode(phone, code) };
}
async function checkSms(cur, phone, code) {
  if (cur.verified && cur.okCode) return code === cur.okCode;
  let ok;
  if (cur.vid) {
    const q = new URLSearchParams({ verificationId: cur.vid, code });
    const r = await fetch('https://cpaas.messagecentral.com/verification/v3/validateOtp?' + q, { headers: { authToken: await mcToken() } });
    const j = await r.json().catch(() => ({}));
    ok = !!(j.data && j.data.verificationStatus === 'VERIFICATION_COMPLETED');
  } else ok = hashCode(phone, code) === cur.hash;
  if (ok) cur.okCode = code; // lets the same code finish sign-up after we ask for a name
  return ok;
}
const profileCard = (u) => (ensureHandle(u), { id: u.id, name: u.name, handle: u.handle, role: u.role, avatar: u.avatar || '' });
function newSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: user.id, createdAt: now() };
  save();
  return token;
}
function getUser(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (\w+)$/);
  const s = m && db.sessions[m[1]];
  return s ? db.users.find((u) => u.id === s.userId) : null;
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
  });
}
const clean = (s, n = 80) => String(s ?? '').trim().slice(0, n);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const ROLES = ['customer', 'business'];
const PLANS = ['free', 'basic', 'premium', 'featured'];
const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
function optUser(req) { try { return getUser(req); } catch (e) { return null; } }
const pubReel = (r, u) => ({ id: r.id, uid: r.userId, av: ((db.users.find((x) => x.id === r.userId) || {}).avatar) || '', src: r.src, by: r.by, role: r.role, shop: r.shop, place: r.place, cat: r.cat, caption: r.caption, rating: r.rating, offer: r.offer, createdAt: r.createdAt, mine: !!(u && u.id === r.userId) });
const pubReview = (v, u) => ({ id: v.id, place: v.place, shop: v.shop, by: v.by, rating: v.rating, text: v.text, createdAt: v.createdAt, mine: !!(u && u.id === v.userId), viaReel: !!v.viaReel });
function addReview(u, place, shop, rating, text, viaReel) {
  let v = db.reviews.find((x) => x.userId === u.id && x.place === place);
  if (v) Object.assign(v, { rating, text: text || v.text, shop: shop || v.shop, createdAt: now(), viaReel: viaReel || v.viaReel });
  else { v = { id: id('rv'), place, shop, userId: u.id, by: u.name, rating, text, createdAt: now(), viaReel }; db.reviews.unshift(v); }
  return v;
}
function upsertSocial({ provider, providerId, email, name, role }) {
  let u = db.users.find((x) => (providerId && x.provider === provider && x.providerId === providerId) || (email && x.email === email));
  if (!u) {
    u = { id: id('u'), name: name || 'Bazaar Buzz user', email, role: ROLES.includes(role) ? role : 'customer', plan: 'free', provider, providerId, createdAt: now() };
    db.users.push(u);
  }
  u.lastLogin = now();
  save();
  return u;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- X (Twitter) OAuth 2.0 PKCE ---------------- */
const pending = new Map(); // state -> { verifier, role, at }
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------------- API ROUTES ---------------- */
async function api(req, res, url) {
  const p = url.pathname, method = req.method;

  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/api/config') return send(res, 200, { googleClientId: CFG.GOOGLE_CLIENT_ID, xEnabled: !!(CFG.X_CLIENT_ID && CFG.X_CLIENT_SECRET), appleEnabled: false, phoneEnabled: smsReady() });

  /* ---------- phone number + SMS code ---------- */
  if (p === '/api/otp/send' && method === 'POST') {
    if (!smsReady()) return send(res, 503, { error: 'Phone sign-in is not set up yet. Please use Google or email.' });
    const b = await readBody(req), phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'Enter a valid 10-digit Indian mobile number.' });
    const ip = clientIp(req), t = Date.now();
    const recent = (k, ms) => (OTP_LOG[k] = (OTP_LOG[k] || []).filter((x) => t - x < ms));
    const cur = OTP[phone];
    if (cur && t - cur.sentAt < 30e3) return send(res, 429, { error: 'Please wait ' + Math.ceil((30e3 - (t - cur.sentAt)) / 1e3) + ' seconds before asking for a new code.', wait: Math.ceil((30e3 - (t - cur.sentAt)) / 1e3) });
    if (recent('p' + phone, 36e5).length >= 5) return send(res, 429, { error: 'Too many codes for this number. Try again in an hour.' });
    if (recent('i' + ip, 36e5).length >= 15) return send(res, 429, { error: 'Too many attempts from this network. Try again later.' });
    try {
      const sent = await sendSms(phone);
      OTP[phone] = { ...sent, sentAt: t, exp: t + 10 * 60e3, tries: 0 };
      OTP_LOG['p' + phone].push(t); OTP_LOG['i' + ip].push(t);
    } catch (e) {
      console.error('  SMS error:', e.message);
      return send(res, 502, { error: "We couldn't send the SMS right now. Please try again in a minute." });
    }
    return send(res, 200, { ok: true, phone: phone.replace(/^(\+91)(\d{2})\d{5}(\d{3})$/, '$1 $2•••••$3'), exists: db.users.some((u) => u.mobile === phone), wait: 30 });
  }
  if (p === '/api/otp/verify' && method === 'POST') {
    const b = await readBody(req), phone = normPhone(b.phone), code = String(b.code || '').replace(/\D/g, '');
    const cur = phone && OTP[phone];
    if (!cur || Date.now() > cur.exp) { if (phone) delete OTP[phone]; return send(res, 400, { error: 'This code has expired. Tap “Resend code” to get a new one.' }); }
    if (cur.tries >= 5) { delete OTP[phone]; return send(res, 429, { error: 'Too many wrong tries. Please ask for a new code.' }); }
    if (!/^\d{4,8}$/.test(code)) return send(res, 400, { error: 'Enter the code from the SMS.' });
    let ok = false;
    try { ok = await checkSms(cur, phone, code); } catch (e) { console.error('  SMS verify error:', e.message); return send(res, 502, { error: "We couldn't check the code right now. Please try again." }); }
    if (!ok) { cur.tries++; return send(res, 400, { error: 'That code is not right. ' + (5 - cur.tries) + ' tries left.' }); }
    let u = db.users.find((x) => x.mobile === phone);
    if (!u) {
      const name = clean(b.name, 40);
      if (name.length < 2) { cur.verified = true; return send(res, 200, { needName: true }); }
      u = { id: id('u'), name, email: '', mobile: phone, role: ROLES.includes(b.role) ? b.role : 'customer', plan: 'free', provider: 'phone', createdAt: now() };
      db.users.push(u);
    }
    delete OTP[phone];
    u.lastLogin = now(); u.mobileVerifiedAt = now(); save();
    return send(res, 200, { token: newSession(u), user: publicUser(u) });
  }

  if (p === '/api/signup' && method === 'POST') {
    const b = await readBody(req);
    const email = clean(b.email, 120).toLowerCase(), name = clean(b.name, 40), role = ROLES.includes(b.role) ? b.role : 'customer';
    if (!name) return send(res, 400, { error: 'Please enter your name.' });
    if (!validEmail(email)) return send(res, 400, { error: 'Please enter a valid email.' });
    if (String(b.password || '').length < 6) return send(res, 400, { error: 'Password must be at least 6 characters.' });
    if (db.users.find((u) => u.email === email)) return send(res, 409, { error: 'An account with this email already exists. Try logging in.' });
    const u = { id: id('u'), name, email, role, plan: 'free', provider: 'email', ...hashPass(String(b.password)), createdAt: now(), lastLogin: now() };
    db.users.push(u); save();
    return send(res, 201, { token: newSession(u), user: publicUser(u) });
  }

  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const u = db.users.find((x) => x.email === clean(b.email, 120).toLowerCase());
    if (!u || !checkPass(String(b.password || ''), u)) return send(res, 401, { error: 'Wrong email or password.' });
    u.lastLogin = now(); save();
    return send(res, 200, { token: newSession(u), user: publicUser(u) });
  }

  if (p === '/api/auth/google' && method === 'POST') {
    if (!CFG.GOOGLE_CLIENT_ID) return send(res, 400, { error: 'Google login is not configured on this server.' });
    const b = await readBody(req);
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(b.credential || ''));
    const t = await r.json();
    if (!r.ok || t.aud !== CFG.GOOGLE_CLIENT_ID || t.email_verified !== 'true') return send(res, 401, { error: 'Google sign-in could not be verified.' });
    const u = upsertSocial({ provider: 'google', providerId: t.sub, email: t.email.toLowerCase(), name: t.name, role: b.role });
    if (!u.avatar && /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(t.picture || '')) { u.avatar = t.picture; save(); }
    return send(res, 200, { token: newSession(u), user: publicUser(u) });
  }

  if (p === '/api/me' && method === 'GET') {
    const u = getUser(req);
    return u ? send(res, 200, { user: publicUser(u) }) : send(res, 401, { error: 'Not logged in.' });
  }

  /* ---------- profiles ---------- */
  if (p === '/api/me' && method === 'PATCH') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in.' });
    const b = await readBody(req);
    if (b.name !== undefined) { const n = clean(b.name, 40); if (n.length < 2) return send(res, 400, { error: 'Name should be at least 2 letters.' }); u.name = n; }
    if (b.handle !== undefined) {
      const h = String(b.handle).trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_.]{3,24}$/.test(h)) return send(res, 400, { error: 'Username can use 3–24 letters, numbers, _ or . only.' });
      if (db.users.some((x) => x !== u && x.handle === h)) return send(res, 409, { error: '@' + h + ' is already taken. Try another.' });
      u.handle = h;
    }
    if (b.bio !== undefined) u.bio = clean(b.bio, 150);
    if (b.city !== undefined) u.city = clean(b.city, 40);
    if (b.phone !== undefined) u.phone = clean(b.phone, 15).replace(/[^0-9+ ]/g, '');
    for (const r of db.reels) if (r.userId === u.id) r.by = u.name;
    save();
    return send(res, 200, { user: publicUser(u) });
  }
  if (p === '/api/me/avatar' && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in.' });
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[type];
    if (!ext) return send(res, 400, { error: 'Please choose a JPG, PNG or WebP photo.' });
    if (+req.headers['content-length'] > MAX_AVATAR) return send(res, 413, { error: 'Photo is too large (max 4 MB).' });
    const name = 'av_' + u.id + '_' + Date.now().toString(36) + ext, file = path.join(UPLOADS, name);
    await new Promise((resolve, reject) => {
      let size = 0; const ws = fs.createWriteStream(file);
      req.on('data', (c) => { size += c.length; if (size > MAX_AVATAR) { req.unpipe(ws); ws.destroy(); fs.unlink(file, () => {}); reject(new Error('Photo is too large (max 4 MB).')); } });
      req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
    });
    if (u.avatar && u.avatar.startsWith('/uploads/av_')) fs.unlink(path.join(UPLOADS, path.basename(u.avatar)), () => {});
    u.avatar = '/uploads/' + name; save();
    return send(res, 200, { user: publicUser(u) });
  }
  if (p === '/api/me/avatar' && method === 'DELETE') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in.' });
    if (u.avatar && u.avatar.startsWith('/uploads/av_')) fs.unlink(path.join(UPLOADS, path.basename(u.avatar)), () => {});
    u.avatar = ''; save();
    return send(res, 200, { user: publicUser(u) });
  }
  {
    const pm = p.match(/^\/api\/users\/([\w.@-]+)(\/follow|\/followers|\/following)?$/);
    if (pm) {
      const key = decodeURIComponent(pm[1]).replace(/^@/, '').toLowerCase();
      const t = db.users.find((x) => x.id === pm[1] || (ensureHandle(x), x.handle === key));
      if (!t) return send(res, 404, { error: 'This profile does not exist.' });
      const me = optUser(req), fl = db.follows;
      const followersOf = (uid) => fl[uid] || [];
      const followingOf = (uid) => Object.keys(fl).filter((k) => fl[k].includes(uid));
      if (pm[2] === '/follow' && method === 'POST') {
        if (!me) return send(res, 401, { error: 'Log in to follow people.' });
        if (me.id === t.id) return send(res, 400, { error: "You can't follow yourself." });
        const arr = fl[t.id] || (fl[t.id] = []), i = arr.indexOf(me.id);
        if (i >= 0) arr.splice(i, 1); else arr.push(me.id);
        save();
        return send(res, 200, { following: i < 0, followers: arr.length });
      }
      if (pm[2] === '/followers' || pm[2] === '/following') {
        const ids = pm[2] === '/followers' ? followersOf(t.id) : followingOf(t.id);
        return send(res, 200, { users: ids.map((i) => db.users.find((x) => x.id === i)).filter(Boolean).map(profileCard) });
      }
      if (!pm[2] && method === 'GET') {
        const reels = db.reels.filter((r) => r.userId === t.id);
        const likesOn = (rid) => (db.likes[rid] || []).length;
        const places = new Set([slug(t.name), ...reels.map((r) => r.place), ...db.deals.filter((d) => d.ownerId === t.id).map((d) => slug(d.shop))]);
        const shopReviews = t.role === 'business' ? db.reviews.filter((v) => places.has(v.place) && v.userId !== t.id) : [];
        const isMe = !!(me && me.id === t.id);
        const pub = publicUser(t);
        if (!isMe) { delete pub.email; delete pub.mobile; }
        if (t.role !== 'business' && !isMe) delete pub.phone;
        return send(res, 200, {
          user: pub, isMe,
          iFollow: !!(me && followersOf(t.id).includes(me.id)),
          stats: { reels: reels.length, likes: reels.reduce((a, r) => a + likesOn(r.id), 0), followers: followersOf(t.id).length, following: followingOf(t.id).length },
          rating: shopReviews.length ? { avg: shopReviews.reduce((a, v) => a + v.rating, 0) / shopReviews.length, n: shopReviews.length } : null,
          reels: reels.map((r) => ({ ...pubReel(r, me), likes: likesOn(r.id), comments: ((db.comments || {})[r.id] || []).length })),
          reviews: db.reviews.filter((v) => v.userId === t.id).map((v) => pubReview(v, me)),
          shopReviews: shopReviews.slice(0, 30).map((v) => pubReview(v, me)),
          deals: db.deals.filter((d) => d.ownerId === t.id).map(({ ownerId, ...d }) => d),
          liked: isMe ? Object.keys(db.likes).filter((k) => db.likes[k].includes(me.id)) : [],
        });
      }
    }
  }

  if (p === '/api/logout' && method === 'POST') {
    const m = (req.headers.authorization || '').match(/^Bearer (\w+)$/);
    if (m) { delete db.sessions[m[1]]; save(); }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/deals' && method === 'GET') {
    return send(res, 200, { deals: db.deals.map(({ ownerId, ...d }) => d) });
  }

  if (p === '/api/deals' && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in.' });
    if (u.role !== 'business') return send(res, 403, { error: 'Only business accounts can post offers.' });
    const b = await readBody(req);
    const lat = +b.lat, lng = +b.lng;
    if (!clean(b.shop) || !clean(b.offer) || !isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'Shop name, offer and location are required.' });
    const rank = { free: 0, basic: 1, premium: 2, featured: 3 };
    const wanted = PLANS.includes(b.pack) ? b.pack : 'free';
    const d = {
      id: id('d'), shop: clean(b.shop, 40), cat: clean(b.cat, 20), offer: clean(b.offer, 50), item: clean(b.item, 60),
      phone: clean(b.phone, 15).replace(/[^0-9+ ]/g, ''), valid: clean(b.valid, 20), lat, lng,
      pack: rank[wanted] <= rank[u.plan] ? wanted : 'free', ownerId: u.id, createdAt: now(),
    };
    db.deals.unshift(d); save();
    const { ownerId, ...pub } = d;
    return send(res, 201, { deal: pub });
  }

  /* ---------- reels ---------- */
  if (p === '/api/reels' && method === 'GET') {
    const u = optUser(req);
    const likes = {};
    for (const [rid, arr] of Object.entries(db.likes)) likes[rid] = { n: arr.length, liked: !!(u && arr.includes(u.id)) };
    const comments = {};
    for (const [rid, arr] of Object.entries(db.comments || {})) comments[rid] = arr.length;
    return send(res, 200, { reels: db.reels.map((r) => pubReel(r, u)), likes, comments });
  }
  if (p === '/api/reels' && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in to post a reel.' });
    let meta = {};
    try { meta = JSON.parse(decodeURIComponent(req.headers['x-meta'] || '%7B%7D')); } catch (e) {}
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' }[type];
    if (!ext) return send(res, 400, { error: 'Please upload an MP4, WebM or MOV video.' });
    if (+req.headers['content-length'] > MAX_VIDEO) return send(res, 413, { error: 'Video is too large (max 30 MB).' });
    const shop = clean(meta.shop, 40), rating = Math.round(+meta.rating || 0);
    if (!shop) return send(res, 400, { error: 'Tell us which shop or place this reel is about.' });
    if (u.role === 'customer' && !(rating >= 1 && rating <= 5)) return send(res, 400, { error: 'Please give the place a star rating.' });
    const rid = id('r'), file = path.join(UPLOADS, rid + ext);
    await new Promise((resolve, reject) => {
      let size = 0; const ws = fs.createWriteStream(file);
      req.on('data', (c) => { size += c.length; if (size > MAX_VIDEO) { req.unpipe(ws); ws.destroy(); fs.unlink(file, () => {}); reject(new Error('Video is too large (max 30 MB).')); } });
      req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
    });
    const r = { id: rid, src: '/uploads/' + rid + ext, userId: u.id, by: u.name, role: u.role, shop, place: slug(shop), cat: clean(meta.cat, 20),
      caption: clean(meta.caption, 160), rating: rating >= 1 && rating <= 5 ? rating : 0, offer: clean(meta.offer, 50), createdAt: now() };
    db.reels.unshift(r);
    if (r.rating) addReview(u, r.place, shop, r.rating, r.caption, true);
    save();
    return send(res, 201, { reel: pubReel(r, u) });
  }
  let m;
  if ((m = p.match(/^\/api\/reels\/([\w-]+)\/like$/)) && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Log in to like reels.' });
    const arr = db.likes[m[1]] || (db.likes[m[1]] = []);
    const i = arr.indexOf(u.id); if (i >= 0) arr.splice(i, 1); else arr.push(u.id);
    save();
    return send(res, 200, { n: arr.length, liked: i < 0 });
  }
  if ((m = p.match(/^\/api\/reels\/([\w-]+)\/comments$/))) {
    db.comments = db.comments || {};
    const u = optUser(req), arr = db.comments[m[1]] || [];
    const pub = (c) => ({ id: c.id, by: c.by, role: c.role, text: c.text, createdAt: c.createdAt, mine: !!(u && u.id === c.userId) });
    if (method === 'GET') return send(res, 200, { comments: arr.map(pub) });
    if (method === 'POST') {
      if (!u) return send(res, 401, { error: 'Log in to comment.' });
      const b = await readBody(req), text = clean(b.text, 300);
      if (!text) return send(res, 400, { error: 'Write something first.' });
      const c = { id: id('c'), userId: u.id, by: u.name, role: u.role, text, createdAt: now() };
      (db.comments[m[1]] = arr).push(c); save();
      return send(res, 201, { comment: pub(c), n: arr.length });
    }
  }
  if ((m = p.match(/^\/api\/reels\/([\w-]+)\/comments\/([\w-]+)$/)) && method === 'DELETE') {
    const u = getUser(req), arr = (db.comments || {})[m[1]] || [], i = arr.findIndex((c) => c.id === m[2]);
    if (!u || i < 0 || arr[i].userId !== u.id) return send(res, 403, { error: 'You can only delete your own comments.' });
    arr.splice(i, 1); save();
    return send(res, 200, { ok: true, n: arr.length });
  }
  if ((m = p.match(/^\/api\/reels\/([\w-]+)$/)) && method === 'DELETE') {
    const u = getUser(req); const r = db.reels.find((x) => x.id === m[1]);
    if (!u || !r || r.userId !== u.id) return send(res, 403, { error: 'You can only delete your own reels.' });
    db.reels = db.reels.filter((x) => x !== r); fs.unlink(path.join(UPLOADS, path.basename(r.src)), () => {}); save();
    return send(res, 200, { ok: true });
  }

  /* ---------- reviews / ratings ---------- */
  if (p === '/api/reviews' && method === 'GET') {
    const u = optUser(req);
    return send(res, 200, { reviews: db.reviews.map((v) => pubReview(v, u)) });
  }
  if (p === '/api/reviews' && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in to rate a place.' });
    const b = await readBody(req);
    const rating = Math.round(+b.rating || 0), shop = clean(b.shop, 40), place = slug(b.place || shop);
    if (!(rating >= 1 && rating <= 5)) return send(res, 400, { error: 'Pick 1 to 5 stars.' });
    if (!place) return send(res, 400, { error: 'Which place are you rating?' });
    const v = addReview(u, place, shop, rating, clean(b.text, 300), false);
    save();
    return send(res, 201, { review: pubReview(v, u) });
  }

  if (p === '/api/claims' && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in to claim coupons.' });
    const b = await readBody(req);
    const c = { id: id('c'), dealId: clean(b.dealId, 40), shop: clean(b.shop, 40), userId: u.id, code: 'BB' + crypto.randomBytes(3).toString('hex').toUpperCase(), createdAt: now() };
    db.claims.push(c); save();
    return send(res, 201, { code: c.code });
  }

  if (p === '/api/plan' && method === 'POST') {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Please log in.' });
    if (u.role !== 'business') return send(res, 403, { error: 'Packs are for business accounts.' });
    const b = await readBody(req);
    if (!PLANS.includes(b.plan)) return send(res, 400, { error: 'Unknown plan.' });
    u.plan = b.plan;
    db.payments.push({ id: id('pay'), userId: u.id, plan: b.plan, amount: +b.amount || 0, paymentId: clean(b.paymentId, 60), mode: String(b.paymentId || '').startsWith('TEST_') ? 'test' : 'razorpay', createdAt: now() });
    save();
    return send(res, 200, { user: publicUser(u) });
  }

  return send(res, 404, { error: 'Not found' });
}

/* ---------------- X OAUTH ROUTES ---------------- */
async function xAuth(req, res, url) {
  if (!CFG.X_CLIENT_ID || !CFG.X_CLIENT_SECRET) { res.writeHead(302, { Location: '/?authError=' + encodeURIComponent('X login is not configured') }); return res.end(); }
  const redirect = CFG.BASE_URL + '/auth/x/callback';
  if (url.pathname === '/auth/x/start') {
    const state = b64url(crypto.randomBytes(16)), verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    pending.set(state, { verifier, role: url.searchParams.get('role') || 'customer', at: Date.now() });
    const q = new URLSearchParams({ response_type: 'code', client_id: CFG.X_CLIENT_ID, redirect_uri: redirect, scope: 'users.read tweet.read', state, code_challenge: challenge, code_challenge_method: 'S256' });
    res.writeHead(302, { Location: 'https://x.com/i/oauth2/authorize?' + q }); return res.end();
  }
  // callback
  const st = pending.get(url.searchParams.get('state'));
  pending.delete(url.searchParams.get('state'));
  try {
    if (!st || !url.searchParams.get('code')) throw new Error('Login cancelled');
    const tok = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(CFG.X_CLIENT_ID + ':' + CFG.X_CLIENT_SECRET).toString('base64') },
      body: new URLSearchParams({ code: url.searchParams.get('code'), grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: st.verifier }),
    }).then((r) => r.json());
    if (!tok.access_token) throw new Error('X token exchange failed');
    const me = await fetch('https://api.x.com/2/users/me', { headers: { Authorization: 'Bearer ' + tok.access_token } }).then((r) => r.json());
    if (!me.data) throw new Error('Could not read X profile');
    const u = upsertSocial({ provider: 'x', providerId: me.data.id, email: '@' + me.data.username, name: me.data.name, role: st.role });
    res.writeHead(302, { Location: '/?token=' + newSession(u) }); res.end();
  } catch (e) {
    res.writeHead(302, { Location: '/?authError=' + encodeURIComponent(e.message) }); res.end();
  }
}

/* ---------------- ADMIN PAGE ---------------- */
function admin(req, res, url) {
  if (url.searchParams.get('key') !== CFG.ADMIN_KEY) { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<h2 style="font-family:sans-serif">Add ?key=YOUR_ADMIN_KEY to the URL</h2>'); }
  const row = (cells) => '<tr>' + cells.map((c) => `<td>${esc(c)}</td>`).join('') + '</tr>';
  const table = (title, head, rows) => `<h2>${title} <small>(${rows.length})</small></h2><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('') || `<tr><td colspan="${head.length}">Nothing yet</td></tr>`}</table>`;
  const name = (uid) => (db.users.find((u) => u.id === uid) || {}).email || '?';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Bazaar Buzz Admin</title><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:system-ui,sans-serif;background:#0B1124;color:#ECF1FF;padding:30px;max-width:1200px;margin:auto}h1{background:linear-gradient(120deg,#6366F1,#22D3EE);-webkit-background-clip:text;color:transparent}
  table{width:100%;border-collapse:collapse;margin-bottom:40px;background:#11183A;border-radius:12px;overflow:hidden}th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #1f2a5a;font-size:14px}th{background:#182150;color:#97A3CC}small{color:#97A3CC}</style></head><body>
  <h1>Bazaar Buzz Admin</h1><p><small>Data file: data/db.json · Refresh to update</small></p>
  ${table('Users', ['Name', 'Email', 'Role', 'Plan', 'Sign-in method', 'Joined', 'Last login'], db.users.map((u) => row([u.name, u.email, u.role, u.plan, u.provider, u.createdAt?.slice(0, 16).replace('T', ' '), (u.lastLogin || '').slice(0, 16).replace('T', ' ')])))}
  ${table('Deals posted', ['Shop', 'Category', 'Offer', 'Pack', 'Phone', 'Posted by', 'Date'], db.deals.map((d) => row([d.shop, d.cat, d.offer, d.pack, d.phone, name(d.ownerId), d.createdAt.slice(0, 10)])))}
  ${table('Coupons claimed', ['Code', 'Shop', 'User', 'Date'], db.claims.map((c) => row([c.code, c.shop, name(c.userId), c.createdAt.slice(0, 16).replace('T', ' ')])))}
  ${table('Reels posted', ['Shop', 'Caption', 'Rating', 'By', 'Role', 'Video', 'Date'], db.reels.map((r) => '<tr>' + [r.shop, r.caption, r.rating ? '★'.repeat(r.rating) : '-', r.by, r.role, ''].map((c) => `<td>${esc(c)}</td>`).join('').replace('<td></td>', `<td><a style="color:#22D3EE" href="${esc(r.src)}" target="_blank">open</a></td>`) + `<td>${esc(r.createdAt.slice(0, 16).replace('T', ' '))}</td></tr>`))}
  ${table('Ratings & reviews', ['Place', 'Stars', 'Review', 'By', 'From reel', 'Date'], db.reviews.map((v) => row([v.shop || v.place, '★'.repeat(v.rating), v.text || '', v.by, v.viaReel ? 'yes' : '', v.createdAt.slice(0, 16).replace('T', ' ')])))}
  ${table('Payments', ['Plan', 'Amount', 'Payment ID', 'Mode', 'User', 'Date'], db.payments.map((p) => row([p.plan, '₹' + p.amount, p.paymentId, p.mode, name(p.userId), p.createdAt.slice(0, 16).replace('T', ' ')])))}
  </body></html>`);
}

/* ---------------- STATIC FILES ---------------- */
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpeg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function sendFile(req, res, file, type, cache) {
  const size = fs.statSync(file).size, range = req.headers.range;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'public, max-age=3600' };
  if (range) {
    const mm = range.match(/bytes=(\d*)-(\d*)/) || [];
    let start = mm[1] ? +mm[1] : 0, end = mm[2] ? +mm[2] : size - 1;
    if (!mm[1] && mm[2]) { start = Math.max(0, size - +mm[2]); end = size - 1; }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}
function serveUpload(req, res, url) {
  const file = path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname)));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  sendFile(req, res, file, TYPES[path.extname(file)] || 'application/octet-stream', 'public, max-age=86400');
}
function serveStatic(req, res, url) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!path.extname(file) && fs.existsSync(file + '.html')) file = file + '.html';
  if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  if (file.endsWith('index.html')) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(file, 'utf8').replace('const SERVER_MODE=false;', 'const SERVER_MODE=true;')
      .replace('<!--SEO-->', `<link rel="canonical" href="${CFG.BASE_URL}/"><meta property="og:url" content="${CFG.BASE_URL}/">` + (CFG.GOOGLE_VERIFY_META ? `<meta name="google-site-verification" content="${esc(CFG.GOOGLE_VERIFY_META)}">` : '')));
  }
  sendFile(req, res, file, TYPES[path.extname(file)] || 'application/octet-stream', /\.(html|js|css|webmanifest)$/.test(file) ? 'no-cache' : undefined);
}

/* ---------------- SERVER ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/auth/x/')) return await xAuth(req, res, url);
    if (url.pathname === '/admin') return admin(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return serveUpload(req, res, url);
    if (url.pathname === '/me' || /^\/u\/[^/]+\/?$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(PUBLIC, 'profile.html'))); }
    if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${CFG.BASE_URL}/sitemap.xml\n`); }
    if (url.pathname === '/sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CFG.BASE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url><url><loc>${CFG.BASE_URL}/reels</loc><changefreq>daily</changefreq><priority>0.8</priority></url></urlset>`); }
    if (url.pathname.startsWith('/google') && url.pathname.endsWith('.html') && CFG.GOOGLE_VERIFY_FILE && url.pathname === '/' + CFG.GOOGLE_VERIFY_FILE) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('google-site-verification: ' + CFG.GOOGLE_VERIFY_FILE); }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message || 'Server error' });
  }
});
(CLOUD ? loadCloud().then(() => console.log('  ☁️  Loaded data from Supabase')) : Promise.resolve()).catch((e) => console.error('  ⚠️ ', e.message)).finally(() => server.listen(PORT, () => {
  console.log(`\n  🚀 Bazaar Buzz running at  http://localhost:${PORT}`);
  console.log(`  🔐 Admin page:          http://localhost:${PORT}/admin?key=${CFG.ADMIN_KEY}`);
  console.log(`  💾 Data saved in:       ${DB_FILE}`);
  console.log(`  ☁️  Cloud storage:       ${CLOUD ? 'Supabase ON' : 'off (local file only)'}`);
  console.log(`  Google login: ${CFG.GOOGLE_CLIENT_ID ? 'ON' : 'OFF (set GOOGLE_CLIENT_ID)'}`);
  console.log(`  Phone login:  ${smsReady() ? 'ON (' + CFG.SMS_PROVIDER + ')' : 'OFF (set SMS_PROVIDER + keys)'}\n`);
}));
