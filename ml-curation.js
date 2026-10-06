const ML_API = 'https://api.mercadolibre.com';

const crypto = require('crypto');
const ITEM_ATTRIBUTES = [
    'id', 'title', 'price', 'original_price', 'thumbnail', 'pictures', 'permalink', 'status',
    'available_quantity', 'sold_quantity', 'category_id', 'condition', 'shipping', 'catalog_product_id'
].join(',');
const MULTIGET_SIZE = 20;

let tokenCache = { value: null, expiresAt: 0 };

// Cache for the user-authorized token (OAuth authorization_code flow), required by endpoints
// like /sites/{site}/search that Mercado Livre no longer accepts with app-only (client_credentials) tokens.
let userTokenCache = { access: null, refresh: null, expiresAt: 0, userId: null };

// Mercado Livre's login/authorization host varies per country (note "mercadolivre" for Brazil).
const AUTH_HOSTS = {
    MLB: 'auth.mercadolivre.com.br',
    MLA: 'auth.mercadolibre.com.ar',
    MLM: 'auth.mercadolibre.com.mx',
    MLC: 'auth.mercadolibre.cl',
    MCO: 'auth.mercadolibre.com.co',
    MLU: 'auth.mercadolibre.com.uy',
    MLV: 'auth.mercadolibre.com.ve',
    MPE: 'auth.mercadolibre.com.pe',
    MEC: 'auth.mercadolibre.com.ec',
    MBO: 'auth.mercadolibre.com.bo',
    MPY: 'auth.mercadolibre.com.py',
    MCR: 'auth.mercadolibre.co.cr',
    MPA: 'auth.mercadolibre.com.pa',
    MHN: 'auth.mercadolibre.com.hn',
    MNI: 'auth.mercadolibre.com.ni',
    MGT: 'auth.mercadolibre.com.gt',
    MSV: 'auth.mercadolibre.com.sv',
    MDO: 'auth.mercadolibre.com.do'
};

// Per-installation configuration (white label): stored in the database, with env vars as fallback.
let config = envConfig();

