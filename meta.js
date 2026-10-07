const crypto = require('crypto');

const DEFAULT_GRAPH_VERSION = 'v23.0';

function encrypt(value, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString('hex')).join(':');
}

function decrypt(payload, key) {
    try {
        const [iv, tag, data] = String(payload).split(':').map(part => Buffer.from(part, 'hex'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

async function encryptionKey(pool) {
    if (process.env.INTEGRATION_SECRET_KEY) {
        return crypto.createHash('sha256').update(process.env.INTEGRATION_SECRET_KEY).digest();
    }
    const [rows] = await pool.query("SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'");
    if (rows.length) return Buffer.from(rows[0].setting_value, 'hex');
    const key = crypto.randomBytes(32);
    await pool.query("INSERT IGNORE INTO integration_settings (setting_key, setting_value) VALUES ('_enc_key', ?)", [key.toString('hex')]);
    const [stored] = await pool.query("SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'");
    return Buffer.from(stored[0].setting_value, 'hex');
}

async function ensureTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS meta_publications (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            item_id VARCHAR(30) NOT NULL,
            network ENUM('facebook','instagram') NOT NULL,
            remote_id VARCHAR(180) NULL,
            status ENUM('published','failed') NOT NULL,
            error_message VARCHAR(500) NULL,
            published_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_meta_item_network (item_id, network)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function loadConfig(pool) {
    const [rows] = await pool.query("SELECT setting_key, setting_value FROM integration_settings WHERE setting_key LIKE 'meta_%'");
    const values = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    const key = await encryptionKey(pool);
    return {
        appId: values.meta_app_id || '',
        pageId: values.meta_page_id || '',
        pageAccessToken: values.meta_page_access_token ? decrypt(values.meta_page_access_token, key) : '',
        instagramUserId: values.meta_instagram_user_id || '',
        instagramAccessToken: values.meta_instagram_access_token ? decrypt(values.meta_instagram_access_token, key) : '',
        graphVersion: values.meta_graph_version || DEFAULT_GRAPH_VERSION,
        autoFacebook: values.meta_auto_facebook === '1',
        autoInstagram: values.meta_auto_instagram === '1'
    };
}

function publicConfig(config) {
    return {
        configured: Boolean(config.pageId || config.instagramUserId),
        appId: config.appId,
        pageId: config.pageId,
        instagramUserId: config.instagramUserId,
        graphVersion: config.graphVersion,
        autoFacebook: config.autoFacebook,
        autoInstagram: config.autoInstagram,
        hasPageAccessToken: Boolean(config.pageAccessToken),
        hasInstagramAccessToken: Boolean(config.instagramAccessToken)
    };
}

async function saveConfig(pool, input) {
    const key = await encryptionKey(pool);
    const current = await loadConfig(pool);
    const values = {
        meta_app_id: String(input.appId ?? current.appId).trim(),
        meta_page_id: String(input.pageId ?? current.pageId).trim(),
        meta_graph_version: String(input.graphVersion ?? current.graphVersion).trim() || DEFAULT_GRAPH_VERSION,
        meta_instagram_user_id: String(input.instagramUserId ?? current.instagramUserId).trim(),
        meta_auto_facebook: input.autoFacebook ? '1' : '0',
        meta_auto_instagram: input.autoInstagram ? '1' : '0'
    };
    if (!/^v\d+\.\d+$/.test(values.meta_graph_version)) throw new Error('A versão da Graph API é inválida.');
    if (String(input.pageAccessToken || '').trim()) values.meta_page_access_token = encrypt(String(input.pageAccessToken).trim(), key);
    if (String(input.instagramAccessToken || '').trim()) values.meta_instagram_access_token = encrypt(String(input.instagramAccessToken).trim(), key);
    for (const [settingKey, settingValue] of Object.entries(values)) {
        await pool.query(
            'INSERT INTO integration_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [settingKey, settingValue]
        );
    }
    return publicConfig(await loadConfig(pool));
}

async function request(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    if (!response.ok || payload.error) throw new Error(payload.error?.message || payload.message || `Meta HTTP ${response.status}`);
    return payload;
}

function caption(offer) {
    const price = Number(offer.price || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const discount = Number(offer.discount_pct) > 0 ? `\n🏷️ ${offer.discount_pct}% OFF` : '';
    return `🔥 ${offer.title}\n\n💰 ${price}${discount}\n\n🛒 Comprar agora: ${offer.affiliate_url}`;
}

async function publishFacebook(config, offer) {
    if (!config.pageId || !config.pageAccessToken) throw new Error('Configure Page ID e Page Access Token do Facebook.');
    const endpoint = `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.pageId)}/photos`;
    return request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: offer.image, message: caption(offer), access_token: config.pageAccessToken })
    });
}

async function publishInstagram(config, offer) {
    if (!config.instagramUserId || !config.instagramAccessToken) throw new Error('Configure Instagram User ID e token de publicação.');
    if (!/^https:\/\//i.test(String(offer.image || ''))) throw new Error('A oferta precisa ter uma URL HTTPS pública de imagem.');
    const base = `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.instagramUserId)}`;
    const container = await request(`${base}/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_url: offer.image, caption: caption(offer), access_token: config.instagramAccessToken })
    });
    return request(`${base}/media_publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creation_id: container.id, access_token: config.instagramAccessToken })
    });
}

