const redis = require('redis');

exports.handler = async (event) => {
    console.log("Event erhalten:", JSON.stringify(event));

    const redisClient = redis.createClient({
        socket: {
            host: process.env.REDIS_HOST,
            port: 6379,
            tls: true
        }
    });

    try {
        console.log("Verbinde zu Redis...");
        await redisClient.connect();
        console.log("Mit Redis verbunden");

        const { nodeId, metricType, timeframe } = event.queryStringParameters || {};

        console.log("Empfangene Query Parameter:", { nodeId, metricType, timeframe });

        if (!nodeId || !metricType || !timeframe) {
            console.warn("Fehlende Parameter");
            return respond(400, { error: "'nodeId', 'metricType' und 'timeframe' müssen angegeben werden" });
        }

        const cacheKey = `athena_data_${nodeId}_${metricType}_${timeframe}`;
        console.log("Suche CacheKey:", cacheKey);

        const data = await redisClient.get(cacheKey);
        console.log("Redis Antwort:", data);

        if (!data) {
            console.warn(`Keine Daten für CacheKey ${cacheKey} gefunden`);
            return respond(404, { error: `Daten für ${nodeId}, ${metricType}, ${timeframe} nicht im Cache gefunden` });
        }

        console.log("Daten erfolgreich gefunden, sende Antwort");
        return respond(200, { data: JSON.parse(data) });

    } catch (error) {
        console.error("Fehler beim Abrufen der Daten:", error);
        return respond(500, { error: "Interner Serverfehler" });
    } finally {
        if (redisClient.isOpen) {
            console.log("Schließe Redis-Verbindung");
            await redisClient.disconnect();
        }
    }
};

function respond(statusCode, body) {
    console.log("Antworte mit Status:", statusCode, "und Body:", body);
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: JSON.stringify(body)
    };
}
