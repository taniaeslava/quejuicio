// QueJuicio — pestaña Coneja: cuántas veces jugamos Coneja.
//
// Cada partida es un documento en households/{codigo}/conejas/{id}:
//   { fecha: "2026-10-14", tipo: "regular" | "linguismo", estructura: true | false,
//     momento: "manana" | "tarde" | "noche" | null, lugar: "Casa" | null, nota: "…" | null,
//     createdAt }
// La fecha va como texto «año-mes-día» del día local, no como Timestamp: así
// una coneja de las 11 de la noche no se corre de día por la zona horaria.
// Las importadas de Loop Habits (el registro de 2019 a oct 2026) solo dicen
// el día: llevan origen: "loop" y tipo y estructura en null («sin detalle»);
// las estadísticas por tipo o estructura las dejan aparte.
// Momento, lugar y nota son opcionales (para que anotar siga siendo rápido),
// pero son los que dan para el resumen del año («Wrapped»): vale la pena
// pedirlos siempre en el diálogo. El momento se pone solo si es de hoy.
//
// app.js se suscribe a la colección (como a las demás) y le pasa la lista a
// pintarConeja(); las escrituras también las hace app.js (configurarConeja),
// así este módulo solo dibuja y no conoce Firestore.
//
// Arriba, el calendario del mes: un puntico si ese día hubo una coneja y el
// número si hubo varias. Tocar un día vacío anota una; tocar uno con conejas
// las muestra para corregirlas. Debajo, el año en 12 meses (comparado con el
// anterior, con filtro por tipo y estructura) y unos datos curiosos.
// La cabecera, las tarjetas, la franja de lectura y las columnas reusan las
// clases de Plata en style.css, para que las dos pestañas se vean iguales.

const NOMBRE_MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const LETRAS_MES = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const NOMBRE_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const TIPOS = { regular: "Regular", linguismo: "Lingüismo" };
const MOMENTOS = { manana: "Mañana", tarde: "Tarde", noche: "Noche" };
const FILTROS = [
  ["todas", "Todas", () => true],
  ["regular", "Regular", (c) => c.tipo === "regular"],
  ["linguismo", "Lingüismo", (c) => c.tipo === "linguismo"],
  ["con", "Con estructura", (c) => c.estructura === true],
  ["sin", "Sin estructura", (c) => c.estructura === false],
];
const CLAVE_ULTIMA = "queJuicio.conejaUltima"; // tipo, estructura y lugar de la última anotada (por teléfono)

let conejas = [];
let llegaron = false;    // ¿ya llegó el primer snapshot?
let errorLectura = false;
let acciones = null;     // { guardar(id, datos), borrar(id), avisar(texto) }: las pone app.js
let visto = null;        // { a, m }: el mes del calendario (m de 1 a 12)
let filtro = "todas";    // qué conejas cuenta «el año en 12 meses»
let diaAbierto = null;   // la fecha del diálogo de un día
let enEdicion = null;    // id de la coneja que se corrige (null = nueva)
let momentoPuesto = false; // ¿el momento lo puso la app (por ser hoy) y no la persona?

/* ── Lo que usa app.js ── */

export function configurarConeja(nuevas) {
  acciones = nuevas;
  $("#form-coneja").addEventListener("submit", guardar);
  $("#btn-cancelar-coneja").addEventListener("click", () => $("#dialogo-coneja").close());
  $("#btn-eliminar-coneja").addEventListener("click", eliminar);
  $("#btn-otra-coneja").addEventListener("click", () => {
    const fecha = diaAbierto;
    $("#dialogo-coneja-dia").close();
    nuevaConeja(fecha);
  });
  $("#btn-cerrar-coneja-dia").addEventListener("click", () => $("#dialogo-coneja-dia").close());
  $("#dialogo-coneja-dia").addEventListener("close", () => (diaAbierto = null));
  // Si la app puso el momento por ser hoy y cambian el día, ya no aplica.
  $("#coneja-fecha").addEventListener("change", () => {
    if (!momentoPuesto) return;
    marcarOpcion("coneja-momento", $("#coneja-fecha").value === hoy().iso ? momentoDeAhora() : null);
  });
  // El momento es opcional: tocar el que ya está marcado lo quita.
  for (const opcion of document.querySelectorAll('input[name="coneja-momento"]')) {
    opcion.addEventListener("pointerdown", () => (opcion.dataset.estaba = String(opcion.checked)));
    opcion.addEventListener("click", () => {
      momentoPuesto = false;
      if (opcion.dataset.estaba === "true") opcion.checked = false;
      opcion.dataset.estaba = "";
    });
  }
}