function envConfig() {
    return {
        clientId: process.env.ML_CLIENT_ID || '',
        clientSecret: process.env.ML_CLIENT_SECRET || '',
        siteId: process.env.ML_SITE_ID || 'MLB',
        affiliateParams: process.env.ML_AFFILIATE_PARAMS || '',
        categories: process.env.ML_DISCOVERY_CATEGORIES || 'MLB1574,MLB1246,MLB1000,MLB1648',
        // Must match exactly an "Authorized redirect URI" registered for the app in the ML DevCenter.
        redirectUri: process.env.ML_REDIRECT_URI || (process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}/oauth/ml/callback` : '')
    };
}

function isConfigured() {
    return Boolean(config.clientId && config.clientSecret);
}

function discoveryCategories() {
    return String(config.categories).split(',').map(s => s.trim()).filter(c => /^MLB\d+$|^ML[A-Z]\d+$/.test(c));
}

async function ensureConfigTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS integration_settings (
            setting_key VARCHAR(100) PRIMARY KEY,
            setting_value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
}

// Encryption key: INTEGRATION_SECRET_KEY if provided, otherwise a random key generated once and kept in the database.
async function getEncryptionKey(pool) {
    if (process.env.INTEGRATION_SECRET_KEY) {
        return crypto.createHash('sha256').update(process.env.INTEGRATION_SECRET_KEY).digest();
    }
    const [rows] = await pool.query("SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'");
    if (rows.length) return Buffer.from(rows[0].setting_value, 'hex');
    const key = crypto.randomBytes(32);
    await pool.query("INSERT IGNORE INTO integration_settings (setting_key, setting_value) VALUES ('_enc_key', ?)", [key.toString('hex')]);
    const [again] = await pool.query("SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'");
    return Buffer.from(again[0].setting_value, 'hex');
}

function encrypt(text, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('hex')).join(':');
}

function decrypt(payload, key) {
    try {
        const [iv, tag, data] = String(payload).split(':').map(h => Buffer.from(h, 'hex'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (err) {
        return '';
    }
}

async function loadConfig(pool) {
    const [rows] = await pool.query("SELECT setting_key, setting_value FROM integration_settings WHERE setting_key LIKE 'ml_%'");
    const stored = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    const key = await getEncryptionKey(pool);
    const base = envConfig();
    config = {
        clientId: stored.ml_client_id || base.clientId,
        clientSecret: stored.ml_client_secret ? decrypt(stored.ml_client_secret, key) : base.clientSecret,
        siteId: stored.ml_site_id || base.siteId,
        affiliateParams: stored.ml_affiliate_params !== undefined ? stored.ml_affiliate_params : base.affiliateParams,
        categories: stored.ml_categories || base.categories,
        // White label: each installation can set its own callback URL from the admin panel.
        // Falls back to ML_REDIRECT_URI/APP_DOMAIN env vars when nothing is saved yet.
        redirectUri: stored.ml_redirect_uri || base.redirectUri
    };
    tokenCache = { value: null, expiresAt: 0 };
    userTokenCache = {
        access: stored.ml_user_access_token ? decrypt(stored.ml_user_access_token, key) : null,
        refresh: stored.ml_user_refresh_token ? decrypt(stored.ml_user_refresh_token, key) : null,
        expiresAt: Number(stored.ml_user_token_expires_at) || 0,
        userId: stored.ml_user_id || null
    };
}

async function saveConfig(pool, input) {
    const key = await getEncryptionKey(pool);
    const upsert = (k, v) => pool.query(
        'INSERT INTO integration_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);

    // A connected user token is tied to this app/credential pair; drop it so stale state isn't reported as "connected".
    const clientIdChanged = typeof input.clientId === 'string' && input.clientId.trim() && input.clientId.trim() !== config.clientId;
    if (clientIdChanged) await clearUserToken(pool);

    if (typeof input.clientId === 'string') await upsert('ml_client_id', input.clientId.trim());
    // An empty secret means "keep the current one"; the secret is never sent back to the browser.
    if (typeof input.clientSecret === 'string' && input.clientSecret.trim()) {
        await upsert('ml_client_secret', encrypt(input.clientSecret.trim(), key));
    }
    if (typeof input.siteId === 'string' && /^ML[A-Z]$/.test(input.siteId.trim())) await upsert('ml_site_id', input.siteId.trim());
    if (typeof input.affiliateParams === 'string') await upsert('ml_affiliate_params', input.affiliateParams.trim().replace(/^\?/, ''));
    if (typeof input.categories === 'string') await upsert('ml_categories', input.categories.trim());
    if (typeof input.redirectUri === 'string') {
        const redirectUri = input.redirectUri.trim().replace(/\/$/, '');
        if (redirectUri && !/^https:\/\/.+/i.test(redirectUri)) {
            throw new Error('A URI de redirecionamento precisa começar com https://.');
        }
        await upsert('ml_redirect_uri', redirectUri);
    }
    await loadConfig(pool);
}

function getPublicConfig() {
    return {
        configured: isConfigured(),
        clientId: config.clientId,
        hasClientSecret: Boolean(config.clientSecret),
        siteId: config.siteId,
        affiliateParams: config.affiliateParams,
        categories: config.categories,
        redirectUri: config.redirectUri,
        mlUserConnected: isUserConnected(),
        mlUserId: userTokenCache.userId || null
    };
}

function isUserConnected() {
    return Boolean(userTokenCache.access || userTokenCache.refresh);
}

async function testCredentials() {
    tokenCache = { value: null, expiresAt: 0 };
    await getAccessToken();
    return true;
}

async function getAccessToken() {
    if (!isConfigured()) throw new Error('Credenciais do Mercado Livre não configuradas.');
    if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.value;

    const response = await fetch(`${ML_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(`Falha ao obter token do Mercado Livre (HTTP ${response.status}).`);
    }
    tokenCache = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 21600) * 1000 };
    return tokenCache.value;
}

