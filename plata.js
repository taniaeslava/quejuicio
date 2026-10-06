// QueJuicio — pestaña Plata: el presupuesto de la casa.
//
// Los números NO viven en Firestore ni en el repo (que es público): los lee en
// vivo del Google Sheet «Buchhaltung» la función de Netlify
// netlify/functions/plata.mjs, que es la que tiene la llave. Aquí solo se
// dibujan. Tampoco se guardan en localStorage ni en la caché offline: viven en
// la memoria de esta pestaña y se pierden al cerrar la app o salir del hogar.
//
// Lo que manda la función:
//   { año: 2026, datosHasta: "2026-09-30",
//     categorias:  [{ nombre, tipo, presMes, presAño, meses: [12 montos] }],
//     movimientos: [{ fecha: "2026-09-03", categoria, viaje, descripcion, monto, cuenta, saleDe }],
//     colombia:    { envios: [{ fecha, etiqueta, eur, cop }],
//                    comisiones: { bancolombia, cuatroPorMil } } | null }
// `tipo` sale de la columna «Tipo» del Resumen: "fijo" | "variable" | "anual" |
// "ahorro" | "ingreso". Montos en euros; positivo = sale plata (las comisiones
// de Colombia, en pesos y en positivo). Los totales se toman tal cual del
// Resumen (no se recalculan aquí) para que la app nunca diga algo distinto al
// Sheet; los movimientos solo sirven para el detalle y para Viajes.
//
// Tres secciones (Mes, Año, Viajes) y, al tocar una categoría, su detalle.
// Diseño: Documents\presupuesto\plata-diseno\ (fuera del repo).
//
// «Datos hasta» es la fecha hasta la que está cerrado el Sheet (la pone el
// cierre). La pestaña abre en ese mes: en Alemania es el último mes cerrado y
// en viaje, con cierres más seguidos, el mes en curso con su aviso.
//
// Para ver los números hay que poner el PIN de cada uno (lo revisa la
// función, con límite de intentos). A cambio la función da una «sesión» que
// dura 15 minutos y vive solo en memoria: al vencerse, al tocar el candado o
// al cerrar la app, se borran los números y vuelve a pedir el PIN.

const RUTA_PLATA = "/.netlify/functions/plata";
const RELEER_MS = 5 * 60 * 1000; // al volver a la pestaña, se relee si pasó esto
const SESION_MS = 15 * 60 * 1000; // igual que en la función

const NOMBRE_MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

let datos = null;         // lo último que mandó la función
let leidoEn = 0;
let cargando = false;
let errorPlata = "";
let mesVisto = null;      // 1–12
let fijosAbiertos = false;
let codigoHogar = "";

let seccion = "mes";      // "mes" | "año" | "viajes"
let detalle = null;       // { nombre, desde: "mes" | "año" }: la categoría abierta
let mesDetalle = null;    // el mes tocado en la gráfica del detalle
let mesAñoTocado = null;  // el mes tocado en «El año en 12 meses»
let envioTocado = null;   // índice del envío tocado en «Lo que rinde cada euro»
let viajeElegido = null;  // nombre del viaje abierto en Viajes

let sesion = null;        // la que dio la función al poner el PIN (solo en memoria)
let venceSesion = 0;
let temporizador = null;
let quien = localStorage.getItem("queJuicio.plataQuien"); // "tania" | "jc": por teléfono, no es secreto
let pinError = "";
let enviandoPin = false;

const sesionViva = () => Boolean(sesion) && Date.now() < venceSesion;

/* ── Entrar / salir ── */

// La llama mostrarVista("plata") en app.js cada vez que se abre la pestaña.
export function abrirPlata(codigo) {
  codigoHogar = codigo;
  if (!sesionViva()) cerrarSesion(sesion ? "Pasaron 15 minutos: vuelve a poner el PIN." : "");
  else if (!datos || Date.now() - leidoEn > RELEER_MS) cargarPlata();
  else pintarPlata();
}

// Al salir del hogar no queda ningún número en memoria.
export function olvidarPlata() {
  cerrarSesion();
  document.querySelector("#vista-plata")?.replaceChildren();
}

// Se olvidan la sesión y los números, y vuelve la pantalla del PIN.
function cerrarSesion(aviso = "") {
  clearTimeout(temporizador);
  sesion = null;
  venceSesion = 0;
  datos = null;
  leidoEn = 0;
  errorPlata = "";
  mesVisto = null;
  fijosAbiertos = false;
  seccion = "mes";
  detalle = mesDetalle = mesAñoTocado = envioTocado = viajeElegido = null;
  pinError = aviso;
  pintarPlata();
}

async function llamarFuncion(opciones = {}) {
  let r;
  try {
    r = await fetch(RUTA_PLATA, {
      cache: "no-store",
      ...opciones,
      headers: { "x-codigo-hogar": codigoHogar, ...opciones.headers },
    });
  } catch {
    throw new Error("Sin internet o el sitio no responde.");
  }
  if (r.status === 404) {
    throw new Error("La función de Plata todavía no está publicada en Netlify.");
  }
  return { r, cuerpo: await r.json().catch(() => ({})) };
}

function recibirDatos(nuevos) {
  datos = nuevos;
  leidoEn = Date.now();
  if (!mesVisto || mesVisto > mesMaximo()) mesVisto = mesMaximo();
}

async function entrarConPin(pin) {
  if (enviandoPin || !quien) return;
  enviandoPin = true;
  pinError = "";
  pintarPlata();
  try {
    const { r, cuerpo } = await llamarFuncion({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quien, pin }),
    });
    if (r.ok) {
      sesion = cuerpo.sesion;
      venceSesion = Date.now() + SESION_MS;
      clearTimeout(temporizador);
      temporizador = setTimeout(() => cerrarSesion("Pasaron 15 minutos: vuelve a poner el PIN."), SESION_MS);
      recibirDatos(cuerpo.datos);
    } else if (cuerpo.error === "pin-malo") {
      pinError = cuerpo.quedan === 1
        ? "PIN equivocado. Te queda 1 intento."
        : `PIN equivocado. Te quedan ${cuerpo.quedan} intentos.`;
    } else if (cuerpo.error === "bloqueado") {
      const hora = new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit" }).format(cuerpo.hasta);
      pinError = `Demasiados intentos. Vuelve a probar a las ${hora}.`;
    } else {
      pinError = cuerpo.mensaje || "No se pudo entrar.";
    }
  } catch (err) {
    pinError = err.message;
  } finally {
    enviandoPin = false;
    pintarPlata();
  }
}

// Releer con la sesión que ya hay (sin repetir el PIN).
async function cargarPlata() {
  if (cargando) return;
  cargando = true;
  errorPlata = "";
  pintarPlata();
  try {
    const { r, cuerpo } = await llamarFuncion({ headers: { Authorization: `Bearer ${sesion}` } });
    if (r.status === 401) {
      cargando = false;
      cerrarSesion(cuerpo.mensaje);
      return;
    }
    if (!r.ok) throw new Error(cuerpo.mensaje || "No se pudo leer el Sheet.");
    recibirDatos(cuerpo.datos);
  } catch (err) {
    errorPlata = err.message;
  } finally {
    cargando = false;
    pintarPlata();
  }
}

/* ── Utilidades ── */

// 1234.5 → «1.234,50 €». A mano porque Intl con es-ES no pone el punto de
// miles en números de cuatro cifras («1234,50»).
function eur(n) {
  const [entero, decimales] = Math.abs(n).toFixed(2).split(".");
  const signo = n <= -0.005 ? "−" : "";
  return `${signo}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimales} €`;
}