// Sin lista, solo vuelve a pintar (p. ej. al abrir la pestaña otro día).
export function pintarConeja(lista) {
  if (lista) {
    conejas = lista.filter((c) => typeof c.fecha === "string");
    llegaron = true;
    errorLectura = false;
  }
  pintar();
}

// Lo más probable: falta publicar la regla de «conejas» en Firestore.
export function errorConeja() {
  errorLectura = true;
  pintar();
}

export function olvidarConeja() {
  conejas = [];
  llegaron = errorLectura = false;
  visto = diaAbierto = enEdicion = null;
  filtro = "todas";
  $("#vista-coneja")?.replaceChildren();
}

// El «+» de la pestaña (y tocar un día vacío). Con `coneja`, la corrige.
export function nuevaConeja(fecha = hoy().iso, coneja = null) {
  enEdicion = coneja?.id ?? null;
  $("#titulo-dialogo-coneja").textContent = coneja ? "Corregir coneja" : "Nueva coneja";
  $("#btn-eliminar-coneja").hidden = !coneja;
  $("#coneja-fecha").value = fecha;
  $("#coneja-fecha").max = hoy().iso;
  const base = coneja || ultimaAnotada();
  // Una «sin detalle» abre sin nada marcado (no se le inventa un tipo).
  marcarOpcion("coneja-tipo", base.tipo in TIPOS ? base.tipo : coneja ? null : "regular");
  marcarOpcion("coneja-estructura", typeof base.estructura === "boolean" ? (base.estructura ? "si" : "no") : coneja ? null : "no");
  momentoPuesto = !coneja && fecha === hoy().iso;
  marcarOpcion("coneja-momento", coneja ? coneja.momento : momentoPuesto ? momentoDeAhora() : null);
  $("#coneja-lugar").value = base.lugar || "";
  $("#coneja-nota").value = coneja?.nota || "";
  // Los lugares más usados, a un toque.
  $("#coneja-lugares").replaceChildren(...lugaresUsados().slice(0, 4).map(([lugar]) => {
    const chip = el("button", "sugerencia", lugar);
    chip.type = "button";
    chip.addEventListener("click", () => ($("#coneja-lugar").value = lugar));
    return chip;
  }));
  $("#dialogo-coneja").showModal();
}

/* ── Utilidades ── */

const $ = (sel) => document.querySelector(sel);
const dos = (n) => String(n).padStart(2, "0");
const isoDe = (a, m, d) => `${a}-${dos(m)}-${dos(d)}`;
const diasDelMes = (a, m) => new Date(a, m, 0).getDate();
const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const suma = (nums) => nums.reduce((s, n) => s + n, 0);
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const decimal = (n) => n.toLocaleString("es-CO", { maximumFractionDigits: 1 });
const delMes = (lista, a, m) => lista.filter((c) => c.fecha.startsWith(`${a}-${dos(m)}-`));
const delAño = (lista, a) => lista.filter((c) => c.fecha.startsWith(`${a}-`));

function hoy() {
  const f = new Date();
  const a = f.getFullYear(), m = f.getMonth() + 1, d = f.getDate();
  return { a, m, d, iso: isoDe(a, m, d) };
}

function partes(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return { a, m, d };
}

// Días entre dos fechas «año-mes-día» (sin líos de horario de verano).
function diasEntre(desde, hasta) {
  const utc = (iso) => { const { a, m, d } = partes(iso); return Date.UTC(a, m - 1, d); };
  return Math.round((utc(hasta) - utc(desde)) / 86_400_000);
}

