const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Increase request size limits for base64 images upload
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files
app.use(express.static(__dirname));

// DB configuration via environment for local and Portainer deployments
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '30mariafn@',
    port: Number(process.env.DB_PORT || 3306)
};
const dbName = process.env.DB_NAME || 'tudopravoce_db';
const defaultAdmin = {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
    displayName: process.env.ADMIN_DISPLAY_NAME || 'Administrador'
};

let pool;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeIdentifier(value) {
    return String(value || '').trim();
}

function createPasswordRecord(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
    const hash = crypto.scryptSync(String(password), salt, 64);
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (hash.length !== expectedBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(hash, expectedBuffer);
}

function isSupportedImageDataUrl(value) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    if (!match) return false;

    const image = Buffer.from(match[2], 'base64');
    if (image.toString('base64') !== match[2]) return false;

    switch (match[1].toLowerCase()) {
        case 'png':
            return image.length >= 8 && image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
        case 'jpeg':
            return image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
        case 'webp':
            return image.length >= 12 && image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP';
        default:
            return false;
    }
}

function hasUnsupportedImageData(value) {
    if (typeof value === 'string') {
        return value.slice(0, 5).toLowerCase() === 'data:' && !isSupportedImageDataUrl(value);
    }
    if (Array.isArray(value)) {
        return value.some(hasUnsupportedImageData);
    }
    if (value && typeof value === 'object') {
        return Object.values(value).some(hasUnsupportedImageData);
    }
    return false;
}

function hashApiToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function createApiToken() {
    return `tpv_${crypto.randomBytes(32).toString('hex')}`;
}