// "2026-09-30" → { a: 2026, m: 9, d: 30 }, sin pasar por Date (y sus husos).
function partesFecha(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return { a, m, d };
}
const diasDelMes = (a, m) => new Date(a, m, 0).getDate();
const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dosDigitos = (n) => String(n).padStart(2, "0");
const conPuntos = (n) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const cop = (n) => `${conPuntos(n)} COP`; // pesos sin decimales
const fechaCorta = (iso) => `${partesFecha(iso).d} ${MES_CORTO[partesFecha(iso).m - 1]}`;
const suma = (lista, valor) => lista.reduce((s, x) => s + (valor(x) || 0), 0);

// Lo que cuenta en el presupuesto: igual que el Resumen, sin lo que se pagó
// desde el Fondo Colombia (eso ya se contó al mandarlo).
const delPresupuesto = (mv) => mv.saleDe !== "Fondo Colombia";

// El último mes que se puede mirar: el de «Datos hasta».
function mesMaximo() {
  const { a, m } = partesFecha(datos.datosHasta);
  return a > datos.año ? 12 : m;
}

// ¿El mes de «Datos hasta» está a medias? (cierres a mitad de mes, en viaje)
function mesAMedias() {
  const { a, m, d } = partesFecha(datos.datosHasta);
  return a === datos.año && d < diasDelMes(a, m);
}

// Los meses que ya están completos en el Sheet.
const mesesCerrados = () => mesMaximo() - (mesAMedias() ? 1 : 0);

// Un tope «redondo» para el eje de una gráfica: 1, 2, 2,5 o 5 × 10^n.
function escalaBonita(maximo) {
  if (!(maximo > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(maximo));
  return [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= maximo);
}

function el(tag, clase = "", texto = "") {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto) n.textContent = texto;
  return n;
}

// Mismo trazo que icono() de app.js, con los que necesita Plata.
const ICONOS = {
  atras: '<path d="m15 18-6-6 6-6"/>',
  adelante: '<path d="m9 18 6-6-6-6"/>',
  reloj: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  subir: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  bajar: '<path d="M7 7 17 17"/><path d="M17 8v9H8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  desplegar: '<path d="m6 9 6 6 6-6"/>',
  calendario: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  candado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};
function icono(nombre) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONOS[nombre];
  return svg;
}

/* ── Los números de un mes ──
   Mensual = fijos + variables (lo anual y los ahorros van en la pantalla del
   año). El ritmo cuenta los fijos completos, porque se pagan al principio del
   mes, y reparte el presupuesto de los variables en los días del mes; si no,
   la renta haría ver el mes siempre «por encima». */
function resumenDelMes(m) {
  const { m: mDatos, d } = partesFecha(datos.datosHasta);
  const dias = diasDelMes(datos.año, m);
  const incompleto = m === mDatos && d < dias;
  const monto = (c) => c.meses[m - 1] ?? 0;
  const fijos = datos.categorias.filter((c) => c.tipo === "fijo");
  const variables = datos.categorias.filter((c) => c.tipo === "variable");
  const movimientos = movimientosDelMes(m);
  const r = {
    m, dias, dia: incompleto ? d : dias, incompleto,
    fijos, variables, monto, movimientos,
    fijosGastado: suma(fijos, monto),
    fijosPres: suma(fijos, (c) => c.presMes),
    varGastado: suma(variables, monto),
    varPres: suma(variables, (c) => c.presMes),
  };
  r.gastado = r.fijosGastado + r.varGastado;
  r.pres = r.fijosPres + r.varPres;
  r.ritmo = r.fijosGastado + r.varPres * (r.dia / dias);
  r.vacio = movimientos.length === 0 && r.gastado === 0;
  return r;
}

function movimientosDelMes(m, categoria = null) {
  const prefijo = `${datos.año}-${dosDigitos(m)}`;
  return datos.movimientos.filter((mv) => mv.fecha.startsWith(prefijo) && delPresupuesto(mv)
    && (!categoria || mv.categoria === categoria));
}

/* ── Pintar ── */

function pintarPlata() {
  const cont = document.querySelector("#vista-plata");
  if (!cont) return;
  cont.replaceChildren();
  if (!sesionViva()) {
    cont.append(pantallaPin());
    // El teclado numérico sale solo, pero solo si la pestaña está a la vista.
    if (!cont.hidden && quien && !enviandoPin) cont.querySelector(".plata-pin-input")?.focus();
    return;
  }
  if (!datos) {
    cont.append(errorPlata ? tarjetaError() : esqueleto());
    return;
  }
  if (detalle) {
    cont.append(pantallaDetalle());
    return;
  }
  cont.append(selectorDeSeccion());
  if (seccion === "año") cont.append(pantallaAño());
  else if (seccion === "viajes") cont.append(pantallaViajes());
  else cont.append(pantallaMes());
}

// Mes · Año · Viajes (como el selector de tema de Ajustes).
function selectorDeSeccion() {
  const sel = el("div", "plata-secciones");
  sel.setAttribute("role", "group");
  sel.setAttribute("aria-label", "Secciones de Plata");
  for (const [valor, nombre] of [["mes", "Mes"], ["año", "Año"], ["viajes", "Viajes"]]) {
    const b = el("button", "", nombre);
    b.type = "button";
    b.setAttribute("aria-pressed", String(seccion === valor));
    b.addEventListener("click", () => {
      seccion = valor;
      pintarPlata();
      window.scrollTo(0, 0);
    });
    sel.append(b);
  }
  return sel;
}

function pantallaMes() {
  const frag = document.createDocumentFragment();
  const mes = resumenDelMes(mesVisto);
  frag.append(cabeceraMes(mes));
  if (errorPlata) frag.append(el("p", "plata-nota", `No se pudo actualizar: ${errorPlata}`));
  if (mes.vacio) {
    frag.append(mesVacio(mes));
    return frag;
  }
  frag.append(
    tarjetaDelMes(mes),
    ...gruposDeCategorias(mes),
    el("p", "plata-pie", "Toca una categoría para ver sus 12 meses y sus movimientos."),
  );
  return frag;
}

function irAMes(m) {
  mesVisto = Math.min(Math.max(m, 1), mesMaximo());
  fijosAbiertos = false;
  pintarPlata();
}

function botonRedondo(nombreIcono, etiqueta, accion) {
  const b = el("button");
  b.type = "button";
  b.setAttribute("aria-label", etiqueta);
  b.append(icono(nombreIcono));
  b.addEventListener("click", accion);
  return b;
}

// Etiqueta, título y botones a la derecha; el último siempre es el candado,
// que cierra Plata ya (por si le prestan el teléfono a alguien).
function cabecera(etiqueta, titulo, botones = [], chip = "") {
  const frag = document.createDocumentFragment();
  const cab = el("div", "plata-cabecera");
  const titulos = el("div", "plata-titulos");
  titulos.append(el("span", "plata-etiqueta", etiqueta), el("h2", "plata-mes", titulo));
  const nav = el("div", "plata-nav");
  nav.append(...botones, botonRedondo("candado", "Cerrar Plata", () => cerrarSesion()));
  cab.append(titulos, nav);
  frag.append(cab);
  if (chip) {
    const c = el("span", "plata-chip");
    c.append(icono("reloj"), chip);
    frag.append(c);
  }
  return frag;
}

function cabeceraMes(mes) {
  const anterior = botonRedondo("atras", "Mes anterior", () => irAMes(mes.m - 1));
  anterior.disabled = mes.m <= 1;
  const siguiente = botonRedondo("adelante", "Mes siguiente", () => irAMes(mes.m + 1));
  siguiente.disabled = mes.m >= mesMaximo();
  return cabecera(`PLATA · ${datos.año}`, mayus(NOMBRE_MES[mes.m - 1]), [anterior, siguiente],
    mes.incompleto ? `datos hasta el ${mes.dia} ${MES_CORTO[mes.m - 1]}` : "");
}