const fechaCorta = (iso) => `${partes(iso).d} ${MES_CORTO[partes(iso).m - 1]}`;

function fechaLarga(iso) {
  const { a, m, d } = partes(iso);
  const dia = NOMBRE_DIA[new Date(a, m - 1, d).getDay()];
  return `${mayus(dia)} ${d} de ${NOMBRE_MES[m - 1]}${a === hoy().a ? "" : ` de ${a}`}`;
}

function lista(palabras) {
  return palabras.length < 2 ? palabras.join("") : `${palabras.slice(0, -1).join(", ")} y ${palabras.at(-1)}`;
}

function momentoDeAhora() {
  const hora = new Date().getHours();
  return hora >= 5 && hora < 12 ? "manana" : hora >= 12 && hora < 19 ? "tarde" : "noche";
}

// [[lugar, veces], ...] del más usado al menos usado. «casa» y «Casa» son el
// mismo lugar; se muestra como se escribió la última vez.
function lugaresUsados(lista = conejas) {
  const cuenta = new Map();
  for (const c of [...lista].sort((x, y) => x.fecha.localeCompare(y.fecha))) {
    const lugar = c.lugar?.trim();
    if (!lugar) continue;
    const clave = lugar.toLocaleLowerCase("es");
    cuenta.set(clave, [lugar, (cuenta.get(clave)?.[1] || 0) + 1]);
  }
  return [...cuenta.values()].sort((a, b) => b[1] - a[1]);
}

function agruparPorDia(lista) {
  const mapa = new Map();
  for (const c of lista) mapa.set(c.fecha, [...(mapa.get(c.fecha) || []), c]);
  return mapa;
}

function el(tag, clase = "", texto = "") {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto) n.textContent = texto;
  return n;
}

// Mismo trazo que icono() de app.js, con los que necesita Coneja.
const ICONOS = {
  atras: '<path d="m15 18-6-6 6-6"/>',
  adelante: '<path d="m9 18 6-6-6-6"/>',
  editar: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  calendario: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
};
function icono(nombre) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONOS[nombre];
  return svg;
}

function botonRedondo(nombreIcono, etiqueta, accion) {
  const b = el("button");
  b.type = "button";
  b.setAttribute("aria-label", etiqueta);
  b.append(icono(nombreIcono));
  b.addEventListener("click", accion);
  return b;
}

/* ── La pantalla ── */

function pintar() {
  const cont = $("#vista-coneja");
  if (!cont) return;
  const h = hoy();
  if (!visto) visto = { a: h.a, m: h.m };
  cont.replaceChildren(cabecera(h), tarjetaCalendario(h));
  if (errorLectura) {
    cont.append(el("p", "plata-nota",
      "No se pudieron leer las conejas. ¿Ya está publicada la regla de «conejas» en Firestore?"));
  } else if (llegaron && !conejas.length) {
    cont.append(el("p", "plata-pie", "Toca un día o el + para anotar la primera coneja."));
  } else if (conejas.length) {
    cont.append(tarjetaAño(h));
    const curiosos = tarjetaCuriosos(h);
    if (curiosos) cont.append(curiosos);
  }
  if (diaAbierto) pintarDia(); // el otro teléfono pudo cambiar algo
}

// Va al mes pedido, sin pasar del mes en curso (no hay conejas del futuro).
function irA(a, m) {
  const h = hoy();
  const k = Math.min(a * 12 + m - 1, h.a * 12 + h.m - 1);
  visto = { a: Math.floor(k / 12), m: (k % 12) + 1 };
  pintar();
}

