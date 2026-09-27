// VozPDF — lector de PDFs con voz en español. PWA, funciona sin internet.
import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

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
const tts = {
  chunks: [],
  pos: 0,
  playing: false,
  lastActivity: 0,
  onPageEnd: null,
};

function esVoices() {
  try {
    return synth.getVoices().filter((v) => (v.lang || "").toLowerCase().startsWith("es"));
  } catch (e) { return []; }
}
function pickVoice() {
  const vs = esVoices();
  if (!vs.length) return null;
  return vs.find((v) => v.voiceURI === settings.voiceURI) || vs[0];
}
function refreshVoiceList() {
  const sel = $("voice-select");
  const vs = esVoices();
  sel.innerHTML = "";
  if (!vs.length) {
    $("voice-note").classList.remove("hidden");
    return;
  }
  $("voice-note").classList.add("hidden");
  vs.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  });
  const pv = pickVoice();
  if (pv) sel.value = pv.voiceURI;
}
if ("onvoiceschanged" in synth) synth.onvoiceschanged = refreshVoiceList;

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
  try { synth.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(chunk.text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = (v && v.lang) || "es-ES";
  u.rate = settings.rate || 1;
  tts.lastActivity = Date.now();
  u.onend = () => {
    if (!tts.playing) return;
    tts.pos++;
    tts.lastActivity = Date.now();
    speakChunk();
  };
  u.onerror = () => {
    if (!tts.playing) return;
    tts.pos++;
    speakChunk();
  };
  highlightChunk(chunk);
  setStatus(`Leyendo… (${tts.pos + 1}/${tts.chunks.length})`);
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
  try { synth.cancel(); } catch (e) {}
  tts.chunks = chunkSentences(pageSentences, fromSentence);
  tts.pos = 0;
  tts.playing = true;
  setPlayIcon(true);
  speakChunk();
}
function pauseReading() {
  tts.playing = false;
  try { synth.cancel(); } catch (e) {}
  setPlayIcon(false);
  setStatus("En pausa — toca ▶ para seguir");
}
function resumeReading() {
  if (!tts.chunks.length || tts.pos >= tts.chunks.length) { startReading(0); return; }
  tts.playing = true;
  setPlayIcon(true);
  speakChunk();
}
function finishReading() {
  tts.playing = false;
  try { synth.cancel(); } catch (e) {}
  setPlayIcon(false);
  clearHighlight();
  // Al terminar la página, seguir con la siguiente si está activado.
  if (settings.continueNext && curPage < numPages && pdfDoc) {
    setStatus("Pasando a la página siguiente…");
    renderPage(curPage + 1).then(() => startReading(0)).catch(() => {
      setStatus("Toca ▶ para escuchar esta página");
    });
    return;
  }
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
  try { synth.cancel(); } catch (e) {}
  tts.playing = false; tts.chunks = []; tts.pos = 0;
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
  try { synth.cancel(); } catch (e) {}
  setPlayIcon(false);
  if (pdfDoc) { try { await pdfDoc.destroy(); } catch (e) {} pdfDoc = null; }
  showView("library");
  renderLibrary();
});

async function renderPage(n) {
  n = Math.max(1, Math.min(numPages, n));
  curPage = n;
  tts.playing = false;
  try { synth.cancel(); } catch (e) {}
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
  refreshVoiceList();
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
  refreshVoiceList();
  await renderLibrary();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) {}
  }
  window.__VOZPDF_BOOTED__ = true;
  loadingEl.hidden = true;
})();