// La tarjeta grande: cuánto se ha gastado del presupuesto mensual y el ritmo.
function tarjetaDelMes(mes) {
  const card = el("section", "plata-card plata-resumen");
  const cifra = el("div", "plata-cifra");
  cifra.append(
    el("span", "plata-cifra-grande", eur(mes.gastado)),
    el("span", "plata-cifra-de", `de ${eur(mes.pres)}`),
  );
  card.append(
    el("div", "plata-etiqueta", `GASTADO EN ${NOMBRE_MES[mes.m - 1].toUpperCase()}`),
    cifra, barraDelMes(mes), leyendaDelMes(mes), avisoDelMes(mes),
  );
  // Releyendo con datos ya en pantalla: se quedan a media tinta, sin saltar.
  if (cargando) {
    card.classList.add("plata-actualizando");
    card.append(el("span", "plata-pildora", "actualizando…"));
  }
  return card;
}

function barraDelMes(mes) {
  const escala = Math.max(mes.pres, mes.gastado, 1);
  const ancho = (v) => `${(Math.max(0, v) / escala) * 100}%`;
  const caja = el("div", "plata-barra");
  const pista = el("div", "plata-barra-pista");
  const fijos = el("div", "plata-barra-fijos");
  fijos.style.width = ancho(mes.fijosGastado);
  const variables = el("div", "plata-barra-variables");
  variables.style.width = ancho(mes.varGastado);
  pista.append(fijos, variables);
  caja.append(pista);

  // Marca: el ritmo si el mes va por la mitad; el presupuesto si se pasaron.
  let marca = null;
  if (mes.incompleto) {
    marca = { valor: mes.ritmo, texto: `ritmo al ${mes.dia} ${MES_CORTO[mes.m - 1]} · ${eur(mes.ritmo)}` };
  } else if (mes.gastado > mes.pres) {
    marca = { valor: mes.pres, texto: `presupuesto · ${eur(mes.pres)}` };
  }
  if (marca) {
    caja.classList.add("con-marca");
    const pos = (Math.max(0, marca.valor) / escala) * 100;
    const raya = el("div", "plata-marca");
    raya.style.left = `${pos}%`;
    // La etiqueta se centra en la raya pero sin salirse de la tarjeta.
    const texto = el("div", "plata-marca-texto", marca.texto);
    texto.style.left = `${Math.min(Math.max(pos, 26), 74)}%`;
    caja.append(raya, texto);
  }
  return caja;
}

function leyendaDelMes(mes) {
  const leyenda = el("div", "plata-leyenda");
  const fila = (muestra, nombre, valor, clase = "") => {
    const f = el("div", "plata-leyenda-fila");
    f.append(
      el("span", `plata-muestra ${muestra}`),
      el("span", "plata-leyenda-nombre", nombre),
      el("span", `plata-leyenda-valor ${clase}`, valor),
    );
    return f;
  };
  const todosPagados = mes.fijos.every((c) => mes.monto(c) > 0);
  const disponible = mes.pres - mes.gastado;
  leyenda.append(
    fila("muestra-fijos", "Fijos", todosPagados
      ? `${eur(mes.fijosGastado)} · pagados`
      : `${eur(mes.fijosGastado)} de ${eur(mes.fijosPres)}`),
    fila("muestra-variables", "Variables", `${eur(mes.varGastado)} de ${eur(mes.varPres)}`),
    disponible >= 0
      ? fila("muestra-pista", "Disponible", eur(disponible))
      : fila("muestra-pista", "Se pasaron", eur(-disponible), "pasado"),
  );
  return leyenda;
}

// Con el mes a medias se compara contra el ritmo; con el mes cerrado, los
// variables contra su presupuesto (los fijos no se pueden «ahorrar»).
function avisoDelMes(mes) {
  const diferencia = mes.incompleto ? mes.gastado - mes.ritmo : mes.varGastado - mes.varPres;
  const encima = diferencia > 0.004;
  const aviso = el("div", `plata-aviso ${encima ? "encima" : "debajo"}`);
  const textos = el("div");
  let titulo, detalle;
  if (mes.incompleto) {
    titulo = `${eur(Math.abs(diferencia))} por ${encima ? "encima" : "debajo"} del ritmo`;
    detalle = `A esta altura tocaría ir en ${eur(mes.ritmo)}. El ritmo cuenta los fijos completos y reparte los variables en los ${mes.dias} días.`;
  } else {
    titulo = encima
      ? `Los variables se pasaron ${eur(diferencia)}`
      : `Los variables cerraron ${eur(-diferencia)} por debajo`;
    detalle = `Gastaron ${eur(mes.varGastado)} de ${eur(mes.varPres)}. Los fijos no cuentan aquí.`;
  }
  textos.append(el("div", "plata-aviso-titulo", titulo), el("div", "plata-aviso-texto", detalle));
  aviso.append(icono(encima ? "subir" : "bajar"), textos);
  return aviso;
}

/* ── Categorías del mes ──
   Filas como las de Tareas, con el mismo anillo: verde por debajo del 80 %,
   ámbar desde el 80 %, terracota pasado el 100 % (el arco se llena hasta el
   100 % y en el centro va el % real). Grupos: SE PASARON, VARIABLES, SIN
   PRESUPUESTO y los fijos juntos en una sola fila que se despliega. */
function gruposDeCategorias(mes) {
  const filas = mes.variables.map((c) => ({ c, gastado: mes.monto(c), pres: c.presMes || 0 }));
  const conTope = filas
    .filter((f) => f.pres > 0)
    .map((f) => ({ ...f, pct: f.gastado / f.pres }))
    .sort((a, b) => b.pct - a.pct);
  const pasadas = conTope.filter((f) => f.pct > 1);
  const dentro = conTope.filter((f) => f.pct <= 1);
  const sinTope = filas.filter((f) => !(f.pres > 0));

  const grupos = [];
  if (pasadas.length) grupos.push(grupoPlata("SE PASARON", pasadas.map(filaCategoria), "grupo-urgente"));
  if (dentro.length) grupos.push(grupoPlata("VARIABLES", dentro.map(filaCategoria)));
  if (sinTope.length) grupos.push(grupoPlata("SIN PRESUPUESTO", sinTope.map((f) => filaSinTope(f, mes))));
  if (mes.fijos.length) grupos.push(grupoPlata("FIJOS", filasFijos(mes), "", mes.fijos.length));
  return grupos;
}

function grupoPlata(etiqueta, filas, claseExtra = "", cuenta = filas.length) {
  const grupo = el("div", "grupo" + (claseExtra ? ` ${claseExtra}` : ""));
  const head = el("div", "grupo-label");
  head.append(el("span", "etq", etiqueta), el("span", "cuenta", String(cuenta)));
  const card = el("div", "grupo-card");
  card.append(...filas);
  grupo.append(head, card);
  return grupo;
}

function ladoDerecho(etiqueta, monto, clase = "") {
  const lado = el("div", "plata-lado" + (clase ? ` ${clase}` : ""));
  lado.append(el("div", "plata-lado-etq", etiqueta), el("div", "plata-lado-monto", monto));
  return lado;
}

// Una fila que se toca para abrir el detalle de su categoría.
function filaQueAbre(nombre, desde, clase = "") {
  const fila = el("button", `fila fila-toque${clase ? ` ${clase}` : ""}`);
  fila.type = "button";
  fila.addEventListener("click", () => abrirDetalle(nombre, desde));
  return fila;
}