function cabecera(h) {
  const frag = document.createDocumentFragment();
  const cab = el("div", "plata-cabecera");
  const titulos = el("div", "plata-titulos");
  titulos.append(el("span", "plata-etiqueta", `CONEJA · ${visto.a}`), el("h2", "plata-mes", mayus(NOMBRE_MES[visto.m - 1])));
  const nav = el("div", "plata-nav");
  const siguiente = botonRedondo("adelante", "Mes siguiente", () => irA(visto.a, visto.m + 1));
  const enCurso = visto.a === h.a && visto.m === h.m;
  siguiente.disabled = enCurso;
  nav.append(botonRedondo("atras", "Mes anterior", () => irA(visto.a, visto.m - 1)), siguiente);
  cab.append(titulos, nav);
  frag.append(cab);
  if (!enCurso) {
    const volver = el("button", "plata-chip coneja-ir-hoy");
    volver.type = "button";
    volver.append(icono("calendario"), `Volver a ${NOMBRE_MES[h.m - 1]}`);
    volver.addEventListener("click", () => irA(h.a, h.m));
    frag.append(volver);
  }
  return frag;
}

// La cuenta del mes, el calendario y cómo se repartieron.
function tarjetaCalendario(h) {
  const { a, m } = visto;
  const delMesVisto = delMes(conejas, a, m);
  const n = delMesVisto.length;
  const card = el("section", "plata-card coneja-calendario");

  const cifra = el("div", "plata-cifra");
  cifra.append(
    el("span", "plata-cifra-grande", String(n)),
    el("span", "plata-cifra-de", `${n === 1 ? "coneja" : "conejas"} en ${NOMBRE_MES[m - 1]}`),
  );
  card.append(cifra);
  const anterior = m === 1 ? { a: a - 1, m: 12 } : { a, m: m - 1 };
  const nAnterior = delMes(conejas, anterior.a, anterior.m).length;
  if (n || nAnterior) {
    const frase = comparar(n, nAnterior, NOMBRE_MES[anterior.m - 1]);
    const enCurso = a === h.a && m === h.m && nAnterior > 0; // el mes va a medias
    card.append(el("div", "plata-card-sub", enCurso ? `Por ahora, ${frase.charAt(0).toLowerCase()}${frase.slice(1)}` : frase));
  }

  const semana = el("div", "coneja-semana");
  semana.setAttribute("aria-hidden", "true");
  for (const letra of ["L", "M", "M", "J", "V", "S", "D"]) semana.append(el("span", "", letra));
  const dias = el("div", "coneja-dias");
  const huecos = (new Date(a, m - 1, 1).getDay() + 6) % 7; // la semana empieza el lunes
  for (let i = 0; i < huecos; i++) dias.append(el("span"));
  const porDia = agruparPorDia(delMesVisto);
  for (let d = 1; d <= diasDelMes(a, m); d++) {
    const iso = isoDe(a, m, d);
    const cuantas = porDia.get(iso)?.length || 0;
    const boton = el("button", "coneja-dia");
    boton.type = "button";
    if (cuantas) boton.classList.add("con");
    if (iso === h.iso) boton.classList.add("hoy");
    const marca = el("span", "coneja-marca");
    if (cuantas === 1) marca.classList.add("punto");
    if (cuantas > 1) {
      marca.classList.add("varias");
      marca.textContent = String(cuantas);
    }
    boton.append(el("span", "coneja-dia-num", String(d)), marca);
    const nombre = `${d} de ${NOMBRE_MES[m - 1]}`;
    if (iso > h.iso) {
      boton.disabled = true;
      boton.setAttribute("aria-label", nombre);
    } else {
      boton.setAttribute("aria-label", cuantas ? `${nombre}: ${plural(cuantas, "coneja", "conejas")}` : `${nombre}: anotar una coneja`);
      boton.addEventListener("click", () => tocarDia(iso));
    }
    dias.append(boton);
  }
  card.append(semana, dias);
  const repartido = n ? reparto(delMesVisto) : null;
  if (repartido) card.append(repartido);
  return card;
}

function comparar(n, antes, nombreMes) {
  const dif = n - antes;
  if (!antes) return `En ${nombreMes} no hubo ninguna`;
  if (!dif) return `Igual que en ${nombreMes}`;
  return `${Math.abs(dif)} ${dif > 0 ? "más" : "menos"} que en ${nombreMes}, que tuvo ${antes}`;
}

