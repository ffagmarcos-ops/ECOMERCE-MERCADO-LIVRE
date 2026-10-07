const crypto = require('crypto');

function normalizeBaseUrl(value) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+(?:\/[^\s]*)?$/i.test(url)) {
        throw new Error('Informe uma URL válida para a Evolution API.');
    }
    return url;
}

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
    const [rows] = await pool.query(
        "SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'"
    );
    if (rows.length) return Buffer.from(rows[0].setting_value, 'hex');
    const key = crypto.randomBytes(32);
    await pool.query(
        "INSERT IGNORE INTO integration_settings (setting_key, setting_value) VALUES ('_enc_key', ?)",
        [key.toString('hex')]
    );
    const [stored] = await pool.query(
        "SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'"
    );
    return Buffer.from(stored[0].setting_value, 'hex');
}

async function ensureTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_channels (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            provider ENUM('evolution','cloud') NOT NULL,
            evolution_url VARCHAR(500) NULL,
            evolution_instance VARCHAR(120) NULL,
            evolution_api_key TEXT NULL,
            cloud_access_token TEXT NULL,
            cloud_phone_number_id VARCHAR(120) NULL,
            cloud_waba_id VARCHAR(120) NULL,
            cloud_graph_version VARCHAR(20) NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_whatsapp_evolution_instance (evolution_url, evolution_instance),
            UNIQUE KEY uniq_whatsapp_cloud_phone (cloud_phone_number_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
}

function publicChannel(row) {
    return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        enabled: Boolean(row.enabled),
        evolutionUrl: row.evolution_url,
        evolutionInstance: row.evolution_instance,
        cloudPhoneNumberId: row.cloud_phone_number_id,
        cloudWabaId: row.cloud_waba_id,
        cloudGraphVersion: row.cloud_graph_version,
        hasEvolutionApiKey: Boolean(row.evolution_api_key),
        hasCloudAccessToken: Boolean(row.cloud_access_token)
    };
}

async function listChannels(pool) {
    const [rows] = await pool.query(`
        SELECT id, name, provider, enabled, evolution_url, evolution_instance, evolution_api_key,
               cloud_access_token, cloud_phone_number_id, cloud_waba_id, cloud_graph_version
        FROM whatsapp_channels
        ORDER BY provider, name
    `);
    return rows.map(publicChannel);
}

function validate(input) {
    const provider = String(input.provider || '');
    const name = String(input.name || '').trim();
    if (!name || !['evolution', 'cloud'].includes(provider)) {
        throw new Error('Informe o nome e o provedor do canal.');
    }

    if (provider === 'evolution') {
        const evolutionUrl = normalizeBaseUrl(input.evolutionUrl);
        const evolutionInstance = String(input.evolutionInstance || '').trim();
        const evolutionApiKey = String(input.evolutionApiKey || '').trim();
        if (!/^[A-Za-z0-9_-]{3,120}$/.test(evolutionInstance)) {
            throw new Error('O nome da instância Evolution deve ter de 3 a 120 caracteres alfanuméricos.');
        }
        return { name, provider, evolutionUrl, evolutionInstance, evolutionApiKey, enabled: input.enabled !== false };
    }

    const cloudAccessToken = String(input.cloudAccessToken || '').trim();
    const cloudPhoneNumberId = String(input.cloudPhoneNumberId || '').trim();
    const cloudWabaId = String(input.cloudWabaId || '').trim();
    const cloudGraphVersion = String(input.cloudGraphVersion || 'v23.0').trim();
    if (!/^\d+$/.test(cloudPhoneNumberId)) throw new Error('Informe o Phone Number ID da Meta.');
    if (cloudWabaId && !/^\d+$/.test(cloudWabaId)) throw new Error('O WABA ID deve conter apenas números.');
    if (!/^v\d+\.\d+$/.test(cloudGraphVersion)) throw new Error('Informe a versão da Graph API no formato v23.0.');
    return { name, provider, cloudAccessToken, cloudPhoneNumberId, cloudWabaId, cloudGraphVersion, enabled: input.enabled !== false };
}