// El anillo de Tareas con el % gastado. Sus clases dan el color (y siguen al
// tema): verde < 80 %, ámbar desde el 80 %, terracota pasado el 100 %.
function anilloDePct(pct, grande = false) {
  const estado = pct > 1 ? "vencida" : pct >= 0.8 ? "pronto" : "fresca";
  const anillo = el("div", `anillo anillo-plata ${estado}${grande ? " anillo-grande" : ""}`);
  anillo.style.setProperty("--pct", String(Math.round(Math.min(Math.max(pct, 0), 1) * 100)));
  anillo.append(el("div", "anillo-disco", `${Math.min(Math.round(Math.max(pct, 0) * 100), 999)}%`));
  return anillo;
}

function filaCategoria({ c, gastado, pres, pct }) {
  const fila = filaQueAbre(c.nombre, "mes");
  const anillo = anilloDePct(pct);
  const cuerpo = el("div", "fila-cuerpo");
  cuerpo.append(el("div", "fila-titulo", c.nombre), el("div", "fila-meta cifras", `${eur(gastado)} de ${eur(pres)}`));
  const lado = pct > 1
    ? ladoDerecho("se pasaron", eur(gastado - pres), "pasado")
    : ladoDerecho("quedan", eur(pres - gastado));
  fila.append(anillo, cuerpo, lado);
  return fila;
}

function filaSinTope({ c, gastado }, mes) {
  const fila = filaQueAbre(c.nombre, "mes");
  const anillo = el("div", "anillo unica");
  anillo.append(el("div", "anillo-disco", "—"));
  const n = mes.movimientos.filter((mv) => mv.categoria === c.nombre).length;
  const cuerpo = el("div", "fila-cuerpo");
  cuerpo.append(
    el("div", "fila-titulo", c.nombre),
    el("div", "fila-meta meta-larga", `Sin tope este mes · ${n === 0 ? "sin movimientos" : n === 1 ? "1 movimiento" : `${n} movimientos`}`),
  );
  fila.append(anillo, cuerpo, ladoDerecho("gastado", eur(gastado)));
  return fila;
}

// Una fila atenuada para todos los fijos; al tocarla, uno por uno con la
// fecha en que se pagó (la del último movimiento del mes en esa categoría).
function filasFijos(mes) {
  const todosPagados = mes.fijos.every((c) => mes.monto(c) > 0);
  const boton = el("button", "fila fila-toque fila-fijos atenuada");
  boton.type = "button";
  boton.setAttribute("aria-expanded", String(fijosAbiertos));
  const disco = el("div", "plata-fijos-disco");
  disco.append(icono("check"));
  const cuerpo = el("div", "fila-cuerpo");
  cuerpo.append(el("div", "fila-titulo", "Pagos fijos"), el("div", "fila-meta", mes.fijos.map((c) => c.nombre).join(", ")));
  const chevron = el("span", "plata-chevron");
  chevron.append(icono("desplegar"));
  boton.append(disco, cuerpo, ladoDerecho(todosPagados ? "pagados" : "pagado", eur(mes.fijosGastado)), chevron);
  boton.addEventListener("click", () => {
    fijosAbiertos = !fijosAbiertos;
    pintarPlata();
  });

  const filas = [boton];
  if (fijosAbiertos) {
    for (const c of mes.fijos) {
      const fechas = mes.movimientos.filter((mv) => mv.categoria === c.nombre).map((mv) => mv.fecha).sort();
      const ultima = fechas.at(-1);
      const fila = filaQueAbre(c.nombre, "mes", "fila-fijo atenuada");
      const cuerpo = el("div", "fila-cuerpo");
      cuerpo.append(
        el("div", "fila-titulo", c.nombre),
        el("div", "fila-meta", ultima
          ? `Fijo · pagado el ${partesFecha(ultima).d} ${MES_CORTO[mes.m - 1]}`
          : "Fijo · todavía no aparece"),
      );
      fila.append(cuerpo, ladoDerecho("pagado", eur(mes.monto(c))));
      filas.push(fila);
    }
  }
  return filas;
}

/* ── Piezas que comparten las gráficas ──
   Al tacto no hay globos (quedarían bajo el dedo): cada gráfica tiene arriba
   una «franja de lectura» con el valor exacto de lo que se tocó. */

const LETRAS_MES = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function tarjeta(titulo, clase = "") {
  const card = el("section", `plata-card${clase ? ` ${clase}` : ""}`);
  card.append(el("h3", "plata-card-titulo", titulo));
  return card;
}

// [[clase de la muestra, texto], ...] → la leyenda de una gráfica.
function leyenda(items) {
  const caja = el("div", "plata-leyenda-linea");
  for (const [muestra, textoMuestra] of items) {
    const item = el("span");
    item.append(el("span", `plata-muestra ${muestra}`), textoMuestra);
    caja.append(item);
  }
  return caja;
}

function franja(titulo, monto = "", nota = "") {
  const caja = el("div", "plata-franja");
  const arriba = el("div", "plata-franja-fila");
  arriba.append(el("span", "plata-franja-titulo", titulo));
  if (monto) arriba.append(el("span", "plata-franja-monto", monto));
  caja.append(arriba);
  if (nota) caja.append(el("div", "plata-franja-nota", nota));
  return caja;
}

// Tres cifras en fila: [[valor, etiqueta], ...]; `arriba` pone la etiqueta primero.
function tresCifras(items, arriba = false) {
  const caja = el("div", "plata-tres");
  for (const [valor, etiqueta, nota] of items) {
    const d = el("div");
    const v = el("span", "plata-tres-valor", valor);
    const e = el("span", "plata-tres-etq", etiqueta);
    d.append(...(arriba ? [e, v] : [v, e]));
    if (nota) d.append(el("span", "plata-tres-etq", nota));
    caja.append(d);
  }
  return caja;
}

function filaDeLetras(elegido) {
  const fila = el("div", "plata-letras");
  LETRAS_MES.forEach((l, i) => fila.append(el("span", i + 1 === elegido ? "elegida" : "", l)));
  return fila;
}

// Una columna por mes. Los que no han pasado van punteados (nunca una barra
// en cero) y el mes a medias, a media tinta.
function columnaDeMes(m, elegido, alTocar) {
  const col = el("button", `plata-col${m === elegido ? " elegido" : ""}`);
  col.type = "button";
  if (m > mesMaximo()) {
    col.classList.add("futuro");
    col.disabled = true;
    col.setAttribute("aria-label", `${mayus(NOMBRE_MES[m - 1])}: todavía no`);
  } else {
    if (m === mesMaximo() && mesAMedias()) col.classList.add("parcial");
    col.addEventListener("click", () => alTocar(m));
  }
  return col;
}

const alto = (valor, escala) => `${(Math.max(valor, 0) / escala) * 100}%`;
const diaDelAño = (iso) => {
  const { a, m, d } = partesFecha(iso);
  return (Date.UTC(a, m - 1, d) - Date.UTC(a, 0, 0)) / 86_400_000;
};
const diasDelAño = (a) => (Date.UTC(a + 1, 0, 1) - Date.UTC(a, 0, 1)) / 86_400_000;

function lista(palabras) {
  return palabras.length < 2 ? palabras.join("") : `${palabras.slice(0, -1).join(", ")} y ${palabras.at(-1)}`;
}

// Las filas de una lista de movimientos (de la más nueva a la más vieja) y su total.
function filasDeMovimientos(movs, { conCategoria = false } = {}) {
  const filas = [...movs].sort((a, b) => b.fecha.localeCompare(a.fecha)).map((mv) => {
    const { d, m } = partesFecha(mv.fecha);
    const fila = el("div", "fila fila-dato fila-mov");
    const fecha = el("div", "mov-fecha");
    fecha.append(el("span", "mov-dia", String(d)), el("span", "mov-mes", MES_CORTO[m - 1].toUpperCase()));
    const cuerpo = el("div", "fila-cuerpo");
    cuerpo.append(el("div", "fila-titulo", mv.descripcion || "—"));
    const meta = conCategoria ? mv.categoria : [mv.cuenta, mv.viaje].filter(Boolean).join(" · ");
    if (meta) cuerpo.append(el("div", "fila-meta", meta));
    fila.append(fecha, cuerpo, el("div", "mov-monto", eur(mv.monto)));
    return fila;
  });
  const total = el("div", "fila fila-dato fila-total");
  total.append(el("span", "fila-cuerpo", "Total"), el("span", "mov-monto", eur(suma(movs, (mv) => mv.monto))));
  filas.push(total);
  return filas;
}

