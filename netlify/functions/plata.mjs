// Ayudante que lee el presupuesto (Google Sheet «Buchhaltung») para la
// pestaña Plata de QueJuicio.
//
// ¿Por qué hace falta? El Sheet es privado y para leerlo hace falta una llave
// (una cuenta de servicio de Google con permiso de Lector). Esa llave no puede
// estar en la app ni en el repo, que es público: vive en las variables de
// entorno de Netlify y solo la usa este archivo, en el servidor.
//
// Dos candados antes de entregar un solo número:
//   1. el código de hogar (CODIGO_HOGAR), como el ayudante de Notion, pero
//      aquí es obligatorio;
//   2. el PIN de quien abre Plata (PIN_TANIA o PIN_JC), con límite de
//      intentos: 5 fallos seguidos → bloqueo de 15 minutos, y cada bloqueo
//      siguiente dura el doble (máximo 24 h). El contador vive en Netlify
//      Blobs (un almacén pequeño de Netlify), no en el teléfono.
// Con el PIN correcto entrega una «sesión» firmada que dura 15 minutos; con
// ella la app puede volver a pedir los datos sin repetir el PIN.
//
//   POST /.netlify/functions/plata   { quien: "tania" | "jc", pin: "1234" }
//        → { sesion, expira, datos }
//   GET  /.netlify/functions/plata   (Authorization: Bearer <sesion>)
//        → { expira, datos }
// Las dos llevan la cabecera x-codigo-hogar. `datos` tiene el formato que se
// describe al inicio de plata.js (en la raíz del repo).
//
// Variables de entorno en Netlify: GOOGLE_SA_JSON (la clave JSON completa),
// SHEET_ID, CODIGO_HOGAR, PIN_TANIA y PIN_JC. Ver README.

import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const SESION_MS = 15 * 60 * 1000;
const FALLOS_MAX = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const BLOQUEO_MAX_MS = 24 * 60 * 60 * 1000;
const PINES = { tania: "PIN_TANIA", jc: "PIN_JC" };

// El Resumen trae los totales (aquí no se recalcula nada) y su columna S
// «Tipo» dice qué filas son categorías; B1 es el año y B2 «Datos hasta».
// Movimientos trae el detalle (A–H; el texto del banco NO se manda).
// Colombia trae los envíos (sección «APORTES DESDE ALEMANIA») y las comisiones.
const RANGO_RESUMEN = "Resumen!A:S";
const RANGO_MOVIMIENTOS = "Movimientos!A2:H";
const RANGO_COLOMBIA = "Colombia!A:M";

const responder = (codigo, cuerpo) =>
  new Response(JSON.stringify(cuerpo), {
    status: codigo,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// Un error con lo que hay que contestarle a la app.
function falla(status, error, mensaje, extra = {}) {
  return Object.assign(new Error(mensaje), { status, error, extra });
}

// Compara dos textos sin dar pistas por el tiempo que tarda.
function iguales(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

const b64url = (datos) => Buffer.from(datos).toString("base64url");
const texto = (v) => (v == null ? "" : String(v).trim());
const numero = (v) => (typeof v === "number" ? v : null);

/* ── La llave de Google ── */

function cuentaDeServicio() {
  const crudo = process.env.GOOGLE_SA_JSON;
  if (!crudo) throw falla(500, "falta-llave", "Falta configurar GOOGLE_SA_JSON en Netlify.");
  let sa;
  try {
    sa = JSON.parse(crudo);
  } catch {
    throw falla(500, "llave-mala", "GOOGLE_SA_JSON no es un JSON válido. Vuelve a pegar el archivo completo.");
  }
  // Por si al pegarla los saltos de línea de la clave llegaron como texto «\n».
  sa.private_key = texto(sa.private_key).replace(/\\n/g, "\n");
  if (!sa.client_email || !sa.private_key) {
    throw falla(500, "llave-mala", "A GOOGLE_SA_JSON le falta client_email o private_key.");
  }
  return sa;
}

// Google da un permiso de una hora a cambio de una firma con la clave. Se
// guarda mientras la función siga despierta, para no pedirlo en cada llamada.
let permisoGoogle = null; // { valor, vence }

async function pedirPermisoGoogle(sa) {
  if (permisoGoogle && permisoGoogle.vence > Date.now() + 60_000) return permisoGoogle.valor;
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  }));
  const firma = createSign("RSA-SHA256").update(`${cabecera}.${cuerpo}`).sign(sa.private_key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${cabecera}.${cuerpo}.${b64url(firma)}`,
    }),
  });
  const respuesta = await r.json().catch(() => ({}));
  if (!r.ok || !respuesta.access_token) {
    console.error("plata: Google no dio permiso:", r.status, JSON.stringify(respuesta).slice(0, 300));
    throw falla(502, "google-llave", "Google rechazó la llave. Revisa GOOGLE_SA_JSON en Netlify.");
  }
  permisoGoogle = { valor: respuesta.access_token, vence: Date.now() + respuesta.expires_in * 1000 };
  return permisoGoogle.valor;
}

/* ── Leer el Sheet ── */

async function leerSheet(sa) {
  const id = process.env.SHEET_ID;
  if (!id) throw falla(500, "falta-sheet", "Falta configurar SHEET_ID en Netlify.");
  const q = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" });
  q.append("ranges", RANGO_RESUMEN);
  q.append("ranges", RANGO_MOVIMIENTOS);
  q.append("ranges", RANGO_COLOMBIA);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchGet?${q}`, {
    headers: { Authorization: `Bearer ${await pedirPermisoGoogle(sa)}` },
  });
  if (!r.ok) {
    console.error("plata: Sheets respondió", r.status, (await r.text()).slice(0, 300));
    if (r.status === 403 || r.status === 404) {
      throw falla(502, "sin-acceso",
        "Google no deja leer el Sheet. ¿Está compartido con la cuenta de servicio como Lector y está habilitada la API de Sheets?");
    }
    throw falla(502, "sheets-fallo", "Google no respondió bien.");
  }
  const { valueRanges = [] } = await r.json();
  const datos = armarDatos(valueRanges[0]?.values || [], valueRanges[1]?.values || []);
  datos.colombia = armarColombia(valueRanges[2]?.values || [], datos.año);
  return datos;
}