// Persists the user-authorized token pair (encrypted) so it survives restarts, and refreshes the in-memory cache.
async function persistUserToken(pool, data) {
    const key = await getEncryptionKey(pool);
    const upsert = (k, v) => pool.query(
        'INSERT INTO integration_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);

    await upsert('ml_user_access_token', encrypt(data.access_token, key));
    // Mercado Livre rotates refresh tokens on every use; keep the latest one or the previous one is lost.
    if (data.refresh_token) await upsert('ml_user_refresh_token', encrypt(data.refresh_token, key));
    const expiresAt = Date.now() + (data.expires_in || 21600) * 1000;
    await upsert('ml_user_token_expires_at', String(expiresAt));
    if (data.user_id) await upsert('ml_user_id', String(data.user_id));

    userTokenCache = {
        access: data.access_token,
        refresh: data.refresh_token || userTokenCache.refresh,
        expiresAt,
        userId: data.user_id || userTokenCache.userId
    };
}

async function clearUserToken(pool) {
    await pool.query("DELETE FROM integration_settings WHERE setting_key IN ('ml_user_access_token', 'ml_user_refresh_token', 'ml_user_token_expires_at', 'ml_user_id')");
    userTokenCache = { access: null, refresh: null, expiresAt: 0, userId: null };
}

// Returns a valid user access token, refreshing it first if needed. Returns null when not connected
// or when the refresh token itself has been revoked (the caller then falls back to the app token).
async function ensureUserAccessToken(pool) {
    if (userTokenCache.access && Date.now() < userTokenCache.expiresAt - 60000) return userTokenCache.access;
    if (!userTokenCache.refresh) return null;
    try {
        const response = await fetch(`${ML_API}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: config.clientId,
                client_secret: config.clientSecret,
                refresh_token: userTokenCache.refresh
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.access_token) return null;
        await persistUserToken(pool, data);
        return userTokenCache.access;
    } catch (err) {
        return null;
    }
}

function signState(key, payload) {
    return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

// Stateless CSRF token for the OAuth redirect round-trip: timestamp + HMAC, valid for 10 minutes.
async function buildOAuthState(pool) {
    const key = await getEncryptionKey(pool);
    const payload = String(Date.now());
    return `${payload}.${signState(key, payload)}`;
}

async function isOAuthStateValid(pool, state) {
    const [payload, signature] = String(state || '').split('.');
    if (!payload || !signature) return false;
    const key = await getEncryptionKey(pool);
    const expected = signState(key, payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const age = Date.now() - Number(payload);
    return age >= 0 && age < 10 * 60 * 1000;
}

// Builds the Mercado Livre login URL. The user approves access once; we then hold a refresh token
// that keeps working even after the short-lived access token expires.
async function getAuthorizationUrl(pool) {
    if (!isConfigured()) throw new Error('Configure o Client ID e o Client Secret antes de conectar a conta.');
    if (!config.redirectUri) throw new Error('Defina a URI de redirecionamento na configuração da integração (ou ML_REDIRECT_URI/APP_DOMAIN no servidor) para habilitar a conexão com o Mercado Livre.');
    const authHost = AUTH_HOSTS[config.siteId] || 'auth.mercadolibre.com';
    const url = new URL(`https://${authHost}/authorization`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    // offline_access is required to receive a refresh_token, so the server can renew access
    // without asking the seller to log in again every few hours.
    url.searchParams.set('scope', 'offline_access read');
    url.searchParams.set('state', await buildOAuthState(pool));
    return url.toString();
}

// Handles the OAuth callback: validates the state and exchanges the authorization code for tokens.
async function connectUserAccount(pool, { code, state }) {
    if (!(await isOAuthStateValid(pool, state))) {
        throw new Error('Estado de autorização inválido ou expirado. Tente conectar novamente.');
    }
    if (!code) throw new Error('Código de autorização ausente na resposta do Mercado Livre.');
    if (!config.redirectUri) throw new Error('URI de redirecionamento não configurada.');

    const response = await fetch(`${ML_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: config.redirectUri
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(`Falha ao autorizar a conta do Mercado Livre (HTTP ${response.status}).`);
    }
    await persistUserToken(pool, data);
    return { userId: data.user_id || null };
}

async function disconnectUserAccount(pool) {
    await clearUserToken(pool);
}

async function mlGet(pathAndQuery, { preferUser = false } = {}) {
    let token;
    let usingUser = false;
    if (preferUser && userTokenCache.access && Date.now() < userTokenCache.expiresAt - 60000) {
        token = userTokenCache.access;
        usingUser = true;
    } else {
        token = await getAccessToken();
    }
    const response = await fetch(`${ML_API}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    if (response.status === 401) {
        if (usingUser) userTokenCache.expiresAt = 0;
        else tokenCache = { value: null, expiresAt: 0 };
    }
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
}

// Multiget returns [{code, body}] preserving the requested order.
async function fetchItems(ids) {
    const results = new Map();
    for (let i = 0; i < ids.length; i += MULTIGET_SIZE) {
        const batch = ids.slice(i, i + MULTIGET_SIZE);
        const res = await mlGet(`/items?ids=${batch.join(',')}&attributes=${ITEM_ATTRIBUTES}`);
        if (!res.ok || !Array.isArray(res.body)) {
            throw new Error(`Falha ao consultar itens no Mercado Livre (HTTP ${res.status}).`);
        }
        res.body.forEach((entry, idx) => results.set(batch[idx], entry));
    }
    return results;
}

function buildAffiliateUrl(permalink) {
    if (!permalink) return '';
    const params = new URLSearchParams(config.affiliateParams);
    const url = new URL(permalink);
    params.forEach((value, key) => url.searchParams.set(key, value));
    return url.toString();
}

function normalizeItem(item) {
    const price = Number(item.price) || 0;
    const oldPrice = Number(item.original_price) || null;
    const discount = oldPrice && oldPrice > price ? Math.round((1 - price / oldPrice) * 100) : 0;
    const pictures = (item.pictures || []).map(p => p.secure_url || p.url).filter(Boolean);
    const thumb = (item.thumbnail || '').replace(/^http:/, 'https:').replace(/-I\.jpg$/, '-O.jpg');
    return {
        item_id: item.id,
        title: item.title,
        price,
        old_price: oldPrice,
        discount_pct: discount,
        image: pictures[0] || thumb,
        image_2: pictures[1] || '',
        permalink: item.permalink,
        category_id: item.category_id || '',
        sold_quantity: Number(item.sold_quantity) || 0,
        available_quantity: Number(item.available_quantity) || 0,
        free_shipping: item.shipping && item.shipping.free_shipping ? 1 : 0,
        condition: item.condition
    };
}

// Score 0-100: demand (sales), deal, shipping and affinity with what already converts on the storefront.
function scoreItem(item, categoryClicks = 0) {
    const demand = Math.min(1, Math.log10(item.sold_quantity + 1) / 4) * 45;
    const deal = Math.min(item.discount_pct, 50) / 50 * 25;
    const shipping = item.free_shipping ? 10 : 0;
    const stock = item.available_quantity >= 5 ? 5 : 0;
    const affinity = Math.min(categoryClicks, 20) / 20 * 15;
    const score = Math.round(demand + deal + shipping + stock + affinity);
    const reasons = [];
    if (item.sold_quantity >= 100) reasons.push(`${item.sold_quantity}+ vendidos`);
    if (item.discount_pct >= 10) reasons.push(`${item.discount_pct}% OFF`);
    if (item.free_shipping) reasons.push('frete grátis');
    if (categoryClicks > 0) reasons.push('categoria com cliques na vitrine');
    return { score, reason: reasons.join(' · ') };
}

function isSellable(item) {
    return item.status === 'active' && item.available_quantity > 0;
}

async function collectCandidateIds(pool, { queries = [], categories = [], topClicked = [] }) {
    const found = new Map();
    const errors = [];
    // Proactively refresh/validate the user token once so every fromSearch() call below can reuse it from cache.
    await ensureUserAccessToken(pool);
    const add = (id, source) => {
        if (/^ML[A-Z]\d+$/.test(id || '') && !found.has(id)) found.set(id, source);
    };

    async function fromSearch(params, source) {
        // The search endpoint now requires a user-authorized token; app-only (client_credentials)
        // tokens get a 403 from Mercado Livre, so skip the call entirely if nobody is connected.
        if (!isUserConnected()) return errors.push(`${source}: conecte a conta do Mercado Livre na configuração da integração para habilitar buscas.`);
        const res = await mlGet(`/sites/${config.siteId}/search?${new URLSearchParams({ limit: '20', ...params })}`, { preferUser: true });
        if (!res.ok) return errors.push(`${source}: HTTP ${res.status}`);
        (res.body.results || []).forEach(r => add(r.id, source));
    }

    for (const q of queries) await fromSearch({ q, sort: 'relevance' }, `busca:${q}`).catch(e => errors.push(e.message));

    for (const category of (categories.length ? categories : discoveryCategories())) {
        try {
            const res = await mlGet(`/highlights/${config.siteId}/category/${category}`);
            if (!res.ok) { errors.push(`destaques ${category}: HTTP ${res.status}`); continue; }
            for (const entry of (res.body.content || []).slice(0, 20)) {
                if (entry.type === 'ITEM') add(entry.id, `destaques:${category}`);
                else if (entry.type === 'PRODUCT') {
                    const product = await mlGet(`/products/${entry.id}`);
                    const winner = product.ok && product.body.buy_box_winner;
                    if (winner) add(winner.item_id, `destaques:${category}`);
                }
            }
        } catch (e) { errors.push(e.message); }
    }

    try {
        const trends = await mlGet(`/trends/${config.siteId}`);
        if (trends.ok && Array.isArray(trends.body)) {
            for (const trend of trends.body.slice(0, 5)) {
                await fromSearch({ q: trend.keyword, limit: '10' }, `tendência:${trend.keyword}`);
            }
        } else errors.push(`tendências: HTTP ${trends.status}`);
    } catch (e) { errors.push(e.message); }

    for (const name of topClicked) {
        const q = String(name).split(/\s+/).slice(0, 4).join(' ');
        await fromSearch({ q, limit: '10' }, `similar:${q}`).catch(e => errors.push(e.message));
    }

    return { ids: [...found.keys()], sources: found, errors };
}

async function ensureCandidateTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS product_candidates (
            item_id VARCHAR(30) PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            price DECIMAL(10,2),
            old_price DECIMAL(10,2) NULL,
            discount_pct INT DEFAULT 0,
            image MEDIUMTEXT,
            image_2 MEDIUMTEXT,
            permalink TEXT,
            affiliate_url MEDIUMTEXT,
            category_id VARCHAR(30),
            store_category VARCHAR(100) DEFAULT '',
            sold_quantity INT DEFAULT 0,
            available_quantity INT DEFAULT 0,
            free_shipping TINYINT(1) DEFAULT 0,
            score INT DEFAULT 0,
            reason VARCHAR(255) DEFAULT '',
            source VARCHAR(120) DEFAULT '',
            status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_candidates_status (status, score)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
}

async function getSalesFlow(pool) {
    const [byCategory] = await pool.query(
        `SELECT category, COUNT(*) AS clicks FROM clicks
         WHERE created_at >= (NOW() - INTERVAL 30 DAY) AND category <> ''
         GROUP BY category ORDER BY clicks DESC`
    );
    const [byProduct] = await pool.query(
        `SELECT name, COUNT(*) AS clicks FROM clicks
         WHERE created_at >= (NOW() - INTERVAL 30 DAY)
         GROUP BY product_id, name ORDER BY clicks DESC LIMIT 3`
    );
    return { byCategory, topClicked: byProduct.map(r => r.name).filter(Boolean) };
}

async function discoverCandidates(pool, options = {}) {
    const flow = await getSalesFlow(pool);
    const { ids, sources, errors } = await collectCandidateIds(pool, { ...options, topClicked: flow.topClicked });
    const [existing] = await pool.query('SELECT item_id FROM product_candidates UNION SELECT id FROM products');
    const known = new Set(existing.map(r => String(r.item_id)));
    const fresh = ids.filter(id => !known.has(id));
    if (!fresh.length) return { added: 0, scanned: ids.length, errors };

    const items = await fetchItems(fresh);
    const maxClicks = flow.byCategory.length ? Number(flow.byCategory[0].clicks) : 0;
    let added = 0;

    for (const [id, entry] of items) {
        if (entry.code !== 200 || !isSellable(entry.body)) continue;
        const item = normalizeItem(entry.body);
        if (!item.image || item.price <= 0) continue;
        const { score, reason } = scoreItem(item, maxClicks ? Math.round(maxClicks / 2) : 0);
        await pool.query(
            `INSERT IGNORE INTO product_candidates
             (item_id, title, price, old_price, discount_pct, image, image_2, permalink, affiliate_url,
              category_id, sold_quantity, available_quantity, free_shipping, score, reason, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, item.title.slice(0, 255), item.price, item.old_price, item.discount_pct, item.image, item.image_2,
                item.permalink, buildAffiliateUrl(item.permalink), item.category_id, item.sold_quantity,
                item.available_quantity, item.free_shipping, score, reason, (sources.get(id) || '').slice(0, 120)]
        );
        added++;
    }
    return { added, scanned: ids.length, errors };
}

// Resolves which Mercado Livre entity a storefront product points to (item listing or catalog product).
function resolveMlRef(product) {
    const id = String(product.id);
    if (/^ML[A-Z]\d+$/.test(id)) return { kind: 'item', mlId: id };
    const url = String(product.url || '');
    const catalog = /\/p\/(ML[A-Z]\d+)/.exec(url);
    if (catalog) return { kind: 'catalog', mlId: catalog[1] };
    const item = /(ML[A-Z])-?(\d{6,})/.exec(url);
    if (item) return { kind: 'item', mlId: `${item[1]}${item[2]}` };
    return null;
}

async function mapLimit(list, limit, fn) {
    const queue = [...list];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) await fn(queue.shift());
    }));
}

// Removes storefront products and drops pending candidates that are no longer purchasable.
async function verifyAvailability(pool) {
    const summary = { checked: 0, removed: [], priceUpdated: 0, candidatesDropped: 0, error: null };
    try {
        const [products] = await pool.query('SELECT id, name, price, url FROM products');
        const [candidates] = await pool.query("SELECT item_id FROM product_candidates WHERE status = 'pending'");
        const refs = products.map(p => ({ product: p, ref: resolveMlRef(p) })).filter(r => r.ref);
        const itemIds = [...new Set([
            ...refs.filter(r => r.ref.kind === 'item').map(r => r.ref.mlId),
            ...candidates.map(c => c.item_id)
        ])];
        const items = itemIds.length ? await fetchItems(itemIds) : new Map();
        const isItemGone = entry => entry && (entry.code === 404 || (entry.code === 200 && !isSellable(entry.body)));
        const removeProduct = async product => {
            await pool.query('DELETE FROM products WHERE id = ?', [product.id]);
            summary.removed.push({ id: product.id, name: product.name });
        };
        summary.checked = refs.length + candidates.length;

        const catalogRefs = refs.filter(r => r.ref.kind === 'catalog');
        const gonePromises = [];
        await mapLimit(catalogRefs, 5, async ({ product, ref }) => {
            const res = await mlGet(`/products/${ref.mlId}`);
            if (res.status === 404 || (res.ok && res.body && res.body.status && res.body.status !== 'active')) {
                gonePromises.push(product);
            } else if (!res.ok) {
                throw new Error(`Falha ao consultar produto de catálogo (HTTP ${res.status}).`);
            }
        });
        for (const product of gonePromises) await removeProduct(product);

        for (const { product, ref } of refs.filter(r => r.ref.kind === 'item')) {
            const entry = items.get(ref.mlId);
            if (isItemGone(entry)) {
                await removeProduct(product);
            } else if (entry && entry.code === 200 && Number(entry.body.price) > 0 && Number(entry.body.price) !== Number(product.price)) {
                await pool.query('UPDATE products SET price = ?, oldPrice = ? WHERE id = ?',
                    [entry.body.price, entry.body.original_price || null, product.id]);
                summary.priceUpdated++;
            }
        }

        for (const candidate of candidates) {
            if (isItemGone(items.get(candidate.item_id))) {
                await pool.query('DELETE FROM product_candidates WHERE item_id = ?', [candidate.item_id]);
                summary.candidatesDropped++;
            }
        }
    } catch (err) {
        // On API failures nothing further is removed, so an outage never empties the storefront.
        summary.error = err.message;
    }
    return summary;
}
// Checks list entries against the official API: current price, photos and availability.
// Entries are { mlbId, permalink }. Ambiguous ids (user products, unknown links) are left untouched.
async function enrichRefs(entries) {
    const result = {};
    const itemEntries = [];
    const catalogEntries = [];
    for (const entry of entries) {
        const id = String(entry.mlbId || '');
        const url = String(entry.permalink || '');
        const catalog = /\/p\/(ML[A-Z]\d+)/.exec(url);
        if (catalog) catalogEntries.push({ key: id, mlId: catalog[1] });
        else if (/^ML[A-Z]\d{7,11}$/.test(id) && !/\/up\//.test(url)) itemEntries.push({ key: id, mlId: id });
    }
    const itemMap = itemEntries.length ? await fetchItems([...new Set(itemEntries.map(e => e.mlId))]) : new Map();
    for (const { key, mlId } of itemEntries) {
        const entry = itemMap.get(mlId);
        if (!entry) continue;
        if (entry.code === 404) result[key] = { available: false };
        else if (entry.code === 200) {
            const n = normalizeItem(entry.body);
            result[key] = { available: isSellable(entry.body), title: n.title, price: n.price, oldPrice: n.old_price, image: n.image, permalink: n.permalink };
        }
    }
    await mapLimit(catalogEntries, 5, async ({ key, mlId }) => {
        const res = await mlGet(`/products/${mlId}`);
        if (res.status === 404) result[key] = { available: false };
        else if (res.ok && res.body) {
            const pic = (res.body.pictures || [])[0];
            result[key] = { available: !res.body.status || res.body.status === 'active', title: res.body.name, image: pic ? (pic.secure_url || pic.url) : '' };
        }
    });
    return result;
}

// Refreshes product photos from the official API. Photos uploaded manually (not hosted by ML) are kept.
async function refreshImages(pool, ids = null) {
    const summary = { checked: 0, updated: 0, skipped: 0, unavailable: 0, error: null };
    try {
        const [allProducts] = await pool.query('SELECT id, name, url, img_url FROM products');
        const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
        const products = wanted ? allProducts.filter(p => wanted.has(String(p.id))) : allProducts;
        const isMlImage = value => !value || /mlstatic\.com/i.test(value);
        const targets = [];
        for (const product of products) {
            const ref = resolveMlRef(product);
            if (!ref || !isMlImage(product.img_url)) { summary.skipped++; continue; }
            targets.push({ product, ref });
        }
        summary.checked = targets.length;
        const info = await enrichRefs(targets.map(({ ref }) => ({
            mlbId: ref.mlId,
            permalink: ref.kind === 'catalog' ? `/p/${ref.mlId}` : ''
        })));
        for (const { product, ref } of targets) {
            const data = info[ref.mlId];
            if (!data) { summary.skipped++; continue; }
            if (!data.available) summary.unavailable++;
            if (data.image && data.image !== product.img_url) {
                await pool.query('UPDATE products SET img_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [data.image, product.id]);
                summary.updated++;
            }
        }
    } catch (err) {
        summary.error = err.message;
    }
    return summary;
}

module.exports = {
    refreshImages, enrichRefs, isConfigured, ensureConfigTable, loadConfig, saveConfig, getPublicConfig, testCredentials, ensureCandidateTable, discoverCandidates, verifyAvailability, getSalesFlow, buildAffiliateUrl,
    getAuthorizationUrl, connectUserAccount, disconnectUserAccount, isUserConnected
};
