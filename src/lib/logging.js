const { DEBUG_PROXY } = require('../config');

function debugLog(message, details) {
    if (!DEBUG_PROXY) {
        return;
    }

    if (details === undefined) {
        console.log(`[proxy-debug] ${message}`);
        return;
    }

    console.log(`[proxy-debug] ${message}`, details);
}

module.exports = {
    debugLog,
};
