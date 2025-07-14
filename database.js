// database.js
const sqlite3 = require('sqlite3').verbose();
const DB_SOURCE = './bot_data.sqlite';

let db; // Define db in the module scope

const initializeDatabase = () => {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_SOURCE, (err) => {
            if (err) {
                console.error('DB Connection Error:', err.message);
                return reject(err);
            }
            console.log('✅ Connected to the SQLite database.');

            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)`);

                db.run(`CREATE TABLE IF NOT EXISTS urls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    url TEXT NOT NULL,
                    interval INTEGER DEFAULT 300,
                    keyword TEXT,
                    headers TEXT,
                    is_active INTEGER DEFAULT 1,
                    success_count INTEGER DEFAULT 0,
                    fail_count INTEGER DEFAULT 0,
                    last_ping_time TEXT,
                    last_status_code INTEGER,
                    last_response_time REAL,
                    maintenance_until TEXT,
                    ssl_expiry_date TEXT,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                )`);

                db.run(`CREATE TABLE IF NOT EXISTS ping_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url_id INTEGER,
                    status TEXT NOT NULL,
                    status_code INTEGER,
                    message TEXT,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (url_id) REFERENCES urls (id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error("Table Creation Error:", err.message);
                        return reject(err);
                    }
                    console.log('Database tables are ready.');
                    resolve(); // Resolve the promise only after all tables are created
                });
            });
        });
    });
};

const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized."));
    db.run(query, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized."));
    db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAll = (query, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized."));
    db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

module.exports = {
    initializeDatabase, // Export the new function
    dbRun,
    dbGet,
    dbAll
};