async function requireApiToken(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) {
        return res.status(401).json({ error: 'A valid Bearer token is required.' });
    }

    try {
        const [rows] = await pool.query(
            `SELECT t.id AS token_id, t.token_type, u.id AS user_id, u.username, u.display_name, u.role
             FROM api_tokens t
             JOIN admin_users u ON u.id = t.created_by
             WHERE t.token_hash = ? AND t.revoked_at IS NULL
               AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP)
               AND u.is_active = 1
             LIMIT 1`,
            [hashApiToken(match[1])]
        );
        if (!rows.length) {
            return res.status(401).json({ error: 'Invalid, expired, or revoked token.' });
        }

        req.adminToken = rows[0];
        await pool.query('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [req.adminToken.token_id]);
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function ensureTable(query) {
    await pool.query(query);
}

async function seedAdminUser() {
    const credentials = createPasswordRecord(defaultAdmin.password);
    await pool.query(
        `INSERT INTO admin_users (username, display_name, password_salt, password_hash, role, is_active)
         VALUES (?, ?, ?, ?, 'admin', 1)
         ON DUPLICATE KEY UPDATE
            display_name = VALUES(display_name),
            password_salt = VALUES(password_salt),
            password_hash = VALUES(password_hash),
            role = VALUES(role),
            is_active = VALUES(is_active),
            updated_at = CURRENT_TIMESTAMP`,
        [defaultAdmin.username, defaultAdmin.displayName, credentials.salt, credentials.hash]
    );
}

async function initDB() {
    try {
        const maxAttempts = Number(process.env.DB_RETRY_ATTEMPTS || 10);
        const retryDelayMs = Number(process.env.DB_RETRY_DELAY_MS || 3000);

        // 1. Connect without database to ensure it exists
        let initialConnection;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                initialConnection = await mysql.createConnection(dbConfig);
                break;
            } catch (err) {
                if (attempt === maxAttempts) {
                    throw err;
                }
                console.log(`Waiting for database (${attempt}/${maxAttempts})...`);
                await delay(retryDelayMs);
            }
        }

        await initialConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await initialConnection.end();
        console.log(`Database "${dbName}" verified/created successfully.`);

        // 2. Initialize connection pool with database
        pool = mysql.createPool({
            ...dbConfig,
            database: dbName,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // 3. Create tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                brand VARCHAR(100),
                price DECIMAL(10,2),
                oldPrice DECIMAL(10,2),
                badge VARCHAR(100),
                emoji VARCHAR(20),
                glowColor VARCHAR(50),
                searchKeys TEXT,
                url MEDIUMTEXT,
                img_url MEDIUMTEXT,
                img_url_2 MEDIUMTEXT,
                video_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS clicks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                product_id VARCHAR(100),
                name VARCHAR(255),
                category VARCHAR(100),
                price DECIMAL(10,2),
                timestamp BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                setting_value LONGTEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NOT NULL UNIQUE,
                display_name VARCHAR(150) NOT NULL,
                password_salt VARCHAR(64) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL DEFAULT 'admin',
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS api_tokens (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                token_hash CHAR(64) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                token_type ENUM('session', 'api') NOT NULL,
                created_by INT NOT NULL,
                expires_at DATETIME NULL,
                last_used_at DATETIME NULL,
                revoked_at DATETIME NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_api_tokens_user (created_by, token_type, revoked_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        console.log("Database tables verified/created successfully.");

        await seedAdminUser();

        // 4. Seed products when missing, without overwriting customizations already in the database
        const defaultProductsPath = path.join(__dirname, 'default_products.json');
        if (fs.existsSync(defaultProductsPath)) {
            const rawData = fs.readFileSync(defaultProductsPath, 'utf8');
            const products = JSON.parse(rawData);
            const [existingProducts] = await pool.query("SELECT id FROM products");
            const existingIds = new Set(existingProducts.map(row => String(row.id)));
            let insertedCount = 0;

            for (const p of products) {
                const productId = String(p.id);
                if (existingIds.has(productId)) {
                    continue;
                }

                try {
                    await pool.query(
                        `INSERT INTO products
                        (id, name, category, brand, price, oldPrice, badge, emoji, glowColor, searchKeys, url, img_url, img_url_2, video_url)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            productId,
                            p.name,
                            p.category || '',
                            p.brand || '',
                            p.price || 0,
                            p.oldPrice || null,
                            p.badge || '',
                            p.emoji || '',
                            p.glowColor || '',
                            p.searchKeys || '',
                            p.url || '',
                            p.img_url || '',
                            p.img_url_2 || '',
                            p.video_url || ''
                        ]
                    );
                    insertedCount++;
                } catch (err) {
                    console.error(`Error seeding product ID ${p.id}:`, err.message);
                }
            }

            console.log(`Default products synchronized. ${insertedCount} new products inserted.`);
        } else {
            console.warn("default_products.json not found. Skipping product synchronization.");
        }

    } catch (err) {
        console.error("Database initialization failed:", err);
        process.exit(1);
    }
}

// Ensure database is initialized before handling requests
initDB();

// --- API ROUTES ---

// 1. Products API
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products', requireApiToken, async (req, res) => {
    try {
        const p = req.body;
        if (hasUnsupportedImageData([p.img_url, p.img_url_2])) {
            return res.status(400).json({ error: 'Images must be PNG, JPG, or WebP files.' });
        }
        if (!p.name || !p.url) {
            return res.status(400).json({ error: "Name and URL are required." });
        }
        const id = p.id ? String(p.id) : String(Date.now());
        
        await pool.query(
            `INSERT INTO products 
            (id, name, category, brand, price, oldPrice, badge, emoji, glowColor, searchKeys, url, img_url, img_url_2, video_url) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                p.name,
                p.category || '',
                p.brand || 'Curadoria',
                p.price || 0,
                p.oldPrice || null,
                p.badge || '',
                p.emoji || '',
                p.glowColor || 'rgba(255,26,117,0.3)',
                p.searchKeys || '',
                p.url,
                p.img_url || '',
                p.img_url_2 || '',
                p.video_url || ''
            ]
        );
        res.status(201).json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/products/:id', requireApiToken, async (req, res) => {
    try {
        const id = req.params.id;
        const p = req.body;
        if (hasUnsupportedImageData([p.img_url, p.img_url_2])) {
            return res.status(400).json({ error: 'Images must be PNG, JPG, or WebP files.' });
        }
        
        // Find existing product first
        const [existing] = await pool.query("SELECT * FROM products WHERE id = ?", [id]);
        if (existing.length === 0) {
            return res.status(404).json({ error: "Product not found." });
        }

        await pool.query(
            `UPDATE products SET 
                name = ?, category = ?, brand = ?, price = ?, oldPrice = ?, 
                badge = ?, emoji = ?, glowColor = ?, searchKeys = ?, url = ?, 
                img_url = ?, img_url_2 = ?, video_url = ?
            WHERE id = ?`,
            [
                p.name || existing[0].name,
                p.category !== undefined ? p.category : existing[0].category,
                p.brand !== undefined ? p.brand : existing[0].brand,
                p.price !== undefined ? p.price : existing[0].price,
                p.oldPrice !== undefined ? p.oldPrice : existing[0].oldPrice,
                p.badge !== undefined ? p.badge : existing[0].badge,
                p.emoji !== undefined ? p.emoji : existing[0].emoji,
                p.glowColor !== undefined ? p.glowColor : existing[0].glowColor,
                p.searchKeys !== undefined ? p.searchKeys : existing[0].searchKeys,
                p.url !== undefined ? p.url : existing[0].url,
                p.img_url !== undefined ? p.img_url : existing[0].img_url,
                p.img_url_2 !== undefined ? p.img_url_2 : existing[0].img_url_2,
                p.video_url !== undefined ? p.video_url : existing[0].video_url,
                id
            ]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products/:id', requireApiToken, async (req, res) => {
    try {
        const id = req.params.id;
        const [result] = await pool.query("DELETE FROM products WHERE id = ?", [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Product not found." });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Synchronize products in bulk, ensuring no duplicates and updating price/oldPrice if changed
app.post('/api/products/sync', requireApiToken, async (req, res) => {
    try {
        const syncedProducts = req.body;
        if (!Array.isArray(syncedProducts)) {
            return res.status(400).json({ error: "Body must be an array of products." });
        }
        if (hasUnsupportedImageData(syncedProducts.map(product => [product.img_url, product.img_url_2]))) {
            return res.status(400).json({ error: 'Images must be PNG, JPG, or WebP files.' });
        }

        let updatedCount = 0;
        let insertedCount = 0;

        for (const p of syncedProducts) {
            const id = String(p.id);
            const cleanUrl = p.url ? p.url.split('?')[0] : '';
            
            // Check if product exists by ID or by URL (stripped of query params)
            let existingId = null;
            let existingPrice = null;

            const [byId] = await pool.query("SELECT id, price FROM products WHERE id = ?", [id]);
            if (byId.length > 0) {
                existingId = byId[0].id;
                existingPrice = byId[0].price;
            } else if (cleanUrl) {
                const [byUrl] = await pool.query("SELECT id, price FROM products WHERE url LIKE ?", [`%${cleanUrl}%`]);
                if (byUrl.length > 0) {
                    existingId = byUrl[0].id;
                    existingPrice = byUrl[0].price;
                }
            }

            if (existingId) {
                // Product exists. If price changed, update it.
                if (parseFloat(existingPrice) !== parseFloat(p.price)) {
                    await pool.query(
                        "UPDATE products SET price = ?, oldPrice = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                        [p.price, p.oldPrice || (p.price * 1.25), existingId]
                    );
                    updatedCount++;
                }
            } else {
                // New product, insert it
                await pool.query(
                    `INSERT INTO products 
                    (id, name, category, brand, price, oldPrice, badge, emoji, glowColor, searchKeys, url, img_url, img_url_2, video_url) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        id,
                        p.name,
                        p.category || '',
                        p.brand || 'Curadoria',
                        p.price || 0,
                        p.oldPrice || null,
                        p.badge || 'Afiliado',
                        p.emoji || '',
                        p.glowColor || 'rgba(255,26,117,0.3)',
                        p.searchKeys || '',
                        p.url || '',
                        p.img_url || '',
                        p.img_url_2 || '',
                        p.video_url || ''
                    ]
                );
                insertedCount++;
            }
        }

        res.json({ success: true, inserted: insertedCount, updated: updatedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 2. Settings API
app.get('/api/settings', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings");
        const settings = {};
        rows.forEach(r => {
            try {
                settings[r.setting_key] = JSON.parse(r.setting_value);
            } catch(e) {
                settings[r.setting_key] = r.setting_value;
            }
        });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', requireApiToken, async (req, res) => {
    try {
        const settings = req.body;
        if (hasUnsupportedImageData(settings)) {
            return res.status(400).json({ error: 'Images must be PNG, JPG, or WebP files.' });
        }
        for (const [key, value] of Object.entries(settings)) {
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
            await pool.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [key, stringValue, stringValue]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Authentication API
app.post('/api/auth/login', async (req, res) => {
    try {
        const username = normalizeIdentifier(req.body?.username);
        const password = normalizeIdentifier(req.body?.password);

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const [rows] = await pool.query(
            'SELECT id, username, display_name, password_salt, password_hash, role, is_active FROM admin_users WHERE username = ? LIMIT 1',
            [username]
        );

        if (rows.length === 0 || Number(rows[0].is_active) !== 1) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const adminUser = rows[0];
        const isValid = verifyPassword(password, adminUser.password_salt, adminUser.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const accessToken = createApiToken();
        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
        await pool.query(
            `INSERT INTO api_tokens (token_hash, name, token_type, created_by, expires_at)
             VALUES (?, ?, 'session', ?, ?)`,
            [hashApiToken(accessToken), `Painel: ${adminUser.username}`, adminUser.id, expiresAt]
        );

        res.json({
            success: true,
            accessToken,
            expiresAt: expiresAt.toISOString(),
            user: {
                id: adminUser.id,
                username: adminUser.username,
                displayName: adminUser.display_name,
                role: adminUser.role
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/logout', requireApiToken, async (req, res) => {
    if (req.adminToken.token_type !== 'session') {
        return res.status(400).json({ error: 'Only an admin session can be logged out here.' });
    }
    await pool.query('UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [req.adminToken.token_id]);
    res.json({ success: true });
});

app.get('/api/auth/tokens', requireApiToken, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt,
                    expires_at AS expiresAt, revoked_at AS revokedAt
             FROM api_tokens WHERE created_by = ? AND token_type = 'api'
             ORDER BY created_at DESC`,
            [req.adminToken.user_id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/tokens', requireApiToken, async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const requestedExpiry = req.body?.expiresInDays;
        const expiresInDays = requestedExpiry === null ? null : (requestedExpiry === undefined ? 90 : Number(requestedExpiry));
        if (!name || name.length > 100) {
            return res.status(400).json({ error: 'Token name is required and must be 100 characters or fewer.' });
        }
        if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
            return res.status(400).json({ error: 'expiresInDays must be between 1 and 3650, or null.' });
        }

        const token = createApiToken();
        const expiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
        const [result] = await pool.query(
            `INSERT INTO api_tokens (token_hash, name, token_type, created_by, expires_at)
             VALUES (?, ?, 'api', ?, ?)`,
            [hashApiToken(token), name, req.adminToken.user_id, expiresAt]
        );
        res.status(201).json({
            success: true,
            token,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            apiToken: { id: result.insertId, name, expiresAt: expiresAt ? expiresAt.toISOString() : null }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/auth/tokens/:id', requireApiToken, async (req, res) => {
    try {
        const [result] = await pool.query(
            `UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP
             WHERE id = ? AND created_by = ? AND token_type = 'api' AND revoked_at IS NULL`,
            [req.params.id, req.adminToken.user_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Active API token not found.' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 3. Tracking & Statistics API
app.post('/api/visit', async (req, res) => {
    try {
        const { isUnique } = req.body;
        
        // 1. Get current values
        const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('admin-page-views', 'admin-visits')");
        let pageViews = 0;
        let uniqueVisits = 0;

        rows.forEach(r => {
            if (r.setting_key === 'admin-page-views') pageViews = parseInt(r.setting_value) || 0;
            if (r.setting_key === 'admin-visits') uniqueVisits = parseInt(r.setting_value) || 0;
        });

        // 2. Increment
        pageViews++;
        if (isUnique) {
            uniqueVisits++;
        }

        // 3. Save
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin-page-views', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [String(pageViews), String(pageViews)]);
        if (isUnique) {
            await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin-visits', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [String(uniqueVisits), String(uniqueVisits)]);
        }

        res.json({ success: true, pageViews, uniqueVisits });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/click', async (req, res) => {
    try {
        const { productId, name, category, price, timestamp } = req.body;
        
        await pool.query(
            "INSERT INTO clicks (product_id, name, category, price, timestamp) VALUES (?, ?, ?, ?, ?)",
            [String(productId), name || '', category || '', price || 0, timestamp || Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', requireApiToken, async (req, res) => {
    try {
        // Get visits and views
        const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('admin-page-views', 'admin-visits')");
        let pageViews = 0;
        let uniqueVisits = 0;

        settingsRows.forEach(r => {
            if (r.setting_key === 'admin-page-views') pageViews = parseInt(r.setting_value) || 0;
            if (r.setting_key === 'admin-visits') uniqueVisits = parseInt(r.setting_value) || 0;
        });

        // Get clicks logs
        const [clicksRows] = await pool.query("SELECT product_id as productId, name, category, price, timestamp FROM clicks ORDER BY timestamp DESC");
        
        res.json({
            pageViews,
            uniqueVisits,
            clicks: clicksRows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/stats/reset', requireApiToken, async (req, res) => {
    try {
        // Reset statistics
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin-page-views', '0') ON DUPLICATE KEY UPDATE setting_value = '0'");
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('admin-visits', '0') ON DUPLICATE KEY UPDATE setting_value = '0'");
        await pool.query("TRUNCATE TABLE clicks");
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin redirect helper
app.get('/api-docs/openapi.json', (req, res) => res.json(openApiSpec));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { swaggerOptions: { persistAuthorization: false } }));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// Fallback index route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
