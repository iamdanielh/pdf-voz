// Texto: troceado en frases y en trozos aptos para el TTS.
// Funciones puras, sin DOM: se pueden probar aparte (ver reader-test.mjs).

// Divide un texto en frases. El texto se aplana antes, así que los saltos de
// línea de un TXT o de un EPUB no crean frases sueltas.
export function splitSentences(text) {
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
// `idx` guarda qué frases van en cada trozo, que es lo que permite luego
// resaltar las palabras justas de ese trozo.
export function chunkSentences(sentences, startIdx = 0, maxLen = 170) {
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
