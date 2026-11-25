// gap-guard.js — « Confirmation de l'écart » (v158, demande admin) : écart minimum de 3 IMPOSÉ entre deux prédictions envoyées dans un même CANAL.
//
// Pourquoi : « Palier parité » et « Palier parité égalité » avaient chacune leur propre mémoire du dernier numéro prédit. Deux stratégies qui
// envoient dans le même canal (ou une autre stratégie qui publie dans ce canal) pouvaient donc poser #N626 puis #N627, alors que chacune,
// prise à part, respectait son écart. Ici la mémoire est PAR CANAL et COMMUNE à toutes les stratégies du Compte parité :
//   • reserve()  : appelée par la stratégie JUSTE AVANT l'envoi (le contrôle et la réservation se font d'un seul geste, sans attente entre les
//                  deux : deux stratégies ne peuvent pas passer en même temps). Écart < 3 avec un numéro déjà prédit dans ce canal → REFUSÉ,
//                  la prédiction n'est PAS envoyée ;
//   • release()  : envoi raté → la réservation est retirée ;
//   • observe()  : appelée par bot.js pour chaque message réellement publié dans un canal : si c'est une prédiction (même lecture que « Retour
//                  après perte »), son numéro est mémorisé aussi, quelle que soit la stratégie qui l'a envoyée ;
//   • l'écart est FORCÉ : jamais moins de 3, même si un ancien réglage valait 1 ou 2 ;
//   • v158b — PLUSIEURS INSTANCES du site (Render, Back4app…) : chaque envoi réserve aussi 3 « cases » consécutives (n, n+1, n+2) du canal dans la base
//     partagée (table sent_dedupe, kind « g »). Deux numéros à moins de 3 d'écart partagent forcément une case : la deuxième réservation est refusée,
//     même si elle vient d'un autre processus. Base muette : la mémoire locale protège.
//   • mémoire enregistrée (fichier + base) : elle survit aux redémarrages ; remise à zéro seulement avec le nouveau sabot de 00h00
//     (la numérotation repart à #1).
'use strict';
const store = require('./store');
const db = require('./db');
const { setOnShoeReset } = require('./predictor');

const FORCED_GAP = 3;
const DB_KEY = 'gap_guard_state', STORE_KEY = 'gapGuard';
const PER_CHANNEL_MAX = 80, STALE_AHEAD = 60, BLOCKED_KEYS_MAX = 300;

const state = { channels: {}, blocked: 0, last: null }; // channels[id] = [{ n, by, at }]
const blockedKeys = new Set();

const keyOf = (id) => String(id == null ? '' : id).trim().toLowerCase();
const forcedGap = (g) => Math.max(FORCED_GAP, Number(g) || FORCED_GAP);
const list = (id) => (state.channels[keyOf(id)] || (state.channels[keyOf(id)] = []));

let timer = null;
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const saved = { channels: state.channels, blocked: state.blocked, last: state.last };
    try { store.patch({ [STORE_KEY]: saved }); } catch (_) { /* best-effort */ }
    if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch(() => {});
  }, 400);
  if (timer.unref) timer.unref();
}

// contrôle sans rien modifier : { ok, conflict } — conflict = { channel, n, by } (le numéro déjà prédit qui gêne)
function check(channels, target, gap, by) {
  const g = forcedGap(gap); const t = Number(target);
  for (const ch of channels || []) {
    for (const e of state.channels[keyOf(ch)] || []) {
      const d = Math.abs(t - e.n);
      if (e.by === by) { if (d > 0 && d < g) return { ok: false, conflict: { channel: String(ch), n: e.n, by: e.by } }; } // même stratégie : d = 0 = doublon, géré par elle
      else if (d < g) return { ok: false, conflict: { channel: String(ch), n: e.n, by: e.by } };                        // autre stratégie : même numéro ou trop proche
    }
  }
  return { ok: true, conflict: null };
}

function noteBlocked(by, target, rv) {
  const c = rv && rv.conflict; if (!c) return;
  const k = `${by}|${c.channel}|${target}`;
  if (blockedKeys.has(k)) return; // un même numéro bloqué (réessayé à chaque passage) n'est compté qu'une fois
  blockedKeys.add(k); if (blockedKeys.size > BLOCKED_KEYS_MAX) blockedKeys.delete(blockedKeys.values().next().value);
  state.blocked += 1;
  state.last = { by, target: Number(target), channel: c.channel, conflictWith: c.n, conflictBy: c.by, at: Date.now() };
  persist();
}

// v158b : cases réservées dans la base partagée : un numéro n occupe les cases n … n+écart-1 (3 cases pour un écart de 3)
const slotKeys = (chan, n, gap) => Array.from({ length: forcedGap(gap) }, (_, i) => `g|${chan}|${Number(n) + i}`);
async function dbClaim(chan, n, gap) { // true = case(s) obtenue(s) ou base indisponible ; false = une case est déjà prise (autre processus)
  if (!db.ready) return true;
  const keys = slotKeys(chan, n, gap);
  const values = keys.map((_, i) => `($${i + 1}, 'g', $${keys.length + 1})`).join(', ');
  let r = null;
  try {
    r = await db.exec(`INSERT INTO sent_dedupe (key, kind, channel) VALUES ${values}
      ON CONFLICT (key) DO UPDATE SET created_at = now() WHERE sent_dedupe.created_at < now() - interval '3 hours'
      RETURNING key`, [...keys, chan]);
  } catch (_) { return true; }
  if (!r) return true; // base muette : la mémoire locale protège
  if (r.rowCount === keys.length) return true;
  const got = (r.rows || []).map((x) => x.key);
  if (got.length) db.exec('DELETE FROM sent_dedupe WHERE key = ANY($1::text[])', [got]).catch(() => {}); // on rend les cases prises
  return false;
}
function dbRelease(chan, n, gap) {
  if (!db.ready) return;
  db.exec('DELETE FROM sent_dedupe WHERE key = ANY($1::text[])', [slotKeys(chan, n, gap)]).catch(() => {});
}