async function saveChannel(pool, input) {
    const channel = validate(input);
    const key = await encryptionKey(pool);
    if (input.id) {
        const [existingRows] = await pool.query('SELECT * FROM whatsapp_channels WHERE id = ?', [input.id]);
        if (!existingRows.length) throw new Error('Canal não encontrado.');
        const existing = existingRows[0];
        if (channel.provider === 'evolution') {
            await pool.query(`
                UPDATE whatsapp_channels
                SET name = ?, provider = ?, evolution_url = ?, evolution_instance = ?,
                    evolution_api_key = ?, cloud_access_token = NULL, cloud_phone_number_id = NULL,
                    cloud_waba_id = NULL, cloud_graph_version = NULL, enabled = ?
                WHERE id = ?
            `, [
                channel.name, channel.provider, channel.evolutionUrl, channel.evolutionInstance,
                channel.evolutionApiKey ? encrypt(channel.evolutionApiKey, key) : existing.evolution_api_key,
                channel.enabled ? 1 : 0, input.id
            ]);
        } else {
            await pool.query(`
                UPDATE whatsapp_channels
                SET name = ?, provider = ?, evolution_url = NULL, evolution_instance = NULL,
                    evolution_api_key = NULL, cloud_access_token = ?, cloud_phone_number_id = ?,
                    cloud_waba_id = ?, cloud_graph_version = ?, enabled = ?
                WHERE id = ?
            `, [
                channel.name, channel.provider,
                channel.cloudAccessToken ? encrypt(channel.cloudAccessToken, key) : existing.cloud_access_token,
                channel.cloudPhoneNumberId, channel.cloudWabaId || null, channel.cloudGraphVersion,
                channel.enabled ? 1 : 0, input.id
            ]);
        }
        return;
    }

    if (channel.provider === 'evolution') {
        if (!channel.evolutionApiKey) throw new Error('Informe a API Key da Evolution.');
        await pool.query(`
            INSERT INTO whatsapp_channels
            (name, provider, evolution_url, evolution_instance, evolution_api_key, enabled)
            VALUES (?, 'evolution', ?, ?, ?, ?)
        `, [channel.name, channel.evolutionUrl, channel.evolutionInstance, encrypt(channel.evolutionApiKey, key), channel.enabled ? 1 : 0]);
    } else {
        if (!channel.cloudAccessToken) throw new Error('Informe o Access Token permanente da Meta.');
        await pool.query(`
            INSERT INTO whatsapp_channels
            (name, provider, cloud_access_token, cloud_phone_number_id, cloud_waba_id, cloud_graph_version, enabled)
            VALUES (?, 'cloud', ?, ?, ?, ?, ?)
        `, [
            channel.name, encrypt(channel.cloudAccessToken, key), channel.cloudPhoneNumberId,
            channel.cloudWabaId || null, channel.cloudGraphVersion, channel.enabled ? 1 : 0
        ]);
    }
}

async function deleteChannel(pool, id) {
    await pool.query('DELETE FROM whatsapp_channels WHERE id = ?', [id]);
}

async function request(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    if (!response.ok) throw new Error(payload.message || payload.error?.message || `HTTP ${response.status}`);
    return payload;
}

async function channelRow(pool, id) {
    const [rows] = await pool.query('SELECT * FROM whatsapp_channels WHERE id = ?', [id]);
    if (!rows.length) throw new Error('Canal não encontrado.');
    return rows[0];
}

function evolutionHeaders(apiKey) {
    return { apikey: apiKey, 'content-type': 'application/json' };
}

async function evolutionRequest(row, key, path, options = {}) {
    return request(`${row.evolution_url}${path}`, {
        ...options,
        headers: { ...evolutionHeaders(decrypt(row.evolution_api_key, key)), ...(options.headers || {}) }
    });
}

async function createEvolutionInstance(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'evolution') throw new Error('Este canal não usa Evolution API.');
    const key = await encryptionKey(pool);
    return evolutionRequest(row, key, '/instance/create', {
        method: 'POST',
        body: JSON.stringify({
            instanceName: row.evolution_instance,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: true
        })
    });
}

async function evolutionQrCode(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'evolution') throw new Error('Este canal não usa Evolution API.');
    const key = await encryptionKey(pool);
    const encoded = encodeURIComponent(row.evolution_instance);
    const response = await evolutionRequest(row, key, `/instance/connect/${encoded}`);
    const base64 = response.base64 || response.qrcode?.base64 || response.instance?.qrcode || '';
    return { base64, code: response.code || response.qrcode?.code || '', raw: response };
}

async function evolutionStatus(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'evolution') throw new Error('Este canal não usa Evolution API.');
    const key = await encryptionKey(pool);
    const encoded = encodeURIComponent(row.evolution_instance);
    try {
        return await evolutionRequest(row, key, `/instance/connectionState/${encoded}`);
    } catch {
        return evolutionRequest(row, key, `/instance/${encoded}/connection-state`);
    }
}

async function cloudStatus(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'cloud') throw new Error('Este canal não usa WhatsApp Cloud API.');
    const key = await encryptionKey(pool);
    const version = row.cloud_graph_version || 'v23.0';
    const accessToken = decrypt(row.cloud_access_token, key);
    return request(
        `https://graph.facebook.com/${version}/${encodeURIComponent(row.cloud_phone_number_id)}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { authorization: `Bearer ${accessToken}` } }
    );
}

module.exports = {
    ensureTables,
    listChannels,
    saveChannel,
    deleteChannel,
    createEvolutionInstance,
    evolutionQrCode,
    evolutionStatus,
    cloudStatus
};
