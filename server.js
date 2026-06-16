const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

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

let pool;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

        console.log("Database tables verified/created successfully.");

        // 4. Seed products if empty
        const [rows] = await pool.query("SELECT COUNT(*) as count FROM products");
        if (rows[0].count === 0) {
            console.log("Products table is empty. Initializing seed from default_products.json...");
            const defaultProductsPath = path.join(__dirname, 'default_products.json');
            if (fs.existsSync(defaultProductsPath)) {
                const rawData = fs.readFileSync(defaultProductsPath, 'utf8');
                const products = JSON.parse(rawData);
                let seedCount = 0;
                for (const p of products) {
                    try {
                        await pool.query(
                            `INSERT INTO products 
                            (id, name, category, brand, price, oldPrice, badge, emoji, glowColor, searchKeys, url, img_url, img_url_2, video_url) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                String(p.id),
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
                        seedCount++;
                    } catch (err) {
                        console.error(`Error seeding product ID ${p.id}:`, err.message);
                    }
                }
                console.log(`Successfully seeded ${seedCount} products.`);
            } else {
                console.warn("default_products.json not found. Skipping seeding.");
            }
        } else {
            console.log(`Database already contains ${rows[0].count} products. Seeding skipped.`);
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

app.post('/api/products', async (req, res) => {
    try {
        const p = req.body;
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

app.put('/api/products/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const p = req.body;
        
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

app.delete('/api/products/:id', async (req, res) => {
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
app.post('/api/products/sync', async (req, res) => {
    try {
        const syncedProducts = req.body;
        if (!Array.isArray(syncedProducts)) {
            return res.status(400).json({ error: "Body must be an array of products." });
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

app.post('/api/settings', async (req, res) => {
    try {
        const settings = req.body;
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

app.get('/api/stats', async (req, res) => {
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

app.post('/api/stats/reset', async (req, res) => {
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
