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
    const [rows] = await pool.query("SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'");
    if (rows.length) return Buffer.from(rows[0].setting_value, 'hex');
    const key = crypto.randomBytes(32);
    await pool.query("INSERT IGNORE INTO integration_settings (setting_key, setting_value) VALUES ('_enc_key', ?)", [key.toString('hex')]);
    const [stored] = await pool.query("SELECT setting_value FROM integration_settings WHERE setting_key = '_enc_key'");
    return Buffer.from(stored[0].setting_value, 'hex');
}

async function hasColumn(pool, table, column) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    return rows.length > 0;
}

async function hasIndex(pool, table, index) {
    const [rows] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [index]);
    return rows.length > 0;
}

async function ensureTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS evolution_servers (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            base_url VARCHAR(500) NOT NULL UNIQUE,
            api_key TEXT NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_channels (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            provider ENUM('evolution','cloud') NOT NULL,
            evolution_server_id BIGINT UNSIGNED NULL,
            evolution_url VARCHAR(500) NULL,
            evolution_instance VARCHAR(120) NULL,
            evolution_api_key TEXT NULL,
            evolution_target_type ENUM('conversation','group','channel') NULL,
            evolution_target VARCHAR(180) NULL,
            cloud_access_token TEXT NULL,
            cloud_phone_number_id VARCHAR(120) NULL,
            cloud_waba_id VARCHAR(120) NULL,
            cloud_graph_version VARCHAR(20) NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_whatsapp_evolution_instance (evolution_url, evolution_instance),
            UNIQUE KEY uniq_whatsapp_cloud_phone (cloud_phone_number_id),
            INDEX idx_whatsapp_evolution_server (evolution_server_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    if (!await hasColumn(pool, 'whatsapp_channels', 'evolution_server_id')) {
        await pool.query('ALTER TABLE whatsapp_channels ADD COLUMN evolution_server_id BIGINT UNSIGNED NULL AFTER provider');
        await pool.query('ALTER TABLE whatsapp_channels ADD INDEX idx_whatsapp_evolution_server (evolution_server_id)');
    }
    if (!await hasColumn(pool, 'whatsapp_channels', 'evolution_target_type')) {
        await pool.query("ALTER TABLE whatsapp_channels ADD COLUMN evolution_target_type ENUM('conversation','group','channel') NULL AFTER evolution_instance");
    }
    if (!await hasColumn(pool, 'whatsapp_channels', 'evolution_target')) {
        await pool.query('ALTER TABLE whatsapp_channels ADD COLUMN evolution_target VARCHAR(180) NULL AFTER evolution_target_type');
    }
    await migrateLegacyEvolutionChannels(pool);
    if (await hasIndex(pool, 'whatsapp_channels', 'uniq_whatsapp_evolution_instance')) {
        await pool.query('ALTER TABLE whatsapp_channels DROP INDEX uniq_whatsapp_evolution_instance');
    }
    if (!await hasIndex(pool, 'whatsapp_channels', 'uniq_whatsapp_server_instance')) {
        await pool.query(
            'ALTER TABLE whatsapp_channels ADD UNIQUE KEY uniq_whatsapp_server_instance (evolution_server_id, evolution_instance)'
        );
    }
}

async function migrateLegacyEvolutionChannels(pool) {
    const [legacy] = await pool.query(`
        SELECT id, evolution_url, evolution_api_key
        FROM whatsapp_channels
        WHERE provider = 'evolution' AND evolution_server_id IS NULL
          AND evolution_url IS NOT NULL AND evolution_api_key IS NOT NULL
    `);
    if (!legacy.length) return;
    const key = await encryptionKey(pool);
    for (const channel of legacy) {
        const [existing] = await pool.query('SELECT id FROM evolution_servers WHERE base_url = ?', [channel.evolution_url]);
        let serverId = existing[0]?.id;
        if (!serverId) {
            const [result] = await pool.query(
                'INSERT INTO evolution_servers (name, base_url, api_key) VALUES (?, ?, ?)',
                [`Servidor migrado: ${channel.evolution_url}`, channel.evolution_url, channel.evolution_api_key || encrypt('', key)]
            );
            serverId = result.insertId;
        }
        await pool.query('UPDATE whatsapp_channels SET evolution_server_id = ? WHERE id = ?', [serverId, channel.id]);
    }
}

function publicServer(row) {
    return {
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        enabled: Boolean(row.enabled),
        hasApiKey: Boolean(row.api_key)
    };
}

function publicChannel(row) {
    return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        enabled: Boolean(row.enabled),
        evolutionServerId: row.evolution_server_id,
        evolutionServerName: row.evolution_server_name || null,
        evolutionInstance: row.evolution_instance,
        evolutionTargetType: row.evolution_target_type,
        evolutionTarget: row.evolution_target,
        cloudPhoneNumberId: row.cloud_phone_number_id,
        cloudWabaId: row.cloud_waba_id,
        cloudGraphVersion: row.cloud_graph_version,
        hasCloudAccessToken: Boolean(row.cloud_access_token)
    };
}

async function listServers(pool) {
    const [rows] = await pool.query('SELECT id, name, base_url, api_key, enabled FROM evolution_servers ORDER BY name');
    return rows.map(publicServer);
}

async function listChannels(pool) {
    const [rows] = await pool.query(`
        SELECT c.*, s.name AS evolution_server_name
        FROM whatsapp_channels c
        LEFT JOIN evolution_servers s ON s.id = c.evolution_server_id
        ORDER BY c.provider, c.name
    `);
    return rows.map(publicChannel);
}

async function saveServer(pool, input) {
    const name = String(input.name || '').trim();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const apiKey = String(input.apiKey || '').trim();
    if (!name) throw new Error('Informe o nome do servidor Evolution.');
    const key = await encryptionKey(pool);
    if (input.id) {
        const [rows] = await pool.query('SELECT api_key FROM evolution_servers WHERE id = ?', [input.id]);
        if (!rows.length) throw new Error('Servidor Evolution não encontrado.');
        await pool.query(
            'UPDATE evolution_servers SET name = ?, base_url = ?, api_key = ?, enabled = ? WHERE id = ?',
            [name, baseUrl, apiKey ? encrypt(apiKey, key) : rows[0].api_key, input.enabled !== false ? 1 : 0, input.id]
        );
        return;
    }
    if (!apiKey) throw new Error('Informe a API Key do servidor Evolution.');
    await pool.query(
        'INSERT INTO evolution_servers (name, base_url, api_key, enabled) VALUES (?, ?, ?, ?)',
        [name, baseUrl, encrypt(apiKey, key), input.enabled !== false ? 1 : 0]
    );
}

async function deleteServer(pool, id) {
    const [inUse] = await pool.query(
        "SELECT COUNT(*) AS count FROM whatsapp_channels WHERE provider = 'evolution' AND evolution_server_id = ?",
        [id]
    );
    if (inUse[0].count) throw new Error('Não é possível excluir um servidor que possui instâncias vinculadas.');
    await pool.query('DELETE FROM evolution_servers WHERE id = ?', [id]);
}

function validateChannel(input) {
    const provider = String(input.provider || '');
    const name = String(input.name || '').trim();
    if (!name || !['evolution', 'cloud'].includes(provider)) {
        throw new Error('Informe o nome e o provedor da instância.');
    }
    if (provider === 'evolution') {
        const evolutionServerId = Number(input.evolutionServerId);
        const evolutionInstance = String(input.evolutionInstance || '').trim();
        const evolutionTargetType = String(input.evolutionTargetType || 'conversation');
        const evolutionTarget = String(input.evolutionTarget || '').trim();
        if (!Number.isInteger(evolutionServerId)) throw new Error('Selecione o servidor Evolution.');
        if (!/^[A-Za-z0-9_-]{3,120}$/.test(evolutionInstance)) {
            throw new Error('O nome da instância deve ter de 3 a 120 caracteres alfanuméricos.');
        }
        if (!['conversation', 'group', 'channel'].includes(evolutionTargetType)) {
            throw new Error('Selecione um tipo de destino Evolution válido.');
        }
        if (evolutionTarget.length > 180) throw new Error('O identificador do destino excede o tamanho permitido.');
        return {
            name, provider, evolutionServerId, evolutionInstance, evolutionTargetType,
            evolutionTarget, enabled: input.enabled !== false
        };
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
    const channel = validateChannel(input);
    const key = await encryptionKey(pool);
    if (channel.provider === 'evolution') {
        const [servers] = await pool.query('SELECT id FROM evolution_servers WHERE id = ? AND enabled = 1', [channel.evolutionServerId]);
        if (!servers.length) throw new Error('O servidor Evolution selecionado não está disponível.');
    }
    if (input.id) {
        const [existingRows] = await pool.query('SELECT * FROM whatsapp_channels WHERE id = ?', [input.id]);
        if (!existingRows.length) throw new Error('Instância não encontrada.');
        const existing = existingRows[0];
        if (channel.provider === 'evolution') {
            await pool.query(`
                UPDATE whatsapp_channels
                SET name = ?, provider = 'evolution', evolution_server_id = ?, evolution_instance = ?,
                    evolution_target_type = ?, evolution_target = ?,
                    cloud_access_token = NULL, cloud_phone_number_id = NULL, cloud_waba_id = NULL,
                    cloud_graph_version = NULL, enabled = ?
                WHERE id = ?
            `, [
                channel.name, channel.evolutionServerId, channel.evolutionInstance,
                channel.evolutionTargetType, channel.evolutionTarget || null,
                channel.enabled ? 1 : 0, input.id
            ]);
        } else {
            await pool.query(`
                UPDATE whatsapp_channels
                SET name = ?, provider = 'cloud', evolution_server_id = NULL, evolution_instance = NULL,
                    evolution_target_type = NULL, evolution_target = NULL,
                    cloud_access_token = ?, cloud_phone_number_id = ?, cloud_waba_id = ?,
                    cloud_graph_version = ?, enabled = ?
                WHERE id = ?
            `, [
                channel.name, channel.cloudAccessToken ? encrypt(channel.cloudAccessToken, key) : existing.cloud_access_token,
                channel.cloudPhoneNumberId, channel.cloudWabaId || null, channel.cloudGraphVersion,
                channel.enabled ? 1 : 0, input.id
            ]);
        }
        return;
    }
    if (channel.provider === 'evolution') {
        await pool.query(`
            INSERT INTO whatsapp_channels
            (name, provider, evolution_server_id, evolution_instance, evolution_target_type, evolution_target, enabled)
            VALUES (?, 'evolution', ?, ?, ?, ?, ?)
        `, [
            channel.name, channel.evolutionServerId, channel.evolutionInstance,
            channel.evolutionTargetType, channel.evolutionTarget || null, channel.enabled ? 1 : 0
        ]);
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
    const [rows] = await pool.query(`
        SELECT c.*, s.base_url AS evolution_base_url, s.api_key AS evolution_server_api_key
        FROM whatsapp_channels c
        LEFT JOIN evolution_servers s ON s.id = c.evolution_server_id AND s.enabled = 1
        WHERE c.id = ?
    `, [id]);
    if (!rows.length) throw new Error('Instância não encontrada.');
    return rows[0];
}

async function evolutionRequest(row, key, path, options = {}) {
    if (!row.evolution_base_url || !row.evolution_server_api_key) {
        throw new Error('O servidor Evolution desta instância não está disponível.');
    }
    return request(`${row.evolution_base_url}${path}`, {
        ...options,
        headers: {
            apikey: decrypt(row.evolution_server_api_key, key),
            'content-type': 'application/json',
            ...(options.headers || {})
        }
    });
}

async function createEvolutionInstance(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'evolution') throw new Error('Esta configuração não usa Evolution API.');
    const key = await encryptionKey(pool);
    return evolutionRequest(row, key, '/instance/create', {
        method: 'POST',
        body: JSON.stringify({ instanceName: row.evolution_instance, integration: 'WHATSAPP-BAILEYS', qrcode: true })
    });
}

async function evolutionQrCode(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'evolution') throw new Error('Esta configuração não usa Evolution API.');
    const key = await encryptionKey(pool);
    const response = await evolutionRequest(row, key, `/instance/connect/${encodeURIComponent(row.evolution_instance)}`);
    return {
        base64: response.base64 || response.qrcode?.base64 || response.instance?.qrcode || '',
        code: response.code || response.qrcode?.code || ''
    };
}

async function evolutionStatus(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'evolution') throw new Error('Esta configuração não usa Evolution API.');
    const key = await encryptionKey(pool);
    const instance = encodeURIComponent(row.evolution_instance);
    try {
        return await evolutionRequest(row, key, `/instance/connectionState/${instance}`);
    } catch {
        return evolutionRequest(row, key, `/instance/${instance}/connection-state`);
    }
}

async function cloudStatus(pool, id) {
    const row = await channelRow(pool, id);
    if (row.provider !== 'cloud') throw new Error('Esta configuração não usa WhatsApp Cloud API.');
    const key = await encryptionKey(pool);
    return request(
        `https://graph.facebook.com/${row.cloud_graph_version || 'v23.0'}/${encodeURIComponent(row.cloud_phone_number_id)}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { authorization: `Bearer ${decrypt(row.cloud_access_token, key)}` } }
    );
}

module.exports = {
    ensureTables,
    listServers,
    saveServer,
    deleteServer,
    listChannels,
    saveChannel,
    deleteChannel,
    createEvolutionInstance,
    evolutionQrCode,
    evolutionStatus,
    cloudStatus
};
