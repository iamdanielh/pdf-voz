// VozPDF — lector de PDF, EPUB, DOCX y texto con voz en español. PWA, sin internet.
import * as pdfjsLib from "./vendor/pdf.min.mjs";
import { importFile, fmtLabel } from "./importers.js";
import { chunkSentences, buildReading } from "./reader-text.js";
import { cumulative, wordAt, estimateMs, calibrate, wordMs, wordIndexMap } from "./karaoke.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).toString();

const $ = (id) => document.getElementById(id);
const loadingEl = $("loading");

/* ================= IndexedDB ================= */
// El store se llama "pdfs" desde el principio; no se renombra para no perder
// las bibliotecas ya guardadas.
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
const dbPutPdf = (doc) => dbOp("readwrite", (s) => s.put(doc));

/* ================= Ajustes ================= */
const settings = Object.assign(
  { voiceURI: "", voiceManual: false, rate: 1, continueNext: true, readSize: 19 },
  JSON.parse(localStorage.getItem("vozpdf-settings") || "{}")
);
function saveSettings() {
  localStorage.setItem("vozpdf-settings", JSON.stringify(settings));
}
// El tamaño de letra se guarda en una variable de CSS: así el texto se
// agranda de verdad, en una sola pasada y sin tocar los estilos de cada parte.
function applyReadSize() {
  const px = Math.min(30, Math.max(15, Number(settings.readSize) || 19));
  document.documentElement.style.setProperty("--read-size", px + "px");
  const out = $("size-val");
  if (out) out.textContent = px + "px";
}

/* ================= Unidades de lectura ================= */
// Cada formato tiene su propia palabra: PDF son páginas, EPUB capítulos y el
// resto secciones. Todo lo que antes hablaba de "página" pasa a hablar de la
// unidad que corresponda.
function unitWord(fmt, plural) {
  if (fmt === "pdf") return plural ? "páginas" : "página";
  if (fmt === "epub") return plural ? "capítulos" : "capítulo";
  return plural ? "secciones" : "sección";
}
const FMT_ICON = { pdf: "📄", epub: "📚", docx: "📝", txt: "📃", md: "📃" };

/* ================= Texto: frases y trozos ================= */
// Ahora viven en reader-text.js (puras y probadas aparte).

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
  chunkStartMs: 0, // cuándo empezó el trozo en curso (para calibrar el karaoke)
  chunkEstMs: 0,   // duración estimada del trozo en curso
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