// Dos barras partidas: regular / lingüismo y con / sin estructura. Las que
// no tienen ese detalle (las importadas de Loop) no entran: van en una nota.
function reparto(lista) {
  const caja = el("div", "coneja-reparto");
  const cuenta = (cumple) => lista.filter(cumple).length;
  for (const [izq, nIzq, der, nDer] of [
    ["Regular", cuenta((c) => c.tipo === "regular"), "Lingüismo", cuenta((c) => c.tipo === "linguismo")],
    ["Con estructura", cuenta((c) => c.estructura === true), "Sin estructura", cuenta((c) => c.estructura === false)],
  ]) {
    if (!nIzq && !nDer) continue;
    const fila = el("div");
    const pista = el("div", "coneja-pista");
    pista.setAttribute("aria-hidden", "true");
    for (const [valor, clase] of [[nIzq, "coneja-pista-a"], [nDer, "coneja-pista-b"]]) {
      if (!valor) continue;
      const tramo = el("span", clase);
      tramo.style.flexGrow = String(valor);
      pista.append(tramo);
    }
    const textos = el("div", "coneja-reparto-textos");
    const a = el("span", "", `${izq} `);
    a.append(el("strong", "", String(nIzq)));
    const b = el("span");
    b.append(el("strong", "", String(nDer)), ` ${der.charAt(0).toLowerCase()}${der.slice(1)}`);
    textos.append(a, b);
    fila.append(pista, textos);
    caja.append(fila);
  }
  const sinDetalle = cuenta((c) => !(c.tipo in TIPOS));
  if (sinDetalle) {
    caja.append(el("div", "coneja-sin-detalle", sinDetalle === lista.length
      ? "Sin detalle de tipo ni estructura. Toca un día para completarlo."
      : `${plural(sinDetalle, "coneja", "conejas")} sin detalle de tipo ni estructura.`));
  }
  return caja.childElementCount ? caja : null;
}

// Un tope «redondo» y par para el eje, así la línea de la mitad es entera.
function escalaConteo(maximo) {
  const pasos = [2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100];
  return pasos.find((p) => p >= maximo) ?? Math.ceil(maximo / 20) * 20;
}

const alto = (valor, escala) => `${(valor / escala) * 100}%`;

