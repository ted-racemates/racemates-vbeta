// api/notify-message.js
// Déclenché par un Database Webhook Supabase sur INSERT de la table "messages".
// Envoie un email via Resend au destinataire, sauf si on lui a déjà envoyé un
// email pour ce même échange sans qu'il ait encore lu les messages précédents
// (anti-spam : on n'email pas à chaque message d'une rafale).

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // 1. Sécurité — le webhook Supabase doit envoyer ce header secret
    //    (configuré à la fois ici en variable d'env et côté Supabase)
    const secret = req.headers['x-webhook-secret'];
    if (!process.env.SUPABASE_WEBHOOK_SECRET || secret !== process.env.SUPABASE_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const payload = req.body || {};
        const msg = payload.record; // format standard des Database Webhooks Supabase
        if (!msg || !msg.conversation_id || !msg.sender_id || !msg.id) {
            return res.status(200).json({ skipped: true, reason: 'invalid payload' });
        }

        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const sbHeaders = {
            apikey: SERVICE_KEY,
            Authorization: 'Bearer ' + SERVICE_KEY,
            'Content-Type': 'application/json'
        };

        // 2. Retrouver la conversation pour identifier le destinataire (l'autre user)
        const convRes = await fetch(
            SUPABASE_URL + '/rest/v1/conversations?id=eq.' + msg.conversation_id + '&select=user1_id,user2_id',
            { headers: sbHeaders }
        );
        const convs = await convRes.json();
        if (!convs || !convs[0]) {
            return res.status(200).json({ skipped: true, reason: 'conversation not found' });
        }
        const conv = convs[0];
        const recipientId = conv.user1_id === msg.sender_id ? conv.user2_id : conv.user1_id;
        if (!recipientId) {
            return res.status(200).json({ skipped: true, reason: 'no recipient' });
        }

        // 3. Anti-spam : si le destinataire a déjà un message NON LU plus ancien
        //    venant du même expéditeur dans cette conversation, on a déjà dû
        //    lui envoyer un email pour celui-là — on ne renvoie pas à chaque
        //    message d'une même rafale, seulement pour le premier non lu.
        const priorUnreadRes = await fetch(
            SUPABASE_URL + '/rest/v1/messages'
                + '?conversation_id=eq.' + msg.conversation_id
                + '&sender_id=eq.' + msg.sender_id
                + '&read_at=is.null'
                + '&created_at=lt.' + encodeURIComponent(msg.created_at)
                + '&select=id&limit=1',
            { headers: sbHeaders }
        );
        const priorUnread = await priorUnreadRes.json();
        if (priorUnread && priorUnread.length > 0) {
            return res.status(200).json({ skipped: true, reason: 'already notified for this streak' });
        }

        // 4. Récupérer l'email du destinataire — vit dans auth.users, pas dans
        //    profiles, donc il faut l'API admin (nécessite la clé service_role)
        const userRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + recipientId, { headers: sbHeaders });
        const recipient = await userRes.json();
        const recipientEmail = recipient && recipient.email;
        if (!recipientEmail) {
            return res.status(200).json({ skipped: true, reason: 'no recipient email' });
        }

        // 5. Récupérer le prénom de l'expéditeur pour personnaliser l'email
        const senderRes = await fetch(
            SUPABASE_URL + '/rest/v1/profiles?id=eq.' + msg.sender_id + '&select=prenom,pseudo',
            { headers: sbHeaders }
        );
        const senders = await senderRes.json();
        const senderName = (senders && senders[0] && senders[0].prenom) || 'Un athlète';

        // 6. Envoyer l'email via Resend
        const preview = escapeHtml(String(msg.content || '').slice(0, 140));
        const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: process.env.RESEND_FROM_EMAIL || 'RaceMates <notifications@racemates.app>',
                to: recipientEmail,
                subject: senderName + ' t\'a envoyé un message sur RaceMates',
                html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">'
                    + '<h2 style="color:#0A1628;margin-bottom:4px">Nouveau message de ' + escapeHtml(senderName) + '</h2>'
                    + '<p style="color:#475569;font-size:15px;line-height:1.5;background:#F1F5F9;padding:12px 16px;border-radius:10px">"' + preview + (msg.content && msg.content.length > 140 ? '…' : '') + '"</p>'
                    + '<a href="https://racemates.app" style="display:inline-block;margin-top:16px;background:#0A1628;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Répondre sur RaceMates</a>'
                    + '</div>'
            })
        });

        if (!emailRes.ok) {
            const errText = await emailRes.text();
            console.error('Resend error:', errText);
            return res.status(200).json({ sent: false, error: errText });
        }

        return res.status(200).json({ sent: true, to: recipientEmail });
    } catch (err) {
        console.error('notify-message error:', err);
        return res.status(200).json({ sent: false, error: String(err) });
    }
}
