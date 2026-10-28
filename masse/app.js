/* Mass Tracker — suivi de prise de masse (100 % côté navigateur).
 * Données : localStorage (JSON) + IndexedDB (photos).
 * Analyse des plats : API Claude appelée directement depuis le navigateur avec la clé de l'utilisateur. */

'use strict';

// ───────────────────────── Helpers ─────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const round = (n, d = 0) => { const p = 10 ** d; return Math.round((+n || 0) * p) / p; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => round(n).toLocaleString('fr-FR');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const weekStart = s => { const d = parse(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return ymd(d); };
const shortDate = s => parse(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const longDate = s => {
  if (s === today()) return "Aujourd'hui";
  if (s === addDays(today(), -1)) return 'Hier';
  return parse(s).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

// ───────────────────────── Storage ─────────────────────────
const KEY = 'massTracker.v1';
const KEY_API = 'massTracker.apiKey';

const defaults = () => ({
  settings: {
    kcal: 4250, protein: 210, carbs: 615, fat: 105, targetWeight: null, model: 'claude-opus-5-5',
    height: 204, age: 19, sex: 'homme', activity: 1.725, phase: 'seche', surplus: -500, profileV: 0, targetWeight: 100,
  },
  meals: [],
  workouts: [],
  weights: [],
  photos: [],
  supps: [
    { id: uid(), name: 'Whey protéine', dose: '1 dose (30 g)', timing: 'post', kcal: 120, protein: 24, carbs: 3, fat: 1.5 },
    { id: uid(), name: 'Créatine monohydrate', dose: '5 g', timing: 'matin', kcal: 0, protein: 0, carbs: 0, fat: 0 },
    { id: uid(), name: 'Gainer', dose: '1 shaker (100 g)', timing: 'collation', kcal: 380, protein: 20, carbs: 65, fat: 4 },
  ],
  suppLog: {},
});

// Phases : ajustement calorique par défaut, protéines et lipides en g/kg, rythme visé (kg/sem).
// En sèche, protéines hautes (2,3 g/kg) pour garder le muscle malgré le déficit.
const PHASES = {
  seche: { label: 'Sèche', adj: -500, prot: 2.3, fat: 0.8, pace: -0.5, paceText: 'Vise −0,4 à −0,6 kg/sem' },
  recompo: { label: 'Recomposition', adj: 0, prot: 2.2, fat: 0.9, pace: 0, paceText: 'Poids stable' },
  masse: { label: 'Prise de masse', adj: 400, prot: 2, fat: 1, pace: 0.375, paceText: 'Vise +0,25 à 0,5 kg/sem' },
};
const phase = () => PHASES[db.settings.phase] || PHASES.masse;

// Besoins : Mifflin-St Jeor × activité + ajustement de la phase. Le reste des calories en glucides.
function computeGoals(st, kg) {
  const ph = PHASES[st.phase] || PHASES.masse;
  const bmr = 10 * kg + 6.25 * st.height - 5 * st.age + (st.sex === 'femme' ? -161 : 5);
  const tdee = bmr * st.activity;
  const kcal = Math.round((tdee + st.surplus) / 50) * 50;
  const protein = Math.round(kg * ph.prot / 5) * 5, fat = Math.round(kg * ph.fat / 5) * 5;
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, protein, fat, carbs: Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4 / 5) * 5) };
}

// Profil de départ (2,04 m, 104 kg, 19 ans) appliqué une seule fois
// Photos de départ fournies par l'utilisateur (injectées uniquement dans la version Artifact)
const BASELINE_PHOTOS = window.MT_BASELINE || [];

function applyProfileOnce() {
  const st = db.settings;
  if (st.profileV >= 3) return;
  if (!db.weights.length) db.weights.push({ id: uid(), date: today(), kg: 104 });
  // v3 : on commence par une sèche, protéines hautes, objectif 100 kg
  Object.assign(st, { phase: 'seche', surplus: PHASES.seche.adj, targetWeight: 100, phaseStart: today() });
  const g = computeGoals(st, weightAround(today()).kg);
  Object.assign(st, { kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat, profileV: 3 });
  save();
}

const normalize = d => {
  const out = Object.assign(defaults(), d || {});
  out.settings = Object.assign(defaults().settings, out.settings);
  return out;
};

let db;
try { db = normalize(JSON.parse(localStorage.getItem(KEY))); }
catch { db = defaults(); }

// Dans claude.ai (Artifact), les données vont dans le stockage `db` de l'artifact,
// découpées en un document « profile » + un document par mois (limite de 256 Ko par document).
const cloud = { col: null, written: new Map(), chains: new Map(), timer: null };

function cloudDocs() {
  const docs = { profile: { settings: db.settings, supps: db.supps } };
  const month = name => docs['m-' + name] || (docs['m-' + name] = { meals: [], workouts: [], weights: [], photos: [], suppLog: {} });
  for (const k of ['meals', 'workouts', 'weights', 'photos']) db[k].forEach(x => month(x.date.slice(0, 7))[k].push(x));
  for (const [d, ids] of Object.entries(db.suppLog)) if (ids.length) month(d.slice(0, 7)).suppLog[d] = ids;
  // Un mois vidé doit aussi être réécrit (vide)
  for (const name of cloud.written.keys()) if (!docs[name]) docs[name] = { meals: [], workouts: [], weights: [], photos: [], suppLog: {} };
  return docs;
}

function cloudFlush() {
  for (const [name, body] of Object.entries(cloudDocs())) {
    const json = JSON.stringify(body);
    if (cloud.written.get(name) === json) continue;
    cloud.written.set(name, json);
    // Une écriture à la fois par document
    const prev = cloud.chains.get(name) || Promise.resolve();
    cloud.chains.set(name, prev.then(() => cloud.col.doc(name).set(body)).catch(e => {
      cloud.written.delete(name);
      toast(e && e.code === 'quota_exceeded' ? '⚠️ Stockage plein — exporte puis supprime d\'anciennes données' : '⚠️ Sauvegarde impossible, réessaie');
    }));
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { if (!cloud.col) toast('⚠️ Stockage plein — exporte tes données'); }
  if (cloud.col) { clearTimeout(cloud.timer); cloud.timer = setTimeout(cloudFlush, 300); }
}

async function initCloud() {
  if (!window.claude || !window.claude.use) return;
  try {
    const [cdb, user, assets, sample] = await Promise.all(['db', 'user', 'assets', 'sample'].map(n => claude.use(n).catch(() => null)));
    assetsNs = assets;
    if (sample) {
      const lim = await sample.limits().catch(() => null);
      if (lim && lim.images) sampleNs = sample;
    }
    if (cdb && user) {
      const id = await user.id();
      if (id) {
        const col = cdb.collection('data/users/' + id);
        const snap = await col.get();
        if (!snap.empty) {
          const merged = defaults();
          merged.meals = []; merged.workouts = []; merged.weights = []; merged.photos = []; merged.suppLog = {};
          for (const doc of snap.docs) {
            const body = doc.data() || {};
            cloud.written.set(doc.id, JSON.stringify(body));
            if (doc.id === 'profile') { merged.settings = body.settings; merged.supps = body.supps || []; continue; }
            for (const k of ['meals', 'workouts', 'weights', 'photos']) merged[k].push(...(body[k] || []));
            Object.assign(merged.suppLog, body.suppLog || {});
          }
          db = normalize(merged);
          cloud.col = col;
          applyProfileOnce();
        } else {
          cloud.col = col;
          applyProfileOnce();
          cloudFlush(); // premier lancement : envoie les données locales (ou par défaut)
        }
      }
    }
  } catch { /* reste en mode local */ }
  render();
}
const getApiKey = () => { try { return localStorage.getItem(KEY_API) || ''; } catch { return ''; } };
const setApiKey = k => { try { k ? localStorage.setItem(KEY_API, k) : localStorage.removeItem(KEY_API); } catch {} };

// IndexedDB pour les images (trop lourdes pour localStorage)
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('massTracker', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('images', mode);
      const req = fn(t.objectStore('images'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
  };
})();

// Images : `assets` de l'artifact quand disponible (réf. « a:<id> »), sinon IndexedDB.
let assetsNs = null;
let sampleNs = null;

function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.match(/:(.*?);/)[1] });
}

async function putImage(dataUrl, prefix) {
  if (assetsNs) {
    try {
      const r = await assetsNs.upload(dataUrlToBlob(dataUrl), { type: 'image/jpeg' });
      return 'a:' + r.id;
    } catch { /* repli sur IndexedDB */ }
  }
  const id = prefix + '-' + uid();
  await idb.set(id, dataUrl);
  imgCache.set(id, dataUrl);
  return id;
}

function delImage(ref) {
  if (!ref) return;
  imgCache.delete(ref);
  if (ref.startsWith('a:')) { if (assetsNs) assetsNs.delete(ref.slice(2)).catch(() => {}); }
  else idb.del(ref).catch(() => {});
}

const imgCache = new Map();
async function loadImg(id) {
  if (!id) return null;
  if (id.startsWith('a:')) return '/_blob/' + id.slice(2);
  if (imgCache.has(id)) return imgCache.get(id);
  try { const v = await idb.get(id); imgCache.set(id, v); return v; } catch { return null; }
}

