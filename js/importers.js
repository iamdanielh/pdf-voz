// Importadores de documentos. Todos producen el mismo modelo:
//   { name, fmt, sections: [{ label, text }], data }
// Un "section" es la unidad de lectura (página, capítulo, bloque). El texto se
// extrae UNA vez al importar; el lector nunca vuelve a parsear el archivo.

/* ================= Utilidades de texto ================= */

// Tabla de entidades HTML. El suplemento Latin-1 (160-255) se genera de los
// nombres canónicos para no teclear 96 entradas a mano.
const LATIN1_NAMES = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy " +
  "reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 " +
  "frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml " +
  "Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute " +
  "Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute " +
  "ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash " +
  "ugrave uacute ucirc uuml yacute thorn yuml").split(" ");
const ENTITIES = (() => {
  const e = Object.create(null);
  LATIN1_NAMES.forEach((n, i) => { e[n] = String.fromCodePoint(160 + i); });
  Object.assign(e, {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š",
    Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜", ensp: " ",
    emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
    lrm: "‎", rlm: "‏", ndash: "–", mdash: "—",
    lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
    bdquo: "„", dagger: "†", Dagger: "‡", bull: "•",
    hellip: "…", permil: "‰", prime: "′", Prime: "″",
    lsaquo: "‹", rsaquo: "›", oline: "‾", frasl: "⁄",
    euro: "€", trade: "™", minus: "−", le: "≤",
    ge: "≥", ne: "≠", larr: "←", uarr: "↑", rarr: "→",
    darr: "↓", harr: "↔", infin: "∞",
  });
  e.nbsp = " ";   // el espacio duro no aporta nada al TTS
  e.shy = "";     // el guion blando tampoco
  e.zwnj = e.zwj = "";
  return e;
})();
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const key = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}
// Colapsa espacios pero conserva los saltos de párrafo como líneas en blanco.
function tidy(s) {
  return String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// Agrupa párrafos en secciones de tamaño legible para la voz.
function packSections(paragraphs, target = 3500) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    cur.push(p.trim());
    n += p.length;
    if (n >= target) { out.push(cur.join("\n\n")); cur = []; n = 0; }
  }
  if (cur.length) out.push(cur.join("\n\n"));
  return out;
}

/* ================= ZIP (DOCX / EPUB) ================= */
// Lector de ZIP mínimo sobre el índice central. La descompresión usa
// DecompressionStream nativo, así que no hace falta ninguna librería.
const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export function hasNativeInflate() {
  return typeof DecompressionStream === "function";
}

function findEocd(dv, len) {
  const max = Math.min(len, 66000); // el comentario EOCD es de 64 KiB máx.
  let firstSig = -1;
  for (let i = len - 22; i >= 0 && i >= len - max; i--) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    if (firstSig < 0) firstSig = i;
    // Solo es el EOCD real si el largo del comentario cierra el archivo. Esto
    // descarta falsos positivos sobre datos ajenos o relleno.
    if (i + 22 + dv.getUint16(i + 20, true) === len) return i;
  }
  return firstSig;
}

// Devuelve un Map con nombre → bytes descomprimidos, solo de las entradas pedidas.
export async function unzip(buf, wanted) {
  if (!hasNativeInflate()) {
    throw new Error("Este navegador no puede descomprimir (falta DecompressionStream). Actualiza iOS/Safari.");
  }
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const eocd = findEocd(dv, u8.length);
  if (eocd < 0) throw new Error("El archivo no parece un ZIP válido.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const need = wanted ? new Set(wanted) : null;
  const out = new Map();

  for (let i = 0; i < count && p + 46 <= u8.length; i++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (need && !need.has(name)) continue;
    // El tamaño real siempre está en el índice central; la cabecera local puede
    // tener ceros si elbit 3 (descriptor) está activo.
    if (localOff + 30 > u8.length || dv.getUint32(localOff, true) !== SIG_LOC) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + compSize);
    try {
      if (method === 0) out.set(name, raw);
      else if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
      }
      // otros métodos (bzip2, etc.) no se usan en DOCX/EPUB: se omiten.
    } catch (e) { /* entrada corrupta: se ignora y sigue */ }
  }
  return out;
}

