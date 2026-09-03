/**
 * Optionaler CORS-Proxy als Cloudflare Worker.
 *
 * Nur nötig, wenn der Browser den direkten Zugriff des Boards auf die
 * ESPN-API blockiert UND das Bookmarklet nicht in Frage kommt.
 * Der Weg über das Bookmarklet ist der bessere: er braucht keine Infrastruktur
 * und deine ESPN-Cookies verlassen den ESPN-Tab nicht.
 *
 * Deployment (kostenloser Cloudflare-Account genügt):
 *   1. dash.cloudflare.com  ->  Workers & Pages  ->  Create Worker
 *   2. Inhalt dieser Datei einfügen, deployen
 *   3. ALLOWED_ORIGINS unten auf die eigene Board-Adresse setzen
 *   4. Im Board unter "Erweitert: CORS-Proxy" eintragen:
 *      https://<dein-worker>.workers.dev/?url=
 */

/** Nur diese Seiten dürfen den Proxy nutzen. Leer lassen = jede Seite. */
const ALLOWED_ORIGINS = [
  // 'https://dein-name.github.io',
];

/** Streng begrenzt: ausschließlich lesende ESPN-Fantasy-Endpunkte. */
const ALLOWED_HOSTS = [
  'lm-api-reads.fantasy.espn.com',
  'fantasy.espn.com',
  'site.api.espn.com',
];

function corsHeaders(origin) {
  const allow = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allow ? (origin || '*') : 'null',
    'Access-Control-Allow-Headers': 'X-Fantasy-Filter, Accept, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Nur GET', { status: 405, headers: cors });
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origin nicht erlaubt', { status: 403, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Parameter "url" fehlt', { status: 400, headers: cors });

    let upstream;
    try {
      upstream = new URL(target);
    } catch {
      return new Response('Ungültige Ziel-URL', { status: 400, headers: cors });
    }
    if (upstream.protocol !== 'https:' || !ALLOWED_HOSTS.includes(upstream.hostname)) {
      return new Response('Ziel-Host nicht erlaubt', { status: 403, headers: cors });
    }

    const headers = { Accept: 'application/json' };
    const filter = request.headers.get('X-Fantasy-Filter');
    if (filter) headers['X-Fantasy-Filter'] = filter;
    // Für private Ligen: Cookie-Header als Secret im Worker hinterlegen
    // und hier setzen. Ohne das sind nur öffentliche Ligen abrufbar.

    const res = await fetch(upstream.toString(), { headers, cf: { cacheTtl: 5 } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
