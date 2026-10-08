const crypto = require('crypto');
const nodemailer = require('nodemailer');

const DEFAULT_FROM_NAME = 'Tudo pra Você';

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

function validateEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Informe um email válido.');
    }
    return email;
}

async function loadConfig(pool) {
    const [rows] = await pool.query("SELECT setting_key, setting_value FROM integration_settings WHERE setting_key LIKE 'smtp_%'");
    const values = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    const key = await encryptionKey(pool);
    return {
        host: values.smtp_host || '',
        port: Number(values.smtp_port || 587),
        secure: values.smtp_secure === '1',
        username: values.smtp_username || '',
        password: values.smtp_password ? decrypt(values.smtp_password, key) : '',
        fromEmail: values.smtp_from_email || '',
        fromName: values.smtp_from_name || DEFAULT_FROM_NAME,
        enabled: values.smtp_enabled === '1'
    };
}

function publicConfig(config) {
    return {
        host: config.host,
        port: config.port,
        secure: config.secure,
        username: config.username,
        fromEmail: config.fromEmail,
        fromName: config.fromName,
        enabled: config.enabled,
        hasPassword: Boolean(config.password)
    };
}

async function saveConfig(pool, input) {
    const current = await loadConfig(pool);
    const host = String(input.host ?? current.host).trim();
    const port = Number(input.port ?? current.port);
    const username = String(input.username ?? current.username).trim();
    const fromEmail = validateEmail(input.fromEmail ?? current.fromEmail);
    const fromName = String(input.fromName ?? current.fromName).trim() || DEFAULT_FROM_NAME;
    const password = String(input.password || '').trim();
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !fromEmail) {
        throw new Error('Informe servidor, porta e email de remetente do SMTP.');
    }

    const key = await encryptionKey(pool);
    const values = {
        smtp_host: host,
        smtp_port: String(port),
        smtp_secure: input.secure ? '1' : '0',
        smtp_username: username,
        smtp_from_email: fromEmail,
        smtp_from_name: fromName,
        smtp_enabled: input.enabled === false ? '0' : '1'
    };
    if (password) values.smtp_password = encrypt(password, key);
    for (const [settingKey, settingValue] of Object.entries(values)) {
        await pool.query(
            'INSERT INTO integration_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [settingKey, settingValue]
        );
    }
    return publicConfig(await loadConfig(pool));
}

function createTransport(config) {
    if (!config.enabled || !config.host || !config.fromEmail || !config.password) {
        throw new Error('Configure e ative o SMTP antes de enviar emails.');
    }
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.username ? { user: config.username, pass: config.password } : undefined
    });
}

async function sendTest(pool, recipient) {
    const config = await loadConfig(pool);
    const email = validateEmail(recipient);
    if (!email) throw new Error('Informe o email que receberá o teste.');
    const transport = createTransport(config);
    await transport.verify();
    await transport.sendMail({
        from: { address: config.fromEmail, name: config.fromName },
        to: email,
        subject: 'Teste de SMTP - Tudo pra Você',
        text: 'O SMTP do painel administrativo está configurado corretamente.'
    });
}

async function sendPasswordReset(pool, recipient, resetUrl) {
    const config = await loadConfig(pool);
    const transport = createTransport(config);
    await transport.sendMail({
        from: { address: config.fromEmail, name: config.fromName },
        to: recipient,
        subject: 'Recuperação de senha - Tudo pra Você',
        text: `Recebemos uma solicitação para redefinir sua senha.\n\nAcesse este link em até 30 minutos:\n${resetUrl}\n\nSe você não solicitou a alteração, ignore este email.`,
        html: `<p>Recebemos uma solicitação para redefinir sua senha.</p><p><a href="${resetUrl}">Clique aqui para criar uma nova senha</a>.</p><p>O link expira em 30 minutos. Se você não solicitou a alteração, ignore este email.</p>`
    });
}

module.exports = { encryptionKey, loadConfig, publicConfig, saveConfig, sendTest, sendPasswordReset, validateEmail };
