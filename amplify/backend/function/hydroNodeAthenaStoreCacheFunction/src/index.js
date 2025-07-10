
const redis = require('redis');
const { AthenaClient, StartQueryExecutionCommand, GetQueryResultsCommand, GetQueryExecutionCommand } = require('@aws-sdk/client-athena');
const { DateTime } = require('luxon');

// Athena und Redis-Clients initialisieren
const athenaClient = new AthenaClient({ region: 'eu-central-1' });
const redisClient = redis.createClient({
    host: 'hydronodeathenacache-mxhr8t.serverless.euc1.cache.amazonaws.com',  // Ersetze mit dem tatsächlichen Endpunkt deines Redis-Clusters
    port: 6379,  // Standard-Port für Redis
    tls: {
        // TLS-Optionen für eine sichere Verbindung
        rejectUnauthorized: true  // Stellt sicher, dass das Zertifikat des Servers überprüft wird
    }  // TLS aktivieren, wenn du SSL-Verbindungen benötigst
});

const ATHENA_DB = 'data-lake-database-0';
const ATHENA_OUTPUT = 's3://s3-data-lake-athena-sql-results/athena-query-results-aggregations/';

exports.handler = async () => {
    try {
        // 1. Abrufen aller verfügbaren `nodeId` und `metricType`
        const nodeIds = await getNodeIds();  // Diese Funktion holt alle nodeIds
        const metricTypes = await getMetricTypes();  // Diese Funktion holt alle metricTypes

        // 2. Für jedes `nodeId` und `metricType` eine Abfrage durchführen
        for (let nodeId of nodeIds) {
            for (let metricType of metricTypes) {
                for (let timeframe of ['DAYS', 'MONTHS', 'YEARS']) {
                    const latestPartition = await getLatestPartition(timeframe, nodeId);
                    if (!latestPartition) {
                        console.log(`Keine Partitionen gefunden für nodeId ${nodeId} und timeframe ${timeframe}`);
                        continue;
                    }

                    console.log("📆 Letzte Partition:", latestPartition);

                    const periods = calculatePeriods(timeframe, latestPartition);
                    console.log("📆 Generierte Perioden:", periods);

                    const sql = buildDataQuery(timeframe, nodeId, metricType, periods);
                    console.log("📄 Finale SQL Query:", sql);

                    const queryExecutionId = await startQuery(sql);
                    console.log("🆔 QueryExecutionId:", queryExecutionId);

                    await waitForQueryToComplete(queryExecutionId);

                    const data = await getQueryResults(queryExecutionId);
                    console.log("📊 Abfrageergebnis (gekürzt):", JSON.stringify(data.slice(0, 3)));

                    // 3. Die Ergebnisse im Redis Cache speichern
                    const cacheKey = `athena_data_${nodeId}_${metricType}_${timeframe}`;
                    await redisClient.set(cacheKey, JSON.stringify(data));

                    console.log("🔄 Daten wurden im Redis Cache gespeichert für:", cacheKey);
                }
            }
        }

    } catch (error) {
        console.error("❌ Fehler im Athena-Handler:", error);
    }
};

// Dynamisch alle nodeIds aus der Datenbank abrufen
async function getNodeIds() {
    const sql = `SELECT DISTINCT hydronode FROM "${ATHENA_DB}".sensordata_daily_aggregates`;

    const queryExecutionId = await startQuery(sql);
    await waitForQueryToComplete(queryExecutionId);
    const results = await getQueryResults(queryExecutionId);

    return results.map(row => row.hydronode);
}

// Dynamisch alle metricTypes abrufen
async function getMetricTypes() {
    const sql = `SELECT DISTINCT "sensor-id" FROM "${ATHENA_DB}".sensordata_daily_aggregates`;

    const queryExecutionId = await startQuery(sql);
    await waitForQueryToComplete(queryExecutionId);
    const results = await getQueryResults(queryExecutionId);

    return results.map(row => row['sensor-id']);
}

