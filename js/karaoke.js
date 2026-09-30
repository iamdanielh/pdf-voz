// Karaoke: cálculo de tiempos para resaltar la palabra que se está leyendo.
// speechSynthesis NO emite eventos de palabra en iOS, así que el tiempo se
// estima; el motor con audio real (voz web) se ancla a su currentTime, que sí
// es la verdad. Mismo enfoque que la app de la Biblia, con la calibración
// separada en funciones puras para poder probarlo sin DOM.

export const CHAR_MS = 62;  // ms por carácter a velocidad 1.0
export const GAP_MS = 50;   // pausa entre palabras

// Peso temporal de cada palabra: una palabra larga tarda más que una corta.
export function wordMs(word) {
  return GAP_MS + CHAR_MS * Math.max(1, (word || "").length);
}

// Pesos acumulados dentro de un trozo, para repartir una posición 0..1.
export function cumulative(words) {
  let acc = 0;
  return words.map((w) => (acc += wordMs(w)));
}

// Índice de la palabra para una posición normalizada p (0..1) del trozo.
// Los valores de `cum` son finales de palabra, así que la palabra buscada es la
// PRIMERA cuyo final todavía no se ha superado.
export function wordAt(cum, p) {
  const n = cum.length;
  if (!n) return -1;
  const total = cum[n - 1] || 1;
  const target = Math.min(1, Math.max(0, p)) * total;
  for (let k = 0; k < n; k++) {
    if (cum[k] > target) return k;
  }
    return n - 1;   // p = 1 exacto: última palabra
}

// Reparte las palabras de las frases sobre un índice global: por cada frase
// dice desde qué palabra global empieza y cuántas tiene. Es el puente entre
// los trozos que arma chunkSentences y el resaltado palabra a palabra.
// Cuenta los mismos tokens que el reparto en <span> de app.js: todo trozo con
// algún carácter que no sea espacio (los saltos y el nbsp también cuentan como
// separadores, igual que al partir).
export function wordIndexMap(sentences) {
  const start = [];
  const count = [];
  let acc = 0;
  for (const s of sentences) {
    const n = (String(s == null ? "" : s).match(/\S+/g) || []).length;
    start.push(acc);
    count.push(n);
    acc += n;
  }
  return { start, count, total: acc };
}

// Duración estimada de un trozo entero, al rate y factor de calibración dados.
export function estimateMs(words, rate, cal = 1) {
  const r = rate > 0 ? rate : 1;
  const c = cal > 0 ? cal : 1;
  let total = 0;
  for (const w of words) total += wordMs(w);
  return total / r * c;
}

// Factor de calibración: cuánto se desvía realmente este dispositivo del
// cálculo. Se suaviza con EMA para que un trozo raro no lo descoloque.
export function calibrate(prev, measuredMs, estimatedMs) {
  if (!(measuredMs > 0) || !(estimatedMs > 0)) return prev;
  const f = measuredMs / estimatedMs;
  if (f < 0.3 || f > 3) return prev;  // pausas o fallos: descartar
  return prev === 1 ? f : prev * 0.6 + f * 0.4;
}