/* ── Detalle de una categoría ──
   Sus 12 meses (contra la raya del presupuesto si es mensual) y los
   movimientos del mes tocado. Se abre desde el Mes o desde el Año. */

function abrirDetalle(nombre, desde) {
  detalle = { nombre, desde };
  mesDetalle = desde === "mes" ? mesVisto : mesMaximo();
  pintarPlata();
  window.scrollTo(0, 0);
}

function pantallaDetalle() {
  const frag = document.createDocumentFragment();
  const volver = el("button", "plata-volver");
  volver.type = "button";
  volver.append(icono("atras"), detalle.desde === "mes" ? mayus(NOMBRE_MES[mesVisto - 1]) : String(datos.año));
  volver.addEventListener("click", () => {
    detalle = null;
    pintarPlata();
    window.scrollTo(0, 0);
  });
  frag.append(volver);
  const c = datos.categorias.find((x) => x.nombre === detalle.nombre);
  if (!c) {
    frag.append(el("p", "plata-nota", "Esta categoría ya no está en el Sheet."));
    return frag;
  }

  const m = mesDetalle;
  const valor = c.meses[m - 1] ?? 0;
  const mensual = (c.tipo === "fijo" || c.tipo === "variable") && c.presMes > 0;
  const anual = c.tipo === "anual" && c.presAño > 0;
  const acumulado = suma(c.meses.slice(0, m), (v) => v);
  const quedanOPasaron = (gasto, tope) => (gasto > tope ? `se pasaron ${eur(gasto - tope)}` : `quedan ${eur(tope - gasto)}`);

  // Cabecera: el anillo y lo gastado del mes tocado (o del año, si es anual).
  const cab = el("div", "plata-detalle-cabecera");
  let anillo, resumen;
  if (mensual) {
    anillo = anilloDePct(valor / c.presMes, true);
    resumen = `${eur(valor)} de ${eur(c.presMes)} · ${quedanOPasaron(valor, c.presMes)}`;
  } else if (anual) {
    anillo = anilloDePct(acumulado / c.presAño, true);
    resumen = `${eur(acumulado)} de ${eur(c.presAño)} en el año · ${quedanOPasaron(acumulado, c.presAño)}`;
  } else {
    anillo = el("div", "anillo unica anillo-grande");
    anillo.append(el("div", "anillo-disco", "—"));
    resumen = `${eur(valor)} en ${NOMBRE_MES[m - 1]} · sin presupuesto`;
  }
  const textos = el("div", "plata-titulos");
  textos.append(el("h2", "plata-mes", c.nombre), el("div", "plata-detalle-resumen", resumen));
  cab.append(anillo, textos);
  frag.append(cab);

  // Sus 12 meses.
  const card = tarjeta(`${c.nombre} en 12 meses`);
  card.append(leyenda(mensual
    ? [["muestra-variables", "dentro del presupuesto"], ["muestra-pasado", "se pasaron"], ["muestra-raya", "presupuesto"]]
    : [["muestra-variables", "gastado"]]));
  const aMedias = m === mesMaximo() && mesAMedias();
  card.append(franja(
    `${mayus(NOMBRE_MES[m - 1])}${aMedias ? ` · hasta el ${partesFecha(datos.datosHasta).d}` : ""}`,
    eur(valor),
    mensual ? mayus(quedanOPasaron(valor, c.presMes).replace("quedan", "quedaron"))
      : anual ? `Acumulado hasta ${NOMBRE_MES[m - 1]}: ${eur(acumulado)} de ${eur(c.presAño)}` : "",
  ));

  const vistos = c.meses.slice(0, mesMaximo());
  const escala = escalaBonita(Math.max(...vistos, mensual ? c.presMes * 1.15 : 0));
  const graf = el("div", "plata-barras");
  const area = el("div", "plata-graf-area");
  c.meses.forEach((v, i) => {
    const col = columnaDeMes(i + 1, m, (mes) => {
      mesDetalle = mes;
      pintarPlata();
    });
    if (i + 1 <= mesMaximo()) {
      const barra = el("span", `plata-barra-col${mensual && v > c.presMes ? " pasado" : ""}`);
      barra.style.height = alto(v, escala);
      col.append(barra);
      col.setAttribute("aria-label", `${mayus(NOMBRE_MES[i])}: ${eur(v)}`);
    }
    area.append(col);
  });
  graf.append(area);
  if (mensual) {
    const raya = el("div", "plata-tope");
    raya.style.bottom = alto(c.presMes, escala);
    raya.append(el("span", "plata-tope-texto", `presupuesto ${eur(c.presMes)}`));
    graf.append(raya);
  }
  card.append(graf, filaDeLetras(m));

  // Promedio de los meses completos y cuántos se pasaron.
  const completos = c.meses.slice(0, mesesCerrados());
  if (completos.length) {
    const datosPie = el("div", "plata-pie-datos");
    const fila = (etq, val) => {
      const f = el("div");
      f.append(el("span", "", etq), el("strong", "", val));
      return f;
    };
    datosPie.append(fila(`Promedio ene–${MES_CORTO[completos.length - 1]}`, eur(suma(completos, (v) => v) / completos.length)));
    if (mensual) {
      datosPie.append(fila("Meses en que se pasaron", `${completos.filter((v) => v > c.presMes).length} de ${completos.length}`));
    }
    card.append(datosPie);
  }
  frag.append(card);

  // Los movimientos del mes tocado.
  const movs = movimientosDelMes(m, c.nombre);
  frag.append(movs.length
    ? grupoPlata(`MOVIMIENTOS DE ${NOMBRE_MES[m - 1].toUpperCase()}`, filasDeMovimientos(movs), "", movs.length)
    : el("p", "plata-nota", `Sin movimientos en ${NOMBRE_MES[m - 1]}.`));
  return frag;
}

/* ── El año ── */

function pantallaAño() {
  const frag = document.createDocumentFragment();
  frag.append(cabecera("PLATA", String(datos.año), [], `datos hasta el ${fechaCorta(datos.datosHasta)}`));
  if (errorPlata) frag.append(el("p", "plata-nota", `No se pudo actualizar: ${errorPlata}`));
  frag.append(tarjetaDelAño(), tarjetaAnuales(), tarjetaAhorros());
  if (datos.colombia?.envios?.length) frag.append(tarjetaColombia());
  return frag;
}