async function getLatestPartition(timeframe, nodeId) {
    let tableName, dateCols;
    if (timeframe === 'DAYS') {
        tableName = 'sensordata_daily_aggregates';
        dateCols = ['year', 'month', 'day'];
    } else if (timeframe === 'MONTHS') {
        tableName = 'sensordata_monthly_aggregates';
        dateCols = ['year', 'month'];
    } else if (timeframe === 'YEARS') {
        tableName = 'sensordata_yearly_agg';
        dateCols = ['year'];
    }

    const maxCols = dateCols.map(c => `MAX(${c}) AS max_${c}`).join(", ");

    const sql = `SELECT ${maxCols} FROM "${ATHENA_DB}".${tableName} WHERE hydronode = '${nodeId}'`;

    const queryExecutionId = await startQuery(sql);
    await waitForQueryToComplete(queryExecutionId);
    const results = await getQueryResults(queryExecutionId);

    if (results.length === 0) return null;

    return results[0];
}

function calculatePeriods(timeframe, latest) {
    if (timeframe === 'DAYS') {
        const latestDate = DateTime.local();
        const result = Array.from({ length: 12 }, (_, i) => {
            const d = latestDate.minus({ days: i });
            return {
                year: d.year.toString(),
                month: d.month.toString().padStart(2, '0'),
                day: d.day.toString().padStart(2, '0')
            };
        });
        return result;
    } else if (timeframe === 'MONTHS') {
        const latestDate = DateTime.local();
        const result = Array.from({ length: 6 }, (_, i) => {
            const d = latestDate.minus({ months: i });
            return {
                year: d.year.toString(),
                month: d.month.toString().padStart(2, '0')
            };
        });
        return result;
    } else if (timeframe === 'YEARS') {
        const latestYear = parseInt(latest.max_year);
        return Array.from({ length: 4 }, (_, i) => ({
            year: (latestYear - i).toString()
        }));
    }
}

function buildDataQuery(timeframe, nodeId, metricType, periods) {
    let tableName, wherePartitions = [];

    if (timeframe === 'DAYS') {
        tableName = 'sensordata_daily_aggregates';
        wherePartitions = periods.map(p => `(year='${p.year}' AND month='${p.month}' AND day='${p.day}')`);
    } else if (timeframe === 'MONTHS') {
        tableName = 'sensordata_monthly_aggregates';
        wherePartitions = periods.map(p => `(year='${p.year}' AND month='${p.month}')`);
    } else if (timeframe === 'YEARS') {
        tableName = 'sensordata_yearly_agg';
        wherePartitions = periods.map(p => `(year='${p.year}')`);
    }

    const partitionFilter = wherePartitions.join(" OR ");

    const query = `
        SELECT hydronode, ${timeframe === 'DAYS' ? 'year, month, day,' : timeframe === 'MONTHS' ? 'year, month,' : 'year,'} avg_value AS value
        FROM "${ATHENA_DB}".${tableName}
        WHERE hydronode = '${nodeId}'
          AND "sensor-id" = '${metricType}'
          AND (${partitionFilter})
        ORDER BY year, month, day ASC
    `;

    return query;
}

async function startQuery(sql) {
    const params = {
        QueryString: sql,
        QueryExecutionContext: { Database: ATHENA_DB },
        ResultConfiguration: { OutputLocation: ATHENA_OUTPUT }
    };
    const command = new StartQueryExecutionCommand(params);
    const response = await athenaClient.send(command);
    return response.QueryExecutionId;
}

async function waitForQueryToComplete(queryExecutionId) {
    let status = 'RUNNING';
    while (status === 'RUNNING' || status === 'QUEUED') {
        await new Promise(r => setTimeout(r, 1000));
        const res = await athenaClient.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
        status = res.QueryExecution.Status.State;
        if (status === 'FAILED' || status === 'CANCELLED') {
            throw new Error(`Athena Query failed: ${res.QueryExecution.Status.StateChangeReason}`);
        }
    }
}

async function getQueryResults(queryExecutionId) {
    const results = [];
    let nextToken;
    do {
        const params = { QueryExecutionId: queryExecutionId, NextToken: nextToken };
        const command = new GetQueryResultsCommand(params);
        const data = await athenaClient.send(command);
        nextToken = data.NextToken;

        const rows = data.ResultSet.Rows;
        const headers = rows[0].Data.map(d => d.VarCharValue);

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            let item = {};
            row.Data.forEach((col, idx) => {
                item[headers[idx]] = col.VarCharValue;
            });
            results.push(item);
        }
    } while (nextToken);

    return results;
}
