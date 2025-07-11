const {
    SNSClient,
    SubscribeCommand,
    ListSubscriptionsByTopicCommand,
    UnsubscribeCommand
} = require('@aws-sdk/client-sns');

const snsClient = new SNSClient({ region: 'eu-central-1' });
const SNS_TOPIC_ARN = 'arn:aws:sns:eu-central-1:717279707507:distance-alert-topic';

exports.handler = async (event) => {
    console.log('🔧 Eingehendes Event:', JSON.stringify(event, null, 2));

    const httpMethod = event.httpMethod;
    const path = event.path;
    const claims = event.requestContext?.authorizer?.claims || {};
    const email = claims.email;

    console.log(`📌 httpMethod: ${httpMethod}, path: ${path}`);
    console.log(`📧 Aus Token extrahierte Email: ${email}`);

    // Preflight-Request immer ganz oben, ohne weitere Prüfung
    if (httpMethod === 'OPTIONS') {
        console.log('⚙️ Behandle OPTIONS Preflight Request');
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            body: ''
        };
    }

    if (!email) {
        console.warn('⚠️ Keine Email im Token gefunden – User wahrscheinlich nicht authentifiziert');
        return respond(401, { error: 'Nicht authentifiziert oder keine E-Mail vorhanden' });
    }

    try {
        if (httpMethod === 'PUT' && path === '/user/subscription') {
            console.log('📬 Prüfe bestehende Subscriptions für PUT');

            const subs = await snsClient.send(new ListSubscriptionsByTopicCommand({ TopicArn: SNS_TOPIC_ARN }));
            console.log('📋 Gefundene Subscriptions:', JSON.stringify(subs.Subscriptions, null, 2));

            const alreadySubscribed = subs.Subscriptions.find(sub => sub.Endpoint === email);

            if (alreadySubscribed) {
                console.log('✅ User ist bereits abonniert');
                return respond(409, { message: 'Bereits abonniert' });
            }

            console.log('➡️ User noch nicht abonniert – starte Subscribe');
            await snsClient.send(new SubscribeCommand({
                TopicArn: SNS_TOPIC_ARN,
                Protocol: 'email',
                Endpoint: email
            }));

            console.log('✅ Subscription erfolgreich angelegt');
            return respond(200, { message: 'Erfolgreich abonniert' });
        }

        if (httpMethod === 'GET' && path === '/user/subscription') {
            console.log('📬 Prüfe Subscription Status für GET');

            const subs = await snsClient.send(new ListSubscriptionsByTopicCommand({ TopicArn: SNS_TOPIC_ARN }));
            console.log('📋 Gefundene Subscriptions:', JSON.stringify(subs.Subscriptions, null, 2));

            const match = subs.Subscriptions.find(sub => sub.Endpoint === email);
            const isConfirmed = match?.SubscriptionArn && !match.SubscriptionArn.startsWith('Pending');

            console.log(`📊 Ergebnis: subscribed=${!!match}, confirmed=${isConfirmed}`);
            return respond(200, {
                subscribed: !!match,
                confirmed: isConfirmed
            });
        }

        if (httpMethod === 'DELETE' && path === '/user/subscription') {
            console.log('🗑️ Prüfe Subscription zum Löschen für DELETE');

            const subs = await snsClient.send(new ListSubscriptionsByTopicCommand({ TopicArn: SNS_TOPIC_ARN }));
            console.log('📋 Gefundene Subscriptions:', JSON.stringify(subs.Subscriptions, null, 2));

            const match = subs.Subscriptions.find(sub => sub.Endpoint === email);

            if (!match) {
                console.log('⚠️ Keine Subscription gefunden zum Löschen');
                return respond(404, { message: 'Keine Subscription gefunden' });
            }

            if (match.SubscriptionArn && !match.SubscriptionArn.startsWith('Pending')) {
                console.log(`➡️ Lösche Subscription mit ARN: ${match.SubscriptionArn}`);
                await snsClient.send(new UnsubscribeCommand({
                    SubscriptionArn: match.SubscriptionArn
                }));
                console.log('✅ Subscription erfolgreich gelöscht');
            } else {
                console.log('⚠️ Subscription ist noch pending oder ohne gültige ARN – nichts zu löschen');
            }

            return respond(200, { message: 'Abmeldung erfolgreich' });
        }

        console.warn('⚠️ Nicht unterstützte Methode oder Pfad');
        return respond(405, { error: 'Nicht unterstützte Methode oder Pfad' });
    } catch (error) {
        console.error('❌ Fehler in /user/subscription:', error);
        return respond(500, { error: 'Interner Serverfehler' });
    }
};

function respond(code, body) {
    console.log(`📦 Response: statusCode=${code}, body=${JSON.stringify(body)}`);
    return {
        statusCode: code,
        body: JSON.stringify(body),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        }
    };
}
