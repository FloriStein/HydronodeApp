const redis = require('redis');

exports.handler = async (event) => {
    const redisClient = redis.createClient({
        host: 'hydronodeathenacache-mxhr8t.serverless.euc1.cache.amazonaws.com',  // Ersetze mit dem tatsächlichen Endpunkt deines Redis-Clusters
        port: 6379,  // Standard-Port für Redis
        tls: {
            // TLS-Optionen für eine sichere Verbindung
            rejectUnauthorized: true  // Stellt sicher, dass das Zertifikat des Servers überprüft wird
        }  // TLS aktivieren, wenn du SSL-Verbindungen benötigst
    });

    try {
        console.log("Verbinde zu Redis...");
        await redisClient.connect();
        console.log("Mit Redis verbunden");

        const keys = [];
        let cursor = 0;

        // Iterativ alle Keys mit SCAN holen
        do {
            const result = await redisClient.scan(cursor, { MATCH: '*', COUNT: 100 });
            cursor = result.cursor;
            keys.push(...result.keys);
        } while (cursor !== 0);

        console.log(`Gefundene Redis Keys (${keys.length}):`, keys);

        return {
            statusCode: 200,
            body: JSON.stringify({
                count: keys.length,
                keys: keys
            })
        };

    } catch (error) {
        console.error("Fehler beim Redis-Debug:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    } finally {
        if (redisClient.isOpen) {
            console.log("Schließe Redis-Verbindung");
            await redisClient.quit();
        }
    }
};