// Remplace confirm(), bloqué dans claude.ai
function askConfirm(msg, okLabel = 'Supprimer') {
  return new Promise(resolve => {
    const box = $('#confirm');
    $('#confirmMsg').textContent = msg;
    $('#confirmOk').textContent = okLabel;
    box.classList.add('open');
    const done = v => { box.classList.remove('open'); $('#confirmOk').onclick = $('#confirmCancel').onclick = null; resolve(v); };
    $('#confirmOk').onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
  });
}
function hydrateImages(root) {
  $$('img[data-img]', root).forEach(async img => {
    const src = await loadImg(img.dataset.img);
    if (src) img.src = src;
  });
}

// Redimensionne une image -> dataURL JPEG
function resizeImage(file, max, quality = 0.82) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Image illisible')); };
    img.src = url;
  });
}

// ───────────────────────── State / navigation ─────────────────────────
let currentDay = today();
let currentView = 'dashboard';

function show(view) {
  currentView = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo({ top: 0 });
  render();
}
$$('.nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

document.addEventListener('click', e => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  const next = addDays(currentDay, +b.dataset.day);
  if (next > today()) return toast('Pas encore de données pour demain 😉');
  currentDay = next;
  render();
});

// ───────────────────────── Calculs ─────────────────────────
const sumMacros = list => list.reduce((a, x) => ({
  kcal: a.kcal + (+x.kcal || 0), protein: a.protein + (+x.protein || 0),
  carbs: a.carbs + (+x.carbs || 0), fat: a.fat + (+x.fat || 0),
}), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

const mealsOn = d => db.meals.filter(m => m.date === d);
const suppsTakenOn = d => (db.suppLog[d] || []).map(id => db.supps.find(s => s.id === id)).filter(Boolean);
function dayTotals(d) {
  const meals = sumMacros(mealsOn(d));
  const supps = sumMacros(suppsTakenOn(d));
  return { meals, supps, total: sumMacros([meals, supps]) };
}

const sortedWeights = () => [...db.weights].sort((a, b) => a.date.localeCompare(b.date));
function weightAround(date) {
  const w = sortedWeights().filter(x => x.date <= date);
  return w.length ? w[w.length - 1] : null;
}

function workoutVolume(w) {
  return w.exercises.reduce((a, ex) => a + ex.sets.reduce((s, st) => s + (+st.reps || 0) * (+st.kg || 0), 0), 0);
}

function weeklyWeights() {
  const map = new Map();
  for (const w of sortedWeights()) {
    const k = weekStart(w.date);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(+w.kg);
  }
  return [...map.entries()].map(([week, arr]) => ({ week, avg: arr.reduce((a, b) => a + b, 0) / arr.length, n: arr.length }));
}

// ───────────────────────── Charts ─────────────────────────
const charts = {};
const C = { blue: '#2f7bff', blue2: '#5aa2ff', cyan: '#38d6ff', violet: '#8b6cff', grid: 'rgba(138,151,184,.12)', muted: '#8a97b8', text: '#eef3ff' };

if (window.Chart) {
  Chart.defaults.color = C.muted;
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = '#141d36';
  Chart.defaults.plugins.tooltip.borderColor = '#1f2a48';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.titleColor = C.text;
  Chart.defaults.plugins.tooltip.bodyColor = C.text;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation.duration = 500;
}

function chart(id, config) {
  if (!window.Chart) return;
  const el = document.getElementById(id);
  if (!el || !el.offsetParent) return; // vue non visible
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(el, config);
}

function gradient(ctx, color) {
  const { chartArea, ctx: c } = ctx.chart;
  if (!chartArea) return color + '33';
  const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, color + '66');
  g.addColorStop(1, color + '00');
  return g;
}

// ───────────────────────── Render : Dashboard ─────────────────────────
function renderDashboard() {
  const s = db.settings;
  const { meals, supps, total } = dayTotals(currentDay);
  $('#dashDate').textContent = longDate(currentDay);
  $('#kcalEaten').textContent = fmt(total.kcal);
  $('#kcalGoalLbl').textContent = `/ ${fmt(s.kcal)} kcal`;
  $('#kcalMeals').textContent = fmt(meals.kcal);
  $('#kcalSupps').textContent = fmt(supps.kcal);
  const left = s.kcal - total.kcal;
  $('#kcalLeft').textContent = left >= 0 ? fmt(left) : '+' + fmt(-left);
  const pct = Math.min(1, total.kcal / (s.kcal || 1));
  $('#ringBar').style.strokeDashoffset = 326.7 * (1 - pct);
  const status = $('#kcalStatus');
  const protLeft = Math.round(s.protein - total.protein);
  if (s.phase === 'seche') {
    status.textContent = pct > 1.05 ? '⚠️ Au-dessus de ta limite' : protLeft > 0 ? `🥩 Encore ${protLeft} g de protéines` : '✅ Protéines OK';
  } else {
    status.textContent = pct >= 1 ? '🔥 Objectif atteint !' : pct >= .75 ? '💪 Presque !' : pct > 0 ? '🍗 Continue à manger' : "C'est parti !";
  }

  const macros = [
    ['Protéines', total.protein, s.protein, 'var(--prot)'],
    ['Glucides', total.carbs, s.carbs, 'var(--carb)'],
    ['Lipides', total.fat, s.fat, 'var(--fat)'],
  ];
  $('#macroBars').innerHTML = macros.map(([n, v, g, col]) => `
    <div class="macro">
      <div class="macro-top"><div><span class="dot" style="background:${col}"></span>${n}</div><div><b>${round(v)}</b><span> / ${g} g</span></div></div>
      <div class="bar-bg"><div class="bar-fill" style="width:${Math.min(100, v / (g || 1) * 100)}%;background:${col}"></div></div>
    </div>`).join('');

  // Poids
  const w = weightAround(currentDay);
  if (w) {
    $('#dashWeight').innerHTML = `${round(w.kg, 1)}<small>kg</small>`;
    const prev = weightAround(addDays(w.date, -7));
    const d = $('#dashWeightDelta');
    if (prev && prev.id !== w.id) {
      const diff = round(w.kg - prev.kg, 1);
      d.textContent = `${diff > 0 ? '+' : ''}${diff} kg / 7 j`;
      d.className = 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
    } else { d.textContent = shortDate(w.date); d.className = 'delta flat'; }
  } else {
    $('#dashWeight').textContent = '—';
    $('#dashWeightDelta').textContent = 'Ajoute une pesée';
  }

  renderGoal();
  renderQuick();

  // Séances de la semaine
  const ws = weekStart(currentDay);
  const wk = db.workouts.filter(x => x.date >= ws && x.date <= addDays(ws, 6));
  $('#dashWorkouts').textContent = wk.length;
  $('#dashVolume').textContent = fmt(wk.reduce((a, x) => a + workoutVolume(x), 0)) + ' kg soulevés';

  // Graph calories 7 jours
  const days = [...Array(7)].map((_, i) => addDays(currentDay, i - 6));
  const vals = days.map(d => round(dayTotals(d).total.kcal));
  chart('chartCals', {
    type: 'bar',
    data: {
      labels: days.map(d => parse(d).toLocaleDateString('fr-FR', { weekday: 'short' })),
      datasets: [
        { type: 'line', data: days.map(() => s.kcal), borderColor: C.muted, borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, label: 'Objectif' },
        { data: vals, backgroundColor: vals.map(v => v >= s.kcal ? C.blue : C.blue + '66'), borderRadius: 8, maxBarThickness: 32, label: 'kcal' },
      ],
    },
    options: { scales: { y: { beginAtZero: true, grid: { color: C.grid } }, x: { grid: { display: false } } } },
  });

  // Mini graph poids (30 derniers jours)
  const ws30 = sortedWeights().filter(x => x.date >= addDays(currentDay, -60) && x.date <= currentDay);
  chart('chartWeightMini', weightChartConfig(ws30, false));
}

// Séance du programme prévue aujourd'hui, sinon la prochaine
const PROGRAM_DAYS = { Lundi: 1, Mardi: 2, Mercredi: 3, Jeudi: 4, Vendredi: 5, Samedi: 6, Dimanche: 0 };
function todaysProgram() {
  const wd = new Date().getDay();
  const ws = weekStart(today());
  const notDone = p => !db.workouts.some(w => w.name === p.name && w.date >= ws);
  const byDist = [...PROGRAM].sort((a, b) => ((PROGRAM_DAYS[a.day] - wd + 7) % 7) - ((PROGRAM_DAYS[b.day] - wd + 7) % 7));
  return byDist.find(notDone) || byDist[0];
}

function renderDashPhotos() {
  const photos = allPhotos().sort((a, b) => b.date.localeCompare(a.date));
  const lastWeek = photos.length ? weekStart(photos[0].date) : null;
  const recent = photos.filter(p => weekStart(p.date) === lastWeek).slice(0, 4);
  $('#dashPhotosDate').textContent = lastWeek ? 'Semaine du ' + shortDate(lastWeek) : '';
  $('#dashPhotos').innerHTML = recent.length
    ? recent.map(p => `<div class="ph" data-goto-body><img data-img="${p.img || p.id}" alt="Photo ${esc(p.label || '')}"><span class="tag">${esc(p.label || shortDate(p.date))}</span></div>`).join('')
    : '<div class="empty" style="grid-column:1/-1">Ajoute ta première photo avec « + Photo ».</div>';
  hydrateImages($('#dashPhotos'));
}

