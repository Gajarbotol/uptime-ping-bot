// index.js
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const { initializeDatabase, dbRun, dbGet, dbAll } = require('./database');
const { startPinger, stopPinger, initializeAllPingers, checkAllSslCertificates } = require('./pinger');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(token, { polling: true });
const userStates = new Map();

function formatTimeAgo(isoDateString) {
    if (!isoDateString) return 'Never';
    const seconds = Math.round((new Date() - new Date(isoDateString)) / 1000);
    if (seconds < 2) return `Just now`;
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

const getMainMenu = (text = "🏠 Main Menu") => ({
    text,
    options: {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Add URL', callback_data: 'add_url' }],
                [{ text: '📊 My URLs Dashboard', callback_data: 'dashboard' }],
                [{ text: 'ℹ️ Help', callback_data: 'help' }]
            ]
        }
    }
});

const getDashboardText = async (userId) => {
    const urls = await dbAll('SELECT * FROM urls WHERE user_id = ? ORDER BY id', [userId]);
    if (urls.length === 0) {
        return { text: '🚫 You have no URLs to monitor. Use "Add URL" to start.', options: getMainMenu().options };
    }

    let text = '📊 *Your Monitored URLs:*\n\n';
    const buttons = [];
    urls.forEach(u => {
        const total = u.success_count + u.fail_count;
        const uptime = total > 0 ? ((u.success_count / total) * 100).toFixed(2) : '100.00';
        const maintenanceUntil = u.maintenance_until ? new Date(u.maintenance_until) : null;
        const sslExpiry = u.ssl_expiry_date ? new Date(u.ssl_expiry_date) : null;
        const sslDays = sslExpiry ? Math.round((sslExpiry - new Date()) / (1000 * 60 * 60 * 24)) : null;

        text += `*ID:* \`${u.id}\` (${u.is_active ? '🟢 Active' : '🔴 Paused'})\n` +
                `🔗 ${u.url}\n` +
                `*Status:* ${u.last_status_code || 'N/A'} | *Latency:* ${u.last_response_time || 'N/A'}ms\n` +
                `*Uptime:* ${uptime}% | *Interval:* ${u.interval}s\n`;

        if (sslDays !== null && sslDays > 0) {
            text += `*SSL Expires:* In ${sslDays} days\n`;
        } else if (sslDays !== null) {
            text += `*SSL Expires:* Expired!\n`;
        }

        if (maintenanceUntil && maintenanceUntil > new Date()) {
            text += `*Maintenance Mode Until:* ${maintenanceUntil.toLocaleString()}\n`;
        }
        
        text += `*Last Ping:* ${formatTimeAgo(u.last_ping_time)}\n\n`;
        buttons.push([{ text: `✏️ Edit ID ${u.id}`, callback_data: `edit_${u.id}` }]);
    });
    
    buttons.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }]);
    return { text, options: { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } } };
};

const getEditMenu = (urlId, urlText) => ({
    text: `✏️ Editing URL: \`${urlText}\``,
    options: {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⏯ Toggle Active/Pause', callback_data: `toggle_${urlId}` }],
                [{ text: '⏱ Change Interval', callback_data: `set_interval_${urlId}` }],
                [{ text: '🔎 Set Keyword', callback_data: `set_keyword_${urlId}` }],
                [{ text: '📋 Set Headers', callback_data: `set_headers_${urlId}` }],
                [{ text: '🛠 Set Maintenance', callback_data: `set_maintenance_${urlId}` }],
                [{ text: '📜 View Event Log', callback_data: `view_log_${urlId}` }],
                [{ text: '🗑️ Delete URL', callback_data: `delete_${urlId}` }],
                [{ text: '🔙 Back to Dashboard', callback_data: 'dashboard' }]
            ]
        }
    }
});

const getMaintenanceMenu = (urlId) => ({
    text: '🛠 How long should maintenance mode be active?',
    options: {
        reply_markup: {
            inline_keyboard: [
                [{ text: '1 Hour', callback_data: `maintenance_${urlId}_1` },
                 { text: '8 Hours', callback_data: `maintenance_${urlId}_8` },
                 { text: '1 Day', callback_data: `maintenance_${urlId}_24` }],
                [{ text: 'Cancel Maintenance', callback_data: `maintenance_${urlId}_0` }],
                [{ text: '🔙 Back to Edit Menu', callback_data: `edit_${urlId}` }]
            ]
        }
    }
});