// Ingreso, gastado (mensual + anual) y ahorrado, mes a mes.
function tarjetaDelAño() {
  const porTipo = (tipos, i) => suma(datos.categorias.filter((c) => tipos.includes(c.tipo)), (c) => c.meses[i]);
  const meses = Array.from({ length: 12 }, (_, i) => ({
    gastado: porTipo(["fijo", "variable", "anual"], i),
    ahorrado: porTipo(["ahorro"], i),
    ingreso: porTipo(["ingreso"], i),
  }));
  const vistos = meses.slice(0, mesMaximo());
  const escala = escalaBonita(Math.max(...vistos.map((x) => Math.max(x.gastado, 0) + Math.max(x.ahorrado, 0)),
    ...vistos.map((x) => x.ingreso)));
  const elegido = mesAñoTocado ?? Math.max(mesesCerrados(), 1);
  const sel = meses[elegido - 1];

  const card = tarjeta("El año en 12 meses");
  card.append(leyenda([["muestra-raya", "Ingreso"], ["muestra-variables", "Gastado"], ["muestra-ahorro", "Ahorrado"], ["muestra-futuro", "Por venir"]]));
  const lectura = franja(mayus(NOMBRE_MES[elegido - 1]) + (elegido === mesMaximo() && mesAMedias() ? ` · hasta el ${partesFecha(datos.datosHasta).d}` : ""));
  lectura.append(
    tresCifras([[eur(sel.ingreso), "ingreso"], [eur(sel.gastado), "gastado"], [eur(sel.ahorrado), "ahorrado"]]),
    el("div", "plata-franja-nota", `Quedó libre: ${eur(sel.ingreso - sel.gastado - sel.ahorrado)}`),
  );
  card.append(lectura);

  const graf = el("div", "plata-graf con-eje");
  for (const f of [0, 0.5, 1]) {
    const linea = el("div", "plata-rejilla");
    linea.style.bottom = `${f * 100}%`;
    linea.append(el("span", "plata-rejilla-texto", eur(escala * f)));
    graf.append(linea);
  }
  const area = el("div", "plata-graf-area");
  meses.forEach((x, i) => {
    const col = columnaDeMes(i + 1, elegido, (m) => {
      mesAñoTocado = m;
      pintarPlata();
    });
    if (i + 1 <= mesMaximo()) {
      const conAhorro = x.ahorrado > 0;
      const g = el("span", `plata-apilada gastado${conAhorro ? " con-ahorro" : ""}`);
      g.style.height = alto(x.gastado, escala);
      col.append(g);
      if (conAhorro) {
        const a = el("span", "plata-apilada ahorrado");
        a.style.bottom = `calc(${alto(x.gastado, escala)} + 2px)`;
        a.style.height = alto(x.ahorrado, escala);
        col.append(a);
      }
      // El ingreso es una rayita; en el mes a medias, solo cuando ya llegó.
      if (x.ingreso > 0) {
        const raya = el("span", "plata-ingreso");
        raya.style.bottom = alto(x.ingreso, escala);
        col.append(raya);
      }
      col.setAttribute("aria-label", `${mayus(NOMBRE_MES[i])}: ingreso ${eur(x.ingreso)}, gastado ${eur(x.gastado)}, ahorrado ${eur(x.ahorrado)}`);
    }
    area.append(col);
  });
  graf.append(area);
  const letras = filaDeLetras(elegido);
  letras.classList.add("con-eje");
  card.append(graf, letras);
  if (mesAMedias()) {
    card.append(el("div", "plata-nota-derecha", `${NOMBRE_MES[mesMaximo() - 1]}: datos hasta el ${partesFecha(datos.datosHasta).d}`));
  }

  const tot = (clave) => eur(suma(vistos, (x) => x[clave]));
  const totales = tresCifras([[tot("ingreso"), "ingreso del año"], [tot("gastado"), "gastado"], [tot("ahorrado"), "ahorrado"]], true);
  totales.classList.add("plata-totales");
  card.append(totales);
  return card;
}

// Lo acumulado contra el presupuesto del año, con una marca de «lo que
// tocaría» a la fecha de los datos. Pasar la marca no es alarma (estos gastos
// llegan de golpe); solo pasarse del total del año pinta terracota.
function tarjetaAnuales() {
  const { a } = partesFecha(datos.datosHasta);
  const fraccion = a > datos.año ? 1 : diaDelAño(datos.datosHasta) / diasDelAño(a);
  const filas = datos.categorias.filter((c) => c.tipo === "anual").map((c) => {
    const acum = suma(c.meses.slice(0, mesMaximo()), (v) => v);
    const pres = c.presAño || 0;
    return { c, acum, pres, pasado: pres > 0 && acum > pres };
  });
  // Las que se pasaron, arriba; el resto, en el orden del Sheet.
  filas.sort((x, y) => Number(y.pasado) - Number(x.pasado) || (y.pasado ? y.acum / y.pres - x.acum / x.pres : 0));

  const card = tarjeta("Gastos anuales");
  const nota = el("div", "plata-nota-marca");
  nota.append(el("span", "plata-muestra muestra-marca"),
    `lo que tocaría al ${fechaCorta(datos.datosHasta)} · pasarla no es alarma: estos gastos llegan de golpe`);
  card.append(nota);
  for (const { c, acum, pres, pasado } of filas) {
    const fila = el("button", "plata-barra-fila");
    fila.type = "button";
    fila.addEventListener("click", () => abrirDetalle(c.nombre, "año"));
    const arriba = el("div", "plata-barra-fila-arriba");
    arriba.append(el("span", "plata-barra-fila-nombre", c.nombre), el("span", "plata-barra-fila-meta", `${eur(acum)} de ${eur(pres)}`));
    const pista = el("div", "plata-pista");
    const relleno = el("div", `plata-pista-relleno${pasado ? " pasado" : ""}`);
    relleno.style.width = pres > 0 ? `${Math.min(Math.max(acum, 0) / pres, 1) * 100}%` : "0%";
    pista.append(relleno);
    const caja = el("div", "plata-pista-caja");
    caja.append(pista);
    if (pres > 0) {
      const marca = el("div", "plata-pista-marca");
      marca.style.left = `${fraccion * 100}%`;
      caja.append(marca);
    }
    const abajo = el("div", "plata-barra-fila-abajo");
    const estado = pasado ? `Se pasaron ${eur(acum - pres)}`
      : acum <= 0 ? `Todavía nada · quedan ${eur(pres)}` : `Quedan ${eur(pres - acum)}`;
    abajo.append(el("span", pasado ? "pasado" : acum <= 0 ? "tenue" : "", estado),
      el("span", "tenue", `tocaría ${eur(pres * fraccion)}`));
    fila.append(arriba, caja, abajo);
    card.append(fila);
  }
  return card;
}

// El saldo hacia la meta del año y 12 baldositas, una por mes. Se cuentan
// por acumulado: con lo ahorrado hasta hoy, ¿cuántos aportes esperados se
// cubren? Así un aporte doble (abril y mayo juntos) cubre los dos meses, y un
// mes sin aporte se ve («!»), no queda como un hueco.
function tarjetaAhorros() {
  const max = mesMaximo();
  const cerrados = mesesCerrados();
  const card = tarjeta("Ahorros");
  card.append(leyenda([["baldosa llego", "aporte llegó"], ["baldosa falta", "falta"], ["baldosa pendiente", "pendiente"], ["baldosa porvenir", "por venir"]]));
  for (const c of datos.categorias.filter((x) => x.tipo === "ahorro")) {
    const saldo = suma(c.meses.slice(0, max), (v) => v);
    const meta = c.presAño || 0;
    const esperado = c.presMes || meta / 12;
    const cubiertos = esperado > 0 ? Math.floor((saldo + 0.01) / esperado) : 0;

    const bloque = el("div", "plata-barra-fila plata-ahorro");
    const arriba = el("div", "plata-barra-fila-arriba");
    arriba.append(el("span", "plata-barra-fila-nombre", c.nombre), el("span", "plata-barra-fila-meta", `${eur(saldo)} de ${eur(meta)}`));
    const pista = el("div", "plata-pista");
    const relleno = el("div", "plata-pista-relleno ahorro");
    relleno.style.width = meta > 0 ? `${Math.min(Math.max(saldo, 0) / meta, 1) * 100}%` : "0%";
    pista.append(relleno);

    const baldosas = el("div", "plata-baldosas");
    const faltan = [];
    for (let k = 1; k <= 12; k++) {
      const estado = k <= cubiertos ? "llego" : k <= cerrados ? "falta" : k === max ? "pendiente" : "porvenir";
      if (estado === "falta") faltan.push(NOMBRE_MES[k - 1]);
      const col = el("div", "plata-baldosa-col");
      const b = el("span", `baldosa ${estado}`, estado === "falta" ? "!" : "");
      b.title = `${mayus(NOMBRE_MES[k - 1])}: ${{ llego: "aporte llegó", falta: "falta", pendiente: "pendiente", porvenir: "por venir" }[estado]}`;
      col.append(b, el("span", "plata-baldosa-letra", LETRAS_MES[k - 1]));
      baldosas.append(col);
    }

    let mensaje = "";
    let pasado = false;
    if (faltan.length) {
      pasado = true;
      const debe = cerrados * esperado - saldo;
      mensaje = `${faltan.length > 1 ? "Faltan los aportes" : "Falta el aporte"} de ${lista(faltan)}${debe > 0.005 ? ` (${eur(debe)})` : ""}`;
    } else if (meta > 0 && saldo >= meta) {
      mensaje = "Ya llegaron a la meta del año";
    } else if (meta > 0 && cerrados > 0) {
      const ritmo = saldo / cerrados;
      mensaje = ritmo * 12 >= meta
        ? `Llegan a la meta en ${NOMBRE_MES[Math.min(Math.ceil(meta / ritmo), 12) - 1]}`
        : `A este ritmo terminan el año en ${eur(ritmo * 12)}: cortos por ${eur(meta - ritmo * 12)}`;
    }
    const abajo = el("div", "plata-barra-fila-abajo");
    abajo.append(el("span", pasado ? "pasado" : "", mensaje), el("span", "tenue sin-cortar", `${eur(esperado)}/mes`));
    bloque.append(arriba, pista, baldosas, abajo);
    card.append(bloque);
  }
  return card;
}