// El año del mes visto en 12 columnas; si hay datos del año anterior, cada
// mes lleva al lado su barrita de ese año. Tocar una columna lleva a ese mes.
function tarjetaAño(h) {
  const { a, m } = visto;
  const [, nombreFiltro, cumple] = FILTROS.find(([valor]) => valor === filtro);
  const filtradas = conejas.filter(cumple);
  const porMes = (año) => Array.from({ length: 12 }, (_, i) => delMes(filtradas, año, i + 1).length);
  const este = porMes(a);
  const antes = porMes(a - 1);
  const hayAntes = delAño(conejas, a - 1).length > 0;
  const ultimoMes = a === h.a ? h.m : 12;

  const card = el("section", "plata-card");
  const titulo = el("div", "coneja-año-titulo");
  const nav = el("div", "plata-nav");
  const siguiente = botonRedondo("adelante", "Año siguiente", () => irA(a + 1, m));
  siguiente.disabled = a >= h.a;
  const primerAño = partes(conejas.reduce((min, c) => (c.fecha < min ? c.fecha : min), "9999")).a;
  const anterior = botonRedondo("atras", "Año anterior", () => irA(a - 1, m));
  anterior.disabled = a <= primerAño;
  nav.append(anterior, siguiente);
  titulo.append(el("h3", "plata-card-titulo", `${a} en 12 meses`), nav);
  card.append(titulo, selectorDeFiltro());
  const fuera = delAño(conejas, a).filter((c) => !cumple(c) && !(c.tipo in TIPOS)).length;
  if (filtro !== "todas" && fuera) {
    card.append(el("p", "plata-hallazgo", `${plural(fuera, "coneja", "conejas")} de ${a} sin detalle no entran en este filtro.`));
  }
  if (hayAntes) {
    const ley = el("div", "plata-leyenda-linea");
    for (const [muestra, texto] of [["muestra-variables", String(a)], ["coneja-muestra-antes", String(a - 1)]]) {
      const item = el("span");
      item.append(el("span", `plata-muestra ${muestra}`), texto);
      ley.append(item);
    }
    card.append(ley);
  }

  const lectura = el("div", "plata-franja");
  const arriba = el("div", "plata-franja-fila");
  arriba.append(
    el("span", "plata-franja-titulo", mayus(NOMBRE_MES[m - 1]) + (filtro === "todas" ? "" : ` · ${nombreFiltro.toLowerCase()}`)),
    el("span", "plata-franja-monto", plural(este[m - 1], "coneja", "conejas")),
  );
  lectura.append(arriba);
  if (hayAntes) lectura.append(el("div", "plata-franja-nota", `En ${NOMBRE_MES[m - 1]} de ${a - 1}: ${antes[m - 1]}`));
  card.append(lectura);

  const escala = escalaConteo(Math.max(1, ...este, ...(hayAntes ? antes : [])));
  const graf = el("div", "plata-graf coneja-graf");
  for (const f of [0, 0.5, 1]) {
    const linea = el("div", "plata-rejilla");
    linea.style.bottom = `${f * 100}%`;
    linea.append(el("span", "plata-rejilla-texto", String(escala * f)));
    graf.append(linea);
  }
  const area = el("div", "plata-graf-area");
  for (let i = 0; i < 12; i++) {
    const mes = i + 1;
    const col = el("button", `plata-col${mes === m ? " elegido" : ""}`);
    col.type = "button";
    if (hayAntes) {
      const barra = el("span", "coneja-barra antes");
      barra.style.height = alto(antes[i], escala);
      col.append(barra);
    }
    const lado = hayAntes ? " este" : "";
    if (mes > ultimoMes) {
      // Lo que no ha pasado va punteado, nunca como una barra en cero.
      col.append(el("span", `coneja-barra porvenir${lado}`));
      col.disabled = true;
      col.setAttribute("aria-label", `${mayus(NOMBRE_MES[i])}: todavía no`);
    } else {
      const barra = el("span", `coneja-barra${lado}`);
      barra.style.height = alto(este[i], escala);
      col.append(barra);
      col.setAttribute("aria-label", `${mayus(NOMBRE_MES[i])}: ${plural(este[i], "coneja", "conejas")}`
        + (hayAntes ? `; en ${a - 1}: ${antes[i]}` : ""));
      col.addEventListener("click", () => irA(a, mes));
    }
    area.append(col);
  }
  graf.append(area);
  const letras = el("div", "plata-letras coneja-letras");
  LETRAS_MES.forEach((l, i) => letras.append(el("span", i + 1 === m ? "elegida" : "", l)));
  card.append(graf, letras);

  // Totales: el año, el anterior hasta la misma fecha (o entero) y el promedio.
  const total = suma(este);
  const primera = conejas.reduce((min, c) => (c.fecha < min ? c.fecha : min), "9999");
  const desde = partes(primera).a === a ? partes(primera).m : 1;
  const meses = Math.max(1, ultimoMes - desde + 1);
  const cifras = [[String(total), `en ${a}`]];
  if (hayAntes) {
    const hasta = a === h.a ? h.iso.slice(5) : "12-31";
    const alMismoDia = delAño(filtradas, a - 1).filter((c) => c.fecha.slice(5) <= hasta).length;
    cifras.push([String(alMismoDia), a === h.a ? `${a - 1}, a esta altura` : `en ${a - 1}`]);
    cifras.push([decimal(total / meses), "por mes"]);
  } else {
    cifras.push([decimal(total / meses), "por mes"]);
    const mejor = Math.max(...este);
    if (mejor > 0) cifras.push([mayus(MES_CORTO[este.indexOf(mejor)]), `el mejor mes (${mejor})`]);
  }
  const totales = el("div", "plata-tres plata-totales");
  for (const [valor, etiqueta] of cifras) {
    const d = el("div");
    d.append(el("span", "plata-tres-etq", etiqueta), el("span", "plata-tres-valor", valor));
    totales.append(d);
  }
  card.append(totales);
  return card;
}