const getHelpText = () => `*ℹ️ Help & Information*\n\nThis bot monitors your websites for uptime and performance.\n\n*Features:*\n- *Dashboard:* View all your monitored URLs and their status.\n- *Pinging:* Checks your site at a set interval.\n- *Keyword Check:* Looks for a specific word on your page to confirm it's working correctly.\n- *SSL Monitoring:* Warns you 14 days before an SSL certificate expires.\n- *Maintenance Mode:* Pause alerts for a specific URL during maintenance.\n- *Custom Headers:* Monitor authenticated pages by providing an auth token or API key.\n- *Event Logs:* View the last 10 success/fail events for any URL.`;

bot.onText(/\/start|^\/menu$/, async (msg) => {
    const userId = msg.from.id;
    await dbRun('INSERT OR IGNORE INTO users (id) VALUES (?)', [userId]);
    const { text, options } = getMainMenu("👋 Welcome to the Professional Ping Bot! I monitor your sites for uptime and performance.");
    bot.sendMessage(userId, text, options);
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.from.id, getHelpText(), { parse_mode: 'Markdown' });
});

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const [command, payload, ...args] = query.data.split('_');
    await bot.answerCallbackQuery(query.id).catch(console.error);
    const messageId = query.message.message_id;

    const commandHandlers = {
        'menu': async () => {
            const { text, options } = getMainMenu();
            bot.editMessageText(text, { chat_id: userId, message_id: messageId, ...options });
        },
        'dashboard': async () => {
            const { text, options } = await getDashboardText(userId);
            bot.editMessageText(text, { chat_id: userId, message_id: messageId, ...options });
        },
        'help': () => bot.editMessageText(getHelpText(), { chat_id: userId, message_id: messageId, ...getMainMenu().options }),
        'add': () => {
            userStates.set(userId, { state: 'awaiting_url' });
            bot.sendMessage(userId, '🔗 Please send the full URL you want to monitor (e.g., https://example.com):');
        },
        'edit': async () => {
            const urlToEdit = await dbGet('SELECT * FROM urls WHERE id = ? AND user_id = ?', [payload, userId]);
            if (urlToEdit) {
                const { text, options } = getEditMenu(payload, urlToEdit.url);
                bot.editMessageText(text, { chat_id: userId, message_id: messageId, ...options });
            }
        },
        'toggle': async () => {
            const urlToToggle = await dbGet('SELECT * FROM urls WHERE id = ? AND user_id = ?', [payload, userId]);
            if (urlToToggle) {
                const newStatus = urlToToggle.is_active ? 0 : 1;
                await dbRun('UPDATE urls SET is_active = ? WHERE id = ?', [newStatus, payload]);
                urlToToggle.is_active = newStatus;
                if (newStatus === 1) startPinger(urlToToggle, bot); else stopPinger(payload);
                await bot.answerCallbackQuery(query.id, { text: `Status set to ${newStatus ? 'Active' : 'Paused'}.` });
                const { options } = getEditMenu(payload, urlToToggle.url);
                bot.editMessageReplyMarkup(options.reply_markup, { chat_id: userId, message_id: messageId });
            }
        },
        'set': () => {
            const urlId = args[0] || payload;
            const action = payload;
            userStates.set(userId, { state: `awaiting_${action}`, urlId });
            const messages = {
                'interval': '⏱ Please send the new interval in seconds (e.g., 60):',
                'keyword': '🔎 Please send the keyword to look for on the page.\nSend "none" to remove the keyword.',
                'headers': '📋 Please send the custom headers as a JSON object.\nExample: `{"Authorization": "Bearer TOKEN"}`\nSend "none" to remove all headers.',
                'maintenance': () => {
                    const { text, options } = getMaintenanceMenu(urlId);
                    bot.editMessageText(text, { chat_id: userId, message_id: messageId, ...options });
                }
            };
            if (typeof messages[action] === 'function') messages[action]();
            else bot.sendMessage(userId, messages[action], { parse_mode: 'Markdown' });
        },
        'maintenance': async () => {
            const urlId = payload;
            const hours = parseInt(args[0], 10);
            const maintenanceUntil = hours === 0 ? null : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
            await dbRun('UPDATE urls SET maintenance_until = ? WHERE id = ?', [maintenanceUntil, urlId]);
            await bot.answerCallbackQuery(query.id, { text: `Maintenance mode ${hours === 0 ? 'cancelled' : `set for ${hours} hour(s)`}.` });
            const urlToEdit = await dbGet('SELECT url FROM urls WHERE id = ?', [urlId]);
            const { text, options } = getEditMenu(urlId, urlToEdit.url);
            bot.editMessageText(text, { chat_id: userId, message_id: messageId, ...options });
        },
        'view': async () => {
            if (payload === 'log') {
                const urlId = args[0];
                const logs = await dbAll('SELECT * FROM ping_logs WHERE url_id = ? ORDER BY timestamp DESC', [urlId]);
                let logText = logs.length ? `📜 *Recent Ping Events for ID ${urlId}:*\n\n` : '📜 No log events found for this URL yet.';
                logs.forEach(log => {
                    logText += `${log.status === 'success' ? '✅' : '❌'} *${log.status.toUpperCase()}* (${log.status_code || 'N/A'}) - ${formatTimeAgo(log.timestamp)}\n   └─ Msg: \`${log.message}\`\n`;
                });
                bot.sendMessage(userId, logText, { parse_mode: 'Markdown' });
            }
        },
        'delete': async () => {
            const urlToDelete = await dbGet('SELECT url FROM urls WHERE id = ? AND user_id = ?', [payload, userId]);
            if (urlToDelete) {
                await bot.deleteMessage(userId, messageId).catch(console.error);
                stopPinger(payload);
                await dbRun('DELETE FROM urls WHERE id = ?', [payload]);
                bot.sendMessage(userId, `🗑️ URL \`${urlToDelete.url}\` has been deleted.`);
            }
        }
    };
    if (commandHandlers[command]) {
        await commandHandlers[command]();
    }
});