// Cuántos pesos llegaron por cada euro enviado, envío por envío, y lo que se
// fue en comisiones (Bancolombia y el 4×1000) en el año.
function tarjetaColombia() {
  const { envios, comisiones = {} } = datos.colombia;
  const ordenados = [...envios].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const totalEur = suma(ordenados, (e) => e.eur);
  const totalCop = suma(ordenados, (e) => e.cop);
  const totalCom = (comisiones.bancolombia || 0) + (comisiones.cuatroPorMil || 0);
  const tasa = (e) => e.cop / e.eur;
  const tasaProm = totalCop / totalEur;

  const card = tarjeta("Lo que rinde cada euro en Colombia");
  card.append(el("div", "plata-card-sub",
    `${ordenados.length} ${ordenados.length === 1 ? "envío" : "envíos"} · ${eur(totalEur)} enviados · ${cop(totalCop)} recibidos`));
  card.append(tresCifras([
    [conPuntos(tasaProm), "tasa promedio", "COP por €"],
    [conPuntos((totalCop - totalCom) / totalEur), "tasa efectiva", "ya sin comisiones"],
    [conPuntos(totalCom), "comisiones", `≈ ${eur(totalCom / tasaProm)}`],
  ], true));

  const i = envioTocado ?? ordenados.length - 1;
  const e = ordenados[i];
  card.append(franja(`${fechaCorta(e.fecha)} · ${e.etiqueta}`, "",
    `${eur(e.eur)} → ${cop(e.cop)} · tasa ${conPuntos(tasa(e))} COP por €`));

  // La gráfica: la tasa de cada envío en su fecha, contra el promedio.
  const tasas = ordenados.map(tasa);
  const piso = Math.floor((Math.min(...tasas) - 50) / 100) * 100;
  const techo = Math.ceil((Math.max(...tasas) + 50) / 100) * 100;
  const y = (t) => ((t - piso) / (techo - piso)) * 100;
  const x = (iso) => ((diaDelAño(iso) - 0.5) / diasDelAño(datos.año)) * 100;
  const graf = el("div", "plata-graf plata-graf-tasa con-eje-corto");
  for (const t of [piso, (piso + techo) / 2, techo]) {
    const linea = el("div", "plata-rejilla");
    linea.style.bottom = `${y(t)}%`;
    linea.append(el("span", "plata-rejilla-texto", conPuntos(t)));
    graf.append(linea);
  }
  const prom = el("div", "plata-promedio");
  prom.style.bottom = `${y(tasaProm)}%`;
  prom.append(el("span", "plata-tope-texto", `promedio ${conPuntos(tasaProm)}`));
  graf.append(prom);
  const area = el("div", "plata-tasa-area");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const linea = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  linea.setAttribute("points", ordenados.map((env) => `${x(env.fecha) * 10},${1000 - y(tasa(env)) * 10}`).join(" "));
  linea.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(linea);
  area.append(svg);
  ordenados.forEach((env, k) => {
    const punto = el("button", `plata-punto${k === i ? " elegido" : ""}`);
    punto.type = "button";
    punto.style.left = `${x(env.fecha)}%`;
    punto.style.bottom = `${y(tasa(env))}%`;
    punto.setAttribute("aria-label", `${fechaCorta(env.fecha)}: ${conPuntos(tasa(env))} COP por euro`);
    punto.append(el("span"));
    punto.addEventListener("click", () => {
      envioTocado = k;
      pintarPlata();
    });
    area.append(punto);
  });
  graf.append(area);
  card.append(graf);
  const letras = filaDeLetras(0);
  letras.classList.add("con-eje-corto");
  card.append(letras);

  if (ordenados.length > 1) {
    const mejor = ordenados.reduce((a, b) => (tasa(b) > tasa(a) ? b : a));
    const peor = ordenados.reduce((a, b) => (tasa(b) < tasa(a) ? b : a));
    card.append(el("p", "plata-hallazgo",
      `El envío que más rindió fue el del ${fechaCorta(mejor.fecha)} (${conPuntos(tasa(mejor))} COP por euro) y el que menos, el del ${fechaCorta(peor.fecha)} (${conPuntos(tasa(peor))}).`));
  }

  const desglose = el("div", "plata-comisiones");
  const mayor = Math.max(comisiones.cuatroPorMil || 0, comisiones.bancolombia || 0, 1);
  for (const [nombre, monto] of [["4×1000", comisiones.cuatroPorMil || 0], ["Comisiones Bancolombia", comisiones.bancolombia || 0]]) {
    const fila = el("div");
    const arriba = el("div", "plata-barra-fila-arriba");
    arriba.append(el("span", "", nombre), el("span", "plata-barra-fila-meta", cop(monto)));
    const pista = el("div", "plata-pista fina");
    const relleno = el("div", "plata-pista-relleno comision");
    relleno.style.width = `${(monto / mayor) * 100}%`;
    pista.append(relleno);
    fila.append(arriba, pista);
    desglose.append(fila);
  }
  card.append(desglose);
  return card;
}

/* ── Viajes ──
   Todo lo que lleva la etiqueta del viaje en Movimientos, también lo que se
   pagó desde el Fondo Colombia (igual que la pestaña Viajes: es lo que de
   verdad costó). Un solo color: comparar largos basta. */

