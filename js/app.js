// VozPDF — lector de PDFs con voz en español. PWA, funciona sin internet.
import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).toString();

const $ = (id) => document.getElementById(id);
const loadingEl = $("loading");

/* ================= IndexedDB ================= */
const DB_NAME = "vozpdf-db";
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("pdfs", { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbOp(mode, op) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("pdfs", mode);
    const req = op(tx.objectStore("pdfs"));
    req.onsuccess = () => { const v = req.result; db.close(); resolve(v); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}
const dbAddPdf = (doc) => dbOp("readwrite", (s) => s.add(doc));
const dbListPdfs = () => dbOp("readonly", (s) => s.getAll()).then((r) => r || []);
const dbGetPdf = (id) => dbOp("readonly", (s) => s.get(id));
const dbDeletePdf = (id) => dbOp("readwrite", (s) => s.delete(id));

/* ================= Ajustes ================= */
const settings = Object.assign(
  { voiceURI: "", rate: 1, continueNext: true },
  JSON.parse(localStorage.getItem("vozpdf-settings") || "{}")
);
function saveSettings() {
  localStorage.setItem("vozpdf-settings", JSON.stringify(settings));
}

/* ================= Texto: frases y trozos ================= */
function splitSentences(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  const re = /[^.!?…]+[.!?…]+["'»”)}\]]?/g;
  let m, last = 0;
  while ((m = re.exec(clean)) !== null) {
    const s = m[0].trim();
    if (s.length > 1) out.push(s);
    last = re.lastIndex;
    if (out.length > 2000) break;
  }
  const rest = clean.slice(last).trim();
  if (rest.length > 1) out.push(rest);
  return out;
}
// Agrupa frases en trozos cortos: iOS corta los enunciados largos.
function chunkSentences(sentences, startIdx = 0, maxLen = 170) {
  const chunks = [];
  let cur = { text: "", idx: [] };
  for (let i = startIdx; i < sentences.length; i++) {
    const s = sentences[i];
    if (cur.text && (cur.text + " " + s).length > maxLen) {
      chunks.push(cur);
      cur = { text: "", idx: [] };
    }
    cur.text = cur.text ? cur.text + " " + s : s;
    cur.idx.push(i);
  }
  if (cur.text) chunks.push(cur);
  return chunks;
}

/* ================= Voz (Web Speech API) ================= */
const synth = window.speechSynthesis;
// iOS se queda con la voz del dispositivo (ruta probada en el iPhone de
// Daniel); Android/escritorio prefieren la voz web (ver abajo).
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const tts = {
  chunks: [],
  pos: 0,
  playing: false,
  lastActivity: 0,
  onPageEnd: null,
  gen: 0,          // generación: los enunciados de una generación vieja se ignoran
  fastRetries: 0,
};
// Sube la generación y cancela la voz: los manejadores de enunciados viejos
// quedan obsoletos y ya no pueden adelantar la posición (saltos aleatorios).
function bumpGen() {
  tts.gen++;
  stopWebAudio();
  try { synth.cancel(); } catch (e) {}
}

/* ============ Voz web (Google TTS) para Android/escritorio ============ */
// En Android, speechSynthesis falla en silencio con frecuencia: el teléfono
// no trae motor TTS o no trae la voz en español, y cada enunciado dispara
// onerror — la app "lee" la página entera sin que suene nada. La voz web
// (MP3 de Google reproducido con <audio>) suena en cualquier teléfono con
// internet, sin depender del TTS del dispositivo. Si no hay red, se cae
// automáticamente a la voz del dispositivo.
let webAudio = null;
let webVoiceDead = false; // si falla una vez, no reintentar en esta lectura
function stopWebAudio() {
  try { if (webAudio) { webAudio.pause(); webAudio.src = ""; } } catch (e) {}
  webAudio = null;
}
function webTtsUrl(text) {
  return "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=es&q=" +
    encodeURIComponent(String(text).slice(0, 200));
}
// Reproduce un trozo con la voz web. cbs: { onstart, onend, onfail }.
function playWebChunk(text, guardMs, cbs) {
  const audio = new Audio();
  // Google 404s translate_tts when the request carries our Referer
  // (hotlink protection). no-referrer gets the MP3 back.
  audio.setAttribute("referrerpolicy", "no-referrer");
  let settled = false;
  const done = (ok) => {
    if (settled) return;
    settled = true;
    if (ok) { webAudio = audio; }
    else { try { audio.pause(); audio.src = ""; } catch (e) {} }
    (ok ? cbs.onstart : cbs.onfail)();
  };
  try { audio.playbackRate = settings.rate || 1; } catch (e) {}
  // Mantiene vivo al perro guardián mientras el audio suena.
  audio.ontimeupdate = () => { tts.lastActivity = Date.now(); };
  audio.onplaying = () => done(true);
  audio.onended = () => { webAudio = null; cbs.onend(); };
  audio.onerror = () => done(false);
  try {
    audio.src = webTtsUrl(text);
    audio.load();
    const p = audio.play();
    if (p && p.catch) p.catch(() => done(false));
  } catch (e) { done(false); }
  setTimeout(() => done(false), guardMs);
}

/* ============ Mantener la pantalla encendida y el audio vivo ============ */
// iOS apaga speechSynthesis cuando la pantalla se bloquea. Dos defensas:
// 1) Wake Lock: pide que la pantalla no se apague mientras lee.
// 2) Audio silencioso en bucle: mantiene viva la sesión de audio de Safari
//    para que la voz siga aunque la pantalla se bloquee igual.
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) {}
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && tts.playing) acquireWakeLock();
});