// Fecha del Sheet → "2026-09-30". Llega como número de serie (días desde el
// 30-12-1899); por si alguna celda quedó como texto, también se entienden
// "2026-09-30", "30/09/2026" y "30.09.2026".
function fechaISO(v) {
  if (typeof v === "number") {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = texto(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

function armarDatos(resumen, movimientos) {
  const año = Number(resumen[0]?.[1]) || null; // B1, sea número o texto «2026»
  const datosHasta = fechaISO(resumen[1]?.[1]);
  if (!año || !datosHasta) {
    throw falla(502, "resumen-raro", "Al Resumen le falta el año (B1) o «Datos hasta» (B2).");
  }
  const categorias = [];
  for (const fila of resumen.slice(3)) { // desde la fila 4 (la 3 son los títulos)
    const tipo = texto(fila[18]);
    if (!tipo || !texto(fila[0])) continue;
    categorias.push({
      nombre: texto(fila[0]),
      tipo,
      presMes: numero(fila[2]),
      presAño: numero(fila[3]),
      meses: Array.from({ length: 12 }, (_, i) => numero(fila[4 + i]) ?? 0),
    });
  }
  // Van todos, con «Sale de»: la app deja fuera lo del Fondo Colombia en el
  // presupuesto (igual que el Resumen) y lo incluye en Viajes (igual que la
  // pestaña Viajes: es lo que de verdad costó el viaje).
  const movs = [];
  for (const f of movimientos) {
    const fecha = fechaISO(f[0]);
    if (!fecha) continue;
    movs.push({
      fecha,
      cuenta: texto(f[1]),
      categoria: texto(f[2]),
      viaje: texto(f[3]),
      descripcion: texto(f[4]),
      monto: numero(f[5]) ?? 0,
      saleDe: texto(f[7]),
    });
  }
  return { año, datosHasta, categorias, movimientos: movs };
}

// Los envíos del año a Colombia (euros que salieron, pesos que llegaron) y lo
// que se fue en comisiones. Se buscan por los títulos de la pestaña, no por
// número de fila. Si la pestaña cambia y no se encuentran, Plata esconde esa
// parte (null) en vez de fallar entera.
function armarColombia(filas, año) {
  const inicio = filas.findIndex((f) => /^APORTES DESDE ALEMANIA/i.test(texto(f[0])));
  if (inicio < 0) return null;
  const envios = [];
  // Columnas: A mes del aporte, B € Colombia, C € Notfalls, E llegó, F COP.
  for (const f of filas.slice(inicio + 2)) { // inicio + 1 son los títulos
    const etiqueta = texto(f[0]);
    if (!etiqueta || /^total/i.test(etiqueta)) break;
    const fecha = fechaISO(f[4]);
    const eur = (numero(f[1]) ?? 0) + (numero(f[2]) ?? 0);
    const cop = numero(f[5]);
    if (!fecha || !fecha.startsWith(String(año)) || !eur || !cop) continue;
    envios.push({ fecha, etiqueta, eur, cop });
  }
  // Las filas mes a mes (B–M) de «MOVIMIENTOS DEL MES»: van en negativo.
  const gasto = (nombre) => {
    const f = filas.find((x) => texto(x[0]) === nombre);
    return f ? -f.slice(1, 13).reduce((s, v) => s + (numero(v) ?? 0), 0) : 0;
  };
  return { envios, comisiones: { bancolombia: gasto("Comisiones Bancolombia"), cuatroPorMil: gasto("4×1000") } };
}

/* ── Sesión (lo que la app guarda en memoria después del PIN) ── */

// La clave para firmar sale de la clave privada de Google: así no hace falta
// otra variable de entorno, y si se cambia la llave las sesiones viejas mueren.
const claveDeSesion = (sa) => createHash("sha256").update(`plata-sesion:${sa.private_key}`).digest();

function firmarSesion(quien, sa) {
  const expira = Date.now() + SESION_MS;
  const cuerpo = b64url(JSON.stringify({ quien, expira }));
  const firma = b64url(createHmac("sha256", claveDeSesion(sa)).update(cuerpo).digest());
  return { sesion: `${cuerpo}.${firma}`, expira };
}

function leerSesion(sesion, sa) {
  const [cuerpo, firma] = texto(sesion).split(".");
  if (!cuerpo || !firma) return null;
  const esperada = b64url(createHmac("sha256", claveDeSesion(sa)).update(cuerpo).digest());
  if (!iguales(firma, esperada)) return null;
  try {
    const s = JSON.parse(Buffer.from(cuerpo, "base64url").toString("utf8"));
    return s.expira > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/* ── Entrar con el PIN ── */

async function entrar(req, sa) {
  const { quien, pin } = await req.json().catch(() => ({}));
  const variable = PINES[quien];
  if (!variable) throw falla(400, "quien", "Escoge quién eres: Tania o JC.");
  const esperado = texto(process.env[variable]);
  if (!esperado) throw falla(500, "falta-pin", `Falta configurar ${variable} en Netlify.`);

  // Un solo contador para los dos: fallar con un nombre también bloquea el otro.
  const almacen = getStore({ name: "plata", consistency: "strong" });
  const estado = (await almacen.get("intentos", { type: "json" })) || { fallos: 0, bloqueos: 0, hasta: 0 };
  if (estado.hasta > Date.now()) throw falla(429, "bloqueado", "Demasiados intentos.", { hasta: estado.hasta });

  if (!iguales(texto(pin), esperado)) {
    estado.fallos += 1;
    if (estado.fallos >= FALLOS_MAX) {
      estado.hasta = Date.now() + Math.min(BLOQUEO_MS * 2 ** estado.bloqueos, BLOQUEO_MAX_MS);
      estado.bloqueos += 1;
      estado.fallos = 0;
    }
    await almacen.setJSON("intentos", estado);
    if (estado.hasta > Date.now()) throw falla(429, "bloqueado", "Demasiados intentos.", { hasta: estado.hasta });
    throw falla(401, "pin-malo", "PIN equivocado.", { quedan: FALLOS_MAX - estado.fallos });
  }

  if (estado.fallos || estado.bloqueos) await almacen.setJSON("intentos", { fallos: 0, bloqueos: 0, hasta: 0 });
  const datos = await leerSheet(sa);
  return responder(200, { ...firmarSesion(quien, sa), datos });
}

export default async (req) => {
  // Candado 1: el código de hogar.
  const codigo = process.env.CODIGO_HOGAR;
  if (!codigo) {
    return responder(500, { error: "falta-codigo", mensaje: "Falta configurar CODIGO_HOGAR en Netlify." });
  }
  if (!iguales(req.headers.get("x-codigo-hogar") || "", codigo)) {
    return responder(403, { error: "no-autorizado", mensaje: "Código de hogar incorrecto." });
  }

  try {
    const sa = cuentaDeServicio();
    // Candado 2: el PIN (POST) o una sesión que se ganó con el PIN (GET).
    if (req.method === "POST") return await entrar(req, sa);
    if (req.method === "GET") {
      const autorizacion = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const sesion = leerSesion(autorizacion, sa);
      if (!sesion) {
        return responder(401, { error: "sin-sesion", mensaje: "La sesión de Plata se cerró. Vuelve a poner el PIN." });
      }
      return responder(200, { expira: sesion.expira, datos: await leerSheet(sa) });
    }
    return responder(405, { error: "metodo", mensaje: "Método no permitido." });
  } catch (err) {
    if (err.status) return responder(err.status, { error: err.error, mensaje: err.message, ...err.extra });
    console.error("plata:", err);
    return responder(500, { error: "plata-fallo", mensaje: "Algo falló leyendo la plata." });
  }
};