async function publish(pool, itemId, networks) {
    const [offers] = await pool.query(
        "SELECT item_id, title, price, discount_pct, image, affiliate_url FROM product_candidates WHERE item_id = ? AND status = 'approved'",
        [itemId]
    );
    if (!offers.length) throw new Error('Oferta aprovada não encontrada.');
    const offer = offers[0];
    const config = await loadConfig(pool);
    const selected = Array.isArray(networks) && networks.length ? networks : ['facebook', 'instagram'];
    const results = [];
    for (const network of selected) {
        if (!['facebook', 'instagram'].includes(network)) continue;
        try {
            const result = network === 'facebook' ? await publishFacebook(config, offer) : await publishInstagram(config, offer);
            await pool.query(
                `INSERT INTO meta_publications (item_id, network, remote_id, status, published_at)
                 VALUES (?, ?, ?, 'published', NOW())
                 ON DUPLICATE KEY UPDATE remote_id = VALUES(remote_id), status = 'published', error_message = NULL, published_at = NOW()`,
                [itemId, network, result.post_id || result.id || null]
            );
            results.push({ network, ok: true, id: result.post_id || result.id || null });
        } catch (error) {
            await pool.query(
                `INSERT INTO meta_publications (item_id, network, status, error_message)
                 VALUES (?, ?, 'failed', ?)
                 ON DUPLICATE KEY UPDATE status = 'failed', error_message = VALUES(error_message)`,
                [itemId, network, String(error.message).slice(0, 500)]
            );
            results.push({ network, ok: false, error: error.message });
        }
    }
    return results;
}

async function listOffers(pool) {
    const [rows] = await pool.query(`
        SELECT p.item_id, p.title, p.price, p.discount_pct, p.image, p.affiliate_url,
               GROUP_CONCAT(CONCAT(m.network, ':', m.status) SEPARATOR ',') AS meta_status
        FROM product_candidates p
        LEFT JOIN meta_publications m ON m.item_id = p.item_id
        WHERE p.status = 'approved'
        GROUP BY p.item_id
        ORDER BY p.updated_at DESC
        LIMIT 200
    `);
    return rows;
}

async function processAutomatic(pool, itemId) {
    const config = await loadConfig(pool);
    const networks = [];
    if (config.autoFacebook) networks.push('facebook');
    if (config.autoInstagram) networks.push('instagram');
    if (networks.length) return publish(pool, itemId, networks);
    return [];
}

module.exports = { ensureTables, loadConfig, publicConfig, saveConfig, listOffers, publish, processAutomatic };