/* ================= HTML/XHTML → texto ================= */
const SKIP_BLOCK = /<(script|style|head|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const PARA_CLOSE = /<\/(p|div|h[1-6]|blockquote|section|article|figcaption|pre|dd|dt|tr)\s*>/gi;
const PARA_OPEN = /<(p|div|h[1-6]|blockquote|section|article|pre)\b[^>]*>/gi;
const LINE_BREAK = /<br\s*\/?>|<hr\s*\/?>/gi;

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(SKIP_BLOCK, " ");
  // Las celdas se unen con hueco para que "A" "B" no se lea como "AB".
  s = s.replace(/<\/(td|th)\s*>/gi, "  ");
  // Los items de lista van uno por línea (sin salto doble).
  s = s.replace(/<li\b[^>]*>/gi, "\n• ");
  s = s.replace(PARA_CLOSE, "\n\n");
  s = s.replace(PARA_OPEN, "\n\n");
  s = s.replace(LINE_BREAK, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
// DOCX: párrafos <w:p> con runs <w:t>; <w:tab>/<w:br> cuentan como separadores.
export function docxXmlToText(xml) {
  const s = String(xml).replace(/<w:p\b[^>]*>/gi, "\u0000");
  return tidy(
    s
      .replace(/<w:tab\b[^>]*\/?>/gi, " ")
      .replace(/<w:br\b[^>]*\/?>/gi, "\n")
      .replace(/<\/w:p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u0000/g, "\n\n")
      .split("\n")
      .map(decodeEntities)
      .join("\n")
  );
}
// Saca el título de un OPF/EPUB.
function opfTitle(xml) {
  const m = String(xml).match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  return m ? tidy(htmlToText(m[1])) : "";
}

/* ================= Importadores ================= */

// pdfjsLib se recibe desde app.js para no cargarlo dos veces ni tocar dos veces
// el worker: aquí solo se extrae el texto por página.
export async function importPdf(pdfjsLib, buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  const sections = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    let lines = [], line = "";
    tc.items.forEach((it) => {
      line += it.str + " ";
      if (it.hasEOL) { lines.push(line); line = ""; }
    });
    if (line.trim()) lines.push(line);
    sections.push({ label: `Página ${n}`, text: tidy(lines.join("\n")) });
    page.cleanup();
  }
  try { await pdf.destroy(); } catch (e) {}
  return { sections, data: buf, pageCount: pdf.numPages };
}

export async function importEpub(file, buf) {
  const zip = await unzip(buf); // primero leemos el contenedor
  const cont = zip.get("META-INF/container.xml");
  if (!cont) throw new Error("El EPUB no tiene META-INF/container.xml.");
  const opfPath = (new TextDecoder("utf-8").decode(cont).match(/full-path\s*=\s*"([^"]+)"/i) || [])[1];
  if (!opfPath) throw new Error("El EPUB no declara el OPF raíz.");
  const opf = zip.get(opfPath);
  if (!opf) throw new Error("No se encontró el OPF del EPUB.");
  const opfXml = new TextDecoder("utf-8").decode(opf);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  // spine → orden de lectura; manifest → id → href
  const manifest = new Map();
  const itemRe = /<item\b[^>]*>/gi;
  let im;
  while ((im = itemRe.exec(opfXml))) {
    const id = (im[0].match(/\bid\s*=\s*"([^"]*)"/i) || [])[1];
    const href = (im[0].match(/\bhref\s*=\s*"([^"]*)"/i) || [])[1];
    const mt = (im[0].match(/\bmedia-type\s*=\s*"([^"]*)"/i) || [])[1] || "";
    if (id && href) manifest.set(id, { href, mt });
  }
  const spine = [];
  const refRe = /<itemref\b[^>]*>/gi;
  let rm;
  while ((rm = refRe.exec(opfXml))) {
    const idref = (rm[0].match(/\bidref\s*=\s*"([^"]*)"/i) || [])[1];
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
  }
  if (!spine.length) throw new Error("El EPUB no tiene spine (no se puede ordenar la lectura).");

  const sections = [];
  for (const it of spine) {
    if (it.mt && !/xhtml|html/i.test(it.mt)) continue;
    const path = base + decodeURIComponent(it.href.split("#")[0]);
    const data = zip.get(path);
    if (!data) continue;
    const text = htmlToText(new TextDecoder("utf-8").decode(data));
    if (!text) continue;
    sections.push({ label: "", text });
  }
  if (!sections.length) throw new Error("El EPUB no contiene texto legible.");
  const title = opfTitle(opfXml);
  return { sections, title, data: null, pageCount: 0 };
}

export async function importDocx(file, buf) {
  const zip = await unzip(buf, ["word/document.xml"]);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new Error("El .docx no contiene word/document.xml.");
  const paras = docxXmlToText(new TextDecoder("utf-8").decode(doc))
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!paras.length) throw new Error("El .docx no contiene texto legible.");
  const sections = packSections(paras).map((text) => ({ label: "", text }));
  return { sections, data: null, pageCount: 0 };
}

export async function importText(file, buf) {
  const text = tidy(new TextDecoder("utf-8").decode(buf));
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (!paras.length) throw new Error("El archivo está vacío.");
  return { sections: packSections(paras).map((t) => ({ label: "", text: t })), data: null, pageCount: 0 };
}

const BY_EXT = {
  pdf: importPdf,
  epub: importEpub,
  docx: importDocx,
  txt: importText,
  md: importText,
  markdown: importText,
};

export function extOf(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
export function fmtLabel(fmt) {
  return { pdf: "PDF", epub: "EPUB", docx: "DOCX", txt: "Texto", md: "Markdown" }[fmt] || "Documento";
}
// Punto de entrada: elige importador y normaliza al modelo común.
// opts.pdfjsLib es obligatorio solo para PDF.
export async function importFile(file, opts = {}) {
  const ext = extOf(file.name);
  const fn = BY_EXT[ext];
  if (!fn) throw new Error(`Formato no admitido: .${ext || "?"}. Usa PDF, EPUB, DOCX, TXT o MD.`);
  const buf = await file.arrayBuffer();
  let r;
  if (ext === "pdf") {
    if (!opts.pdfjsLib) throw new Error("No se pudo cargar el lector de PDF.");
    r = await importPdf(opts.pdfjsLib, buf);
  } else {
    r = await fn(file, buf);
  }
  const name = String(file.name).replace(/\.[a-z0-9]+$/i, "") || "Documento";
  const title = r.title && r.title.trim();
  return {
    name: title && title !== name ? `${name} — ${title}` : name,
    fmt: ext,
    sections: r.sections,
    data: r.data || null,
    size: file.size,
  };
}
