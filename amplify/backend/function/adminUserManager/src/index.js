const {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminCreateUserCommand,
    AdminDeleteUserCommand,
    AdminAddUserToGroupCommand,
    AdminGetUserCommand
} = require('@aws-sdk/client-cognito-identity-provider');

const {
    SNSClient,
    SubscribeCommand,
    ListSubscriptionsByTopicCommand,
    UnsubscribeCommand
} = require('@aws-sdk/client-sns');

const {
    SESClient,
    SendEmailCommand
} = require('@aws-sdk/client-ses');

const client = new CognitoIdentityProviderClient({ region: 'eu-central-1' });
const USER_POOL_ID = process.env.USER_POOL_ID;
const snsClient = new SNSClient({ region: 'eu-central-1' });
const SNS_TOPIC_ARN = 'arn:aws:sns:eu-central-1:717279707507:distance-alert-topic';
const sesClient = new SESClient({ region: 'eu-central-1' });

exports.handler = async (event) => {
    console.log('🔧 Eingehendes Event:', JSON.stringify(event, null, 2));

    const claims = event.requestContext?.authorizer?.claims || {};
    const groups = claims['cognito:groups'] || [];
    const isAdmin = Array.isArray(groups) ? groups.includes('Admin') : groups === 'Admin';
    const { httpMethod, pathParameters, body } = event;

    console.log(`📌 httpMethod: ${httpMethod}, pathParameters: ${JSON.stringify(pathParameters)}, isAdmin: ${isAdmin}`);
    console.log(`👤 Token claims: ${JSON.stringify(claims)}`);

    if (httpMethod === 'OPTIONS') {
        console.log('⚙️ Behandle OPTIONS Preflight Request');
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
            },
            body: ''
        };
    }

    if (!isAdmin) {
        console.warn('⛔ Zugriff verweigert: kein Admin');
        return respond(403, { error: 'Nur Admins erlaubt' });
    }

    try {
        if (httpMethod === 'GET') {
            console.log('📬 Liste alle Nutzer');
            const users = await client.send(new ListUsersCommand({
                UserPoolId: USER_POOL_ID
            }));
            console.log('✅ Gefundene Nutzer:', JSON.stringify(users.Users, null, 2));

            return respond(200, users.Users.map(u => ({
                username: u.Username,
                email: u.Attributes.find(attr => attr.Name === 'email')?.Value || '',
                status: u.UserStatus
            })));
        }

        if (httpMethod === 'POST' && body) {
            const { email } = JSON.parse(body);
            console.log(`✏️ Erstelle neuen Nutzer mit Email: ${email}`);

            await client.send(new AdminCreateUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: email,
                UserAttributes: [
                    { Name: 'email', Value: email },
                    { Name: 'email_verified', Value: 'true' }
                ]
            }));
            console.log('✅ Benutzer in Cognito erstellt');

            await client.send(new AdminAddUserToGroupCommand({
                UserPoolId: USER_POOL_ID,
                Username: email,
                GroupName: 'User'
            }));
            console.log('✅ Benutzer zur Gruppe "User" hinzugefügt');

            await snsClient.send(new SubscribeCommand({
                TopicArn: SNS_TOPIC_ARN,
                Protocol: 'email',
                Endpoint: email
            }));
            console.log('✅ SNS Subscription angelegt');

            return respond(200, { message: 'Benutzer erstellt, Gruppe zugewiesen, SNS subscription hinzugefügt' });
        }

        if (httpMethod === 'DELETE' && pathParameters?.username) {
            console.log(`🗑️ Lösche Nutzer: ${pathParameters.username}`);

            // 1. Nutzer abrufen, um Email zu finden
            const user = await client.send(new AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: pathParameters.username
            }));
            console.log('📋 Gefundener Nutzer:', JSON.stringify(user, null, 2));

            const emailAttr = user.UserAttributes.find(attr => attr.Name === 'email');
            const email = emailAttr?.Value;
            console.log(`📧 Email des Nutzers: ${email}`);

            // 2. SNS Subscription löschen (wenn vorhanden)
            if (email) {
                try {
                    const subs = await snsClient.send(new ListSubscriptionsByTopicCommand({
                        TopicArn: SNS_TOPIC_ARN
                    }));
                    console.log('📋 Gefundene SNS Subscriptions:', JSON.stringify(subs.Subscriptions, null, 2));

                    const matching = subs.Subscriptions.find(sub =>
                        sub?.Endpoint === email && sub?.SubscriptionArn && sub?.SubscriptionArn !== 'PendingConfirmation'
                    );
                    if (matching) {
                        await snsClient.send(new UnsubscribeCommand({
                            SubscriptionArn: matching.SubscriptionArn
                        }));
                        console.log(`✅ SNS Subscription für ${email} gelöscht`);
                    } else {
                        console.log('ℹ️ Keine gültige SNS Subscription zum Löschen gefunden');
                    }
                } catch (snsError) {
                    console.warn(`⚠️ Fehler beim SNS Unsubscribe für ${email}:`, snsError);
                }

                // 3. Abschieds‑Mail schicken
                try {
                    await sesClient.send(new SendEmailCommand({
                        Destination: { ToAddresses: [email] },
                        Message: {
                            Subject: { Data: 'Dein Benutzerkonto wurde gelöscht' },
                            Body: {
                                Text: { Data: `Hallo,\n\ndein Benutzerkonto wurde vom Administrator gelöscht und ist nicht mehr verfügbar.` }
                            }
                        },
                        Source: 'noreply@grafana-proxy.com'
                    }));
                    console.log(`✅ E-Mail an ${email} gesendet`);
                } catch (sesError) {
                    console.warn(`⚠️ Konnte E-Mail nicht senden an ${email}:`, sesError);
                }
            } else {
                console.log('⚠️ Keine Email gefunden, überspringe SNS und E-Mail');
            }

            // 4. Nutzer löschen
            await client.send(new AdminDeleteUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: pathParameters.username
            }));
            console.log('✅ Benutzer aus Cognito gelöscht');

            return respond(200, { message: 'Benutzer gelöscht (inkl. optionaler SNS und E-Mail)' });
        }

        console.warn('⚠️ Nicht unterstützte Methode oder Route');
        return respond(405, { error: 'Methode nicht erlaubt oder Route ungültig' });
    } catch (error) {
        console.error('❌ Fehler in Lambda:', error);
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
            'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization'
        }
    };
}
