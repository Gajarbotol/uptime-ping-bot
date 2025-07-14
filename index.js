// ✅ Auto Ping Telegram Bot with Full Features + Fail Limit Auto Stop (Fixed & Refactored)

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
const http = require('http'); // 👈 Added http module

// --- CONFIGURATION ---
const token = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const SELF_PING_URL = process.env.SELF_PING_URL || null; // e.g., your Glitch/Render URL
const PORT = process.env.PORT || 3000; // 👈 Added port configuration
const DATA_FILE = './users.json';
const FAIL_LIMIT = 5; // Auto-stop URL after this many consecutive fails
const MIN_INTERVAL = 4; // Minimum allowed ping interval in seconds

// --- INITIALIZATION ---
const bot = new TelegramBot(token, { polling: true });

// --- DATA MANAGEMENT ---
let users = {};
try {
    if (fs.existsSync(DATA_FILE)) {
        users = JSON.parse(fs.readFileSync(DATA_FILE));
    }
} catch (error) {
    console.error("Error reading data file:", error);
}

const saveUsers = () => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error("Error writing data file:", error);
    }
};

// In-memory store for active setInterval timers
const pingIntervals = {};

// --- HELPER FUNCTIONS ---

/**
 * Formats an ISO date string into a relative time format (e.g., "5 minutes ago").
 * @param {string} isoDateString - The ISO date string to format.
 * @returns {string} The formatted relative time.
 */
function formatTimeAgo(isoDateString) {
    if (!isoDateString) return 'N/A';

    const now = new Date();
    const past = new Date(isoDateString);
    const secondsAgo = Math.round((now - past) / 1000);

    if (secondsAgo < 60) {
        return `${secondsAgo} second${secondsAgo !== 1 ? 's' : ''} ago`;
    }

    const minutesAgo = Math.floor(secondsAgo / 60);
    if (minutesAgo < 60) {
        return `${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago`;
    }

    const hoursAgo = Math.floor(minutesAgo / 60);
    if (hoursAgo < 24) {
        return `${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`;
    }

    const daysAgo = Math.floor(hoursAgo / 24);
    return `${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago`;
}


// --- CORE PINGING LOGIC ---

/**
 * Stops a single ping interval for a specific URL.
 * @param {string} userId - The user's ID.
 * @param {number} urlIndex - The index of the URL in the user's array.
 */
function stopSinglePing(userId, urlIndex) {
    if (pingIntervals[userId] && pingIntervals[userId][urlIndex]) {
        clearInterval(pingIntervals[userId][urlIndex]);
        delete pingIntervals[userId][urlIndex];
    }
}

/**
 * Stops all active pings for a given user.
 * @param {string} userId - The user's ID.
 */
function stopUserPings(userId) {
    if (pingIntervals[userId]) {
        for (const urlIndex in pingIntervals[userId]) {
            clearInterval(pingIntervals[userId][urlIndex]);
        }
        pingIntervals[userId] = {}; // Clear all intervals for the user
    }
}

/**
 * Starts pinging all active URLs for a given user.
 * @param {string} userId - The user's ID.
 */
function startUserPings(userId) {
    stopUserPings(userId); // Ensure no old intervals are running

    const user = users[userId];
    if (!user || !user.urls || !user.urls.length) return;

    pingIntervals[userId] = {};

    user.urls.forEach((entry, index) => {
        if (!entry.active) return;

        // Initialize stats if they don't exist
        entry.success = entry.success || 0;
        entry.fail = entry.fail || 0;
        entry.consecutiveFails = 0; // Reset on start

        const intervalId = setInterval(async () => {
            try {
                await axios.get(entry.url);
                entry.lastPing = new Date().toISOString();
                entry.success++;
                entry.consecutiveFails = 0;
            } catch (err) {
                entry.fail++;
                entry.consecutiveFails = (entry.consecutiveFails || 0) + 1;
                console.error(`[Ping Error] URL: ${entry.url}, User: ${userId}, Error: ${err.message}`);

                if (entry.consecutiveFails >= FAIL_LIMIT) {
                    entry.active = false;
                    stopSinglePing(userId, index); // Stop this specific interval
                    bot.sendMessage(userId, `❌ **Auto-Stopped Pinging** ❌\n\nYour URL has been automatically stopped after ${FAIL_LIMIT} consecutive failures.\n\n🔗 **URL:** ${entry.url}\n\nYou can re-enable it from the dashboard.`, { parse_mode: 'Markdown' });
                }
            } finally {
                saveUsers(); // Save state after each attempt
            }
        }, entry.interval * 1000);

        pingIntervals[userId][index] = intervalId;
    });
}


