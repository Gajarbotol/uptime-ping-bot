// pinger.js
const axios = require('axios');
const https = require('https');
const { dbRun, dbAll, dbGet } = require('./database');

const FAIL_LIMIT = 5;
const activePings = new Map();

const logPingEvent = async (urlId, { status, statusCode, errorMessage }) => {
    const message = status === 'success' ? 'OK' : (errorMessage || 'Request failed');
    await dbRun('INSERT INTO ping_logs (url_id, status, status_code, message, timestamp) VALUES (?, ?, ?, ?, ?)',
        [urlId, status, statusCode, message, new Date().toISOString()]);
    await dbRun('DELETE FROM ping_logs WHERE id IN (SELECT id FROM ping_logs WHERE url_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET 10)', [urlId]);
};

const pingUrl = async (urlEntry) => {
    const startTime = Date.now();
    let responseTime, statusCode, status, errorMessage;

    try {
        const headers = urlEntry.headers ? JSON.parse(urlEntry.headers) : {};
        const response = await axios.get(urlEntry.url, { timeout: 10000, headers });
        responseTime = Date.now() - startTime;
        statusCode = response.status;

        if (statusCode >= 200 && statusCode < 400) {
            if (urlEntry.keyword && !response.data.includes(urlEntry.keyword)) {
                throw new Error(`Keyword "${urlEntry.keyword}" not found.`);
            }
            status = 'success';
        } else {
            throw new Error(`HTTP Status ${statusCode}`);
        }
    } catch (error) {
        responseTime = Date.now() - startTime;
        status = 'fail';
        statusCode = error.response?.status || null;
        errorMessage = error.message;
        console.error(`[Ping Error] ID ${urlEntry.id}: ${urlEntry.url} -> ${errorMessage}`);
    }
    return { status, statusCode, responseTime, errorMessage };
};

const updatePingStats = async (urlId, result) => {
    await logPingEvent(urlId, result);
    const fieldToIncrement = result.status === 'success' ? 'success_count' : 'fail_count';
    const query = `
        UPDATE urls
        SET ${fieldToIncrement} = ${fieldToIncrement} + 1,
            last_ping_time = ?,
            last_status_code = ?,
            last_response_time = ?
        WHERE id = ?
    `;
    await dbRun(query, [new Date().toISOString(), result.statusCode, result.responseTime, urlId]);
};

const checkSslCertificate = (url) => new Promise((resolve) => {
    if (!url.startsWith('https://')) return resolve(null);
    const hostname = new URL(url).hostname;
    const options = { hostname, port: 443, method: 'GET', rejectUnauthorized: false };

    const req = https.request(options, res => {
        const cert = res.socket.getPeerCertificate();
        resolve(cert && cert.valid_to ? new Date(cert.valid_to) : null);
    });
    req.on('error', () => resolve(null));
    req.end();
});

const startPinger = (urlEntry, bot) => {
    stopPinger(urlEntry.id);
    if (!urlEntry.is_active) return;

    let consecutiveFails = 0;
    const intervalId = setInterval(async () => {
        const result = await pingUrl(urlEntry);
        await updatePingStats(urlEntry.id, result);
        const latestUrlData = await dbGet('SELECT * FROM urls WHERE id = ?', [urlEntry.id]);

        if (result.status === 'success') {
            consecutiveFails = 0;
        } else {
            consecutiveFails++;
            if (consecutiveFails >= FAIL_LIMIT) {
                const maintenanceUntil = latestUrlData.maintenance_until ? new Date(latestUrlData.maintenance_until) : null;
                if (maintenanceUntil && maintenanceUntil > new Date()) {
                    console.log(`[Maintenance] Down alert for URL ID ${urlEntry.id} suppressed.`);
                    return;
                }
                
                await dbRun('UPDATE urls SET is_active = 0 WHERE id = ?', [urlEntry.id]);
                stopPinger(urlEntry.id);
                console.log(`[Auto-Stop] URL ID ${urlEntry.id} deactivated after ${FAIL_LIMIT} failures.`);
                bot.sendMessage(urlEntry.user_id, `❌ **Auto-Stopped Pinging** ❌\n\nYour URL has been automatically stopped after ${FAIL_LIMIT} consecutive failures.\n\n🔗 **URL:** ${urlEntry.url}`);
            }
        }
    }, urlEntry.interval * 1000);
    activePings.set(urlEntry.id, intervalId);
};

const stopPinger = (urlId) => {
    if (activePings.has(urlId)) {
        clearInterval(activePings.get(urlId));
        activePings.delete(urlId);
    }
};

const checkAllSslCertificates = async (bot) => {
    console.log('🗓️ Running daily SSL certificate check...');
    const urlsToCheck = await dbAll("SELECT id, user_id, url FROM urls WHERE url LIKE 'https://%' AND is_active = 1");
    
    for (const url of urlsToCheck) {
        try {
            const expiryDate = await checkSslCertificate(url.url);
            if (!expiryDate) continue;

            await dbRun('UPDATE urls SET ssl_expiry_date = ? WHERE id = ?', [expiryDate.toISOString(), url.id]);
            const daysRemaining = Math.round((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
            if (daysRemaining <= 14 && daysRemaining > 0) {
                 bot.sendMessage(url.user_id, `🔔 **SSL Warning** 🔔\n\nThe SSL certificate for \`${url.url}\` expires in *${daysRemaining} days*!`);
            }
        } catch (error) {
            console.error(`SSL Check Error for ${url.url}:`, error.message);
        }
    }
};

const initializeAllPingers = async (bot) => {
    console.log("Initializing all active pingers from database...");
    const activeUrls = await dbAll('SELECT * FROM urls WHERE is_active = 1');
    for (const url of activeUrls) {
        startPinger(url, bot);
    }
    console.log(`✅ ${activeUrls.length} pingers initialized.`);
};

module.exports = { startPinger, stopPinger, initializeAllPingers, checkAllSslCertificates };