bot.on('message', async (msg) => {
    const userId = msg.from.id;
    if (msg.text.startsWith('/') || !userStates.has(userId)) return;

    const { state, urlId } = userStates.get(userId);
    const text = msg.text;

    const stateHandlers = {
        'awaiting_url': async () => {
            new URL(text);
            const { lastID } = await dbRun('INSERT INTO urls (user_id, url) VALUES (?, ?)', [userId, text]);
            const newUrl = await dbGet('SELECT * FROM urls WHERE id = ?', [lastID]);
            startPinger(newUrl, bot);
            bot.sendMessage(userId, '✅ URL added and is now being monitored!');
        },
        'awaiting_interval': async () => {
            const interval = parseInt(text, 10);
            if (isNaN(interval) || interval < 30) throw new Error('❌ Invalid input. Please send a number equal to or greater than 30.');
            await dbRun('UPDATE urls SET interval = ? WHERE id = ?', [interval, urlId]);
            const updatedUrl = await dbGet('SELECT * FROM urls WHERE id = ?', [urlId]);
            startPinger(updatedUrl, bot);
            bot.sendMessage(userId, `✅ Interval for URL ID ${urlId} has been updated to ${interval} seconds.`);
        },
        'awaiting_keyword': async () => {
            const keyword = text.toLowerCase() === 'none' ? null : text;
            await dbRun('UPDATE urls SET keyword = ? WHERE id = ?', [keyword, urlId]);
            bot.sendMessage(userId, `✅ Keyword for URL ID ${urlId} has been ${keyword ? `set to "${keyword}"` : 'removed'}.`);
        },
        'awaiting_headers': async () => {
            const headers = text.toLowerCase() === 'none' ? null : text;
            if (headers) JSON.parse(headers); // Validate JSON
            await dbRun('UPDATE urls SET headers = ? WHERE id = ?', [headers, urlId]);
            bot.sendMessage(userId, `✅ Headers for URL ID ${urlId} have been updated.`);
        }
    };

    try {
        if (stateHandlers[state]) {
            await stateHandlers[state]();
        }
    } catch (e) {
        console.error("State machine error:", e);
        bot.sendMessage(userId, e.message.startsWith('❌') ? e.message : "An error occurred. Please try again.");
    } finally {
        userStates.delete(userId);
    }
});

const startApp = async () => {
    try {
        await initializeDatabase();
        
        http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Bot is running.');
        }).listen(PORT, () => {
            console.log(`🚀 Server listening on port ${PORT}`);
            
            initializeAllPingers(bot);
            checkAllSslCertificates(bot);
            setInterval(() => checkAllSslCertificates(bot), 24 * 60 * 60 * 1000);
        });

        console.log("✅ Bot is polling for messages.");
        bot.on('polling_error', console.error);

    } catch (error) {
        console.error("❌ Failed to start the application:", error);
        process.exit(1);
    }
};

startApp();