// contrôle + réservation : le contrôle local et l'inscription en mémoire se font d'un seul geste (sans attente entre les deux), puis les cases de
// la base partagée sont réservées (autre instance du site)
async function reserve(channels, target, gap, by) {
  const rv = check(channels, target, gap, by);
  if (!rv.ok) { noteBlocked(by, target, rv); return rv; }
  const t = Number(target); const added = [];
  for (const ch of channels || []) {
    const l = list(ch);
    if (!l.some((e) => e.n === t && e.by === by)) { l.push({ n: t, by, at: Date.now() }); added.push(ch); if (l.length > PER_CHANNEL_MAX) l.splice(0, l.length - PER_CHANNEL_MAX); }
  }
  persist();
  const claimed = [];
  for (const ch of channels || []) {
    if (!(await dbClaim(keyOf(ch), t, gap))) {
      for (const c of claimed) dbRelease(keyOf(c), t, gap);
      for (const c of added) { const l = state.channels[keyOf(c)]; const i = l ? l.findIndex((e) => e.n === t && e.by === by) : -1; if (i >= 0) l.splice(i, 1); }
      persist();
      const rv2 = { ok: false, conflict: { channel: String(ch), n: null, by: 'autre instance' } };
      noteBlocked(by, target, rv2);
      return rv2;
    }
    claimed.push(ch);
  }
  return rv;
}
function release(channels, target, by, gap) {
  const t = Number(target);
  for (const ch of channels || []) { const l = state.channels[keyOf(ch)]; if (!l) continue; const i = l.findIndex((e) => e.n === t && e.by === by); if (i >= 0) l.splice(i, 1); dbRelease(keyOf(ch), t, gap); }
  persist();
}

// plus petit numéro qu'une prédiction de `by` peut viser dans ces canaux : au-delà du dernier numéro prédit + écart
function floor(channels, gap) {
  let m = 0;
  for (const ch of channels || []) for (const e of state.channels[keyOf(ch)] || []) if (e.n > m) m = e.n;
  return m ? m + forcedGap(gap) : 0;
}

// message réellement publié dans un canal (toute stratégie) : si c'est une prédiction, son numéro est mémorisé
function observe(chatId, text) {
  try {
    const post = require('./loss-return').parsePost(text);
    if (!post || !(post.target > 0)) return false;
    const l = list(chatId);
    if (l.some((e) => e.n === post.target)) return false; // déjà mémorisé (réservé par la stratégie avant l'envoi)
    l.push({ n: post.target, by: 'observé', at: Date.now() }); if (l.length > PER_CHANNEL_MAX) l.splice(0, l.length - PER_CHANNEL_MAX);
    persist();
    return true;
  } catch (_) { return false; }
}

// numéros d'un ancien sabot (jeu en direct très en dessous) : retirés
function prune(known) {
  const k = Number(known) || 0; if (!k) return false;
  let changed = false;
  for (const id of Object.keys(state.channels)) {
    const before = state.channels[id].length;
    state.channels[id] = state.channels[id].filter((e) => e.n <= k + STALE_AHEAD);
    if (state.channels[id].length !== before) changed = true;
  }
  if (changed) persist();
  return changed;
}

function reset() { state.channels = {}; blockedKeys.clear(); persist(); if (db.ready) db.exec("DELETE FROM sent_dedupe WHERE kind = 'g'").catch(() => {}); }
setOnShoeReset(() => { try { reset(); } catch (_) { /* ignoré */ } });

function status(channels) {
  const chans = (channels && channels.length ? channels : Object.keys(state.channels)).map((id) => ({ id: String(id), numbers: (state.channels[keyOf(id)] || []).slice(-6).map((e) => e.n) }));
  return { forcedGap: FORCED_GAP, blocked: state.blocked, last: state.last, channels: chans };
}

function applySaved(s) {
  if (!s || typeof s !== 'object') return;
  const ch = s.channels && typeof s.channels === 'object' ? s.channels : {};
  state.channels = {};
  for (const [id, arr] of Object.entries(ch)) if (Array.isArray(arr)) state.channels[id] = arr.filter((e) => e && Number(e.n) > 0).map((e) => ({ n: Number(e.n), by: String(e.by || 'observé'), at: Number(e.at) || 0 })).slice(-PER_CHANNEL_MAX);
  state.blocked = Number(s.blocked) || 0; state.last = s.last && typeof s.last === 'object' ? s.last : null;
}
function restore() { try { const s = (store.read() || {})[STORE_KEY]; if (s) applySaved(s); } catch (_) { /* ignoré */ } }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); } catch (_) { /* ignoré */ }
}

module.exports = { FORCED_GAP, forcedGap, check, noteBlocked, reserve, release, floor, observe, prune, reset, status, restore, restoreFromDb };