// --- BOT UI & MENUS ---

const mainMenu = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '➕ Add URL', callback_data: 'add_url' }],
            [{ text: '🟢 Start Pinging', callback_data: 'start_ping' }, { text: '🔴 Stop Pinging', callback_data: 'stop_ping' }],
            [{ text: '📊 Dashboard', callback_data: 'dashboard_0' }],
            [{ text: '👑 Admin Panel', callback_data: 'admin_stats' }]
        ]
    }
};

/**
 * Generates the dashboard view with pagination.
 * @param {string} userId - The user's ID.
 * @param {number} page - The current page number.
 * @returns {{text: string, options: object}}
 */
const getDashboardPage = (userId, page = 0) => {
    const user = users[userId];
    const perPage = 3;
    const urls = user.urls || [];
    const start = page * perPage;
    const end = start + perPage;
    const totalPages = Math.ceil(urls.length / perPage) || 1;

    const pageUrls = urls.slice(start, end);

    const text = pageUrls.length > 0 ? pageUrls.map((u, i) => {
        const globalIndex = start + i;
        return `*URL ID: ${globalIndex}*\n` +
               `🔗 *Link:* ${u.url}\n` +
               `⏱ *Interval:* ${u.interval}s\n` +
               `*Status:* ${u.active ? '🟢 Active' : '🔴 Inactive'}\n` +
               `✅ *Success:* ${u.success || 0} | ❌ *Fail:* ${u.fail || 0}\n` +
               `📅 *Last Ping:* ${formatTimeAgo(u.lastPing)}`;
    }).join("\n\n") : '🚫 You have not added any URLs yet. Click "Add URL" to begin.';

    const buttons = pageUrls.map((_, i) => {
        const globalIndex = start + i;
        return [
            { text: `✏️ Edit ${globalIndex}`, callback_data: `edit_${globalIndex}` },
            { text: `🗑️ Delete ${globalIndex}`, callback_data: `delete_${globalIndex}` }
        ];
    });

    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️ Previous', callback_data: `dashboard_${page - 1}` });
    if (end < urls.length) navRow.push({ text: '➡️ Next', callback_data: `dashboard_${page + 1}` });

    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }]);

    return {
        text: `📊 *Your Dashboard (Page ${page + 1}/${totalPages})*:\n\n${text}`,
        options: {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        }
    };
};

// --- BOT EVENT HANDLERS ---

bot.onText(/\/start/, (msg) => {
    const userId = msg.from.id.toString();
    if (!users[userId]) {
        users[userId] = { urls: [] };
        saveUsers();
    }
    bot.sendMessage(userId, "👋 Welcome to the Auto Ping Bot!\n\nI can monitor your web projects by pinging them at set intervals to keep them awake. Use the menu below to get started.", mainMenu);
});