function renderQuick() {
  renderDashPhotos();
  const w = weightAround(today());
  $('#quickWeightSub').textContent = w ? `${round(w.kg, 1)} kg` : 'Ajouter';
  $('#quickWorkoutSub').textContent = todaysProgram().name.split(' — ')[0];

  const taken = new Set(db.suppLog[currentDay] || []);
  $('#dashSuppsCard').classList.toggle('hidden', !db.supps.length);
  $('#dashSuppsCount').textContent = `${db.supps.filter(s => taken.has(s.id)).length}/${db.supps.length}`;
  $('#dashSupps').innerHTML = db.supps.map(s => `<button class="chip ${taken.has(s.id) ? 'active' : ''}" data-dash-supp="${s.id}">${esc(s.name)}</button>`).join('');
}

$('#dashSupps').addEventListener('click', e => {
  const b = e.target.closest('[data-dash-supp]');
  if (!b) return;
  const log = new Set(db.suppLog[currentDay] || []);
  log.has(b.dataset.dashSupp) ? log.delete(b.dataset.dashSupp) : log.add(b.dataset.dashSupp);
  db.suppLog[currentDay] = [...log];
  save(); render();
});

$('#dashPhotos').addEventListener('click', e => { if (e.target.closest('[data-goto-body]')) show('body'); });

$('#quickWorkout').addEventListener('click', () => openWorkout(null, todaysProgram()));

$('#quickWeight').addEventListener('click', () => {
  const last = weightAround(today());
  openModal('Pesée du jour', `
    <label class="field"><span>Poids (kg)</span><input type="number" step="0.1" inputmode="decimal" id="qwKg" value="${last ? round(last.kg, 1) : ''}"></label>
    <button class="btn primary block" id="qwSave">Enregistrer</button>`);
  const input = $('#qwKg');
  input.focus(); input.select();
  $('#qwSave').onclick = () => {
    const kg = parseFloat(String(input.value).replace(',', '.'));
    if (!(kg > 20 && kg < 400)) return toast('Entre un poids valide');
    db.weights = db.weights.filter(w => w.date !== today());
    db.weights.push({ id: uid(), date: today(), kg });
    save(); closeModal(); render();
    toast(`⚖️ ${kg} kg enregistré`);
  };
});

function renderGoal() {
  const target = +db.settings.targetWeight;
  const ws = sortedWeights();
  $('#goalCard').classList.toggle('hidden', !target || !ws.length);
  if (!target || !ws.length) return;
  // Départ = première pesée de la phase en cours
  const since = db.settings.phaseStart || ws[0].date;
  const startW = ws.find(w => w.date >= since) || ws[ws.length - 1];
  const start = +startW.kg, now = +ws[ws.length - 1].kg;
  const dir = target >= start ? 1 : -1;
  const pct = target === start ? 100 : Math.max(0, Math.min(100, (now - start) / (target - start) * 100));
  const left = round((target - now) * dir, 1);
  $('#goalPhase').textContent = phase().label;
  $('#goalTarget').textContent = round(target, 1);
  $('#goalBar').style.width = pct + '%';
  $('#goalStart').textContent = `Départ ${round(start, 1)} kg`;
  $('#goalLeft').textContent = left > 0 ? `encore ${left} kg ${dir < 0 ? 'à perdre' : 'à prendre'}` : 'Objectif atteint 🎉';
  // Rythme réel sur ~4 semaines, sinon rythme visé de 0,375 kg/sem
  const ref = weightAround(addDays(today(), -28));
  const weeks = ref ? (parse(ws[ws.length - 1].date) - parse(ref.date)) / 6048e5 : 0;
  const pace = ref && weeks >= 1 ? (now - ref.kg) / weeks : null;
  $('#goalPace').textContent = pace == null ? phase().paceText : `${pace >= 0 ? '+' : ''}${round(pace, 2)} kg/sem`;
  // Rythme dans le bon sens, sinon le rythme visé de la phase
  const p = pace && pace * dir > 0.05 ? Math.abs(pace) : Math.abs(phase().pace) || 0.375;
  $('#goalEta').textContent = left > 0 ? `≈ ${parse(addDays(today(), Math.round(left / p * 7))).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : '';
}

function weightChartConfig(list, withWeekly) {
  const target = db.settings.targetWeight;
  const datasets = [{
    label: 'Poids',
    data: list.map(w => ({ x: w.date, y: +w.kg })),
    borderColor: C.blue2,
    backgroundColor: ctx => gradient(ctx, C.blue),
    fill: true, tension: .35, borderWidth: 2.5,
    pointRadius: list.length > 40 ? 0 : 3, pointBackgroundColor: C.blue2,
  }];
  if (withWeekly) {
    const weekly = weeklyWeights().filter(w => list.length && w.week >= weekStart(list[0].date));
    datasets.push({
      label: 'Moyenne hebdo',
      data: weekly.map(w => ({ x: addDays(w.week, 3), y: round(w.avg, 2) })),
      borderColor: C.cyan, borderWidth: 2, pointRadius: 4, pointBackgroundColor: C.cyan, tension: .3, fill: false,
    });
  }
  if (target && list.length) {
    datasets.push({
      label: 'Objectif', data: [{ x: list[0].date, y: +target }, { x: list[list.length - 1].date, y: +target }],
      borderColor: C.violet, borderDash: [6, 6], borderWidth: 1.5, pointRadius: 0, fill: false,
    });
  }
  const labels = [...new Set(datasets.flatMap(d => d.data.map(p => p.x)))].sort();
  return {
    type: 'line',
    data: { labels, datasets: datasets.map(d => ({ ...d, data: labels.map(l => (d.data.find(p => p.x === l) || {}).y ?? null), spanGaps: true })) },
    options: {
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, callback(v) { return shortDate(this.getLabelForValue(v)); } } },
        y: { grid: { color: C.grid }, ticks: { callback: v => v + ' kg' } },
      },
      plugins: { tooltip: { callbacks: { title: i => shortDate(i[0].label), label: i => `${i.dataset.label} : ${i.parsed.y} kg` } } },
    },
  };
}

// ───────────────────────── Render : Repas ─────────────────────────
const MEAL_TYPES = { breakfast: ['🥣', 'Petit-déj'], lunch: ['🍛', 'Déjeuner'], snack: ['🍌', 'Collation'], dinner: ['🍝', 'Dîner'] };
function guessMealType() {
  const h = new Date().getHours();
  return h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h < 18 ? 'snack' : 'dinner';
}

function renderMeals() {
  $$('.dayLabel').forEach(el => el.textContent = longDate(currentDay));
  const list = mealsOn(currentDay).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const tot = sumMacros(list);
  $('#mealsTotal').textContent = fmt(tot.kcal) + ' kcal';
  $('#mealList').innerHTML = list.length ? list.map(m => `
    <div class="item">
      ${m.photoId ? `<img class="thumb" data-img="${m.photoId}" alt="">` : `<div class="thumb">${(MEAL_TYPES[m.type] || ['🍽️'])[0]}</div>`}
      <div class="meta">
        <b>${esc(m.name)}</b>
        <small>${(MEAL_TYPES[m.type] || ['', 'Repas'])[1]}${m.time ? ' · ' + m.time : ''}</small>
        <div class="macro-chips"><span class="mchip p">P ${round(m.protein)}g</span><span class="mchip c">G ${round(m.carbs)}g</span><span class="mchip f">L ${round(m.fat)}g</span></div>
      </div>
      <div class="kcal">${fmt(m.kcal)}<small>kcal</small></div>
      <button class="del" data-del-meal="${m.id}" aria-label="Supprimer">✕</button>
    </div>`).join('') : '<div class="empty">Aucun repas ce jour. Prends ton plat en photo ! 📸</div>';
  hydrateImages($('#mealList'));
}

$('#mealList').addEventListener('click', async e => {
  const b = e.target.closest('[data-del-meal]');
  if (!b || !(await askConfirm('Supprimer ce repas ?'))) return;
  const m = db.meals.find(x => x.id === b.dataset.delMeal);
  db.meals = db.meals.filter(x => x !== m);
  if (m) delImage(m.photoId);
  save(); render(); toast('Repas supprimé');
});

// Photo -> analyse IA
let pendingPhoto = null; // { full: dataURL (pour l'IA), thumb: dataURL (stockée) }
let analysis = null;

$('#mealPhoto').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const [full, thumb] = await Promise.all([resizeImage(file, 1024, 0.85), resizeImage(file, 220, 0.75)]);
    pendingPhoto = { full, thumb };
    analysis = null;
    $('#mealPreview').src = full;
    $('#uploadZone').classList.add('hidden');
    $('#analysisBox').classList.remove('hidden');
    $('#analysisResult').classList.add('hidden');
    $('#analyzeBtn').classList.remove('hidden');
    $('#analyzeBtn').textContent = '✨ Analyser le plat';
    $('#mealHint').value = '';
    if (currentView !== 'meals') show('meals');
    if (canAnalyze()) $('#analyzeBtn').click(); // analyse directe, sans étape en plus
  } catch (err) { toast('❌ ' + err.message); }
});

const FOOD_SCHEMA = {
  type: 'object',
  properties: {
    dish: { type: 'string', description: 'Nom court du plat, en français' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'string', description: 'Portion estimée, ex: "150 g" ou "1 œuf"' },
          kcal: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
        },
        required: ['name', 'quantity', 'kcal', 'protein', 'carbs', 'fat'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['faible', 'moyenne', 'élevée'] },
    note: { type: 'string', description: "Une phrase courte : hypothèses faites ou conseil pour l'objectif de l'utilisateur" },
  },
  required: ['dish', 'items', 'confidence', 'note'],
  additionalProperties: false,
};

const foodPrompt = hint => `Tu es un nutritionniste expert. Analyse la photo de ce repas et estime, pour chaque aliment visible, la portion et ses valeurs nutritionnelles (kcal, protéines, glucides, lipides en grammes).
Base-toi sur la taille de l'assiette, des couverts et des aliments pour estimer les quantités. Compte les huiles, sauces et matières grasses de cuisson probables.
Réponds en français.${hint ? `\nPrécisions de l'utilisateur : « ${hint} »` : ''}
S'il n'y a pas de nourriture sur la photo, renvoie une liste "items" vide et explique-le dans "note".`;

const SAMPLE_ERRORS = {
  not_granted: "Autorise l'artifact à utiliser Claude pour analyser tes photos",
  sampling_disabled: "Claude n'est pas disponible sur ce compte",
  rate_limited: 'Trop de demandes, réessaie dans un moment',
  image_rejected: 'Photo refusée : essaie un autre format (JPEG, PNG)',
  refused: "Claude n'a pas pu analyser cette photo",
  invalid_json: 'Réponse illisible, réessaie',
  session_expired: 'Reconnecte-toi à Claude puis réessaie',
};

function cleanAnalysis(a) {
  if (!a || !Array.isArray(a.items)) throw new Error('Réponse illisible, réessaie');
  return {
    dish: String(a.dish || 'Repas'),
    confidence: String(a.confidence || 'moyenne'),
    note: String(a.note || ''),
    items: a.items.map(i => ({
      name: String(i.name || 'Aliment'), quantity: String(i.quantity || ''),
      kcal: +i.kcal || 0, protein: +i.protein || 0, carbs: +i.carbs || 0, fat: +i.fat || 0,
    })),
  };
}

const canAnalyze = () => !!sampleNs || !!getApiKey();

async function analyzeFood(dataUrl, hint) {
  // Dans claude.ai : passe par le compte Claude de l'utilisateur, sans clé API
  if (sampleNs) {
    const prompt = foodPrompt(hint) + `

Réponds uniquement avec un objet JSON de cette forme :
{"dish": "nom court du plat", "items": [{"name": "aliment", "quantity": "150 g", "kcal": 0, "protein": 0, "carbs": 0, "fat": 0}], "confidence": "faible" | "moyenne" | "élevée", "note": "une phrase : hypothèses faites ou conseil pour une ${phase().label.toLowerCase()}"}`;
    try {
      return cleanAnalysis(await sampleNs.json(prompt, { images: [dataUrlToBlob(dataUrl)] }));
    } catch (e) {
      throw new Error((e && SAMPLE_ERRORS[e.code]) || (e && e.message) || 'Analyse impossible, réessaie');
    }
  }
  const key = getApiKey();
  if (!key) throw new Error('NO_KEY');
  const base64 = dataUrl.split(',')[1];
  const prompt = foodPrompt(hint);


  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: db.settings.model || 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: FOOD_SCHEMA } },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Erreur ${res.status}`;
    if (res.status === 401) throw new Error('Clé API invalide — vérifie-la dans les réglages ⚙️');
    if (res.status === 429) throw new Error('Trop de requêtes, réessaie dans un instant');
    throw new Error(msg);
  }
  if (data.stop_reason === 'refusal') throw new Error("L'IA n'a pas pu analyser cette photo");
  if (data.stop_reason === 'max_tokens') throw new Error('Réponse tronquée, réessaie');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try { return cleanAnalysis(JSON.parse(text)); }
  catch { throw new Error('Réponse illisible, réessaie'); }
}