function selectorDeFiltro() {
  const caja = el("div", "coneja-filtros");
  caja.setAttribute("role", "group");
  caja.setAttribute("aria-label", "Qué conejas contar");
  for (const [valor, nombre] of FILTROS) {
    const b = el("button", "coneja-chip", nombre);
    b.type = "button";
    b.setAttribute("aria-pressed", String(filtro === valor));
    b.addEventListener("click", () => {
      filtro = valor;
      pintar();
    });
    caja.append(b);
  }
  return caja;
}

// Rachas, récords y el día de la semana en que más se juega (sin filtro).
function tarjetaCuriosos(h) {
  const a = visto.a;
  const delAñoVisto = delAño(conejas, a);
  if (!delAñoVisto.length) return null;
  const porDia = agruparPorDia(delAñoVisto);
  const fechas = [...porDia.keys()].sort();
  const filas = [["Días con coneja", plural(fechas.length, "día", "días")]];

  let racha = { n: 1, desde: fechas[0] }, actual = { ...racha };
  for (let i = 1; i < fechas.length; i++) {
    actual = diasEntre(fechas[i - 1], fechas[i]) === 1 ? { n: actual.n + 1, desde: actual.desde } : { n: 1, desde: fechas[i] };
    if (actual.n > racha.n) racha = actual;
  }
  if (racha.n >= 2) filas.push(["Racha más larga", `${racha.n} días, desde el ${fechaCorta(racha.desde)}`]);

  const record = fechas.reduce((mejor, f) => (porDia.get(f).length > porDia.get(mejor).length ? f : mejor));
  if (porDia.get(record).length >= 2) filas.push(["Récord en un día", `${porDia.get(record).length}, el ${fechaCorta(record)}`]);

  if (delAñoVisto.length >= 3) {
    const porSemana = Array(7).fill(0);
    for (const c of delAñoVisto) { const { m, d } = partes(c.fecha); porSemana[new Date(a, m - 1, d).getDay()]++; }
    const max = Math.max(...porSemana);
    const favoritos = NOMBRE_DIA.filter((_, i) => porSemana[i] === max);
    if (favoritos.length <= 3) filas.push([favoritos.length === 1 ? "El día que más se juega" : "Los días que más se juega", mayus(lista(favoritos))]);
  }

  const lugares = lugaresUsados(delAñoVisto);
  if (lugares.length) filas.push(["El lugar favorito", `${lugares[0][0]} (${lugares[0][1]})`]);
  if (lugares.length > 1) filas.push(["Lugares distintos", String(lugares.length)]);
  const porMomento = Object.keys(MOMENTOS).map((k) => [k, delAñoVisto.filter((c) => c.momento === k).length]);
  const [momento, veces] = porMomento.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (veces) filas.push(["El momento favorito", `${MOMENTOS[momento].toLowerCase()} (${veces})`]);

  if (a === h.a) {
    const ultima = conejas.reduce((max, c) => (c.fecha > max && c.fecha <= h.iso ? c.fecha : max), "");
    if (ultima) {
      const hace = diasEntre(ultima, h.iso);
      filas.push(["La última", hace === 0 ? "hoy" : hace === 1 ? "ayer" : `hace ${hace} días`]);
    }
  }

  const card = el("section", "plata-card");
  card.append(el("h3", "plata-card-titulo", `Datos curiosos de ${a}`));
  const datos = el("div", "plata-pie-datos");
  for (const [etiqueta, valor] of filas) {
    const fila = el("div");
    fila.append(el("span", "", etiqueta), el("strong", "", valor));
    datos.append(fila);
  }
  card.append(datos);
  return card;
}

/* ── Un día: sus conejas, para corregirlas o anotar otra ── */

function tocarDia(iso) {
  if (!conejas.some((c) => c.fecha === iso)) {
    nuevaConeja(iso);
    return;
  }
  diaAbierto = iso;
  pintarDia();
  $("#dialogo-coneja-dia").showModal();
}

