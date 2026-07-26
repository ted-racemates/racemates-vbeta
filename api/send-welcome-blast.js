// api/send-welcome-blast.js
// Fonction à usage PONCTUEL — pas déclenchée par un webhook, mais visitée
// manuellement dans le navigateur pour envoyer le mail de bienvenue à TOUS
// les comptes déjà inscrits (rattrapage, une seule fois).
//
// Usage :
//   1. D'ABORD en mode test (n'envoie rien, montre juste qui recevrait le mail) :
//      https://racemates.app/api/send-welcome-blast?secret=TON_SECRET&dry_run=true
//   2. Une fois vérifié, l'envoi réel (retire dry_run, ou mets-le à false) :
//      https://racemates.app/api/send-welcome-blast?secret=TON_SECRET
//
// "TON_SECRET" = la même valeur que SUPABASE_WEBHOOK_SECRET dans Vercel.
// À ne lancer qu'UNE SEULE FOIS pour l'envoi réel (pas de protection contre
// les doublons si tu le relances plusieurs fois de suite).

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function buildWelcomeEmail(firstName) {
    return {
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
    };
}

export default async function handler(req, res) {
    var url;
    try {
        url = new URL(req.url, 'http://' + (req.headers && req.headers.host || 'localhost'));
    } catch (e) {
        return res.status(400).json({ error: 'URL invalide' });
    }
    const secret = url.searchParams.get('secret');
    if (!process.env.SUPABASE_WEBHOOK_SECRET || secret !== process.env.SUPABASE_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized — ajoute ?secret=TON_SECRET dans l\'URL' });
    }

    const dryRunParam = url.searchParams.get('dry_run');
    const dryRun = dryRunParam === 'true' || dryRunParam === '1';

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbHeaders = {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json'
    };

    try {
        // Récupérer tous les profils existants
        const profilesRes = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=id,prenom&limit=1000', { headers: sbHeaders });
        const profiles = await profilesRes.json();
        if (!Array.isArray(profiles)) {
            return res.status(500).json({ error: 'Impossible de récupérer les profils', details: profiles });
        }

        const results = { total: profiles.length, sent: 0, skipped: 0, failed: 0, details: [] };

        for (const profile of profiles) {
            const firstName = profile.prenom || 'toi';

            // Récupérer l'email (auth.users)
            const userRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + profile.id, { headers: sbHeaders });
            const user = await userRes.json();
            const email = user && user.email;

            if (!email) {
                results.skipped++;
                results.details.push({ id: profile.id, status: 'skipped', reason: 'no email' });
                continue;
            }

            if (dryRun) {
                results.sent++; // compté comme "aurait été envoyé" en dry-run
                results.details.push({ id: profile.id, status: 'would_send', to: email, firstName: firstName });
                continue;
            }

            const { subject, html } = buildWelcomeEmail(firstName);
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
                    subject: subject,
                    html: html
                })
            });

            if (emailRes.ok) {
                results.sent++;
                results.details.push({ id: profile.id, status: 'sent', to: email });
            } else {
                const errText = await emailRes.text();
                results.failed++;
                results.details.push({ id: profile.id, status: 'failed', to: email, error: errText });
            }

            // Pause entre chaque envoi pour rester tranquille sur les limites de débit Resend
            await sleep(400);
        }

        return res.status(200).json({ dry_run: dryRun, ...results });
    } catch (err) {
        return res.status(500).json({ error: String(err) });
    }
}
 