const AUTO_VOICE = "__auto__";
function allVoices() {
  try { return synth.getVoices() || []; } catch (e) { return []; }
}
function esVoices() {
  return allVoices().filter((v) => (v.lang || "").toLowerCase().startsWith("es"));
}
function pickVoice() {
  const vs = esVoices();
  if (!vs.length) return null;
  // Solo se respeta la voz guardada si el usuario la eligió a mano en la app.
  // Una elección automática nunca se guarda, así que el valor viejo no puede
  // congelar la lectura en un "primer uso" viejo.
  if (settings.voiceManual) {
    const saved = vs.find((v) => v.voiceURI === settings.voiceURI);
    if (saved) return saved;
  }
  const isEnhanced = (v) => /mejorada|enhanced|premium/i.test(v.name || "");
  // En iOS, lo correcto es NO fijar u.voice: el sistema ya expone la voz
  // elegida en Ajustes → Accesibilidad → Contenido hablado → Voces como la
  // predeterminada del idioma, y asignar cualquier voz de getVoices() la pisa
  // (puede salir una voz "asset" mediocre aunque haya una mejor instalada).
  // Mismo criterio que la app de la Biblia. Solo fuera de iOS elegimos nosotros.
  if (IS_IOS) return null;
  // 1) predeterminada si es mejorada, 2) predeterminada,
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
  const autoOpt = document.createElement("option");
  autoOpt.value = AUTO_VOICE;
  sel.appendChild(autoOpt);
  vs.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})${v.default ? " — predeterminada" : ""}`;
    sel.appendChild(o);
  });
  const pv = pickVoice();
  // La etiqueta de "Automático" muestra a qué voz resuelve ahora mismo, para
  // ver cuál está mandando sin tener que abrir los Ajustes del iPhone.
  autoOpt.textContent = pv
    ? `↺ Automático: ${pv.name} (${pv.lang})`
    : "↺ Automático: predeterminada del iPhone";
  // Con elección manual la selección no salta aunque iOS reordene la lista.
  // Si la voz guardada ya no existe, se vuelve a automático.
  const manual = settings.voiceManual && vs.some((v) => v.voiceURI === settings.voiceURI);
  sel.value = manual ? settings.voiceURI : AUTO_VOICE;
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
  for (const el of sentEls) if (el) el.classList.remove("speaking");
  for (const el of paraEls) if (el) el.classList.remove("speaking");
}
// Marca las frases del trozo y el párrafo donde están. El párrafo se tiñe para
// saber de un vistazo dónde estás, y la frase para no perder el hilo en un
// párrafo largo.
function highlightChunk(chunk) {
  clearHighlight();
  if (!chunk) return;
  let first = null;
  const spoken = new Set();
  for (const i of chunk.idx) {
    const el = sentEls[i];
    if (!el) continue;
    el.classList.add("speaking");
    spoken.add(el.parentElement);
    if (!first) first = el;
  }
  for (const p of spoken) p.classList.add("speaking");
  if (first) {
    const p = first.closest(".para");
    // "center" deja la frase a media pantalla: así el ojo no corre y el texto
    // no queda debajo de los botones de abajo.
    (p || first).scrollIntoView({ block: "center", behavior: "smooth" });
    // Se anuncia la frase entera, no cada palabra: si no, el lector de pantalla
    // recitaría un flujo imposible de seguir.
    announce(first.textContent);
  }
}
let liveRegion = null;
function announce(text) {
  if (!liveRegion) liveRegion = $("live-region");
  if (liveRegion && text) liveRegion.textContent = text;
}
function setStatus(t) { $("read-status").textContent = t; }
function setPlayIcon(playing) { $("btn-play").textContent = playing ? "⏸" : "▶"; }

/* ================= Karaoke: palabra que se está leyendo ================= */
// Dos motores, mismo aspecto:
//  · voz web: el <audio> tiene línea de tiempo real, así que las palabras se
//    reparten sobre audio.currentTime. Es exacto, no deriva.
//  · voz del dispositivo (iOS): speechSynthesis no emite eventos de palabra,
//    así que se estima por longitud y se calibra con la duración real medida
//    del trozo anterior. Mismo truco que la app de la Biblia.
let karaokeTimer = null;
let karaokeWord = -1;
let calFactor = 1;   // factor de calibración del dispositivo

function clearKaraoke() {
  if (karaokeTimer) { clearTimeout(karaokeTimer); karaokeTimer = null; }
  const w = karaokeWord >= 0 ? allWords[karaokeWord] : null;
  if (w) w.classList.remove("karaoke");
  karaokeWord = -1;
}
function setKaraokeWord(words, wi) {
  if (wi === karaokeWord) return;
  const prev = karaokeWord >= 0 ? allWords[karaokeWord] : null;
  if (prev) prev.classList.remove("karaoke");
  karaokeWord = wi;
  const w = words[wi];
  if (w) {
    w.classList.add("karaoke");
    if (w.scrollIntoView) w.scrollIntoView({ block: "nearest" });
  }
}
// Palabras del trozo actual, en el orden en que se leen.
function wordsForChunk(chunk) {
  if (!chunk || !chunk.idx || !chunk.idx.length) return [];
  const first = sentWordStart[chunk.idx[0]];
  const lastS = chunk.idx[chunk.idx.length - 1];
  const end = sentWordStart[lastS] + sentWordCount[lastS];
  if (!(first >= 0) || !(end > first)) return [];
  return allWords.slice(first, end);
}
// Motor 1: anclado al audio real.
function startKaraokeAudio(chunk) {
  clearKaraoke();
  const words = wordsForChunk(chunk);
  if (!words.length) return;
  const cum = cumulative(words.map((w) => w.textContent || ""));
  const g = tts.gen;
  const tick = () => {
    if (!tts.playing || g !== tts.gen) return;
    const a = webAudio;
    if (!a || !(a.duration > 0) || !isFinite(a.duration)) {
      karaokeTimer = setTimeout(tick, 100);   // aún no hay duración
      return;
    }
    setKaraokeWord(words, wordAt(cum, a.currentTime / a.duration));
    karaokeTimer = setTimeout(tick, 55);
  };
  // Se mira casi de inmediato: si aún no hay duración, el propio bucle espera.
  karaokeTimer = setTimeout(tick, 40);
}
// Motor 2: estimación con calibración previa.
function startKaraokeTimer(chunk) {
  clearKaraoke();
  const words = wordsForChunk(chunk);
  if (!words.length) return;
  const texts = words.map((w) => w.textContent || "");
  const g = tts.gen;
  const rate = settings.rate || 1;
  const cal = Math.max(calFactor, 0.25);
  tts.chunkEstMs = estimateMs(texts, rate, cal);
  tts.chunkStartMs = Date.now();
  const tick = (wi) => {
    if (!tts.playing || g !== tts.gen) return;
    setKaraokeWord(words, wi);
    if (wi + 1 >= texts.length) { karaokeTimer = null; return; }
    const wait = Math.max(20, (wordMs(texts[wi]) / rate) * cal);
    karaokeTimer = setTimeout(() => tick(wi + 1), wait);
  };
  tick(0);
}

function speakChunk() {
  const chunk = tts.chunks[tts.pos];
  if (!chunk) { finishReading(); return; }
  // Sin synth.cancel() aquí: el enunciado anterior ya terminó. Cancelar y
  // hablar de inmediato hace que iOS trague enunciados o dispare onend
  // tardíos que saltaban párrafos al azar.
  stopWebAudio(); // por si el perro guardián re-dispara un trozo atascado
  const g = tts.gen;
  highlightChunk(chunk);
  savePosition(curSection, chunk.idx[0]);
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
      onstart: () => {
        if (tts.gen !== g || !tts.playing) { stopWebAudio(); return; }
        startKaraokeAudio(chunk);
      },
      onend: () => { clearKaraoke(); advance(); },
      onfail: () => {
        clearKaraoke();
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
  // El karaoke arranca con el onset real si iOS lo notifica; si no, tras un
  // pellizco, porque speechSynthesis a veces no dispara onstart.
  let onset = false;
  const beginKaraoke = () => {
    if (onset) return;
    onset = true;
    if (!tts.playing || tts.gen !== g) return;
    startKaraokeTimer(chunk);
  };
  u.onstart = beginKaraoke;
  setTimeout(beginKaraoke, 250);
  u.onend = () => {
    if (!tts.playing || tts.gen !== g) return; // enunciado viejo: ignorar
    // iOS a veces "termina" un enunciado al instante sin hablarlo: reintentar
    // el mismo trozo en vez de saltarlo.
    if (Date.now() - startedAt < 300 && tts.fastRetries < 3) {
      tts.fastRetries++;
      tts.lastActivity = Date.now();
      clearKaraoke();
      speakChunk();
      return;
    }
    tts.fastRetries = 0;
    // El trozo se leyó de verdad: aprovechamos para aprender el ritmo real.
    if (onset && tts.chunkEstMs > 0) {
      calFactor = calibrate(calFactor, Date.now() - tts.chunkStartMs, tts.chunkEstMs);
    }
    clearKaraoke();
    advance();
  };
  u.onerror = () => {
    if (!tts.playing || tts.gen !== g) return; // enunciado viejo: ignorar
    tts.fastRetries = 0;
    clearKaraoke();
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
  if (!sectionSentences.length) return;
  bumpGen();
  tts.chunks = chunkSentences(sectionSentences, fromSentence);
  tts.pos = 0;
  tts.fastRetries = 0;
  tts.chunkEstMs = 0;
  webVoiceDead = false; // reintentar la voz web en cada lectura nueva
  calFactor = 1;         // cada lectura vuelve a calibrar desde cero
  tts.playing = true;
  setPlayIcon(true);
  acquireWakeLock();
  startKeepalive();
  speakChunk();
}
function pauseReading() {
  tts.playing = false;
  bumpGen();
  clearKaraoke();
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
  clearKaraoke();
  clearHighlight();
  // Al terminar la sección, seguir con la siguiente si está activado.
  if (doc && settings.continueNext && curSection < doc.sections.length - 1) {
    setStatus(`Pasando a la ${unitWord(doc.fmt)} siguiente…`);
    goToSection(curSection + 1).then(() => startReading(0)).catch(() => {
      releaseWakeLock();
      stopKeepalive();
      setStatus(`Toca ▶ para escuchar esta ${unitWord(doc.fmt)}`);
    });
    return;
  }
  releaseWakeLock();
  stopKeepalive();
  setStatus(`Toca ▶ para escuchar esta ${unitWord(doc.fmt)}`);
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
  list.sort((a, b) => b.addedAt - a.addedAt).forEach((d) => {
    const b = document.createElement("button");
    b.className = "pdf-item";
    const meta = document.createElement("div");
    meta.className = "pdf-meta";
    const name = document.createElement("div");
    name.className = "pdf-name";
    name.textContent = d.name;
    // Los PDF antiguos aún no tienen `sections`: caemos a `pages`.
    const fmt = d.fmt || "pdf";
    const n = (d.sections && d.sections.length) || d.pages || 0;
    const sub = document.createElement("div");
    sub.className = "pdf-sub";
    sub.textContent = n
      ? `${fmtLabel(fmt).toUpperCase()} · ${n} ${unitWord(fmt, n !== 1)} · ${fmtDate(d.addedAt)}`
      : `${fmtLabel(fmt).toUpperCase()} · ${fmtDate(d.addedAt)}`;
    meta.appendChild(name); meta.appendChild(sub);
    const icon = document.createElement("span");
    icon.className = "pdf-icon"; icon.textContent = FMT_ICON[fmt] || "📄";
    const del = document.createElement("button");
    del.className = "pdf-del"; del.textContent = "×"; del.setAttribute("aria-label", "Eliminar");
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (confirm(`¿Eliminar "${d.name}" de tu biblioteca?`)) {
        await dbDeletePdf(d.id).catch(() => {});
        renderLibrary();
      }
    });
    b.appendChild(icon); b.appendChild(meta); b.appendChild(del);
    b.addEventListener("click", () => openDoc(d.id));
    box.appendChild(b);
  });
}
$("btn-add").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!f) return;
  loadingEl.hidden = false;
  loadingEl.textContent = "Leyendo documento…";
  try {
    const r = await importFile(f, { pdfjsLib });
    // Para PDF guardamos el binario original, que hace falta para el lienzo.
    // EPUB/DOCX/TXT/MD solo necesitan el texto ya extraído.
    const rec = r.fmt === "pdf"
      ? { name: r.name, fmt: r.fmt, sections: r.sections, size: r.size, data: r.data, addedAt: Date.now() }
      : { name: r.name, fmt: r.fmt, sections: r.sections, size: r.size, addedAt: Date.now() };
    await dbAddPdf(rec);
    await renderLibrary();
  } catch (e) {
    alert(e && e.message ? e.message : "No se pudo leer ese archivo.");
  }
  loadingEl.hidden = true;
});

/* ================= Lector ================= */
let pdfDoc = null;        // solo existe para PDF
let docId = null;
let docName = "";
let doc = null;           // { fmt, sections: [{ label, text }], data? }
let curSection = 0;
let sectionSentences = [];  // frases de la sección actual, en orden
let allWords = [];          // <span class="w"> de la sección actual
let sentWordStart = [];     // frase i -> primer índice en allWords
let sentWordCount = [];     // frase i -> cuántas palabras tiene
let sentEls = [];           // frase i -> <span class="sent">
let paraEls = [];           // párrafo i -> <p class="para">
let lastRead = { section: 0, sentence: 0 };  // dónde lo dejamos, para volver
let restorePending = 0;
let saveTimer = null;
// Guardar la posición en el mismo registro del documento, para no tener que
// llevar una lista aparte. Se aplaza un poco: al avanzar por las frases se
// llama muchas veces seguidas y no hace falta escribir en disco cada vez.
function savePosition(section, sentence) {
  lastRead = { section, sentence };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!doc || doc.id == null) return;
    doc.lastRead = lastRead;
    try { await dbPutPdf(doc); } catch (e) {}
  }, 800);
}

function showView(name) {
  $("view-library").classList.toggle("hidden", name !== "library");
  $("view-reader").classList.toggle("hidden", name !== "reader");
}
async function openDoc(id) {
  const rec = await dbGetPdf(id).catch(() => null);
  if (!rec) { alert("No se encontró el documento."); return; }
  loadingEl.hidden = false;
  loadingEl.textContent = "Abriendo…";
  tts.playing = false;
  bumpGen();
  releaseWakeLock();
  stopKeepalive();
  tts.chunks = []; tts.pos = 0;
  try {
    // Los PDF guardados por versiones antiguas solo tienen `pages`, sin
    // `sections`: se extrae el texto una vez y se guarda ya normalizado.
    let d = rec;
    if (!d.fmt) d.fmt = "pdf";
    if (!d.sections || !d.sections.length) {
      loadingEl.textContent = "Preparando texto…";
      const parsed = await importFile(new File([d.data], (d.name || "libro") + ".pdf"), { pdfjsLib });
      d = { ...d, fmt: parsed.fmt, sections: parsed.sections };
      try { await dbPutPdf(d); } catch (e) { /* si no se guarda, igual se lee */ }
    }
    if (d.fmt === "pdf") {
      if (pdfDoc) { try { await pdfDoc.destroy(); } catch (e) {} }
      pdfDoc = await pdfjsLib.getDocument({ data: d.data.slice(0) }).promise;
    } else if (pdfDoc) {
      try { await pdfDoc.destroy(); } catch (e) {}
      pdfDoc = null;
    }
    doc = d;
    docId = id; docName = d.name; curSection = 0;
    // Volver donde lo dejó la última vez, no al principio del libro.
    lastRead = (d.lastRead && typeof d.lastRead.section === "number") ? d.lastRead : { section: 0, sentence: 0 };
    restorePending = lastRead.sentence || 0;
    $("doc-title").textContent = docName;
    $("page-slider").max = d.sections.length;
    showView("reader");
    await renderSection(lastRead.section || 0, restorePending);
    if (lastRead.section) {
      const u = unitWord(doc.fmt);
      setStatus(`Continuando donde lo dejaste — toca ▶ para escuchar esta ${u}`);
    }
  } catch (e) {
    alert("No se pudo abrir el documento.");
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
  clearKaraoke();
  if (pdfDoc) { try { await pdfDoc.destroy(); } catch (e) {} pdfDoc = null; }
  doc = null;
  showView("library");
  renderLibrary();
});

async function renderSection(n, restore = 0) {
  if (!doc || !doc.sections.length) return;
  n = Math.max(0, Math.min(doc.sections.length - 1, n));
  curSection = n;
  tts.playing = false;
  bumpGen();
  tts.chunks = []; tts.pos = 0;
  setPlayIcon(false);
  clearHighlight();
  clearKaraoke();
  const u = unitWord(doc.fmt);
  setStatus(`Toca ▶ para escuchar esta ${u}`);
  $("page-indicator").textContent =
    `${u[0].toUpperCase() + u.slice(1)} ${n + 1} de ${doc.sections.length}`;
  $("page-slider").value = n + 1;
  $("page-slider").setAttribute("aria-valuetext", $("page-indicator").textContent);

  const text = doc.sections[n].text;
  const reading = buildReading(text);
  sectionSentences = reading.sentences;
  allWords = []; sentWordStart = []; sentWordCount = [];
  sentEls = []; paraEls = [];
  const box = $("sentences");
  box.innerHTML = "";
  $("no-text").classList.toggle("hidden", sectionSentences.length > 0);

  // Se pinta por párrafos, no por frases: el texto queda seguido, como en un
  // libro, en vez de una caja por frase.
  const wmap = wordIndexMap(sectionSentences);
  sentWordStart = wmap.start;
  sentWordCount = wmap.count;
  let wi = 0;
  reading.paras.forEach((para, pi) => {
    const pe = document.createElement("p");
    pe.className = "para";
    // El párrafo es pulsable para empezar a leer por ahí. role + tabindex
    // hacen que un lector de pantalla también lo pueda activar, no solo un dedo.
    pe.setAttribute("role", "button");
    pe.tabIndex = 0;
    pe.setAttribute("aria-label",
      `Leer desde aquí: ${para.text.slice(0, 60)}${para.text.length > 60 ? "…" : ""}`);
    para.sentences.forEach((s, k) => {
      const i = para.start + k;
      const se = document.createElement("span");
      se.className = "sent";
      for (const part of String(s).split(/(\s+)/)) {
        if (!part) continue;
        if (!/\S/.test(part)) { se.appendChild(document.createTextNode(part)); continue; }
        const w = document.createElement("span");
        w.className = "w";
        w.textContent = part;
        se.appendChild(w);
        allWords.push(w);
        wi++;
      }
      sentEls[i] = se;
      pe.appendChild(se);
      pe.appendChild(document.createTextNode(" "));
    });
    paraEls[pi] = pe;
    const go = () => { pe.classList.add("pressed");
      setTimeout(() => pe.classList.remove("pressed"), 220);
      startReading(para.start); };
    pe.addEventListener("click", go);
    pe.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
    });
    box.appendChild(pe);
  });

  // Imagen de la página: solo si la página no tiene texto (entonces es lo único
  // que hay) o si el usuario la pide a mano. Si ya hay texto, repetirlo en
  // imagen solo estorba.
  const wrap = $("page-wrap");
  const hasText = sectionSentences.length > 0;
  const toggle = $("page-toggle");
  const isPdf = doc.fmt === "pdf" && pdfDoc;
  if (isPdf) {
    toggle.hidden = false;
    if (!hasText || showPageImage) {
      wrap.hidden = false;
      await drawPage(n);
      toggle.textContent = hasText ? "Ocultar imagen de la página" : "Imagen de la página";
    } else {
      wrap.hidden = true;
      toggle.textContent = "Ver la página tal cual";
    }
  } else {
    wrap.hidden = true;
    toggle.hidden = true;
  }

  if (restore > 0 && paraEls.length) {
    // Volver donde lo dejamos: al párrafo que contenía la frase `restore`.
    let target = null;
    for (let i = 0; i < paraEls.length; i++) {
      const p = reading.paras[i];
      if (p && restore >= p.start && restore < p.end) { target = paraEls[i]; break; }
    }
    if (!target && paraEls[0]) target = paraEls[0];
    if (target) {
      target.scrollIntoView({ block: "start" });
      target.classList.add("speaking");
    }
  } else {
    $("reader-scroll").scrollTop = 0;
    // Llegar a una sección a mano también cuenta como "aquí lo dejé": si
    // alguien va a la página 5 y cierra el libro, debe volver a la 5 y no
    // a la última frase que sonó.
    savePosition(n, 0);
  }
}
let showPageImage = false;
async function drawPage(n) {
  const wrap = $("page-wrap");
  const page = await pdfDoc.getPage(n + 1);
  const targetW = wrap.clientWidth || window.innerWidth - 40;
  const baseVp = page.getViewport({ scale: 1 });
  const scale = (targetW / baseVp.width) * Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale });
  const canvas = $("page-canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  page.cleanup();
}
$("page-toggle").addEventListener("click", async () => {
  showPageImage = $("page-wrap").hidden;
  await renderSection(curSection, restorePending);
});
// Al cambiar de sección a mano se empieza por su principio: `restorePending`
// era para reabrir el documento, no para saltar de una sección a otra.
function goToSection(n) {
  restorePending = 0;
  return renderSection(n);
}
$("btn-prev").addEventListener("click", () => { if (curSection > 0) goToSection(curSection - 1); });
$("btn-next").addEventListener("click", () => { if (doc && curSection < doc.sections.length - 1) goToSection(curSection + 1); });
$("page-slider").addEventListener("change", (ev) => goToSection((parseInt(ev.target.value, 10) || 1) - 1));

/* ================= Ajustes ================= */
let sheetReturnFocus = null;
function openSettings() {
  ensureVoicesLoaded(true);
  $("rate-slider").value = settings.rate;
  $("rate-val").textContent = Number(settings.rate).toFixed(1) + "×";
  $("size-slider").value = settings.readSize;
  $("size-val").textContent = (settings.readSize || 19) + "px";
  $("continue-next").checked = settings.continueNext;
  const sheet = $("settings-sheet");
  sheet.classList.remove("hidden");
  // Guardamos dónde estaba el foco para devolverlo al cerrar. Si no era un
  // control (por ejemplo, se abrió con un toque y el foco seguía en el
  // documento), usamos el propio botón de ajustes: si no, el foco se perdía.
  sheetReturnFocus = document.activeElement;
  const first = sheet.querySelector("select, input, button");
  if (first) first.focus();
}
function closeSettings() {
  $("settings-sheet").classList.add("hidden");
  const back = sheetReturnFocus;
  if (back && back.focus && back !== document.body) back.focus();
  else $("btn-settings").focus();
  sheetReturnFocus = null;
}
$("btn-settings").addEventListener("click", openSettings);
$("btn-close-settings").addEventListener("click", closeSettings);
// Escape cierra los ajustes y Tab queda atrapado dentro mientras están abiertos.
$("settings-sheet").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { ev.preventDefault(); closeSettings(); return; }
  if (ev.key !== "Tab") return;
  const f = Array.from($("settings-sheet").querySelectorAll(
    "select, input, button, [tabindex]:not([tabindex='-1'])"))
    .filter((el) => el.offsetParent !== null && !el.disabled);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});
// Tocar fuera del panel también lo cierra.
$("settings-sheet").addEventListener("click", (ev) => {
  if (ev.target === $("settings-sheet")) closeSettings();
});
$("voice-select").addEventListener("change", (ev) => {
  if (ev.target.value === AUTO_VOICE) {
    // Volver a automático: borrar el pin para que la app vuelva a seguir a iOS.
    settings.voiceManual = false;
    settings.voiceURI = "";
  } else {
    settings.voiceManual = true;
    settings.voiceURI = ev.target.value;
  }
  saveSettings();
  refreshVoiceList(); // repinta la etiqueta de "Automático" y fija la selección
});
$("btn-reload-voices").addEventListener("click", () => ensureVoicesLoaded(true));
$("rate-slider").addEventListener("input", (ev) => {
  settings.rate = parseFloat(ev.target.value);
  $("rate-val").textContent = settings.rate.toFixed(1) + "×";
  calFactor = 1; // la calibración es por velocidad: al cambiarla, a cero
  saveSettings();
});
$("size-slider").addEventListener("input", (ev) => {
  settings.readSize = parseInt(ev.target.value, 10);
  applyReadSize();
  saveSettings();
});
$("continue-next").addEventListener("change", (ev) => {
  settings.continueNext = ev.target.checked;
  saveSettings();
});
/* ================= Arranque ================= */
(async function init() {
  ensureVoicesLoaded();
  applyReadSize();
  await renderLibrary();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) {}
  }
  window.__VOZPDF_BOOTED__ = true;
  loadingEl.hidden = true;
})();
