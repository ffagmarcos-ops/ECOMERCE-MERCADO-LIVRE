const crypto = require('crypto');

const DEFAULT_TEMPLATE = [
    '🔥 {title}',
    '',
    '💰 Por {price}',
    '{discount_line}',
    '',
    '🛒 Comprar agora: {affiliate_url}'
].join('\n');

function encrypt(value, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(buffer => buffer.toString('hex')).join(':');
}

function decrypt(payload, key) {
    try {
        const [iv, tag, data] = String(payload).split(':').map(value => Buffer.from(value, 'hex'));
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
        CREATE TABLE IF NOT EXISTS telegram_channels (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            chat_id VARCHAR(120) NOT NULL UNIQUE,
            bot_token TEXT NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS telegram_templates (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            channel_id BIGINT UNSIGNED NOT NULL,
            name VARCHAR(120) NOT NULL,
            body TEXT NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_telegram_templates_channel FOREIGN KEY (channel_id)
                REFERENCES telegram_channels(id) ON DELETE CASCADE,
            INDEX idx_telegram_templates_channel (channel_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS telegram_schedules (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            item_id VARCHAR(30) NOT NULL,
            channel_id BIGINT UNSIGNED NOT NULL,
            template_id BIGINT UNSIGNED NOT NULL,
            scheduled_at DATETIME NOT NULL,
            status ENUM('scheduled','sending','published','failed','cancelled') NOT NULL DEFAULT 'scheduled',
            telegram_message_id BIGINT NULL,
            error_message VARCHAR(500) NULL,
            published_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_telegram_schedules_channel FOREIGN KEY (channel_id)
                REFERENCES telegram_channels(id) ON DELETE CASCADE,
            CONSTRAINT fk_telegram_schedules_template FOREIGN KEY (template_id)
                REFERENCES telegram_templates(id) ON DELETE RESTRICT,
            INDEX idx_telegram_schedules_due (status, scheduled_at),
            INDEX idx_telegram_schedules_item (item_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
}

function publicChannel(row) {
    return {
        id: row.id,
        name: row.name,
        chatId: row.chat_id,
        enabled: Boolean(row.enabled),
        hasBotToken: Boolean(row.bot_token)
    };
}

async function listConfig(pool) {
    const [channels] = await pool.query('SELECT id, name, chat_id, bot_token, enabled FROM telegram_channels ORDER BY name');
    const [templates] = await pool.query(
        'SELECT id, channel_id, name, body, enabled FROM telegram_templates ORDER BY channel_id, name'
    );
    const [schedules] = await pool.query(`
        SELECT s.id, s.item_id, s.channel_id, s.template_id, s.scheduled_at, s.status,
               s.error_message, c.name AS channel_name, p.title, p.price, p.affiliate_url
        FROM telegram_schedules s
        JOIN telegram_channels c ON c.id = s.channel_id
        LEFT JOIN product_candidates p ON p.item_id = s.item_id
        ORDER BY s.scheduled_at DESC
        LIMIT 100
    `);
    return {
        channels: channels.map(publicChannel),
        templates,
        schedules
    };
}

function validateChannel(input) {
    const name = String(input.name || '').trim();
    const chatId = String(input.chatId || '').trim();
    const botToken = String(input.botToken || '').trim();
    if (!name || !chatId) throw new Error('Informe o nome e o Chat ID do canal.');
    if (botToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
        throw new Error('O token do bot do Telegram parece inválido.');
    }
    return { name, chatId, botToken, enabled: input.enabled !== false };
}

async function saveChannel(pool, input) {
    const channel = validateChannel(input);
    const key = await encryptionKey(pool);
    if (input.id) {
        const fields = [channel.name, channel.chatId, channel.enabled ? 1 : 0, input.id];
        let query = 'UPDATE telegram_channels SET name = ?, chat_id = ?, enabled = ? WHERE id = ?';
        if (channel.botToken) {
            query = 'UPDATE telegram_channels SET name = ?, chat_id = ?, bot_token = ?, enabled = ? WHERE id = ?';
            fields.splice(2, 0, encrypt(channel.botToken, key));
        }
        await pool.query(query, fields);
        return;
    }
    if (!channel.botToken) throw new Error('Informe o token do bot para criar o canal.');
    await pool.query(
        'INSERT INTO telegram_channels (name, chat_id, bot_token, enabled) VALUES (?, ?, ?, ?)',
        [channel.name, channel.chatId, encrypt(channel.botToken, key), channel.enabled ? 1 : 0]
    );
}

async function deleteChannel(pool, id) {
    await pool.query('DELETE FROM telegram_channels WHERE id = ?', [id]);
}

async function saveTemplate(pool, input) {
    const name = String(input.name || '').trim();
    const body = String(input.body || '').trim();
    const channelId = Number(input.channelId);
    if (!name || !body || !Number.isInteger(channelId)) {
        throw new Error('Informe canal, nome e conteúdo do template.');
    }
    if (input.id) {
        await pool.query(
            'UPDATE telegram_templates SET channel_id = ?, name = ?, body = ?, enabled = ? WHERE id = ?',
            [channelId, name, body, input.enabled === false ? 0 : 1, input.id]
        );
    } else {
        await pool.query(
            'INSERT INTO telegram_templates (channel_id, name, body, enabled) VALUES (?, ?, ?, ?)',
            [channelId, name, body, input.enabled === false ? 0 : 1]
        );
    }
}

async function deleteTemplate(pool, id) {
    await pool.query('DELETE FROM telegram_templates WHERE id = ?', [id]);
}

async function listOffers(pool) {
    const [rows] = await pool.query(`
        SELECT item_id, title, price, old_price, discount_pct, image, affiliate_url
        FROM product_candidates
        WHERE status = 'approved'
        ORDER BY updated_at DESC
        LIMIT 200
    `);
    return rows;
}

async function schedule(pool, input) {
    const itemIds = Array.isArray(input.itemIds) ? input.itemIds.map(String).filter(Boolean) : [];
    const channelIds = Array.isArray(input.channelIds) ? input.channelIds.map(Number).filter(Number.isInteger) : [];
    const templateId = Number(input.templateId);
    const scheduledAt = new Date(input.scheduledAt);
    if (!itemIds.length || !channelIds.length || !Number.isInteger(templateId) || Number.isNaN(scheduledAt.getTime())) {
        throw new Error('Selecione ofertas, canais, template e uma data válida.');
    }
    if (scheduledAt.getTime() < Date.now() - 60000) throw new Error('O horário precisa estar no futuro.');

    const placeholders = itemIds.map(() => '?').join(',');
    const [offers] = await pool.query(
        `SELECT item_id FROM product_candidates WHERE status = 'approved' AND item_id IN (${placeholders})`,
        itemIds
    );
    if (offers.length !== itemIds.length) throw new Error('Todas as ofertas precisam estar aprovadas na curadoria.');

    const [templates] = await pool.query(
        'SELECT id, channel_id FROM telegram_templates WHERE id = ? AND enabled = 1',
        [templateId]
    );
    if (!templates.length || !channelIds.includes(Number(templates[0].channel_id))) {
        throw new Error('O template selecionado não pertence a um dos canais escolhidos.');
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const itemId of itemIds) {
            for (const channelId of channelIds) {
                await connection.query(
                    `INSERT INTO telegram_schedules (item_id, channel_id, template_id, scheduled_at)
                     SELECT ?, ?, ?, ? FROM telegram_channels c
                     WHERE c.id = ? AND c.enabled = 1`,
                    [itemId, channelId, templateId, scheduledAt, channelId]
                );
            }
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

function renderTemplate(body, offer) {
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[character]));
    const discountLine = Number(offer.discount_pct) > 0
        ? `🏷️ ${offer.discount_pct}% OFF`
        : '';
    return String(body)
        .replaceAll('{title}', escapeHtml(offer.title))
        .replaceAll('{price}', escapeHtml(Number(offer.price || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })))
        .replaceAll('{old_price}', escapeHtml(Number(offer.old_price || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })))
        .replaceAll('{discount}', escapeHtml(offer.discount_pct || 0))
        .replaceAll('{discount_line}', discountLine)
        .replaceAll('{affiliate_url}', escapeHtml(offer.affiliate_url));
}

async function telegramRequest(token, method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
    return result.result;
}

async function testChannel(pool, id) {
    const key = await encryptionKey(pool);
    const [rows] = await pool.query('SELECT bot_token, chat_id FROM telegram_channels WHERE id = ?', [id]);
    if (!rows.length) throw new Error('Canal não encontrado.');
    return telegramRequest(decrypt(rows[0].bot_token, key), 'getChat', { chat_id: rows[0].chat_id });
}

async function processDue(pool) {
    const key = await encryptionKey(pool);
    const [rows] = await pool.query(`
        SELECT s.id, s.item_id, s.channel_id, s.template_id, c.chat_id, c.bot_token,
               t.body, p.title, p.price, p.old_price, p.discount_pct, p.image, p.affiliate_url
        FROM telegram_schedules s
        JOIN telegram_channels c ON c.id = s.channel_id AND c.enabled = 1
        JOIN telegram_templates t ON t.id = s.template_id AND t.enabled = 1
        JOIN product_candidates p ON p.item_id = s.item_id AND p.status = 'approved'
        WHERE s.status = 'scheduled' AND s.scheduled_at <= NOW()
        ORDER BY s.scheduled_at
        LIMIT 20
    `);
    for (const row of rows) {
        const [claimed] = await pool.query(
            "UPDATE telegram_schedules SET status = 'sending' WHERE id = ? AND status = 'scheduled'",
            [row.id]
        );
        if (!claimed.affectedRows) continue;
        try {
            const text = renderTemplate(row.body, row);
            const payload = { chat_id: row.chat_id, caption: text, parse_mode: 'HTML' };
            const result = row.image
                ? await telegramRequest(decrypt(row.bot_token, key), 'sendPhoto', { ...payload, photo: row.image })
                : await telegramRequest(decrypt(row.bot_token, key), 'sendMessage', { chat_id: row.chat_id, text, parse_mode: 'HTML' });
            await pool.query(
                "UPDATE telegram_schedules SET status = 'published', telegram_message_id = ?, published_at = NOW() WHERE id = ?",
                [result.message_id, row.id]
            );
        } catch (error) {
            await pool.query(
                "UPDATE telegram_schedules SET status = 'failed', error_message = ? WHERE id = ?",
                [String(error.message).slice(0, 500), row.id]
            );
        }
    }
}

module.exports = {
    DEFAULT_TEMPLATE,
    ensureTables,
    listConfig,
    saveChannel,
    deleteChannel,
    saveTemplate,
    deleteTemplate,
    listOffers,
    schedule,
    testChannel,
    processDue
};