function pintarDia() {
  const dialogo = $("#dialogo-coneja-dia");
  const delDia = conejas
    .filter((c) => c.fecha === diaAbierto)
    .sort((x, y) => (x.createdAt?.seconds ?? Infinity) - (y.createdAt?.seconds ?? Infinity));
  if (!delDia.length) {
    if (dialogo.open) dialogo.close();
    return;
  }
  $("#titulo-coneja-dia").textContent = fechaLarga(diaAbierto);
  $("#lista-coneja-dia").replaceChildren(...delDia.map((c, i) => {
    const fila = el("button", "fila fila-toque coneja-fila");
    fila.type = "button";
    fila.setAttribute("aria-label", `Corregir la coneja ${i + 1}`);
    const cuerpo = el("div", "fila-cuerpo");
    cuerpo.append(
      el("div", "fila-titulo", TIPOS[c.tipo] || "Sin detalle"),
      el("div", "fila-meta", [
        typeof c.estructura === "boolean" ? (c.estructura ? "Con estructura" : "Sin estructura") : "",
        MOMENTOS[c.momento], c.lugar, c.origen === "loop" ? "de Loop Habits" : "",
      ].filter(Boolean).join(" · ") || "Toca para completarla"),
    );
    if (c.nota) cuerpo.append(el("div", "fila-meta coneja-nota", `«${c.nota}»`));
    const editar = el("span", "coneja-editar");
    editar.append(icono("editar"));
    fila.append(el("span", "coneja-ficha", String(i + 1)), cuerpo, editar);
    fila.addEventListener("click", () => {
      dialogo.close();
      nuevaConeja(c.fecha, c);
    });
    return fila;
  }));
}

/* ── Guardar / borrar ── */

function ultimaAnotada() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_ULTIMA)) || { tipo: "regular", estructura: false, lugar: "" };
  } catch {
    return { tipo: "regular", estructura: false, lugar: "" };
  }
}

// Con valor null no deja ninguna marcada.
function marcarOpcion(nombre, valor) {
  for (const opcion of document.querySelectorAll(`input[name="${nombre}"]`)) opcion.checked = opcion.value === valor;
}

const opcionMarcada = (nombre) => document.querySelector(`input[name="${nombre}"]:checked`)?.value;

// Se cierra el diálogo antes de esperar a Firestore: sin internet, la
// coneja aparece igual (Firestore la guarda en el teléfono) y sube al volver.
async function guardar(ev) {
  ev.preventDefault();
  const fecha = $("#coneja-fecha").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return;
  if (fecha > hoy().iso) {
    acciones.avisar("Ese día todavía no ha llegado.");
    return;
  }
  const datos = {
    fecha,
    tipo: opcionMarcada("coneja-tipo") ?? null,
    estructura: { si: true, no: false }[opcionMarcada("coneja-estructura")] ?? null,
    momento: opcionMarcada("coneja-momento") ?? null,
    lugar: $("#coneja-lugar").value.trim().slice(0, 60) || null,
    nota: $("#coneja-nota").value.trim().slice(0, 140) || null,
  };
  const id = enEdicion;
  $("#dialogo-coneja").close();
  if (!id) {
    localStorage.setItem(CLAVE_ULTIMA, JSON.stringify({ tipo: datos.tipo, estructura: datos.estructura, lugar: datos.lugar }));
  }
  visto = { a: partes(fecha).a, m: partes(fecha).m };
  pintar();
  acciones.avisar(id ? "Coneja corregida." : "¡Coneja anotada! 🐇");
  try {
    await acciones.guardar(id, datos);
  } catch (err) {
    console.error("coneja:", err);
    acciones.avisar("No se pudo guardar. ¿Ya está publicada la regla de «conejas» en Firestore?");
  }
}

async function eliminar() {
  if (!enEdicion || !confirm("¿Borrar esta coneja?")) return;
  const id = enEdicion;
  $("#dialogo-coneja").close();
  try {
    await acciones.borrar(id);
  } catch (err) {
    console.error("coneja:", err);
    acciones.avisar("No se pudo borrar. Revisa la conexión.");
  }
}
