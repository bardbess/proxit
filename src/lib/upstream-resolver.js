const dns = require('node:dns').promises;
const https = require('node:https');

const { UPSTREAM_DOH_URL } = require('../config');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                headers: {
                    Accept: 'application/dns-json, application/json',
                    'User-Agent': 'Mozilla/5.0 (compatible; ProxyIFrame/1.0)',
                },
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');

                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`DoH resolver returned ${response.statusCode}: ${response.statusMessage}`));
                        return;
                    }

                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        request.on('error', reject);
    });
}

async function resolveViaDoh(hostname, recordType) {
    if (!UPSTREAM_DOH_URL) {
        return null;
    }

    const dohUrl = new URL(UPSTREAM_DOH_URL);
    dohUrl.searchParams.set('name', hostname);
    dohUrl.searchParams.set('type', recordType);
    const payload = await fetchJson(dohUrl);
    const answer = Array.isArray(payload.Answer)
        ? payload.Answer.find((record) => typeof record.data === 'string')
        : null;

    return answer ? answer.data : null;
}

async function resolveUpstreamAddress(hostname) {
    for (const recordType of ['A', 'AAAA']) {
        try {
            const dohAddress = await resolveViaDoh(hostname, recordType);
            if (dohAddress) {
                return dohAddress;
            }
        } catch (error) {
            if (recordType === 'AAAA') {
                console.warn(`DoH lookup failed for ${hostname}: ${error.message}`);
            }
        }
    }

    for (const resolver of [dns.resolve4, dns.resolve6]) {
        try {
            const addresses = await resolver(hostname);
            if (addresses.length > 0) {
                return addresses[0];
            }
        } catch (error) {
            if (!['ENODATA', 'ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'EREFUSED', 'ETIMEOUT'].includes(error.code)) {
                throw error;
            }
        }
    }

    throw new Error(`Unable to resolve upstream host outside the hosts file: ${hostname}`);
}

module.exports = {
    resolveUpstreamAddress,
};