function pantallaViajes() {
  const porViaje = new Map();
  for (const mv of datos.movimientos) {
    if (!mv.viaje) continue;
    const v = porViaje.get(mv.viaje) || { nombre: mv.viaje, total: 0, movs: [], ultima: "" };
    v.total += mv.monto;
    v.movs.push(mv);
    if (mv.fecha > v.ultima) v.ultima = mv.fecha;
    porViaje.set(mv.viaje, v);
  }
  const viajes = [...porViaje.values()].sort((a, b) => b.total - a.total);
  const frag = document.createDocumentFragment();
  frag.append(cabecera(`PLATA · ${datos.año}`, "Viajes"));
  if (!viajes.length) {
    frag.append(el("p", "plata-nota", "Todavía no hay viajes en Movimientos."));
    return frag;
  }
  frag.append(el("p", "plata-nota", `${viajes.length} ${viajes.length === 1 ? "viaje" : "viajes"} · ${eur(suma(viajes, (v) => v.total))} en el año`));

  // El abierto: el que se tocó o, si no, el más reciente. El mes de un viaje
  // es el de su último movimiento (el primero suele ser la reserva).
  const elegido = viajes.find((v) => v.nombre === viajeElegido)
    || [...viajes].sort((a, b) => b.ultima.localeCompare(a.ultima))[0];
  const mesDe = (v) => NOMBRE_MES[partesFecha(v.ultima).m - 1];
  const mayor = Math.max(...viajes.map((v) => v.total), 1);

  const listaCard = el("div", "grupo-card plata-viajes");
  for (const v of viajes) {
    const fila = el("button", `plata-viaje${v === elegido ? " elegido" : ""}`);
    fila.type = "button";
    fila.setAttribute("aria-pressed", String(v === elegido));
    const arriba = el("div", "plata-viaje-arriba");
    const derecha = el("span", "plata-viaje-derecha");
    derecha.append(el("span", "tenue", mesDe(v)), el("strong", "", eur(v.total)));
    arriba.append(el("span", "plata-viaje-nombre", v.nombre), derecha);
    const pista = el("div", "plata-pista fina");
    const relleno = el("div", "plata-pista-relleno");
    relleno.style.width = `${(Math.max(v.total, 0) / mayor) * 100}%`;
    pista.append(relleno);
    fila.append(arriba, pista);
    fila.addEventListener("click", () => {
      viajeElegido = v.nombre;
      pintarPlata();
      const quieto = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      document.querySelector(".plata-viaje-detalle")?.scrollIntoView({ behavior: quieto ? "auto" : "smooth", block: "start" });
    });
    listaCard.append(fila);
  }
  frag.append(listaCard);

  // El viaje abierto: por categoría (de mayor a menor) y sus movimientos.
  const porCategoria = new Map();
  for (const mv of elegido.movs) porCategoria.set(mv.categoria, (porCategoria.get(mv.categoria) || 0) + mv.monto);
  const categorias = [...porCategoria.entries()].sort((a, b) => b[1] - a[1]);
  const card = el("section", "plata-card plata-viaje-detalle");
  const titulo = el("div", "plata-viaje-arriba");
  titulo.append(el("h3", "plata-viaje-titulo", elegido.nombre), el("strong", "plata-viaje-total", eur(elegido.total)));
  card.append(titulo, el("div", "plata-card-sub",
    `${mesDe(elegido)} · ${categorias.length} ${categorias.length === 1 ? "categoría" : "categorías"} · ${elegido.movs.length} ${elegido.movs.length === 1 ? "movimiento" : "movimientos"}`));
  const mayorCat = Math.max(...categorias.map(([, t]) => t), 1);
  for (const [nombre, total] of categorias) {
    const fila = el("div", "plata-viaje-cat");
    const arriba = el("div", "plata-barra-fila-arriba");
    const pct = elegido.total > 0 ? Math.round((total / elegido.total) * 100) : 0;
    arriba.append(el("span", "", nombre), el("span", "plata-barra-fila-meta", `${eur(total)} · ${pct} %`));
    const pista = el("div", "plata-pista fina");
    const relleno = el("div", "plata-pista-relleno");
    relleno.style.width = `${(Math.max(total, 0) / mayorCat) * 100}%`;
    pista.append(relleno);
    fila.append(arriba, pista);
    card.append(fila);
  }
  card.append(el("div", "plata-mini-etiqueta", "MOVIMIENTOS"), ...filasDeMovimientos(elegido.movs, { conCategoria: true }));
  frag.append(card);
  return frag;
}

/* ── El PIN ── */

function pantallaPin() {
  const card = el("section", "plata-card plata-vacio plata-pin");
  const ico = el("div", "plata-vacio-icono");
  ico.append(icono("candado"));
  card.append(ico, el("div", "plata-vacio-titulo", "Plata"), el("p", "", "Pon tu PIN para ver el presupuesto."));

  // Quién eres: se recuerda en este teléfono para no preguntarlo cada vez.
  const quienes = el("div", "plata-quien");
  quienes.setAttribute("role", "group");
  quienes.setAttribute("aria-label", "¿Quién eres?");
  for (const [valor, nombre] of [["tania", "Tania"], ["jc", "JC"]]) {
    const opcion = el("button", "", nombre);
    opcion.type = "button";
    opcion.setAttribute("aria-pressed", String(quien === valor));
    opcion.addEventListener("click", () => {
      quien = valor;
      localStorage.setItem("queJuicio.plataQuien", valor);
      pinError = "";
      pintarPlata();
    });
    quienes.append(opcion);
  }

  const form = el("form", "plata-pin-form");
  const input = el("input", "plata-pin-input");
  input.type = "password";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 4;
  input.setAttribute("aria-label", "PIN de 4 dígitos");
  input.disabled = !quien || enviandoPin;
  // Al cuarto dígito entra solo; el botón queda por si acaso.
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
    if (input.value.length === 4) entrarConPin(input.value);
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (input.value.length === 4) entrarConPin(input.value);
  });
  const error = quien
    ? el("p", "plata-pin-error", pinError)
    : el("p", "plata-pin-error ayuda", "¿Quién eres? Escoge arriba.");
  error.setAttribute("role", "alert");
  const entrarBtn = el("button", "btn btn-primario", enviandoPin ? "Entrando…" : "Entrar");
  entrarBtn.type = "submit";
  entrarBtn.disabled = !quien || enviandoPin;
  form.append(input, error, entrarBtn);
  card.append(quienes, form);
  return card;
}

/* ── Estados ── */

function mesVacio(mes) {
  const card = el("section", "plata-card plata-vacio");
  const ico = el("div", "plata-vacio-icono");
  ico.append(icono("calendario"));
  card.append(
    ico,
    el("div", "plata-vacio-titulo", `${mayus(NOMBRE_MES[mes.m - 1])} todavía no tiene datos`),
    el("p", "", "Se llena al cerrar el mes, o a mitad de mes si alguien actualiza la hoja."),
  );
  if (mes.m > 1) {
    const ver = el("button", "btn btn-primario", `Ver ${NOMBRE_MES[mes.m - 2]}`);
    ver.type = "button";
    ver.addEventListener("click", () => irAMes(mes.m - 1));
    card.append(ver);
  }
  return card;
}

// Primera carga: formas quietas en el color de la pista, sin brillo animado.
function esqueleto() {
  const card = el("section", "plata-card plata-esqueleto");
  card.setAttribute("aria-busy", "true");
  card.setAttribute("aria-label", "Cargando");
  const bloque = (clase) => el("div", clase);
  card.append(bloque("esq-etiqueta"), bloque("esq-cifra"), bloque("esq-barra"));
  for (const anchos of [["55%", "35%"], ["40%", "50%"], ["60%", "30%"]]) {
    const fila = bloque("esq-fila");
    const textos = bloque("esq-textos");
    for (const ancho of anchos) {
      const linea = bloque("esq-linea");
      linea.style.width = ancho;
      textos.append(linea);
    }
    fila.append(bloque("esq-anillo"), textos);
    card.append(fila);
  }
  return card;
}

function tarjetaError() {
  const card = el("section", "plata-card plata-vacio");
  const reintentar = el("button", "btn btn-primario", "Reintentar");
  reintentar.type = "button";
  reintentar.addEventListener("click", cargarPlata);
  card.append(
    el("div", "plata-vacio-titulo", "No se pudo leer la plata"),
    el("p", "", errorPlata),
    reintentar,
  );
  return card;
}