let keepaliveAudio = null;
function silentWavUrl() {
  const rate = 8000, n = rate; // 1 s de silencio, 8 bits mono
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + n, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  wstr(36, "data"); dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function startKeepalive() {
  try {
    if (!keepaliveAudio) {
      keepaliveAudio = new Audio(silentWavUrl());
      keepaliveAudio.loop = true;
      keepaliveAudio.setAttribute("playsinline", "");
    }
    const p = keepaliveAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function stopKeepalive() {
  try { if (keepaliveAudio) keepaliveAudio.pause(); } catch (e) {}
}

function allVoices() {
  try { return synth.getVoices() || []; } catch (e) { return []; }
}
function esVoices() {
  return allVoices().filter((v) => (v.lang || "").toLowerCase().startsWith("es"));
}
function pickVoice() {
  const vs = esVoices();
  if (!vs.length) return null;
  const saved = vs.find((v) => v.voiceURI === settings.voiceURI);
  if (saved) return saved;
  const isEnhanced = (v) => /mejorada|enhanced|premium/i.test(v.name || "");
  // 1) predeterminada del iPhone si es mejorada, 2) predeterminada,
  // 3) cualquier voz mejorada en español, 4) la primera disponible.
  return vs.find((v) => v.default && isEnhanced(v))
      || vs.find((v) => v.default)
      || vs.find(isEnhanced)
      || vs[0];
}
function refreshVoiceList() {
  const sel = $("voice-select");
  const es = esVoices();
  // Si iOS no expone ninguna voz en español, muestra todas las que haya
  // para diagnosticar (antes la lista quedaba vacía sin explicación).
  const vs = es.length ? es : allVoices();
  sel.innerHTML = "";
  const note = $("voice-note");
  const count = $("voice-count");
  if (count) count.textContent = vs.length
    ? `${vs.length} ${vs.length === 1 ? "voz disponible" : "voces disponibles"}${es.length ? "" : " (ninguna en español)"}`
    : "Buscando voces…";
  if (!vs.length) {
    note.textContent = "El iPhone no está entregando voces a la app. Cierra VozPDF por completo y vuelve a abrirla; si acabas de descargar voces, iOS a veces tarda en exponerlas.";
    note.classList.remove("hidden");
    return;
  }
  if (!es.length) {
    note.textContent = "iOS no está exponiendo voces en español a la app. Estas son todas las disponibles. Prueba cerrar y reabrir la app.";
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  vs.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})${v.default ? " — predeterminada" : ""}`;
    sel.appendChild(o);
  });
  // Fija la voz elegida automáticamente para que no cambie si iOS reordena la lista.
  if (!settings.voiceURI) {
    const auto = pickVoice();
    if (auto) { settings.voiceURI = auto.voiceURI; saveSettings(); }
  }
  const pv = pickVoice();
  if (pv) sel.value = pv.voiceURI;
}
if ("onvoiceschanged" in synth) synth.onvoiceschanged = () => ensureVoicesLoaded();
// iOS entrega las voces de forma asíncrona y el evento voiceschanged a veces
// se dispara antes de que este módulo cargue: sondear hasta que aparezcan.
let voicePoll = null;
function ensureVoicesLoaded(force) {
  refreshVoiceList();
  if (allVoices().length && !force) return;
  if (voicePoll) {
    if (!force) return;
    clearInterval(voicePoll);
    voicePoll = null;
  }
  let tries = 0;
  voicePoll = setInterval(() => {
    refreshVoiceList();
    if (allVoices().length || ++tries >= 20) { clearInterval(voicePoll); voicePoll = null; }
  }, 500);
}

function clearHighlight() {
  document.querySelectorAll(".sentence.speaking").forEach((el) => el.classList.remove("speaking"));
}
function highlightChunk(chunk) {
  clearHighlight();
  if (!chunk) return;
  let first = null;
  chunk.idx.forEach((i) => {
    const el = document.querySelector(`.sentence[data-i="${i}"]`);
    if (el) { el.classList.add("speaking"); if (!first) first = el; }
  });
  if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function setStatus(t) { $("read-status").textContent = t; }
function setPlayIcon(playing) { $("btn-play").textContent = playing ? "⏸" : "▶"; }

function speakChunk() {
  const chunk = tts.chunks[tts.pos];
  if (!chunk) { finishReading(); return; }
  // Sin synth.cancel() aquí: el enunciado anterior ya terminó. Cancelar y
  // hablar de inmediato hace que iOS trague enunciados o dispare onend
  // tardíos que saltaban párrafos al azar.
  stopWebAudio(); // por si el perro guardián re-dispara un trozo atascado
  const g = tts.gen;
  highlightChunk(chunk);
  setStatus(`Leyendo… (${tts.pos + 1}/${tts.chunks.length})`);
  tts.lastActivity = Date.now();
  const advance = () => {
    if (!tts.playing || tts.gen !== g) return; // trozo viejo: ignorar
    tts.pos++;
    tts.lastActivity = Date.now();
    speakChunk();
  };
  // Fuera de iOS: primero la voz web (confiable en Android); si no hay red
  // o el endpoint falla, se cae a la voz del dispositivo.
  if (!IS_IOS && !webVoiceDead) {
    playWebChunk(chunk.text, 3500, {
      onstart: () => { if (tts.gen !== g || !tts.playing) stopWebAudio(); },
      onend: advance,
      onfail: () => {
        webVoiceDead = true; // no reintentar la voz web en esta lectura
        if (!tts.playing || tts.gen !== g) return;
        speakLocal(chunk, g, advance);
      },
    });
    return;
  }
  speakLocal(chunk, g, advance);
}
// Voz del dispositivo (Web Speech API): ruta principal en iOS, respaldo
// en Android/escritorio cuando no hay red.
function speakLocal(chunk, g, advance) {
  const u = new SpeechSynthesisUtterance(chunk.text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = (v && v.lang) || "es-ES";
  u.rate = settings.rate || 1;
  const startedAt = Date.now();
  u.onend = () => {
    if (!tts.playing || tts.gen !== g) return; // enunciado viejo: ignorar
    // iOS a veces "termina" un enunciado al instante sin hablarlo: reintentar
    // el mismo trozo en vez de saltarlo.
    if (Date.now() - startedAt < 300 && tts.fastRetries < 3) {
      tts.fastRetries++;
      tts.lastActivity = Date.now();
      speakChunk();
      return;
    }
    tts.fastRetries = 0;
    advance();
  };
  u.onerror = () => {
    if (!tts.playing || tts.gen !== g) return; // enunciado viejo: ignorar
    tts.fastRetries = 0;
    advance();
  };
  try { synth.speak(u); } catch (e) { finishReading(); }
}
// Perro guardián: iOS a veces deja la voz colgada en silencio.
setInterval(() => {
  if (!tts.playing) return;
  if (Date.now() - tts.lastActivity < 4000) return;
  try {
    if (!synth.speaking && !synth.pending) speakChunk();
  } catch (e) {}
}, 2500);

function startReading(fromSentence = 0) {
  if (!pageSentences.length) return;
  bumpGen();
  tts.chunks = chunkSentences(pageSentences, fromSentence);
  tts.pos = 0;
  tts.fastRetries = 0;
  webVoiceDead = false; // reintentar la voz web en cada lectura nueva
  tts.playing = true;
  setPlayIcon(true);
  acquireWakeLock();
  startKeepalive();
  speakChunk();
}
function pauseReading() {
  tts.playing = false;
  bumpGen();
  releaseWakeLock();
  stopKeepalive();
  setPlayIcon(false);
  setStatus("En pausa — toca ▶ para seguir");
}
function resumeReading() {
  if (!tts.chunks.length || tts.pos >= tts.chunks.length) { startReading(0); return; }
  tts.playing = true;
  setPlayIcon(true);
  acquireWakeLock();
  startKeepalive();
  speakChunk();
}
function finishReading() {
  tts.playing = false;
  bumpGen();
  setPlayIcon(false);
  clearHighlight();
  // Al terminar la página, seguir con la siguiente si está activado.
  if (settings.continueNext && curPage < numPages && pdfDoc) {
    setStatus("Pasando a la página siguiente…");
    renderPage(curPage + 1).then(() => startReading(0)).catch(() => {
      releaseWakeLock();
      stopKeepalive();
      setStatus("Toca ▶ para escuchar esta página");
    });
    return;
  }
  releaseWakeLock();
  stopKeepalive();
  setStatus("Toca ▶ para escuchar esta página");
}
$("btn-play").addEventListener("click", () => {
  if (tts.playing) pauseReading();
  else if (tts.chunks.length && tts.pos < tts.chunks.length) resumeReading();
  else startReading(0);
});
$("btn-stop").addEventListener("click", () => {
  tts.chunks = []; tts.pos = 0;
  finishReading();
  setStatus("Toca ▶ para escuchar esta página");
});

/* ================= Biblioteca ================= */
function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }); }
  catch (e) { return ""; }
}
async function renderLibrary() {
  const list = await dbListPdfs().catch(() => []);
  const box = $("pdf-list");
  box.innerHTML = "";
  $("library-empty").classList.toggle("hidden", list.length > 0);
  list.sort((a, b) => b.addedAt - a.addedAt).forEach((doc) => {
    const b = document.createElement("button");
    b.className = "pdf-item";
    const meta = document.createElement("div");
    meta.className = "pdf-meta";
    const name = document.createElement("div");
    name.className = "pdf-name";
    name.textContent = doc.name;
    const sub = document.createElement("div");
    sub.className = "pdf-sub";
    sub.textContent = `${doc.pages} páginas · ${fmtDate(doc.addedAt)}`;
    meta.appendChild(name); meta.appendChild(sub);
    const icon = document.createElement("span");
    icon.className = "pdf-icon"; icon.textContent = "📄";
    const del = document.createElement("button");
    del.className = "pdf-del"; del.textContent = "×"; del.setAttribute("aria-label", "Eliminar");
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (confirm(`¿Eliminar "${doc.name}" de tu biblioteca?`)) {
        await dbDeletePdf(doc.id).catch(() => {});
        renderLibrary();
      }
    });
    b.appendChild(icon); b.appendChild(meta); b.appendChild(del);
    b.addEventListener("click", () => openDoc(doc.id));
    box.appendChild(b);
  });
}
$("btn-add").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!f) return;
  loadingEl.hidden = false;
  loadingEl.textContent = "Añadiendo PDF…";
  try {
    const buf = await f.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    await dbAddPdf({
      name: f.name.replace(/\.pdf$/i, ""),
      pages: pdf.numPages,
      size: f.size,
      data: buf,
      addedAt: Date.now(),
    });
    try { await pdf.destroy(); } catch (e) {}
    await renderLibrary();
  } catch (e) {
    alert("No se pudo leer ese PDF. ¿Es un archivo PDF válido?");
  }
  loadingEl.hidden = true;
});

/* ================= Lector ================= */
let pdfDoc = null;
let docId = null;
let docName = "";
let numPages = 0;
let curPage = 1;
let pageSentences = [];

function showView(name) {
  $("view-library").classList.toggle("hidden", name !== "library");
  $("view-reader").classList.toggle("hidden", name !== "reader");
}
async function openDoc(id) {
  const doc = await dbGetPdf(id).catch(() => null);
  if (!doc) { alert("No se encontró el PDF."); return; }
  loadingEl.hidden = false;
  loadingEl.textContent = "Abriendo PDF…";
  tts.playing = false;
  bumpGen();
  releaseWakeLock();
  stopKeepalive();
  tts.chunks = []; tts.pos = 0;
  try {
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch (e) {} }
    pdfDoc = await pdfjsLib.getDocument({ data: doc.data.slice(0) }).promise;
    docId = id; docName = doc.name; numPages = pdfDoc.numPages; curPage = 1;
    $("doc-title").textContent = docName;
    $("page-slider").max = numPages;
    showView("reader");
    await renderPage(1);
  } catch (e) {
    alert("No se pudo abrir el PDF.");
    showView("library");
  }
  loadingEl.hidden = true;
}
$("btn-back").addEventListener("click", async () => {
  tts.playing = false;
  bumpGen();
  releaseWakeLock();
  stopKeepalive();
  setPlayIcon(false);
  if (pdfDoc) { try { await pdfDoc.destroy(); } catch (e) {} pdfDoc = null; }
  showView("library");
  renderLibrary();
});

async function renderPage(n) {
  n = Math.max(1, Math.min(numPages, n));
  curPage = n;
  tts.playing = false;
  bumpGen();
  tts.chunks = []; tts.pos = 0;
  setPlayIcon(false);
  clearHighlight();
  setStatus("Toca ▶ para escuchar esta página");
  $("page-indicator").textContent = `Página ${n} de ${numPages}`;
  $("page-slider").value = n;
  // Lienzo
  const page = await pdfDoc.getPage(n);
  const wrap = $("page-wrap");
  const targetW = wrap.clientWidth || window.innerWidth - 24;
  const baseVp = page.getViewport({ scale: 1 });
  const scale = (targetW / baseVp.width) * Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale });
  const canvas = $("page-canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  // Texto
  const tc = await page.getTextContent();
  let lines = [], line = "";
  tc.items.forEach((it) => {
    line += it.str + " ";
    if (it.hasEOL) { lines.push(line); line = ""; }
  });
  if (line.trim()) lines.push(line);
  pageSentences = splitSentences(lines.join("\n"));
  const box = $("sentences");
  box.innerHTML = "";
  $("no-text").classList.toggle("hidden", pageSentences.length > 0);
  pageSentences.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "sentence";
    d.dataset.i = i;
    d.textContent = s;
    d.addEventListener("click", () => startReading(i));
    box.appendChild(d);
  });
  $("reader-scroll").scrollTop = 0;
}
$("btn-prev").addEventListener("click", () => { if (curPage > 1) renderPage(curPage - 1); });
$("btn-next").addEventListener("click", () => { if (curPage < numPages) renderPage(curPage + 1); });
$("page-slider").addEventListener("change", (ev) => renderPage(parseInt(ev.target.value, 10) || 1));

/* ================= Ajustes ================= */
$("btn-settings").addEventListener("click", () => {
  ensureVoicesLoaded(true);
  $("rate-slider").value = settings.rate;
  $("rate-val").textContent = Number(settings.rate).toFixed(1) + "×";
  $("continue-next").checked = settings.continueNext;
  $("settings-sheet").classList.remove("hidden");
});
$("btn-close-settings").addEventListener("click", () => {
  $("settings-sheet").classList.add("hidden");
});
$("voice-select").addEventListener("change", (ev) => {
  settings.voiceURI = ev.target.value;
  saveSettings();
});
$("btn-reload-voices").addEventListener("click", () => ensureVoicesLoaded(true));
$("rate-slider").addEventListener("input", (ev) => {
  settings.rate = parseFloat(ev.target.value);
  $("rate-val").textContent = settings.rate.toFixed(1) + "×";
  saveSettings();
});
$("continue-next").addEventListener("change", (ev) => {
  settings.continueNext = ev.target.checked;
  saveSettings();
});
/* ================= Arranque ================= */
(async function init() {
  ensureVoicesLoaded();
  await renderLibrary();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) {}
  }
  window.__VOZPDF_BOOTED__ = true;
  loadingEl.hidden = true;
})();
