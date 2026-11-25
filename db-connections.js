// db-connections.js — « Connexions à la base » (v160) : combien de SERVEURS (instances du site : Render, Back4app…) et combien de
// CONNEXIONS sont ouverts sur la base de données.
//
// • Serveurs : à travers le pooler Supabase (Supavisor) le nom d'application du client n'est pas transmis, on ne peut donc pas les
//   distinguer dans pg_stat_activity. Chaque instance du site écrit donc un « battement » (settings, clé server_hb:<id>) toutes les 25 s ;
//   un serveur est « connecté » si son dernier battement a moins de 75 s. Les anciens battements (> 1 h) sont nettoyés.
// • Connexions : lues dans pg_stat_activity (toutes les sessions ouvertes avec le même rôle PostgreSQL que le site), avec la limite du serveur.
'use strict';
const os = require('os');
const db = require('./db');

const HB_PREFIX = 'server_hb:';
const BEAT_MS = 25000, ALIVE_MS = 75000, PURGE_MS = 3600 * 1000;
const ID = `${String(process.env.RENDER_SERVICE_NAME || process.env.HOSTNAME || os.hostname() || 'serveur').slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`;
const STARTED = Date.now();
let beats = 0, timer = null;

async function beat() {
  if (!db.ready) return;
  try {
    let version = ''; try { version = require('./version').version || ''; } catch (_) { /* facultatif */ }
    await db.setSetting(HB_PREFIX + ID, JSON.stringify({ id: ID, host: os.hostname(), at: Date.now(), startedAt: STARTED, version, pid: process.pid }));
    beats += 1;
    if (beats % 20 === 1) { // nettoyage des instances disparues depuis plus d'une heure
      const r = await db.exec(`SELECT key, value FROM settings WHERE key LIKE '${HB_PREFIX}%'`);
      const old = ((r && r.rows) || []).filter((x) => { const v = parse(x.value); return !v || Date.now() - Number(v.at || 0) > PURGE_MS; }).map((x) => x.key);
      if (old.length) await db.exec('DELETE FROM settings WHERE key = ANY($1::text[])', [old]);
    }
  } catch (_) { /* suivi seulement : ne gêne jamais le bot */ }
}
function parse(v) { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } }

function start() {
  if (timer) return;
  timer = setInterval(() => { beat(); }, BEAT_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => { beat(); }, 4000).unref?.();
}

async function snapshot() {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée' };
  await beat(); // ce serveur-ci est toujours à jour dans la liste
  const now = Date.now();
  const hb = await db.exec(`SELECT key, value FROM settings WHERE key LIKE '${HB_PREFIX}%'`);
  const servers = ((hb && hb.rows) || []).map((x) => parse(x.value)).filter(Boolean)
    .map((v) => ({ id: v.id, host: v.host, version: v.version || '', startedAt: v.startedAt || null, lastSeenSecondsAgo: Math.max(0, Math.round((now - Number(v.at || 0)) / 1000)), alive: now - Number(v.at || 0) < ALIVE_MS, self: v.id === ID }))
    .sort((a, b) => (b.alive - a.alive) || (a.lastSeenSecondsAgo - b.lastSeenSecondsAgo));
  let connections = null;
  try {
    const c = await db.exec(`SELECT coalesce(state,'inconnu') AS state, count(*)::int AS n FROM pg_stat_activity WHERE usename = current_user AND pid <> pg_backend_pid() GROUP BY 1`);
    const m = await db.exec(`SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'`);
    if (c) {
      const by = {}; let total = 0; for (const r of c.rows) { by[r.state] = r.n; total += r.n; }
      connections = { total, byState: by, serverMax: m && m.rows[0] ? m.rows[0].max : null };
    }
  } catch (_) { /* droits insuffisants : on affiche seulement les serveurs */ }
  let base = null; try { const s = db.status(); base = s && (s.active != null ? s : null); } catch (_) { /* facultatif */ }
  return { ok: true, at: now, thisServer: ID, serversAlive: servers.filter((s) => s.alive).length, servers, connections, base };
}

module.exports = { start, snapshot, id: ID };