$('#analyzeBtn').addEventListener('click', async () => {
  if (!pendingPhoto) return;
  if (!canAnalyze()) {
    toast('Ajoute ta clé API Claude dans les réglages ⚙️');
    return openSettings();
  }
  $('#mealLoader').classList.remove('hidden');
  $('#analyzeBtn').disabled = true;
  try {
    analysis = await analyzeFood(pendingPhoto.full, $('#mealHint').value.trim());
    renderAnalysis();
    $('#analyzeBtn').textContent = '↻ Réanalyser avec ma précision';
  } catch (err) {
    toast('❌ ' + err.message);
  } finally {
    $('#mealLoader').classList.add('hidden');
    $('#analyzeBtn').disabled = false;
  }
});

function renderAnalysis() {
  const box = $('#analysisResult');
  const t = sumMacros(analysis.items);
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="section-head" style="margin-bottom:6px">
      <h3 style="margin:0">${esc(analysis.dish)}</h3>
      <span class="pill">Confiance ${esc(analysis.confidence)}</span>
    </div>
    ${analysis.items.map(i => `
      <div class="food-row">
        <div><b>${esc(i.name)}</b><br><small>${esc(i.quantity)}</small>
          <div class="macro-chips"><span class="mchip p">P ${round(i.protein)}g</span><span class="mchip c">G ${round(i.carbs)}g</span><span class="mchip f">L ${round(i.fat)}g</span></div>
        </div>
        <div class="kcal"><b>${fmt(i.kcal)}</b> <small style="color:var(--muted)">kcal</small></div>
      </div>`).join('') || '<div class="empty">Aucun aliment détecté.</div>'}
    <p class="note">💡 ${esc(analysis.note)}</p>
    <p class="note" style="margin-top:12px">Total (modifiable) :</p>
    <div class="totals">
      <div><input type="number" inputmode="decimal" id="aKcal" value="${round(t.kcal)}"><span>kcal</span></div>
      <div><input type="number" inputmode="decimal" id="aP" value="${round(t.protein)}"><span>Prot. g</span></div>
      <div><input type="number" inputmode="decimal" id="aC" value="${round(t.carbs)}"><span>Gluc. g</span></div>
      <div><input type="number" inputmode="decimal" id="aF" value="${round(t.fat)}"><span>Lip. g</span></div>
    </div>
    <label class="field"><span>Repas</span>${mealTypeSelect('aType')}</label>
    <div class="btn-row">
      <button class="btn" id="cancelMeal">Annuler</button>
      <button class="btn primary" id="saveMeal">✓ Ajouter</button>
    </div>`;
  $('#cancelMeal').onclick = resetMealUpload;
  $('#saveMeal').onclick = async () => {
    $('#saveMeal').disabled = true;
    let photoId = null;
    try { photoId = await putImage(pendingPhoto.thumb, 'meal'); } catch {}
    addMeal({
      name: analysis.dish, type: $('#aType').value, items: analysis.items, photoId,
      kcal: +$('#aKcal').value, protein: +$('#aP').value, carbs: +$('#aC').value, fat: +$('#aF').value,
    });
    resetMealUpload();
  };
}

function mealTypeSelect(id, val = guessMealType()) {
  return `<select id="${id}">${Object.entries(MEAL_TYPES).map(([k, [ic, n]]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${ic} ${n}</option>`).join('')}</select>`;
}

function resetMealUpload() {
  pendingPhoto = null; analysis = null;
  $('#analysisBox').classList.add('hidden');
  $('#uploadZone').classList.remove('hidden');
}

function addMeal(m) {
  const now = new Date();
  db.meals.push({
    id: uid(), date: currentDay, time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    ...m,
  });
  save(); render();
  toast(`✅ ${fmt(m.kcal)} kcal ajoutées`);
}

$('#manualMealBtn').addEventListener('click', () => {
  openModal('Ajouter un repas', `
    <label class="field"><span>Nom</span><input id="mName" placeholder="Poulet riz brocolis"></label>
    <label class="field"><span>Repas</span>${mealTypeSelect('mType')}</label>
    <div class="inline">
      <label class="field"><span>Calories</span><input type="number" inputmode="decimal" id="mKcal" placeholder="650"></label>
      <label class="field"><span>Protéines (g)</span><input type="number" inputmode="decimal" id="mP" placeholder="45"></label>
    </div>
    <div class="inline">
      <label class="field"><span>Glucides (g)</span><input type="number" inputmode="decimal" id="mC" placeholder="80"></label>
      <label class="field"><span>Lipides (g)</span><input type="number" inputmode="decimal" id="mF" placeholder="15"></label>
    </div>
    <p class="note" style="margin:-4px 0 12px">Astuce : laisse les calories vides, elles seront calculées depuis les macros.</p>
    <button class="btn primary block" id="mSave">Ajouter</button>`);
  $('#mSave').onclick = () => {
    const p = +$('#mP').value || 0, c = +$('#mC').value || 0, f = +$('#mF').value || 0;
    const kcal = +$('#mKcal').value || round(p * 4 + c * 4 + f * 9);
    if (!kcal) return toast('Indique au moins les calories ou les macros');
    addMeal({ name: $('#mName').value.trim() || 'Repas', type: $('#mType').value, kcal, protein: p, carbs: c, fat: f, items: [] });
    closeModal();
  };
});

// ───────────────────────── Render : Muscu ─────────────────────────
const COMMON_EXERCISES = [
  'Développé couché', 'Développé incliné haltères', 'Développé militaire', 'Squat', 'Soulevé de terre',
  'Soulevé de terre roumain', 'Tractions', 'Rowing barre', 'Rowing haltère', 'Tirage vertical', 'Dips',
  'Curl biceps', 'Curl marteau', 'Extension triceps poulie', 'Barre au front', 'Élévations latérales',
  'Presse à cuisses', 'Fentes', 'Leg curl', 'Leg extension', 'Hip thrust', 'Mollets debout', 'Écarté poulie', 'Shrugs', 'Tirage poitrine',
];
const exerciseNames = () => [...new Set([...db.workouts.flatMap(w => w.exercises.map(e => e.name)), ...COMMON_EXERCISES])];

function renderWorkouts() {
  const ws = [...db.workouts].sort((a, b) => b.date.localeCompare(a.date));
  $('#wTotal').textContent = ws.length;
  const month = today().slice(0, 7);
  $('#wMonth').textContent = ws.filter(w => w.date.startsWith(month)).length;

  // Série de semaines consécutives avec au moins 1 séance
  const weeks = new Set(ws.map(w => weekStart(w.date)));
  let streak = 0, wk = weekStart(today());
  if (!weeks.has(wk)) wk = addDays(wk, -7);
  while (weeks.has(wk)) { streak++; wk = addDays(wk, -7); }
  $('#wStreak').innerHTML = `${streak}<small>sem</small>`;

  renderProgram();
  $('#workoutList').innerHTML = ws.length ? ws.slice(0, 20).map(w => `
    <div class="item" data-edit-workout="${w.id}" style="cursor:pointer;align-items:flex-start">
      <div class="thumb">🏋️</div>
      <div class="meta">
        <b>${esc(w.name || 'Séance')}</b>
        <small>${longDate(w.date)} · ${w.exercises.length} exo${w.exercises.length > 1 ? 's' : ''} · ${w.exercises.reduce((a, e) => a + e.sets.length, 0)} séries</small>
        ${w.exercises.map(e => `<div class="session-ex"><b>${esc(e.name)}</b> — ${e.sets.map(s => `${s.reps}×${s.kg || 0}kg`).join(', ')}</div>`).join('')}
      </div>
      <div class="kcal">${fmt(workoutVolume(w))}<small>kg vol.</small></div>
    </div>`).join('') : '<div class="empty">Aucune séance. Lance-toi avec « + Séance » 💪</div>';

  // Volume par semaine (12 dernières semaines)
  const cur = weekStart(today());
  const wkeys = [...Array(12)].map((_, i) => addDays(cur, (i - 11) * 7));
  const vol = wkeys.map(k => round(db.workouts.filter(w => weekStart(w.date) === k).reduce((a, w) => a + workoutVolume(w), 0)));
  chart('chartVolume', {
    type: 'bar',
    data: { labels: wkeys.map(shortDate), datasets: [{ data: vol, backgroundColor: ctx => gradient(ctx, C.blue), borderColor: C.blue, borderWidth: 1.5, borderRadius: 8, maxBarThickness: 26, label: 'Volume' }] },
    options: { scales: { y: { beginAtZero: true, ticks: { callback: v => v >= 1000 ? v / 1000 + 't' : v } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } } } },
  });

  // Progression par exercice
  const sel = $('#exerciseSelect');
  const done = [...new Set(db.workouts.flatMap(w => w.exercises.map(e => e.name)))].sort();
  const prev = sel.value;
  sel.innerHTML = done.length ? done.map(n => `<option>${esc(n)}</option>`).join('') : '<option>—</option>';
  if (done.includes(prev)) sel.value = prev;
  renderExerciseChart();
}

function renderExerciseChart() {
  const name = $('#exerciseSelect').value;
  const pts = [...db.workouts].sort((a, b) => a.date.localeCompare(b.date)).map(w => {
    const ex = w.exercises.find(e => e.name === name);
    if (!ex || !ex.sets.length) return null;
    const max = Math.max(...ex.sets.map(s => +s.kg || 0));
    const orm = Math.max(...ex.sets.map(s => (+s.kg || 0) * (1 + (+s.reps || 0) / 30)));
    return { date: w.date, max, orm: round(orm, 1) };
  }).filter(Boolean);
  chart('chartExercise', {
    type: 'line',
    data: {
      labels: pts.map(p => shortDate(p.date)),
      datasets: [
        { label: 'Charge max', data: pts.map(p => p.max), borderColor: C.blue2, backgroundColor: ctx => gradient(ctx, C.blue), fill: true, tension: .3, borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: C.blue2 },
        { label: '1RM estimé', data: pts.map(p => p.orm), borderColor: C.cyan, borderDash: [5, 4], tension: .3, borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.cyan },
      ],
    },
    options: {
      plugins: { legend: { display: true, labels: { boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: i => `${i.dataset.label} : ${i.parsed.y} kg` } } },
      scales: { y: { ticks: { callback: v => v + ' kg' } }, x: { grid: { display: false } } },
    },
  });
}
$('#exerciseSelect').addEventListener('change', renderExerciseChart);

$('#newWorkoutBtn').addEventListener('click', () => openWorkout());
$('#programList').addEventListener('click', e => {
  const b = e.target.closest('[data-start-prog]');
  if (b) openWorkout(null, PROGRAM[+b.dataset.startProg]);
});
$('#workoutList').addEventListener('click', e => {
  const it = e.target.closest('[data-edit-workout]');
  if (it) openWorkout(db.workouts.find(w => w.id === it.dataset.editWorkout));
});

// Programme adapté : largeur d'épaules, dos, haut des pecs, + jambes pour la masse globale.
// [exercice, séries, reps]
const PROGRAM = [
  { day: 'Lundi', name: 'Push — Épaules & pecs', ex: [['Développé militaire', 4, 8], ['Développé incliné haltères', 4, 10], ['Élévations latérales', 4, 15], ['Dips', 3, 10], ['Extension triceps poulie', 3, 12]] },
  { day: 'Mardi', name: 'Pull — Dos & largeur', ex: [['Tractions', 4, 8], ['Rowing barre', 4, 8], ['Tirage vertical', 3, 12], ['Shrugs', 3, 12], ['Curl biceps', 3, 12]] },
  { day: 'Jeudi', name: 'Jambes', ex: [['Squat', 4, 8], ['Soulevé de terre roumain', 3, 10], ['Presse à cuisses', 3, 12], ['Leg curl', 3, 12], ['Mollets debout', 4, 15]] },
  { day: 'Samedi', name: 'Haut du corps — Largeur', ex: [['Développé couché', 4, 8], ['Rowing haltère', 3, 10], ['Élévations latérales', 4, 15], ['Écarté poulie', 3, 12], ['Curl marteau', 3, 12]] },
];

function lastExercise(name, excludeId) {
  const prev = [...db.workouts].sort((a, b) => b.date.localeCompare(a.date)).find(x => x.id !== excludeId && x.exercises.some(e => e.name === name));
  return prev && prev.exercises.find(e => e.name === name);
}

function renderProgram() {
  const ws = weekStart(today());
  $('#programList').innerHTML = PROGRAM.map((p, i) => {
    const done = db.workouts.some(w => w.name === p.name && w.date >= ws);
    return `<div class="item">
      <div class="thumb">${done ? '✅' : '🏋️'}</div>
      <div class="meta">
        <span class="prog-day">${p.day}</span>
        <b>${esc(p.name)}</b>
        <small>${p.ex.map(e => `${e[0]} ${e[1]}×${e[2]}`).join(' · ')}</small>
      </div>
      <button class="btn small ${done ? '' : 'primary'}" data-start-prog="${i}">${done ? 'Refaire' : 'Démarrer'}</button>
    </div>`;
  }).join('');
}

function openWorkout(existing, template) {
  const id = uid();
  const w = existing ? JSON.parse(JSON.stringify(existing))
    : template ? {
      id, date: today(), name: template.name,
      // Reprend les charges de la dernière fois, sinon les séries × reps du programme
      exercises: template.ex.map(([name, sets, reps]) => {
        const prev = lastExercise(name, id);
        return { name, sets: prev ? prev.sets.map(s => ({ reps: s.reps, kg: s.kg })) : [...Array(sets)].map(() => ({ reps, kg: '' })) };
      }),
    }
    : { id, date: today(), name: '', exercises: [{ name: '', sets: [{ reps: '', kg: '' }] }] };
  // Reprend les charges de la dernière séance du même nom
  const last = name => lastExercise(name, w.id);

  openModal(existing ? 'Modifier la séance' : 'Nouvelle séance', `
    <div class="inline">
      <label class="field"><span>Nom</span><input id="wName" list="wTemplates" placeholder="Push, Pull, Legs…" value="${esc(w.name)}"></label>
      <label class="field"><span>Date</span><input type="date" id="wDate" value="${w.date}" max="${today()}"></label>
    </div>
    <datalist id="wTemplates">${[...new Set(['Push', 'Pull', 'Legs', 'Haut du corps', 'Bas du corps', 'Full body', ...db.workouts.map(x => x.name)])].filter(Boolean).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <datalist id="exList">${exerciseNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <div id="wExercises"></div>
    <button class="btn block" id="wAddEx" style="margin-bottom:14px">+ Ajouter un exercice</button>
    <div class="btn-row">
      ${existing ? '<button class="btn danger" id="wDelete">Supprimer</button>' : ''}
      <button class="btn primary" id="wSave">✓ Enregistrer</button>
    </div>`);

  const draw = () => {
    $('#wExercises').innerHTML = w.exercises.map((ex, i) => `
      <div class="exercise" data-ex="${i}">
        <div class="exercise-head">
          <input list="exList" placeholder="Exercice" value="${esc(ex.name)}" data-field="name">
          <button class="del" data-rm-ex aria-label="Retirer l'exercice">🗑️</button>
        </div>
        <div class="set-labels"><span>#</span><span>Reps</span><span>Charge (kg)</span><span></span></div>
        ${ex.sets.map((s, j) => `
          <div class="set-row" data-set="${j}">
            <span class="n">${j + 1}</span>
            <input type="number" inputmode="numeric" placeholder="10" value="${s.reps}" data-field="reps">
            <input type="number" inputmode="decimal" step="0.5" placeholder="60" value="${s.kg}" data-field="kg">
            <button class="del" data-rm-set aria-label="Retirer la série">✕</button>
          </div>`).join('')}
        <button class="btn small ghost block" data-add-set>+ Série</button>
      </div>`).join('');
  };
  draw();

  const box = $('#wExercises');
  box.addEventListener('input', e => {
    const exEl = e.target.closest('[data-ex]');
    if (!exEl) return;
    const ex = w.exercises[+exEl.dataset.ex];
    const setEl = e.target.closest('[data-set]');
    if (setEl) ex.sets[+setEl.dataset.set][e.target.dataset.field] = e.target.value;
    else ex.name = e.target.value;
  });
  box.addEventListener('change', e => {
    // Nouvel exercice choisi -> pré-remplit avec la dernière séance
    if (e.target.dataset.field !== 'name') return;
    const ex = w.exercises[+e.target.closest('[data-ex]').dataset.ex];
    const prev = last(ex.name.trim());
    if (prev && ex.sets.every(s => !s.reps && !s.kg)) {
      ex.sets = prev.sets.map(s => ({ reps: s.reps, kg: s.kg }));
      draw();
      toast('Charges de la dernière séance reprises');
    }
  });
  box.addEventListener('click', e => {
    const exEl = e.target.closest('[data-ex]');
    if (!exEl) return;
    const i = +exEl.dataset.ex;
    if (e.target.closest('[data-add-set]')) {
      const s = w.exercises[i].sets;
      s.push({ ...(s[s.length - 1] || { reps: '', kg: '' }) });
      draw();
    } else if (e.target.closest('[data-rm-set]')) {
      w.exercises[i].sets.splice(+e.target.closest('[data-set]').dataset.set, 1);
      draw();
    } else if (e.target.closest('[data-rm-ex]')) {
      w.exercises.splice(i, 1);
      draw();
    }
  });
  $('#wAddEx').onclick = () => { w.exercises.push({ name: '', sets: [{ reps: '', kg: '' }] }); draw(); };
  $('#wSave').onclick = () => {
    w.name = $('#wName').value.trim();
    w.date = $('#wDate').value || today();
    w.exercises = w.exercises
      .map(ex => ({ name: ex.name.trim(), sets: ex.sets.filter(s => +s.reps > 0).map(s => ({ reps: +s.reps, kg: +s.kg || 0 })) }))
      .filter(ex => ex.name && ex.sets.length);
    if (!w.exercises.length) return toast('Ajoute au moins un exercice avec des reps');
    db.workouts = db.workouts.filter(x => x.id !== w.id).concat(w);
    save(); closeModal(); render();
    toast(`💪 Séance enregistrée — ${fmt(workoutVolume(w))} kg de volume`);
  };
  if (existing) $('#wDelete').onclick = async () => {
    if (!(await askConfirm('Supprimer cette séance ?'))) return;
    db.workouts = db.workouts.filter(x => x.id !== w.id);
    save(); closeModal(); render();
  };
}

// ───────────────────────── Render : Corps ─────────────────────────
let weightRange = 90;
let compareSel = [];

function renderBody() {
  const ws = sortedWeights();
  if (!$('#weightDate').value) $('#weightDate').value = today();
  $('#weightDate').max = today();
  if (ws.length) {
    const first = ws[0], last = ws[ws.length - 1];
    const gain = round(last.kg - first.kg, 1);
    $('#bStart').innerHTML = `${round(first.kg, 1)}<small>kg</small>`;
    $('#bNow').innerHTML = `${round(last.kg, 1)}<small>kg</small>`;
    $('#bGain').innerHTML = `<span style="color:${gain >= 0 ? 'var(--ok)' : 'var(--danger)'}">${gain > 0 ? '+' : ''}${gain}</span><small>kg</small>`;
    if (!$('#weightInput').value) $('#weightInput').placeholder = round(last.kg, 1);
  } else {
    ['#bStart', '#bNow', '#bGain'].forEach(s => $(s).textContent = '—');
  }

  const from = weightRange ? addDays(today(), -weightRange) : '0000';
  chart('chartWeight', weightChartConfig(ws.filter(w => w.date >= from), true));

  // Récap hebdo
  const weekly = weeklyWeights().reverse();
  const workoutsByWeek = k => db.workouts.filter(w => weekStart(w.date) === k).length;
  const avgKcal = k => {
    const days = [...Array(7)].map((_, i) => addDays(k, i)).filter(d => d <= today());
    const logged = days.map(d => dayTotals(d).total.kcal).filter(v => v > 0);
    return logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
  };
  $('#weekTable').innerHTML = weekly.length ? `
    <tr><th>Semaine</th><th>Moy.</th><th>Δ</th><th>kcal/j</th><th>Séances</th></tr>
    ${weekly.slice(0, 12).map((w, i) => {
      const prev = weekly[i + 1];
      const d = prev ? round(w.avg - prev.avg, 2) : null;
      return `<tr>
        <td>${shortDate(w.week)}</td>
        <td><b>${round(w.avg, 1)}</b></td>
        <td style="color:${d == null ? 'var(--muted)' : d > 0 ? 'var(--ok)' : d < 0 ? 'var(--danger)' : 'var(--muted)'}">${d == null ? '—' : (d > 0 ? '+' : '') + d}</td>
        <td>${avgKcal(w.week) ? fmt(avgKcal(w.week)) : '—'}</td>
        <td>${workoutsByWeek(w.week)}</td>
      </tr>`;
    }).join('')}` : '<tr><td class="empty">Ajoute des pesées pour voir ton récap.</td></tr>';

  // Historique des pesées
  $('#weightList').innerHTML = ws.length ? [...ws].reverse().slice(0, 15).map((w, i, arr) => {
    const prev = arr[i + 1];
    const d = prev ? round(w.kg - prev.kg, 1) : null;
    return `<div class="item">
      <div class="thumb">⚖️</div>
      <div class="meta"><b>${round(w.kg, 1)} kg</b><small>${longDate(w.date)}</small></div>
      ${d != null ? `<div class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${d}</div>` : ''}
      <button class="del" data-del-weight="${w.id}" aria-label="Supprimer">✕</button>
    </div>`;
  }).join('') : '<div class="empty">Aucune pesée pour l\'instant.</div>';

  renderPhotos();
}

// Photos enregistrées + photos de départ (toujours affichées, sauf si masquées)
function allPhotos() {
  const hidden = db.settings.hiddenBaseline || [];
  const base = BASELINE_PHOTOS
    .filter(p => !hidden.includes(p.img) && !db.photos.some(x => x.img === p.img))
    .map(p => ({ id: 'base-' + p.img.slice(2), img: p.img, date: p.date, label: p.label, baseline: true }));
  return [...db.photos, ...base];
}

function renderPhotos() {
  const photos = allPhotos().sort((a, b) => b.date.localeCompare(a.date));
  const groups = new Map();
  photos.forEach(p => { const k = weekStart(p.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
  const weeks = [...groups.keys()];
  const firstWeek = weeks[weeks.length - 1];
  $('#photoWeeks').innerHTML = photos.length ? weeks.map(k => {
    const avg = weeklyWeights().find(w => w.week === k);
    const n = firstWeek ? Math.round((parse(k) - parse(firstWeek)) / 6048e5) + 1 : 1;
    return `<div class="week-group">
      <div class="week-title"><b>Semaine ${n}</b><span>${shortDate(k)}${avg ? ' · ' + round(avg.avg, 1) + ' kg' : ''}</span></div>
      <div class="photo-grid">${groups.get(k).map(p => `
        <div class="ph ${compareSel.includes(p.id) ? 'sel' : ''}" data-photo="${p.id}">
          <img data-img="${p.img || p.id}" alt="Photo du ${shortDate(p.date)}">
          <span class="tag">${esc(p.label || shortDate(p.date))}</span>
          <button class="rm" data-rm-photo="${p.id}" aria-label="Supprimer la photo">✕</button>
        </div>`).join('')}</div>
    </div>`;
  }).join('') : '<div class="empty">Ajoute une photo par semaine (même pose, même lumière) pour voir ton évolution 📷</div>';
  hydrateImages($('#photoWeeks'));
  renderCompare();
}

async function renderCompare() {
  const box = $('#compareBox');
  if (compareSel.length !== 2) return box.classList.add('hidden');
  const ps = compareSel.map(id => allPhotos().find(p => p.id === id)).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  if (ps.length !== 2) { compareSel = []; return box.classList.add('hidden'); }
  box.classList.remove('hidden');
  const imgs = await Promise.all(ps.map(p => loadImg(p.img || p.id)));
  $('#compareView').innerHTML = ps.map((p, i) => {
    const w = weightAround(p.date);
    return `<figure><img src="${imgs[i] || ''}" alt=""><figcaption>${i ? 'Après' : 'Avant'} · ${shortDate(p.date)}${w ? ' · ' + round(w.kg, 1) + ' kg' : ''}</figcaption></figure>`;
  }).join('');
}

$('#photoWeeks').addEventListener('click', e => {
  const rm = e.target.closest('[data-rm-photo]');
  if (rm) return deletePhoto(rm.dataset.rmPhoto);
  const ph = e.target.closest('[data-photo]');
  if (!ph) return;
  const id = ph.dataset.photo;
  if (compareSel.includes(id)) compareSel = compareSel.filter(x => x !== id);
  else compareSel = [...compareSel.slice(-1), id];
  if (compareSel.length === 1) toast('Touche une 2e photo pour comparer');
  renderPhotos();
});
$('#clearCompare').addEventListener('click', () => { compareSel = []; renderPhotos(); });

async function deletePhoto(id) {
  if (!(await askConfirm('Supprimer cette photo ?'))) return;
  const p = allPhotos().find(x => x.id === id);
  compareSel = compareSel.filter(x => x !== id);
  if (p && p.baseline) {
    db.settings.hiddenBaseline = [...(db.settings.hiddenBaseline || []), p.img];
  } else {
    db.photos = db.photos.filter(x => x !== p);
    if (p) delImage(p.img || p.id);
  }
  save(); render();
}

$('#bodyPhoto').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let dataUrl;
  try { dataUrl = await resizeImage(file, 1000, 0.82); } catch (err) { return toast('❌ ' + err.message); }
  openModal('Nouvelle photo', `
    <div class="preview"><img src="${dataUrl}" alt=""></div>
    <div class="inline">
      <label class="field"><span>Date</span><input type="date" id="pDate" value="${today()}" max="${today()}"></label>
      <label class="field"><span>Pose</span>
        <select id="pLabel"><option>Face</option><option>Profil</option><option>Dos</option><option>Contracté</option></select>
      </label>
    </div>
    <button class="btn primary block" id="pSave">Enregistrer</button>`);
  $('#pSave').onclick = async () => {
    $('#pSave').disabled = true;
    let img;
    try { img = await putImage(dataUrl, 'body'); } catch { $('#pSave').disabled = false; return toast('❌ Impossible de sauvegarder la photo'); }
    db.photos.push({ id: uid(), img, date: $('#pDate').value || today(), label: $('#pLabel').value });
    save(); closeModal(); render();
    toast('📷 Photo ajoutée');
  };
});

$('#addWeightBtn').addEventListener('click', () => {
  const kg = parseFloat(String($('#weightInput').value).replace(',', '.'));
  const date = $('#weightDate').value || today();
  if (!(kg > 20 && kg < 400)) return toast('Entre un poids valide');
  db.weights = db.weights.filter(w => w.date !== date); // une pesée par jour
  db.weights.push({ id: uid(), date, kg });
  save();
  $('#weightInput').value = '';
  render();
  toast(`⚖️ ${kg} kg enregistré`);
});
$('#weightList').addEventListener('click', async e => {
  const b = e.target.closest('[data-del-weight]');
  if (!b || !(await askConfirm('Supprimer cette pesée ?'))) return;
  db.weights = db.weights.filter(w => w.id !== b.dataset.delWeight);
  save(); render();
});
$('#weightRange').addEventListener('click', e => {
  const c = e.target.closest('[data-range]');
  if (!c) return;
  weightRange = +c.dataset.range;
  $$('#weightRange .chip').forEach(x => x.classList.toggle('active', x === c));
  renderBody();
});

// ───────────────────────── Render : Compléments ─────────────────────────
const TIMINGS = { matin: '🌅 Matin', pre: '⚡ Pré-training', post: '💪 Post-training', collation: '🥤 Collation', soir: '🌙 Soir' };

function renderSupps() {
  $$('.dayLabel').forEach(el => el.textContent = longDate(currentDay));
  const taken = new Set(db.suppLog[currentDay] || []);
  const t = sumMacros(suppsTakenOn(currentDay));
  $('#sTaken').textContent = `${[...taken].filter(id => db.supps.some(s => s.id === id)).length}/${db.supps.length}`;
  $('#sKcal').innerHTML = `${fmt(t.kcal)}<small>kcal</small>`;
  $('#sProt').textContent = `${round(t.protein)} g protéines`;

  $('#suppList').innerHTML = db.supps.length ? Object.entries(TIMINGS).map(([k, label]) => {
    const list = db.supps.filter(s => s.timing === k);
    if (!list.length) return '';
    return `<div class="timing-title">${label}</div><div class="list">${list.map(s => `
      <div class="supp ${taken.has(s.id) ? 'taken' : ''}" data-supp="${s.id}">
        <div class="check">${taken.has(s.id) ? '✓' : ''}</div>
        <div class="meta" style="flex:1;min-width:0">
          <b>${esc(s.name)}</b><br>
          <small style="color:var(--muted)">${esc(s.dose)}${s.protein ? ` · ${round(s.protein)} g prot.` : ''}</small>
        </div>
        <div class="kcal">${fmt(s.kcal)}<small>kcal</small></div>
        <button class="del" data-edit-supp="${s.id}" aria-label="Modifier">✎</button>
      </div>`).join('')}</div>`;
  }).join('') : '<div class="empty">Ajoute tes compléments avec « + Ajouter ».</div>';

  // Régularité 14 jours
  const days = [...Array(14)].map((_, i) => addDays(currentDay, i - 13));
  const pct = days.map(d => db.supps.length ? round(suppsTakenOn(d).length / db.supps.length * 100) : 0);
  chart('chartSupps', {
    type: 'bar',
    data: { labels: days.map(d => parse(d).getDate()), datasets: [{ data: pct, backgroundColor: pct.map(p => p >= 100 ? C.blue : p > 0 ? C.blue + '77' : C.grid), borderRadius: 6, maxBarThickness: 20, label: '% pris' }] },
    options: {
      scales: { y: { max: 100, beginAtZero: true, ticks: { callback: v => v + '%', stepSize: 50 } }, x: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { title: i => shortDate(days[i[0].dataIndex]), label: i => `${i.parsed.y}% des compléments pris` } } },
    },
  });
}

$('#suppList').addEventListener('click', e => {
  const ed = e.target.closest('[data-edit-supp]');
  if (ed) return openSupp(db.supps.find(s => s.id === ed.dataset.editSupp));
  const row = e.target.closest('[data-supp]');
  if (!row) return;
  const id = row.dataset.supp;
  const log = new Set(db.suppLog[currentDay] || []);
  log.has(id) ? log.delete(id) : log.add(id);
  db.suppLog[currentDay] = [...log];
  save(); renderSupps();
});
$('#newSuppBtn').addEventListener('click', () => openSupp());

function openSupp(s) {
  const v = s || { name: '', dose: '', timing: 'matin', kcal: '', protein: '', carbs: '', fat: '' };
  openModal(s ? 'Modifier le complément' : 'Nouveau complément', `
    <label class="field"><span>Nom</span><input id="sName" placeholder="Whey, créatine, oméga-3…" value="${esc(v.name)}"></label>
    <div class="inline">
      <label class="field"><span>Dose</span><input id="sDose" placeholder="30 g" value="${esc(v.dose)}"></label>
      <label class="field"><span>Quand</span><select id="sTiming">${Object.entries(TIMINGS).map(([k, l]) => `<option value="${k}" ${k === v.timing ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="inline">
      <label class="field"><span>Calories</span><input type="number" inputmode="decimal" id="sKcalIn" value="${v.kcal}" placeholder="0"></label>
      <label class="field"><span>Protéines (g)</span><input type="number" inputmode="decimal" id="sP" value="${v.protein}" placeholder="0"></label>
    </div>
    <div class="inline">
      <label class="field"><span>Glucides (g)</span><input type="number" inputmode="decimal" id="sC" value="${v.carbs}" placeholder="0"></label>
      <label class="field"><span>Lipides (g)</span><input type="number" inputmode="decimal" id="sF" value="${v.fat}" placeholder="0"></label>
    </div>
    <div class="btn-row">
      ${s ? '<button class="btn danger" id="sDel">Supprimer</button>' : ''}
      <button class="btn primary" id="sSave">✓ Enregistrer</button>
    </div>`);
  $('#sSave').onclick = () => {
    const name = $('#sName').value.trim();
    if (!name) return toast('Donne un nom au complément');
    const p = +$('#sP').value || 0, c = +$('#sC').value || 0, f = +$('#sF').value || 0;
    const item = {
      id: s ? s.id : uid(), name, dose: $('#sDose').value.trim(), timing: $('#sTiming').value,
      kcal: $('#sKcalIn').value === '' ? round(p * 4 + c * 4 + f * 9) : +$('#sKcalIn').value, protein: p, carbs: c, fat: f,
    };
    db.supps = s ? db.supps.map(x => x.id === s.id ? item : x) : [...db.supps, item];
    save(); closeModal(); render();
  };
  if (s) $('#sDel').onclick = async () => {
    if (!(await askConfirm(`Supprimer « ${s.name} » ?`))) return;
    db.supps = db.supps.filter(x => x.id !== s.id);
    save(); closeModal(); render();
  };
}

// ───────────────────────── Réglages ─────────────────────────
$('#openSettings').addEventListener('click', openSettings);

function openSettings() {
  const s = db.settings;
  const key = getApiKey();
  openModal('Réglages', `
    <h3>🎯 Objectifs quotidiens</h3>
    <div class="inline">
      <label class="field"><span>Calories</span><input type="number" id="gKcal" value="${s.kcal}"></label>
      <label class="field"><span>Protéines (g)</span><input type="number" id="gP" value="${s.protein}"></label>
    </div>
    <div class="inline">
      <label class="field"><span>Glucides (g)</span><input type="number" id="gC" value="${s.carbs}"></label>
      <label class="field"><span>Lipides (g)</span><input type="number" id="gF" value="${s.fat}"></label>
    </div>
    <label class="field"><span>Poids objectif (kg)</span><input type="number" step="0.1" id="gW" value="${s.targetWeight ?? ''}" placeholder="112"></label>

    <h3>👤 Mon profil</h3>
    <div class="inline">
      <label class="field"><span>Taille (cm)</span><input type="number" inputmode="numeric" id="gH" value="${s.height}"></label>
      <label class="field"><span>Âge</span><input type="number" inputmode="numeric" id="gAge" value="${s.age}"></label>
    </div>
    <div class="inline">
      <label class="field"><span>Sexe</span><select id="gSex"><option value="homme">Homme</option><option value="femme">Femme</option></select></label>
      <label class="field"><span>Ajustement (kcal)</span><input type="number" inputmode="numeric" step="50" id="gSur" value="${s.surplus}"></label>
    </div>
    <label class="field"><span>Phase</span>
      <select id="gPhase">${Object.entries(PHASES).map(([k, p]) => `<option value="${k}">${p.label} (${p.adj > 0 ? '+' : ''}${p.adj} kcal, prot. ${String(p.prot).replace('.', ',')} g/kg)</option>`).join('')}</select>
    </label>
    <label class="field"><span>Activité</span>
      <select id="gAct">
        <option value="1.375">1 à 3 entraînements / semaine</option>
        <option value="1.55">3 à 5 entraînements / semaine</option>
        <option value="1.725">6 à 7 entraînements / semaine</option>
        <option value="1.9">2 fois par jour</option>
      </select>
    </label>
    <button class="btn small block" id="gAuto">🧮 Recalculer mes objectifs</button>
    <p class="note" id="gCalc" style="margin:8px 0 20px"></p>

    ${sampleNs ? `<h3>🤖 Analyse des photos</h3>
    <p class="note" style="margin:-6px 0 20px">L'analyse passe par ton compte Claude : pas besoin de clé API.</p>` : `    <h3>🤖 Analyse des photos (IA Claude)</h3>
    <label class="field"><span>Clé API Anthropic</span><input type="password" id="gKey" value="${esc(key)}" placeholder="sk-ant-…" autocomplete="off"></label>
    <label class="field"><span>Modèle</span>
      <select id="gModel">
        <option value="claude-opus-5-5">Claude Opus 5.5 — le plus précis</option>
        <option value="claude-sonnet-5-5">Claude Sonnet 5.5 — rapide</option>
        <option value="claude-haiku-5-5">Claude Haiku 5.5 — le moins cher</option>
      </select>
    </label>
    <p class="note" style="margin:-4px 0 20px">Crée une clé sur console.anthropic.com. Elle reste uniquement dans ce navigateur et sert seulement à appeler l'API Claude.</p>`}

    <button class="btn primary block" id="gSave" style="margin-bottom:20px">✓ Enregistrer</button>

    <h3>💾 Mes données</h3>
    <p class="note" style="margin:-6px 0 10px">${cloud.col ? 'Tes données sont sauvegardées dans ton espace Claude. Tu peux aussi les exporter.' : 'Tout est stocké sur ton téléphone. Exporte régulièrement pour ne rien perdre.'}</p>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn small" id="gExport">⬇️ Exporter</button>
      <label class="btn small" for="gImport">⬆️ Importer</label>
      <input type="file" id="gImport" accept="application/json" hidden>
    </div>
    <button class="btn small ghost danger block" id="gReset">Tout effacer</button>`);
  if ($('#gModel')) $('#gModel').value = s.model;

  $('#gSex').value = s.sex;
  $('#gAct').value = String(s.activity);
  $('#gPhase').value = s.phase;
  $('#gPhase').addEventListener('change', () => { $('#gSur').value = PHASES[$('#gPhase').value].adj; explain(); });
  const profileForm = () => ({ height: +$('#gH').value || s.height, age: +$('#gAge').value || s.age, sex: $('#gSex').value, activity: +$('#gAct').value, surplus: +$('#gSur').value || 0, phase: $('#gPhase').value });
  const explain = () => {
    const w = weightAround(today());
    if (!w) { $('#gCalc').textContent = "Ajoute une pesée dans « Corps » pour calculer tes besoins."; return null; }
    const g = computeGoals(profileForm(), w.kg);
    $('#gCalc').textContent = `Pour ${round(w.kg, 1)} kg : métabolisme de base ${fmt(g.bmr)} kcal, dépense totale ${fmt(g.tdee)} kcal → ${fmt(g.kcal)} kcal/jour, ${g.protein} g de protéines. ${PHASES[profileForm().phase].paceText}.`;
    return g;
  };
  explain();
  ['#gH', '#gAge', '#gSex', '#gAct', '#gSur'].forEach(id => $(id).addEventListener('input', explain));
  $('#gAuto').onclick = () => {
    const g = explain();
    if (!g) return toast("Ajoute d'abord une pesée dans « Corps »");
    $('#gKcal').value = g.kcal; $('#gP').value = g.protein; $('#gF').value = g.fat; $('#gC').value = g.carbs;
    toast('Objectifs recalculés — pense à enregistrer');
  };
  $('#gSave').onclick = () => {
    Object.assign(db.settings, {
      kcal: +$('#gKcal').value || 3000, protein: +$('#gP').value || 0, carbs: +$('#gC').value || 0, fat: +$('#gF').value || 0,
      targetWeight: $('#gW').value ? +$('#gW').value : null, ...profileForm(),
      phaseStart: $('#gPhase').value !== s.phase ? today() : s.phaseStart, model: $('#gModel') ? $('#gModel').value : s.model,
    });
    if ($('#gKey')) setApiKey($('#gKey').value.trim());
    save(); closeModal(); render();
    toast('✓ Réglages enregistrés');
  };
  $('#gExport').onclick = exportData;
  $('#gImport').onchange = importData;
  $('#gReset').onclick = async () => {
    if (!(await askConfirm('Effacer TOUTES les données ? Cette action est irréversible.', 'Tout effacer'))) return;
    imageRefs().forEach(delImage);
    db = defaults(); save(); closeModal(); render();
    toast('Données effacées');
  };
}

const imageRefs = () => [...db.photos.map(p => p.img || p.id), ...db.meals.map(m => m.photoId)].filter(Boolean);

async function refToDataUrl(ref) {
  const src = await loadImg(ref);
  if (!src || src.startsWith('data:')) return src;
  try {
    const blob = await (await fetch(src)).blob();
    return await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  } catch { return null; }
}

async function exportData() {
  const images = {};
  for (const ref of imageRefs()) { const v = await refToDataUrl(ref); if (v) images[ref] = v; }
  const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: db, images });
  const filename = `mass-tracker-${today()}.json`;
  const downloads = window.claude && window.claude.use ? await claude.use('downloads').catch(() => null) : null;
  if (downloads) {
    try { await downloads.save({ filename, data: new Blob([json], { type: 'application/json' }) }); toast('⬇️ Export enregistré'); }
    catch (e) { if (e && e.code !== 'declined') toast('❌ Export impossible ici'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('⬇️ Export téléchargé');
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let json;
  try {
    json = JSON.parse(await file.text());
    if (!json.data || !Array.isArray(json.data.meals)) throw new Error();
  } catch { return toast('❌ Fichier invalide'); }
  if (!(await askConfirm('Remplacer les données actuelles par cet export ?', 'Remplacer'))) return;
  const data = normalize(json.data);
  // Ré-enregistre chaque image dans le stockage courant et met à jour les références
  const map = {};
  for (const [ref, v] of Object.entries(json.images || {})) {
    try { map[ref] = await putImage(v, 'img'); } catch {}
  }
  data.meals.forEach(m => { if (m.photoId) m.photoId = map[m.photoId] || null; });
  data.photos = data.photos.map(p => ({ ...p, img: map[p.img || p.id] })).filter(p => p.img);
  db = data;
  save(); closeModal(); render();
  toast('⬆️ Données importées');
}

// ───────────────────────── Modal ─────────────────────────
function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  $('#modal').classList.remove('open');
  document.body.style.overflow = '';
}
$('#modal').addEventListener('click', e => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ───────────────────────── Render global ─────────────────────────
function render() {
  ({ dashboard: renderDashboard, meals: renderMeals, workouts: renderWorkouts, body: renderBody, supps: renderSupps })[currentView]();
}

// Revenir à aujourd'hui quand l'app est rouverte un autre jour
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentDay > today()) { currentDay = today(); render(); }
});

applyProfileOnce();
render();
initCloud();
