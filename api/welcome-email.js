// api/welcome-email.js
// Déclenché par un Database Webhook Supabase sur INSERT de la table "profiles"
// (c'est-à-dire à chaque fin d'inscription réussie). Envoie un email de
// bienvenue via Resend au nouvel athlète.

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

    // Sécurité — même secret que pour notify-message, réutilisé ici
    const secret = req.headers['x-webhook-secret'];
    if (!process.env.SUPABASE_WEBHOOK_SECRET || secret !== process.env.SUPABASE_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const payload = req.body || {};
        const profile = payload.record;
        if (!profile || !profile.id) {
            console.log('welcome-email SKIPPED:', 'invalid payload');
            return res.status(200).json({ skipped: true, reason: 'invalid payload' });
        }

        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const sbHeaders = {
            apikey: SERVICE_KEY,
            Authorization: 'Bearer ' + SERVICE_KEY,
            'Content-Type': 'application/json'
        };

        // Récupérer l'email du nouvel inscrit (vit dans auth.users)
        const userRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + profile.id, { headers: sbHeaders });
        const user = await userRes.json();
        const email = user && user.email;
        if (!email) {
            console.log('welcome-email SKIPPED:', 'no email found');
            return res.status(200).json({ skipped: true, reason: 'no email found' });
        }

        const firstName = profile.prenom || 'toi';

        console.log('welcome-email CALLING RESEND, sending to:', email);
        const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: process.env.RESEND_FROM_EMAIL || 'RaceMates <notifications@racemates.app>',
                to: email,
                reply_to: 'contact@racemates.app',
                subject: 'Bienvenue sur RaceMates, ' + escapeHtml(firstName) + ' ! 🏁',
                html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">'
                    + '<h1 style="color:#0A1628;font-size:1.4em;margin-bottom:4px">Bienvenue ' + escapeHtml(firstName) + ' 👋</h1>'
                    + '<p style="color:#475569;font-size:15px;line-height:1.6">Ton compte RaceMates est prêt. Tu peux dès maintenant :</p>'
                    + '<ul style="color:#475569;font-size:15px;line-height:1.8;padding-left:20px">'
                    + '<li>Trouver un partenaire d\'entraînement ou de compétition</li>'
                    + '<li>Trouver un logement ou proposer le tien</li>'
                    + '<li>T\'organiser en covoiturage pour ta prochaine course</li>'
                    + '<li>Découvrir les événements à venir près de chez toi</li>'
                    + '<li>Lancer une alerte de dernière minute en cas d\'imprévu</li>'
                    + '</ul>'
                    + '<a href="https://racemates.app" style="display:inline-block;margin-top:16px;background:#DC2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Découvrir l\'application</a>'
                    + '<table role="presentation" width="100%" style="margin-top:32px;border-collapse:collapse">'
                    + '<tr><td style="border:2px solid #0A1628;border-radius:8px;padding:18px 20px">'
                    + '<div style="font-weight:900;letter-spacing:1px;color:#0A1628;font-size:1.05em">🏅 TU AS TROUVÉ TON MATCH ?</div>'
                    + '<img src="https://racemates.app/badge_preview.png" alt="Aperçu du badge RaceMates" width="100%" style="display:block;max-width:100%;border-radius:6px;margin:10px 0">'
                    + '<p style="color:#475569;font-size:13.5px;line-height:1.6;margin-top:8px">Un partenaire d\'entraînement, un logement, un covoiturage... dès que RaceMates t\'a aidé à trouver quelqu\'un, préviens-nous par retour de mail ! On t\'envoie un badge à accrocher, à porter le jour de la course pour la photo souvenir.</p>'
                    + '<a href="mailto:contact@racemates.app?subject=J%27ai%20trouv%C3%A9%20mon%20match%20sur%20RaceMates%20!" style="display:inline-block;margin-top:10px;color:#DC2626;font-weight:700;font-size:13.5px;text-decoration:none">✉️ Nous prévenir →</a>'
                    + '</td></tr></table>'
                    + '<p style="color:#94A3B8;font-size:12px;margin-top:28px">À bientôt sur RaceMates — Your mate, our race.</p>'
                    + '</div>'
            })
        });

        if (!emailRes.ok) {
            const errText = await emailRes.text();
            console.error('Resend error:', errText);
            return res.status(200).json({ sent: false, error: errText });
        }

        return res.status(200).json({ sent: true, to: email });
    } catch (err) {
        console.error('welcome-email error:', err);
        return res.status(200).json({ sent: false, error: String(err) });
    }
}