bot.on('callback_query', (query) => {
    const userId = query.from.id.toString();
    const [command, payload] = query.data.split('_');

    if (!users[userId]) {
        users[userId] = { urls: [] };
        saveUsers();
    }
    const user = users[userId];

    bot.answerCallbackQuery(query.id); // Acknowledge the button press immediately

    switch (command) {
        case 'menu':
            bot.editMessageText('🏠 Main Menu:', { chat_id: query.message.chat.id, message_id: query.message.message_id, ...mainMenu });
            break;

        case 'add': // 'add_url'
            bot.sendMessage(userId, '🔗 Please send me the full URL you want to ping (e.g., https://example.com):');
            bot.once('message', (msg) => {
                const urlToAdd = msg.text;
                try {
                    new URL(urlToAdd);
                    user.urls.push({ url: urlToAdd, interval: 300, active: true, lastPing: null, success: 0, fail: 0, consecutiveFails: 0 });
                    saveUsers();
                    bot.sendMessage(userId, '✅ URL added successfully with a default interval of 300 seconds. You can change this in the dashboard.', mainMenu);
                } catch (error) {
                    bot.sendMessage(userId, '❌ Invalid URL format. Please make sure it starts with http:// or https://', mainMenu);
                }
            });
            break;

        case 'start': // 'start_ping'
            user.urls.forEach(u => u.active = true);
            saveUsers();
            startUserPings(userId);
            bot.sendMessage(userId, '🟢 Pinging started for all active URLs!', mainMenu);
            break;

        case 'stop': // 'stop_ping'
            user.urls.forEach(u => u.active = false);
            saveUsers();
            stopUserPings(userId);
            bot.sendMessage(userId, '🔴 Pinging stopped for all URLs.', mainMenu);
            break;

        case 'dashboard':
            const page = parseInt(payload || '0', 10);
            const dash = getDashboardPage(userId, page);
            bot.editMessageText(dash.text, { chat_id: query.message.chat.id, message_id: query.message.message_id, ...dash.options });
            break;

        case 'edit':
            const editIndex = parseInt(payload, 10);
            if (user.urls[editIndex]) {
                bot.sendMessage(userId, `✏️ The current interval for this URL is ${user.urls[editIndex].interval}s.\n\nEnter the new interval in seconds (minimum ${MIN_INTERVAL}):`);
                bot.once('message', (msg) => {
                    const newInterval = parseInt(msg.text, 10);
                    if (!isNaN(newInterval) && newInterval >= MIN_INTERVAL) {
                        user.urls[editIndex].interval = newInterval;
                        saveUsers();
                        startUserPings(userId);
                        bot.sendMessage(userId, '✅ Interval updated! Pings have been restarted.', mainMenu);
                    } else {
                        bot.sendMessage(userId, `❌ Invalid interval. Please enter a number greater than or equal to ${MIN_INTERVAL}.`, mainMenu);
                    }
                });
            }
            break;

        case 'delete':
            const deleteIndex = parseInt(payload, 10);
            if (user.urls[deleteIndex]) {
                const deletedUrl = user.urls[deleteIndex].url;
                stopSinglePing(userId, deleteIndex);
                user.urls.splice(deleteIndex, 1);
                saveUsers();
                startUserPings(userId);
                bot.sendMessage(userId, `🗑️ URL removed successfully:\n${deletedUrl}`, mainMenu);
            }
            break;

        case 'admin': // 'admin_stats'
            if (userId !== ADMIN_ID) {
                bot.sendMessage(userId, '🚫 You are not authorized to view this.');
                return;
            }
            const totalUsers = Object.keys(users).length;
            const allUrls = Object.values(users).flatMap(u => u.urls);
            const totalUrls = allUrls.length;
            const activeUrls = allUrls.filter(u => u.active).length;
            const totalSuccess = allUrls.reduce((sum, url) => sum + (url.success || 0), 0);
            const totalFail = allUrls.reduce((sum, url) => sum + (url.fail || 0), 0);
            bot.sendMessage(userId, `👑 *Admin Stats*\n\n👤 *Total Users:* ${totalUsers}\n🔗 *Total URLs:* ${totalUrls}\n🟢 *Active URLs:* ${activeUrls}\n\n✅ *Total Success Pings:* ${totalSuccess}\n❌ *Total Failed Pings:* ${totalFail}`, { parse_mode: 'Markdown' });
            break;
    }
});

// --- BOT & PINGER STARTUP ---
console.log("Bot starting up...");

for (const userId in users) {
    if (users[userId].urls && users[userId].urls.some(u => u.active)) {
        console.log(`Initializing pings for user ${userId}`);
        startUserPings(userId);
    }
}

if (SELF_PING_URL) {
    setInterval(() => {
        axios.get(SELF_PING_URL)
            .then(() => console.log('🌐 Self-ping successful.'))
            .catch((err) => console.error('🌐 Self-ping failed:', err.message));
    }, 5 * 60 * 1000);
    console.log(`Self-pinging enabled for: ${SELF_PING_URL}`);
}

// --- WEB SERVER FOR HOSTING ---
// This part is crucial for platforms like Render, Heroku, etc.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive.');
});

server.listen(PORT, () => {
    console.log(`🚀 Server is listening on port ${PORT}`);
    console.log("✅ Bot is running and polling for messages.");
});

