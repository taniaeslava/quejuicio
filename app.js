// QueJuicio — módulo principal.
// Habla con Firestore directamente desde el navegador (SDK por CDN, sin build).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot,
  addDoc, updateDoc, deleteDoc, setDoc,
  serverTimestamp, Timestamp, deleteField, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported as messagingIsSupported,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { firebaseConfig, VAPID_KEY } from "./config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const DIA_MS = 86_400_000;
const HISTORIAL_MAX = 10;
const $ = (sel) => document.querySelector(sel);

let codigoHogar = localStorage.getItem("queJuicio.hogar") || "";
let tareas = [];
let desuscribir = null;
let idEnEdicion = null;

// ── Lista de compras ──
let compras = [];        // artículos activos { id, name, store, createdAt }
let tiendasExtra = [];   // tiendas agregadas por la usuaria { id, name }
let despensa = [];       // memoria para autocompletar { id, name, store, lastBought }
let desuscribirCompras = null;
let desuscribirTiendas = null;
let desuscribirDespensa = null;
let ultimoBorrado = null; // para "Deshacer" al marcar comprado
let editandoItemId = null; // artículo cuyo nombre se está reescribiendo
let arrastrando = false;  // true mientras se reordena algo (pausa el re-render)
let arrastrandoDesde = 0; // momento en que empezó; sirve de red de seguridad
let ordenTiendas = [];    // orden manual de las tiendas (se guarda en prefs/general)
let desuscribirPrefs = null;

// ── Kits (listas para no olvidar nada) ──
let kits = [];            // { id, name, order, items:[{id,label,cat}], checked:{id:true} }
let desuscribirKits = null;
let kitAbiertoId = null;  // id del kit cuyo detalle se está viendo (null = lista)
let itemKitEnEdicion = null; // { itemId } al editar; null al agregar
let kitRenombrarId = null;   // kit o plantilla que se está renombrando
let creandoKit = false;      // evita crear dos kits por doble toque

// ── Plantillas de kits (editables; viven en Firestore, no en el código) ──
let plantillas = [];            // { id, name, order, items:[{id,label,cat}] }
let desuscribirPlantillas = null;
let plantillaAbiertaId = null;  // plantilla que se está editando (null = ninguna)
let viendoPlantillas = false;   // true = pantalla con la lista de plantillas
let snapPrefsLista = false;     // ¿ya llegó el primer snapshot de prefs?
let snapPlantillasLista = false;// ¿ya llegó el primer snapshot de plantillas?
let plantillasSembradas = false;// bandera guardada en prefs/general
const TIENDAS_DEFECTO = ["Edeka", "Ikea", "Amazon", "Tedi"];
const tiendasAbiertas = new Set(
  JSON.parse(localStorage.getItem("queJuicio.tiendasAbiertas") || "[]"),
);
const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

/* ── Estado de frescura ─────────────────────────────────────
   La misma regla vive en notify/index.js (estaVencida): una
   tarea está vencida cuando han pasado >= frequencyDays desde
   lastDone. Si cambias esto, cambia también el script. */
function taskStatus(tarea, ahora = Date.now()) {
  // Las de una sola vez no envejecen: están pendientes hasta hacerse.
  if (tarea.once) return { ratio: 0, diasRestantes: null, estado: "unica" };
  const ultimaMs = aMilis(tarea.lastDone) ?? aMilis(tarea.createdAt) ?? ahora;
  const diasTranscurridos = (ahora - ultimaMs) / DIA_MS;
  const ratio = Math.max(0, diasTranscurridos / tarea.frequencyDays);
  const diasRestantes = Math.ceil(tarea.frequencyDays - diasTranscurridos);
  const estado = ratio >= 1 ? "vencida" : diasRestantes <= 7 ? "pronto" : "fresca";
  return { ratio, diasRestantes, estado };
}

function aMilis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return null;
}

/* ── Entrar / salir del hogar ── */
function coleccionTareas() {
  return collection(db, "households", codigoHogar, "tasks");
}
const coleccionCompras = () => collection(db, "households", codigoHogar, "shopping");
const coleccionTiendas = () => collection(db, "households", codigoHogar, "stores");
const coleccionDespensa = () => collection(db, "households", codigoHogar, "pantry");
const docPrefs = () => doc(db, "households", codigoHogar, "prefs", "general");
const coleccionKits = () => collection(db, "households", codigoHogar, "kits");
const coleccionPlantillas = () => collection(db, "households", codigoHogar, "plantillas");

// Un kit y una plantilla tienen la misma forma; solo cambia dónde viven.
const buscarKit = (id) => kits.find((k) => k.id === id) || plantillas.find((p) => p.id === id);
const refDe = (kit) => doc(kit.esPlantilla ? coleccionPlantillas() : coleccionKits(), kit.id);

function entrarAlHogar(codigo) {
  codigoHogar = codigo;
  localStorage.setItem("queJuicio.hogar", codigo);
  $("#pantalla-entrada").hidden = true;
  $("#pantalla-principal").hidden = false;
  $("#ajustes-codigo").textContent = codigo;
  desuscribir?.();
  desuscribir = onSnapshot(
    coleccionTareas(),
    (snap) => {
      tareas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      pintarLista();
    },
    (err) => {
      console.error(err);
      avisar("No se pudo conectar con Firestore. Revisa config.js y las reglas.");
    },
  );

  const errorCompras = (err) => console.error("compras:", err);
  desuscribirCompras?.();
  desuscribirCompras = onSnapshot(coleccionCompras(), (snap) => {
    compras = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    pintarCompras();
  }, errorCompras);
  desuscribirTiendas?.();
  desuscribirTiendas = onSnapshot(coleccionTiendas(), (snap) => {
    tiendasExtra = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    pintarCompras();
  }, errorCompras);
  desuscribirDespensa?.();
  desuscribirDespensa = onSnapshot(coleccionDespensa(), (snap) => {
    despensa = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }, errorCompras);
  desuscribirPrefs?.();
  desuscribirPrefs = onSnapshot(docPrefs(), (snap) => {
    ordenTiendas = snap.data()?.storeOrder || [];
    plantillasSembradas = snap.data()?.plantillasSembradas === true;
    snapPrefsLista = true;
    quizasSembrarPlantillas();
    pintarCompras();
  }, errorCompras);
  desuscribirKits?.();
  desuscribirKits = onSnapshot(coleccionKits(), (snap) => {
    kits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    pintarKits();
  }, errorCompras);
  desuscribirPlantillas?.();
  desuscribirPlantillas = onSnapshot(coleccionPlantillas(), (snap) => {
    plantillas = snap.docs.map((d) => ({ id: d.id, ...d.data(), esPlantilla: true }));
    snapPlantillasLista = true;
    quizasSembrarPlantillas();
    pintarKits();
  }, (err) => {
    // Lo más probable: falta publicar la regla de 'plantillas' en Firestore.
    console.error("plantillas:", err);
  });

  // Pintar ya el estado inicial, sin esperar a Firestore.
  pintarCompras();
  pintarKits();
  mostrarVista(localStorage.getItem("queJuicio.vista") || "tareas");
}

function salirDelHogar() {
  desuscribir?.();
  desuscribirCompras?.();
  desuscribirTiendas?.();
  desuscribirDespensa?.();
  desuscribirPrefs?.();
  desuscribirKits?.();
  desuscribirPlantillas?.();
  desuscribir = desuscribirCompras = desuscribirTiendas = desuscribirDespensa = desuscribirPrefs = desuscribirKits = desuscribirPlantillas = null;
  localStorage.removeItem("queJuicio.hogar");
  codigoHogar = "";
  tareas = [];
  compras = [];
  tiendasExtra = [];
  despensa = [];
  ordenTiendas = [];
  kits = [];
  kitAbiertoId = null;
  plantillas = [];
  plantillaAbiertaId = null;
  viendoPlantillas = false;
  snapPrefsLista = snapPlantillasLista = plantillasSembradas = false;
  mostrarVista("tareas");
  $("#dialogo-ajustes").close();
  $("#pantalla-principal").hidden = true;
  $("#pantalla-entrada").hidden = false;
}

/* ── Render de tareas (agrupadas en tarjetas por tipo) ── */
function pintarLista() {
  const cont = $("#lista-tareas");
  const ahora = Date.now();
  const unicas = tareas
    .filter((t) => t.once)
    .sort((a, b) => (aMilis(a.createdAt) ?? 0) - (aMilis(b.createdAt) ?? 0));
  const recurrentes = tareas
    .filter((t) => !t.once)
    .sort((a, b) => taskStatus(b, ahora).ratio - taskStatus(a, ahora).ratio);

  cont.replaceChildren();
  if (unicas.length) cont.append(grupoTareas("UNA SOLA VEZ", unicas, ahora));
  if (recurrentes.length) cont.append(grupoTareas("RECURRENTES", recurrentes, ahora));
  $("#estado-vacio").hidden = tareas.length > 0;
}

function grupoTareas(etiqueta, items, ahora) {
  const grupo = document.createElement("div");
  grupo.className = "grupo";
  const head = document.createElement("div");
  head.className = "grupo-label";
  const etq = document.createElement("span");
  etq.className = "etq";
  etq.textContent = etiqueta;
  const cnt = document.createElement("span");
  cnt.className = "cuenta";
  cnt.textContent = String(items.length);
  head.append(etq, cnt);
  const card = document.createElement("div");
  card.className = "grupo-card";
  for (const t of items) card.append(filaDeTarea(t, ahora));
  grupo.append(head, card);
  return grupo;
}

function filaDeTarea(tarea, ahora) {
  const { ratio, diasRestantes, estado } = taskStatus(tarea, ahora);
  const fila = document.createElement("div");
  fila.className = "fila";

  // Anillo: conic-gradient que se llena con lo transcurrido; punteado en las
  // de una sola vez. Verde (lejos) → ámbar (≤7 días) → terracota (vencida).
  const anillo = document.createElement("div");
  anillo.className = `anillo ${estado}`;
  if (estado !== "unica") {
    const color = estado === "vencida" ? "#C25A38" : estado === "pronto" ? "#C08A2E" : "#4F7A5B";
    const pct = Math.round(Math.min(ratio, 1) * 100);
    anillo.style.background = `conic-gradient(${color} 0 ${pct}%, var(--ring-track) ${pct}% 100%)`;
  }
  const disco = document.createElement("div");
  disco.className = "anillo-disco";
  disco.textContent = estado === "unica" ? "1×" : estado === "vencida" ? "¡ya!" : `${diasRestantes}d`;
  anillo.append(disco);

  const cuerpo = document.createElement("div");
  cuerpo.className = "fila-cuerpo";
  const titulo = document.createElement("div");
  titulo.className = "fila-titulo";
  titulo.textContent = tarea.name;
  const meta = document.createElement("div");
  meta.className = "fila-meta";
  meta.textContent = metaTarea(tarea, estado, diasRestantes);
  cuerpo.append(titulo, meta);

  const check = document.createElement("button");
  check.type = "button";
  check.className = "btn-hecha";
  check.setAttribute("aria-label", `Marcar «${tarea.name}» como hecha`);
  check.textContent = "✓";
  check.addEventListener("click", (ev) => {
    ev.stopPropagation();
    marcarHecha(tarea);
  });

  fila.append(anillo, cuerpo, check);
  fila.addEventListener("click", () => abrirDialogoTarea(tarea));
  return fila;
}

// Metadatos en UNA sola línea. Lejos → cuándo se hizo; cerca → cuándo vence.
function metaTarea(tarea, estado, diasRestantes) {
  if (estado === "unica") return "Pendiente";
  const freq = mayus(frecuenciaTexto(tarea.frequencyDays));
  let est;
  if (estado === "vencida") {
    const d = Math.max(1, -diasRestantes + 1);
    est = `vencida hace ${d} día${d === 1 ? "" : "s"}`;
  } else if (diasRestantes <= 14) {
    est = diasRestantes <= 0 ? "vence hoy"
      : diasRestantes === 1 ? "vence mañana"
      : `vence en ${diasRestantes} días`;
  } else {
    est = `hecha el ${fechaCorta(tarea.lastDone)}`;
  }
  return `${freq} · ${est}`;
}

const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function frecuenciaTexto(dias) {
  if (dias % 30 === 0) {
    const m = dias / 30;
    return m === 1 ? "cada mes" : `cada ${m} meses`;
  }
  if (dias % 7 === 0) {
    const s = dias / 7;
    return s === 1 ? "cada semana" : `cada ${s} semanas`;
  }
  return `cada ${dias} días`;
}

function fechaCorta(ts) {
  const ms = aMilis(ts);
  if (!ms) return "—";
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short" }).format(ms);
}

/* ── Acciones sobre tareas ── */
async function marcarHecha(tarea) {
  // Las de una sola vez se retiran de la lista al hacerse.
  if (tarea.once) {
    await deleteDoc(doc(coleccionTareas(), tarea.id));
    avisar(`«${tarea.name}» hecha. ¡Qué juicio! 🎉`);
    return;
  }
  const historial = [
    { doneAt: Timestamp.now() },
    ...(tarea.history || []),
  ].slice(0, HISTORIAL_MAX);
  await updateDoc(doc(coleccionTareas(), tarea.id), {
    lastDone: Timestamp.now(),
    history: historial,
    lastNotified: deleteField(),
  });
  avisar(`«${tarea.name}» quedó al día. ¡Qué juicio! 🎉`);
}

function abrirDialogoTarea(tarea = null) {
  idEnEdicion = tarea?.id ?? null;
  $("#titulo-dialogo-tarea").textContent = tarea ? "Editar tarea" : "Nueva tarea";
  $("#btn-eliminar").hidden = !tarea;
  $("#tarea-nombre").value = tarea?.name ?? "";

  if (tarea?.once) {
    $("#tarea-unidad").value = "0";
    $("#tarea-cantidad").value = "1";
  } else {
    const dias = tarea?.frequencyDays ?? 90;
    let unidad = 1;
    if (dias % 30 === 0) unidad = 30;
    else if (dias % 7 === 0) unidad = 7;
    $("#tarea-unidad").value = String(unidad);
    $("#tarea-cantidad").value = String(dias / unidad);
  }

  const ultimaMs = aMilis(tarea?.lastDone) ?? Date.now();
  $("#tarea-ultima").value = new Date(ultimaMs).toISOString().slice(0, 10);

  actualizarCamposFrecuencia();
  $("#dialogo-tarea").showModal();
}

// Con "una sola vez" no aplican ni la cantidad ni la fecha de última vez.
function actualizarCamposFrecuencia() {
  const esUnica = $("#tarea-unidad").value === "0";
  $("#tarea-cantidad").hidden = esUnica;
  $("#label-ultima").hidden = esUnica;
  $("#tarea-ultima").hidden = esUnica;
  $("#tarea-ultima").required = !esUnica;
}

async function guardarTarea(ev) {
  ev.preventDefault();
  const nombre = $("#tarea-nombre").value.trim();
  if (!nombre) return;

  const esUnica = $("#tarea-unidad").value === "0";
  let cambios;
  if (esUnica) {
    cambios = { name: nombre, once: true, frequencyDays: null, lastDone: null };
  } else {
    const frequencyDays =
      Number($("#tarea-cantidad").value) * Number($("#tarea-unidad").value);
    if (!frequencyDays) return;
    // Fecha del <input type="date"> interpretada a mediodía local para
    // que no se corra de día por la zona horaria.
    const lastDone = Timestamp.fromDate(new Date(`${$("#tarea-ultima").value}T12:00:00`));
    cambios = { name: nombre, once: false, frequencyDays, lastDone };
  }

  if (idEnEdicion) {
    await updateDoc(doc(coleccionTareas(), idEnEdicion), {
      ...cambios, lastNotified: deleteField(),
    });
  } else {
    await addDoc(coleccionTareas(), {
      ...cambios, history: [], createdAt: serverTimestamp(),
    });
  }
  $("#dialogo-tarea").close();
}

// Las tareas de arranque del hogar; se crean desde el estado vacío
// con lastDone = hoy (cada una se ajusta después tocando la tarjeta).
const TAREAS_INICIALES = [
  { name: "Lavar brochas de maquillaje", frequencyDays: 30 },
  { name: "Lavar ducha", frequencyDays: 90 },
  { name: "Alacenas", frequencyDays: 120 },
];

async function crearTareasIniciales() {
  const boton = $("#btn-semilla");
  boton.disabled = true;
  try {
    await Promise.all(
      TAREAS_INICIALES.map((t) =>
        addDoc(coleccionTareas(), {
          ...t, once: false, lastDone: Timestamp.now(), history: [], createdAt: serverTimestamp(),
        }),
      ),
    );
    avisar("Tareas creadas. Toca cada una para ajustar su última vez.");
  } catch (err) {
    console.error(err);
    avisar("No se pudieron crear. ¿Ya está lista la configuración de Firebase?");
  } finally {
    boton.disabled = false;
  }
}

async function eliminarTarea() {
  if (!idEnEdicion) return;
  const tarea = tareas.find((t) => t.id === idEnEdicion);
  if (!confirm(`¿Eliminar «${tarea?.name}»?`)) return;
  await deleteDoc(doc(coleccionTareas(), idEnEdicion));
  $("#dialogo-tarea").close();
}

/* ── Pestañas: Tareas / Compras / Kits ── */
function mostrarVista(cual) {
  const vistas = ["tareas", "compras", "kits"];
  if (!vistas.includes(cual)) cual = "tareas";
  for (const v of vistas) {
    $(`#vista-${v}`).hidden = v !== cual;
    $(`#tab-${v}`).classList.toggle("activa", v === cual);
  }
  $("#btn-nueva").hidden = cual !== "tareas"; // el FAB "+" es solo para tareas
  localStorage.setItem("queJuicio.vista", cual);
}

/* ── Lista de compras ── */
function listaDeTiendas() {
  // Las de por defecto primero; luego las personalizadas que no repitan una.
  const nombres = [...TIENDAS_DEFECTO];
  for (const t of tiendasExtra) {
    if (!nombres.some((n) => n.toLowerCase() === t.name.toLowerCase())) nombres.push(t.name);
  }
  if (!ordenTiendas.length) return nombres;
  // Ordenar según el orden manual guardado; las no listadas quedan al final
  // en su orden base (Array.sort es estable, así que empatan sin moverse).
  const idx = (n) => { const i = ordenTiendas.indexOf(n); return i === -1 ? Infinity : i; };
  return nombres.slice().sort((a, b) => idx(a) - idx(b));
}

function esTiendaPersonalizada(nombre) {
  return !TIENDAS_DEFECTO.some((n) => n.toLowerCase() === nombre.toLowerCase());
}

function pintarCompras() {
  // No re-renderizar en medio de un arrastre real. Red de seguridad: si el
  // estado "arrastrando" quedó pegado por un gesto que no cerró bien, se libera
  // solo tras 4 s para que la lista nunca quede bloqueada.
  if (arrastrando && Date.now() - arrastrandoDesde < 4000) return;
  // Tampoco mientras se está reescribiendo el nombre de un artículo.
  if (editandoItemId && $(".item-edit")) return;
  arrastrando = false;
  const cont = $("#lista-tiendas");
  // Un cambio del otro teléfono dispara un re-render; guardamos el input en
  // edición (tienda, texto y cursor) para restaurarlo y no interrumpir.
  const activo = document.activeElement;
  let focoTienda = null, focoValor = "", focoPos = 0;
  if (activo && activo.classList?.contains("input-item")) {
    focoTienda = activo.closest(".tienda")?.dataset.store;
    focoValor = activo.value;
    focoPos = activo.selectionStart ?? focoValor.length;
  }

  const porTienda = new Map();
  for (const nombre of listaDeTiendas()) porTienda.set(nombre, []);
  for (const item of compras) {
    if (!porTienda.has(item.store)) porTienda.set(item.store, []); // tienda huérfana
    porTienda.get(item.store).push(item);
  }

  cont.replaceChildren(
    ...[...porTienda.entries()].map(([nombre, items]) => tarjetaTienda(nombre, items)),
  );

  if (focoTienda) {
    const input = cont.querySelector(`.tienda[data-store="${cssEscape(focoTienda)}"] .input-item`);
    if (input) {
      input.value = focoValor;
      input.focus();
      input.setSelectionRange(focoPos, focoPos);
      actualizarSugerencias(input, focoTienda);
    }
  }
}

function tarjetaTienda(nombre, items) {
  const abierta = tiendasAbiertas.has(nombre);
  const vacia = items.length === 0;
  const sec = document.createElement("section");
  sec.className = "tienda" + (abierta ? " abierta" : "") + (vacia && !abierta ? " vacia" : "");
  sec.dataset.store = nombre;

  // Encabezado: asa de arrastre · chevron · nombre · conteo.
  const header = document.createElement("button");
  header.type = "button";
  header.className = "tienda-header";
  const grip = document.createElement("span");
  grip.className = "tienda-grip";
  grip.setAttribute("aria-hidden", "true");
  grip.textContent = "⠿";
  const chevron = document.createElement("span");
  chevron.className = "tienda-chevron";
  chevron.setAttribute("aria-hidden", "true");
  const nom = document.createElement("span");
  nom.className = "tienda-nombre";
  nom.textContent = nombre;
  header.append(grip, chevron, nom);
  if (vacia && !abierta) {
    const etq = document.createElement("span");
    etq.className = "tienda-vacia-etq";
    etq.textContent = "vacía";
    header.append(etq);
  } else if (items.length) {
    const conteo = document.createElement("span");
    conteo.className = "tienda-conteo";
    conteo.textContent = String(items.length);
    header.append(conteo);
  }
  if (esTiendaPersonalizada(nombre)) {
    const del = document.createElement("span");
    del.className = "tienda-eliminar";
    del.setAttribute("role", "button");
    del.setAttribute("aria-label", `Eliminar tienda ${nombre}`);
    del.textContent = "✕";
    del.addEventListener("click", (ev) => { ev.stopPropagation(); eliminarTienda(nombre, items); });
    header.append(del);
  }
  header.addEventListener("click", () => alternarTienda(nombre));
  habilitarArrastreTienda(grip, sec);
  sec.append(header);

  if (!abierta) return sec; // colapsada: solo el encabezado

  const cuerpo = document.createElement("div");
  cuerpo.className = "tienda-cuerpo";

  if (items.length) {
    const div = document.createElement("div");
    div.className = "divisor-tienda";
    cuerpo.append(div);
    const ul = document.createElement("ul");
    ul.className = "lista-items";
    // Orden manual (campo order); si falta, por fecha de creación.
    const ordenados = [...items].sort(
      (a, b) => (a.order ?? aMilis(a.createdAt) ?? 0) - (b.order ?? aMilis(b.createdAt) ?? 0),
    );
    for (const item of ordenados) ul.append(filaItem(item));
    habilitarArrastre(ul, nombre);
    cuerpo.append(ul);
  }

  // Fila "+ Añadir a X" (input silencioso, sin caja).
  const form = document.createElement("form");
  form.className = "add-row";
  const plus = document.createElement("span");
  plus.className = "add-plus";
  plus.textContent = "+";
  const input = document.createElement("input");
  input.className = "input-item";
  input.type = "text";
  input.maxLength = 100;
  input.autocomplete = "off";
  input.placeholder = `Añadir a ${nombre}`;
  form.append(plus, input);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    agregarCompra(nombre, input.value);
    input.value = "";
    actualizarSugerencias(input, nombre);
  });
  input.addEventListener("input", () => actualizarSugerencias(input, nombre));
  // Pegar varias líneas (p. ej. copiadas de Notion) → un artículo por renglón.
  input.addEventListener("paste", (ev) => {
    const texto = ev.clipboardData?.getData("text") ?? "";
    if (/\r?\n/.test(texto)) {
      ev.preventDefault();
      const lineas = texto.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      agregarVariasCompras(nombre, lineas);
      input.value = "";
      actualizarSugerencias(input, nombre);
    }
  });
  cuerpo.append(form);

  const sug = document.createElement("div");
  sug.className = "sugerencias";
  cuerpo.append(sug);

  sec.append(cuerpo);
  return sec;
}

function filaItem(item) {
  const li = document.createElement("li");
  li.className = "item";
  li.dataset.id = item.id;

  const grip = document.createElement("span");
  grip.className = "item-grip";
  grip.setAttribute("aria-hidden", "true");
  grip.textContent = "⠿";

  // La casilla va SOLA dentro del <label>: así tocar el texto no la marca.
  const label = document.createElement("label");
  label.className = "item-check";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  label.append(chk);
  chk.addEventListener("change", () => { if (chk.checked) comprarItem(item); });

  // Tocar el texto = corregir el nombre ahí mismo (no lo borra).
  const txt = document.createElement("span");
  txt.className = "item-texto";
  txt.textContent = item.name;
  txt.addEventListener("click", () => editarItemInline(txt, item));

  li.append(grip, label, txt);
  habilitarSwipe(li, item);
  return li;
}

/* Editar el nombre de un artículo tocándolo (como en Google Keep).
   Mientras hay un input abierto, pintarCompras() se abstiene de re-dibujar
   para que un cambio del otro teléfono no te quite el texto de las manos. */
function editarItemInline(txt, item) {
  if (editandoItemId) return;
  editandoItemId = item.id;

  const input = document.createElement("input");
  input.className = "item-edit";
  input.type = "text";
  input.maxLength = 100;
  input.value = item.name;
  txt.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let cerrado = false;
  const terminar = async (guardar) => {
    if (cerrado) return;
    cerrado = true;
    const nuevo = input.value.trim().slice(0, 100);
    editandoItemId = null;
    if (guardar && nuevo && nuevo !== item.name) {
      try {
        await updateDoc(doc(coleccionCompras(), item.id), { name: nuevo });
      } catch (err) {
        console.error(err);
        avisar("No se pudo cambiar el nombre.");
      }
    }
    pintarCompras();
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); terminar(true); }
    if (ev.key === "Escape") { ev.preventDefault(); terminar(false); }
  });
  input.addEventListener("blur", () => terminar(true));
}

// Swipe a la derecha para ELIMINAR del todo (sin guardar en la despensa).
// Se distingue del checkbox (comprar) y del arrastre vertical del asa.
function habilitarSwipe(li, item) {
  const UMBRAL = 90; // px que hay que arrastrar para que borre
  let x0 = 0, y0 = 0, eje = null, dx = 0, activo = false;

  li.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".item-grip")) return; // el asa es para reordenar
    if (e.target.closest(".item-edit")) return; // no deslizar mientras se edita
    x0 = e.clientX; y0 = e.clientY; eje = null; dx = 0; activo = true;
    li.style.transition = "none";
  });
  li.addEventListener("pointermove", (e) => {
    if (!activo) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (eje === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      eje = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (eje === "x") { try { li.setPointerCapture(e.pointerId); } catch {} }
    }
    if (eje === "x") {
      e.preventDefault();
      dx = Math.max(0, mx); // solo hacia la derecha
      li.style.transform = `translateX(${dx}px)`;
      li.classList.toggle("swipe-borrar", dx > UMBRAL);
    }
  });
  const soltar = () => {
    if (!activo) return;
    activo = false;
    if (eje === "x") li.dataset.swiped = "1"; // que el swipe no marque el checkbox
    li.style.transition = "transform 0.2s ease";
    if (eje === "x" && dx > UMBRAL) {
      li.style.transform = "translateX(110%)";
      eliminarItem(item);
    } else {
      li.style.transform = "";
      li.classList.remove("swipe-borrar");
    }
  };
  li.addEventListener("pointerup", soltar);
  li.addEventListener("pointercancel", soltar);
  li.addEventListener("click", (e) => {
    if (li.dataset.swiped) { e.preventDefault(); e.stopPropagation(); delete li.dataset.swiped; }
  }, true);
}

async function eliminarItem(item) {
  try {
    await deleteDoc(doc(coleccionCompras(), item.id)); // NO se guarda en despensa
    ultimoBorrado = { name: item.name, store: item.store };
    avisarDeshacer(`«${item.name}» eliminado`, deshacerCompra);
  } catch (err) {
    console.error(err);
    avisar("No se pudo eliminar.");
  }
}

/* Arrastre para reordenar ÍTEMS (asa ⠿ de cada fila).
   Clave anti-bloqueo: el estado "arrastrando" se activa SOLO cuando el dedo
   se mueve de verdad (> UMBRAL px). Un toque simple nunca deja la lista
   trabada. Y `fin` siempre limpia el estado, pase lo que pase. */
const UMBRAL_ARRASTRE = 6;
function habilitarArrastre(ul, tienda) {
  for (const grip of ul.querySelectorAll(".item-grip")) {
    const li = grip.closest(".item");
    let y0 = 0, activo = false, moviendo = false;

    const mover = (ev) => {
      if (!activo) return;
      if (!moviendo) {
        if (Math.abs(ev.clientY - y0) < UMBRAL_ARRASTRE) return; // todavía es un toque
        moviendo = true;
        arrastrando = true;
        arrastrandoDesde = Date.now();
        li.classList.add("arrastrando");
      }
      const y = ev.clientY;
      const otros = [...ul.querySelectorAll(".item:not(.arrastrando)")];
      const siguiente = otros.find((s) => {
        const r = s.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (siguiente) ul.insertBefore(li, siguiente);
      else ul.append(li);
    };
    const fin = async (ev) => {
      grip.removeEventListener("pointermove", mover);
      grip.removeEventListener("pointerup", fin);
      grip.removeEventListener("pointercancel", fin);
      try { grip.releasePointerCapture(ev.pointerId); } catch {}
      const huboArrastre = moviendo;
      activo = false;
      moviendo = false;
      li.classList.remove("arrastrando");
      if (huboArrastre) {
        try { await guardarOrden(ul); } finally { arrastrando = false; pintarCompras(); }
      }
    };
    grip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      y0 = ev.clientY;
      activo = true;
      moviendo = false;
      try { grip.setPointerCapture(ev.pointerId); } catch {}
      grip.addEventListener("pointermove", mover);
      grip.addEventListener("pointerup", fin);
      grip.addEventListener("pointercancel", fin);
    });
  }
}

/* Arrastre para reordenar TIENDAS (asa ⠿ del encabezado). Mismo criterio
   anti-bloqueo que los ítems: solo arrastra si el dedo se mueve de verdad. */
function habilitarArrastreTienda(grip, sec) {
  grip.style.touchAction = "none";
  // Un toque en el asa no debe plegar/desplegar la tienda.
  grip.addEventListener("click", (ev) => ev.stopPropagation());

  let y0 = 0, activo = false, moviendo = false, cont = null;

  const mover = (ev) => {
    if (!activo) return;
    if (!moviendo) {
      if (Math.abs(ev.clientY - y0) < UMBRAL_ARRASTRE) return; // todavía es un toque
      moviendo = true;
      arrastrando = true;
      arrastrandoDesde = Date.now();
      sec.classList.add("arrastrando");
    }
    const y = ev.clientY;
    const otras = [...cont.querySelectorAll(".tienda:not(.arrastrando)")];
    const siguiente = otras.find((s) => {
      const r = s.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (siguiente) cont.insertBefore(sec, siguiente);
    else cont.append(sec);
  };
  const fin = async (ev) => {
    grip.removeEventListener("pointermove", mover);
    grip.removeEventListener("pointerup", fin);
    grip.removeEventListener("pointercancel", fin);
    try { grip.releasePointerCapture(ev.pointerId); } catch {}
    const huboArrastre = moviendo;
    activo = false;
    moviendo = false;
    sec.classList.remove("arrastrando");
    if (huboArrastre) {
      try { await guardarOrdenTiendas(cont); } finally { arrastrando = false; pintarCompras(); }
    }
  };
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    cont = sec.parentElement;
    if (!cont) return;
    y0 = ev.clientY;
    activo = true;
    moviendo = false;
    try { grip.setPointerCapture(ev.pointerId); } catch {}
    grip.addEventListener("pointermove", mover);
    grip.addEventListener("pointerup", fin);
    grip.addEventListener("pointercancel", fin);
  });
}

async function guardarOrdenTiendas(cont) {
  const orden = [...cont.querySelectorAll(".tienda")].map((s) => s.dataset.store);
  await setDoc(docPrefs(), { storeOrder: orden }, { merge: true });
}

async function guardarOrden(ul) {
  const ids = [...ul.querySelectorAll(".item")].map((li) => li.dataset.id);
  await Promise.all(
    ids.map((id, i) => {
      const item = compras.find((c) => c.id === id);
      if (item && item.order !== i) return updateDoc(doc(coleccionCompras(), id), { order: i });
      return null;
    }),
  );
}

function siguienteOrden(tienda) {
  const ordenes = compras.filter((c) => c.store === tienda).map((c) => c.order ?? 0);
  return ordenes.length ? Math.max(...ordenes) + 1 : 0;
}

async function agregarVariasCompras(tienda, nombres) {
  // Sin duplicados (entre las líneas pegadas y contra lo ya activo en la tienda).
  const yaEn = new Set(compras.filter((c) => c.store === tienda).map((c) => c.name.toLowerCase()));
  const nuevos = [];
  for (const n of nombres) {
    const bajo = n.toLowerCase();
    if (n && !yaEn.has(bajo)) { yaEn.add(bajo); nuevos.push(n.slice(0, 100)); }
  }
  if (!nuevos.length) return;
  const base = siguienteOrden(tienda);
  try {
    await Promise.all(
      nuevos.map((n, i) =>
        addDoc(coleccionCompras(), {
          name: n, store: tienda, order: base + i, createdAt: serverTimestamp(),
        }),
      ),
    );
    avisar(`${nuevos.length} artículo(s) agregados a ${tienda}.`);
  } catch (err) {
    console.error(err);
    avisar("No se pudieron agregar. ¿Publicaste las reglas de Firestore?");
  }
}

function alternarTienda(nombre) {
  if (tiendasAbiertas.has(nombre)) tiendasAbiertas.delete(nombre);
  else tiendasAbiertas.add(nombre);
  localStorage.setItem("queJuicio.tiendasAbiertas", JSON.stringify([...tiendasAbiertas]));
  pintarCompras();
}

function actualizarSugerencias(input, tienda) {
  const sug = input.closest(".tienda")?.querySelector(".sugerencias");
  if (!sug) return;
  const texto = input.value.trim().toLowerCase();
  if (!texto) { sug.replaceChildren(); return; }
  // Nombres ya activos en esta tienda: no los sugerimos otra vez.
  const yaEn = new Set(
    compras.filter((c) => c.store === tienda).map((c) => c.name.toLowerCase()),
  );
  const vistos = new Set();
  const matches = [];
  for (const p of despensa) {
    const n = p.name.toLowerCase();
    if (n.includes(texto) && !yaEn.has(n) && !vistos.has(n)) {
      vistos.add(n);
      matches.push(p.name);
      if (matches.length >= 5) break;
    }
  }
  sug.replaceChildren(
    ...matches.map((nombre) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sugerencia";
      b.textContent = nombre;
      b.addEventListener("click", () => {
        agregarCompra(tienda, nombre);
        input.value = "";
        sug.replaceChildren();
        input.focus();
      });
      return b;
    }),
  );
}

async function agregarCompra(tienda, nombre) {
  nombre = nombre.trim();
  if (!nombre) return;
  const existe = compras.some(
    (c) => c.store === tienda && c.name.toLowerCase() === nombre.toLowerCase(),
  );
  if (existe) { avisar(`«${nombre}» ya está en ${tienda}.`); return; }
  try {
    await addDoc(coleccionCompras(), {
      name: nombre, store: tienda, order: siguienteOrden(tienda), createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    avisar("No se pudo agregar. ¿Publicaste las reglas de Firestore?");
  }
}

async function comprarItem(item) {
  try {
    // Recordar en la despensa (deduplicado por nombre) para autocompletar luego.
    const clave = claveDespensa(item.name);
    if (clave) {
      await setDoc(
        doc(coleccionDespensa(), clave),
        { name: item.name, store: item.store, lastBought: serverTimestamp() },
        { merge: true },
      );
    }
    await deleteDoc(doc(coleccionCompras(), item.id));
    ultimoBorrado = { name: item.name, store: item.store };
    avisarDeshacer(`«${item.name}» comprado ✓`, deshacerCompra);
  } catch (err) {
    console.error(err);
    avisar("No se pudo marcar como comprado.");
  }
}

async function deshacerCompra() {
  if (!ultimoBorrado) return;
  const { name, store } = ultimoBorrado;
  ultimoBorrado = null;
  await addDoc(coleccionCompras(), {
    name, store, order: siguienteOrden(store), createdAt: serverTimestamp(),
  });
}

function claveDespensa(nombre) {
  return nombre.trim().toLowerCase().replaceAll("/", "-").slice(0, 120);
}

async function agregarTienda(nombre) {
  nombre = nombre.trim();
  if (!nombre) return;
  if (listaDeTiendas().some((n) => n.toLowerCase() === nombre.toLowerCase())) {
    avisar(`«${nombre}» ya existe.`);
    return;
  }
  tiendasAbiertas.add(nombre);
  localStorage.setItem("queJuicio.tiendasAbiertas", JSON.stringify([...tiendasAbiertas]));
  await addDoc(coleccionTiendas(), { name: nombre, createdAt: serverTimestamp() });
}

async function eliminarTienda(nombre, items) {
  const extra = tiendasExtra.find((t) => t.name.toLowerCase() === nombre.toLowerCase());
  if (!extra) return;
  const aviso = items.length
    ? `¿Eliminar la tienda «${nombre}» y sus ${items.length} artículo(s)?`
    : `¿Eliminar la tienda «${nombre}»?`;
  if (!confirm(aviso)) return;
  tiendasAbiertas.delete(nombre);
  await Promise.all(items.map((it) => deleteDoc(doc(coleccionCompras(), it.id))));
  await deleteDoc(doc(coleccionTiendas(), extra.id));
}

/* ── Kits (listas para no olvidar nada) ─────────────────────
   Cada kit vive en households/{code}/kits/{id} con:
     items:   [{ id, label, cat }]     (cat = categoría)
     checked: { [itemId]: true }       (mapa de marcados; se resetea al reusar)
   Las plantillas viven en households/{code}/plantillas/{id} (misma forma, sin
   'checked') y son EDITABLES. KITS_PLANTILLA es solo la semilla de fábrica:
   se copia a Firestore la primera vez y después ya no se vuelve a mirar. */
const KITS_PLANTILLA = [
  {
    name: "Asado",
    items: [
      { cat: "Comida y bebida", label: "Carne y/o chorizos" },
      { cat: "Comida y bebida", label: "Sal" },
      { cat: "Comida y bebida", label: "Limones" },
      { cat: "Comida y bebida", label: "Ají / salsas" },
      { cat: "Comida y bebida", label: "Pan o arepas" },
      { cat: "Comida y bebida", label: "Bebidas" },
      { cat: "Comida y bebida", label: "Hielo" },
      { cat: "Parrilla y utensilios", label: "Carbón" },
      { cat: "Parrilla y utensilios", label: "Encendedor o fósforos" },
      { cat: "Parrilla y utensilios", label: "Pinzas y cuchillo" },
      { cat: "Parrilla y utensilios", label: "Tabla para picar" },
      { cat: "Parrilla y utensilios", label: "Papel aluminio" },
      { cat: "Parrilla y utensilios", label: "Destapador de botellas" },
      { cat: "Parrilla y utensilios", label: "Platos, vasos y cubiertos" },
      { cat: "Comodidad", label: "Sillas o manta" },
      { cat: "Comodidad", label: "Música / parlante" },
      { cat: "Comodidad", label: "Repelente de insectos" },
      { cat: "Limpieza", label: "Bolsas de basura" },
      { cat: "Limpieza", label: "Servilletas / toallas de papel" },
      { cat: "Protección", label: "Protector solar" },
      { cat: "Protección", label: "Sombra o carpa" },
    ],
  },
  {
    name: "Viaje",
    items: [
      { cat: "Documentos", label: "Pasaporte o cédula" },
      { cat: "Documentos", label: "Pasabordo / tiquetes" },
      { cat: "Documentos", label: "Reservas (hotel, transporte)" },
      { cat: "Documentos", label: "Tarjetas y algo de efectivo" },
      { cat: "Documentos", label: "Seguro de viaje" },
      { cat: "Equipaje de mano", label: "Medicinas" },
      { cat: "Equipaje de mano", label: "Cepillo y crema dental" },
      { cat: "Equipaje de mano", label: "Muda de ropa" },
      { cat: "Equipaje de mano", label: "Botella de agua vacía" },
      { cat: "Equipaje de mano", label: "Snacks" },
      { cat: "Electrónica", label: "Cargador del celular" },
      { cat: "Electrónica", label: "Batería externa (power bank)" },
      { cat: "Electrónica", label: "Adaptador de enchufe" },
      { cat: "Electrónica", label: "Audífonos" },
      { cat: "Antes de salir de casa", label: "Apagar luces y gas" },
      { cat: "Antes de salir de casa", label: "Sacar la basura" },
      { cat: "Antes de salir de casa", label: "Cerrar ventanas" },
      { cat: "Antes de salir de casa", label: "Bajar la calefacción" },
      { cat: "Antes de salir de casa", label: "Cargar el celular" },
    ],
  },
  {
    name: "Playa",
    items: [
      { cat: "Sol y protección", label: "Protector solar" },
      { cat: "Sol y protección", label: "Gafas de sol" },
      { cat: "Sol y protección", label: "Sombrero o gorra" },
      { cat: "Sol y protección", label: "Sombrilla" },
      { cat: "Comodidad", label: "Toallas" },
      { cat: "Comodidad", label: "Manta" },
      { cat: "Comodidad", label: "Muda de ropa seca" },
      { cat: "Comodidad", label: "Vestido de baño extra" },
      { cat: "Comida y bebida", label: "Agua" },
      { cat: "Comida y bebida", label: "Hielo" },
      { cat: "Comida y bebida", label: "Snacks" },
      { cat: "No olvidar", label: "Bolsa impermeable para el celular" },
      { cat: "No olvidar", label: "Toallitas húmedas" },
      { cat: "No olvidar", label: "Bolsa para la basura" },
      { cat: "No olvidar", label: "Repelente" },
      { cat: "No olvidar", label: "Efectivo" },
    ],
  },
  {
    name: "Picnic",
    items: [
      { cat: "Comida y bebida", label: "Comida preparada" },
      { cat: "Comida y bebida", label: "Bebidas" },
      { cat: "Comida y bebida", label: "Hielo / nevera portátil" },
      { cat: "Para comer", label: "Platos y vasos" },
      { cat: "Para comer", label: "Cubiertos" },
      { cat: "Para comer", label: "Servilletas" },
      { cat: "Para comer", label: "Destapador y cuchillo" },
      { cat: "Comodidad", label: "Manta de picnic" },
      { cat: "Comodidad", label: "Cojines" },
      { cat: "Comodidad", label: "Música / parlante" },
      { cat: "No olvidar", label: "Bolsa para la basura" },
      { cat: "No olvidar", label: "Toallitas húmedas" },
      { cat: "No olvidar", label: "Repelente de insectos" },
      { cat: "No olvidar", label: "Protector solar" },
      { cat: "No olvidar", label: "Bolsa para lo sucio" },
    ],
  },
];

const nuevoId = () =>
  (self.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

/* La primera vez que se entra a un hogar se copian las plantillas de fábrica
   a Firestore (con ids fijos, para que los dos teléfonos no creen duplicados).
   De ahí en adelante son de la casa: se pueden editar y los cambios quedan.
   La bandera en prefs evita que reaparezcan solas si se borran a propósito. */
async function quizasSembrarPlantillas() {
  if (!snapPrefsLista || !snapPlantillasLista) return;
  if (plantillasSembradas || plantillas.length) return;
  plantillasSembradas = true; // no reintentar en esta sesión
  try {
    await Promise.all(
      KITS_PLANTILLA.map((p, i) =>
        setDoc(doc(coleccionPlantillas(), p.name.toLowerCase()), {
          name: p.name,
          items: p.items.map((it) => ({ id: nuevoId(), label: it.label, cat: it.cat })),
          order: i,
          createdAt: serverTimestamp(),
        }),
      ),
    );
    await setDoc(docPrefs(), { plantillasSembradas: true }, { merge: true });
  } catch (err) {
    console.error("plantillas:", err);
  }
}

function contarChecked(kit) {
  const ids = new Set((kit.items || []).map((i) => i.id));
  return Object.keys(kit.checked || {}).filter((id) => ids.has(id)).length;
}

// Agrupa los ítems por categoría, conservando el orden de primera aparición.
function categoriasDe(kit) {
  const orden = [];
  const mapa = new Map();
  for (const it of kit.items || []) {
    const c = it.cat || "Otros";
    if (!mapa.has(c)) { mapa.set(c, []); orden.push(c); }
    mapa.get(c).push(it);
  }
  return orden.map((nombre) => ({ nombre, items: mapa.get(nombre) }));
}

/* La pestaña Kits tiene cuatro pantallas: lista de kits, detalle de un kit,
   lista de plantillas y detalle de una plantilla. */
function pintarKits() {
  const mostrar = (cual) => {
    $("#kits-lista").hidden = cual !== "kits";
    $("#plantillas-lista").hidden = cual !== "plantillas";
    $("#kit-detalle").hidden = cual !== "detalle";
  };

  const plantilla = plantillas.find((p) => p.id === plantillaAbiertaId);
  if (plantilla) {
    mostrar("detalle");
    pintarDetalleKit(plantilla);
    return;
  }
  plantillaAbiertaId = null;

  if (viendoPlantillas) {
    mostrar("plantillas");
    pintarListaPlantillas();
    return;
  }

  const kit = kits.find((k) => k.id === kitAbiertoId);
  if (kit) {
    mostrar("detalle");
    pintarDetalleKit(kit);
  } else {
    kitAbiertoId = null;
    mostrar("kits");
    pintarListaKits();
  }
}

function abrirPlantillas() {
  viendoPlantillas = true;
  kitAbiertoId = null;
  pintarKits();
  window.scrollTo(0, 0);
}
function cerrarPlantillas() { viendoPlantillas = false; plantillaAbiertaId = null; pintarKits(); }
function cerrarPlantilla() { plantillaAbiertaId = null; pintarKits(); }

function pintarListaPlantillas() {
  const cont = $("#plantillas-lista");
  cont.replaceChildren();

  const cab = document.createElement("div");
  cab.className = "kit-detalle-cabecera";
  const volver = document.createElement("button");
  volver.type = "button";
  volver.className = "kit-volver";
  volver.textContent = "‹ Kits";
  volver.addEventListener("click", cerrarPlantillas);
  const h = document.createElement("h2");
  h.className = "kit-titulo";
  h.textContent = "Plantillas";
  const nota = document.createElement("div");
  nota.className = "kit-progreso";
  nota.textContent = "Lo que cambies aquí saldrá así cada vez que uses la plantilla.";
  cab.append(volver, h, nota);
  cont.append(cab);

  const ordenadas = [...plantillas].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (ordenadas.length) {
    const lista = document.createElement("div");
    lista.className = "lista-tiendas";
    lista.append(...ordenadas.map(plantillaCard));
    cont.append(lista);
  } else {
    const p = document.createElement("p");
    p.className = "nota nota-centrada";
    p.textContent =
      "No tienes plantillas. Abre un kit y usa «Guardar como plantilla» para crear una.";
    cont.append(p);
  }
}

function plantillaCard(plantilla) {
  const total = (plantilla.items || []).length;
  const card = document.createElement("button");
  card.type = "button";
  card.className = "kit-card";
  const cuerpo = document.createElement("div");
  cuerpo.className = "kit-card-cuerpo";
  const nom = document.createElement("div");
  nom.className = "kit-card-nombre";
  nom.textContent = plantilla.name;
  const sub = document.createElement("div");
  sub.className = "kit-card-prog";
  sub.textContent = total === 1 ? "1 ítem" : `${total} ítems`;
  cuerpo.append(nom, sub);
  const chev = document.createElement("span");
  chev.className = "kit-card-chevron";
  chev.setAttribute("aria-hidden", "true");
  card.append(cuerpo, chev);
  card.addEventListener("click", () => {
    plantillaAbiertaId = plantilla.id;
    pintarKits();
    window.scrollTo(0, 0);
  });
  return card;
}

function pintarListaKits() {
  const cont = $("#lista-kits");
  const ordenados = [...kits].sort(
    (a, b) => (a.order ?? aMilis(a.createdAt) ?? 0) - (b.order ?? aMilis(b.createdAt) ?? 0),
  );
  cont.replaceChildren(...ordenados.map(kitCard));
  $("#kits-vacio").hidden = kits.length > 0;
}

function kitCard(kit) {
  const total = (kit.items || []).length;
  const card = document.createElement("button");
  card.type = "button";
  card.className = "kit-card";
  const cuerpo = document.createElement("div");
  cuerpo.className = "kit-card-cuerpo";
  const nom = document.createElement("div");
  nom.className = "kit-card-nombre";
  nom.textContent = kit.name;
  const prog = document.createElement("div");
  prog.className = "kit-card-prog";
  prog.textContent = total ? `${contarChecked(kit)}/${total} listo` : "vacío";
  cuerpo.append(nom, prog);
  const chev = document.createElement("span");
  chev.className = "kit-card-chevron";
  chev.setAttribute("aria-hidden", "true");
  card.append(cuerpo, chev);
  card.addEventListener("click", () => abrirKit(kit.id));
  return card;
}

function pintarDetalleKit(kit) {
  const esP = !!kit.esPlantilla; // una plantilla no se marca, solo se edita
  const cont = $("#kit-detalle");
  // Conservar el foco del input "Añadir" en edición (un cambio del otro
  // teléfono dispara re-render mientras escribes).
  const activo = document.activeElement;
  const focoCat = activo?.classList?.contains("input-item") ? activo.dataset.cat : null;

  cont.replaceChildren();
  const total = (kit.items || []).length;
  const hechos = contarChecked(kit);

  const cab = document.createElement("div");
  cab.className = "kit-detalle-cabecera";
  const volver = document.createElement("button");
  volver.type = "button";
  volver.className = "kit-volver";
  volver.textContent = esP ? "‹ Plantillas" : "‹ Kits";
  volver.addEventListener("click", esP ? cerrarPlantilla : cerrarKit);
  const h = document.createElement("h2");
  h.className = "kit-titulo";
  h.textContent = kit.name;
  const prog = document.createElement("div");
  prog.className = "kit-progreso";
  if (!total) prog.textContent = "Aún sin ítems — agrega abajo";
  else if (esP) prog.textContent = "Lo que cambies aquí saldrá así cada vez que la uses.";
  else prog.textContent = `${hechos} de ${total} listo`;
  cab.append(volver, h, prog);
  if (total && !esP) {
    const barra = document.createElement("div");
    barra.className = "kit-barra";
    const rel = document.createElement("div");
    rel.className = "kit-barra-relleno";
    rel.style.width = `${Math.round((hechos / total) * 100)}%`;
    barra.append(rel);
    cab.append(barra);
  }
  cont.append(cab);

  for (const cat of categoriasDe(kit)) {
    const grupo = document.createElement("div");
    grupo.className = "grupo";
    const lab = document.createElement("div");
    lab.className = "grupo-label";
    const etq = document.createElement("span");
    etq.className = "etq";
    etq.textContent = cat.nombre.toUpperCase();
    const cnt = document.createElement("span");
    cnt.className = "cuenta";
    const catHechos = cat.items.filter((i) => kit.checked?.[i.id]).length;
    cnt.textContent = `${catHechos}/${cat.items.length}`;
    lab.append(etq, cnt);
    const card = document.createElement("div");
    card.className = "grupo-card";
    const ul = document.createElement("ul");
    ul.className = "lista-items";
    for (const it of cat.items) ul.append(filaItemKit(kit, it));
    card.append(ul, addRowKit(kit, cat.nombre));
    grupo.append(lab, card);
    cont.append(grupo);
  }

  const btnCat = document.createElement("button");
  btnCat.type = "button";
  btnCat.className = "fila-punteada";
  btnCat.textContent = "＋ Nueva categoría";
  btnCat.addEventListener("click", () => abrirDialogoItem(kit, null, ""));
  cont.append(btnCat);

  const acc = document.createElement("div");
  acc.className = "kit-acciones";
  const mkBtn = (txt, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = txt;
    b.addEventListener("click", fn);
    return b;
  };
  if (esP) {
    acc.append(
      mkBtn("Usar esta plantilla", "btn btn-primario", () => crearKitDesdePlantilla(kit)),
      mkBtn("Renombrar", "btn", () => abrirDialogoRenombrar(kit)),
      mkBtn("Eliminar plantilla", "btn btn-peligro", () => eliminarKit(kit)),
    );
  } else {
    acc.append(
      mkBtn("Renombrar", "btn", () => abrirDialogoRenombrar(kit)),
      mkBtn("Duplicar", "btn", () => duplicarKit(kit)),
      mkBtn("Guardar como plantilla", "btn", () => guardarComoPlantilla(kit)),
      mkBtn("Desmarcar todo", "btn", () => desmarcarKit(kit)),
      mkBtn("Eliminar kit", "btn btn-peligro", () => eliminarKit(kit)),
    );
  }
  cont.append(acc);

  if (focoCat) {
    const input = cont.querySelector(`.input-item[data-cat="${cssEscape(focoCat)}"]`);
    if (input) input.focus();
  }
}

function filaItemKit(kit, item) {
  const li = document.createElement("li");
  li.className = "item kit-item";
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = item.label;
  if (kit.esPlantilla) {
    // En una plantilla no hay nada que marcar: un punto guarda la alineación.
    const punto = document.createElement("span");
    punto.className = "item-punto";
    punto.setAttribute("aria-hidden", "true");
    label.append(punto, span);
  } else {
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = !!kit.checked?.[item.id];
    label.append(chk, span);
    chk.addEventListener("change", () => toggleItemKit(kit, item.id, chk.checked));
  }
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "item-editar";
  edit.setAttribute("aria-label", `Editar ${item.label}`);
  edit.textContent = "✎";
  edit.addEventListener("click", (ev) => { ev.stopPropagation(); abrirDialogoItem(kit, item.id, item.cat); });
  li.append(label, edit);
  return li;
}

function addRowKit(kit, catNombre) {
  const form = document.createElement("form");
  form.className = "add-row";
  const plus = document.createElement("span");
  plus.className = "add-plus";
  plus.textContent = "+";
  const input = document.createElement("input");
  input.className = "input-item";
  input.type = "text";
  input.maxLength = 100;
  input.autocomplete = "off";
  input.placeholder = "Añadir";
  input.dataset.cat = catNombre;
  form.append(plus, input);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    if (v) { agregarItemKit(kit, catNombre, v); input.value = ""; }
  });
  return form;
}

function abrirKit(id) { kitAbiertoId = id; pintarKits(); window.scrollTo(0, 0); }
function cerrarKit() { kitAbiertoId = null; pintarKits(); }

/* Deja abierto el kit recién creado. Ojo: hay que repintar de una, porque el
   snapshot que trae el kit nuevo llega ANTES de que se sepa su id — si no se
   repinta, la pantalla se queda igualita y parece que el botón no hizo nada. */
function abrirKitNuevo(id) {
  $("#dialogo-kit-nuevo").close();
  viendoPlantillas = false;
  plantillaAbiertaId = null;
  kitAbiertoId = id;
  pintarKits();
  window.scrollTo(0, 0);
}

async function crearKitDesdePlantilla(plantilla) {
  if (creandoKit) return;
  creandoKit = true;
  const items = (plantilla.items || []).map((it) => ({ id: nuevoId(), label: it.label, cat: it.cat }));
  try {
    const ref = await addDoc(coleccionKits(), {
      name: plantilla.name, items, checked: {}, order: kits.length, createdAt: serverTimestamp(),
    });
    abrirKitNuevo(ref.id);
    avisar(`Kit «${plantilla.name}» creado ✓`);
  } catch (err) {
    console.error(err);
    avisar("No se pudo crear. ¿Publicaste las reglas de Firestore?");
  } finally {
    creandoKit = false;
  }
}

async function crearKitVacio(nombre) {
  nombre = nombre.trim();
  if (!nombre || creandoKit) return;
  creandoKit = true;
  try {
    const ref = await addDoc(coleccionKits(), {
      name: nombre, items: [], checked: {}, order: kits.length, createdAt: serverTimestamp(),
    });
    abrirKitNuevo(ref.id);
  } catch (err) {
    console.error(err);
    avisar("No se pudo crear. ¿Publicaste las reglas de Firestore?");
  } finally {
    creandoKit = false;
  }
}

async function toggleItemKit(kit, itemId, checked) {
  await updateDoc(doc(coleccionKits(), kit.id), {
    [`checked.${itemId}`]: checked ? true : deleteField(),
  });
}

async function agregarItemKit(kit, cat, label) {
  await updateDoc(refDe(kit), {
    items: arrayUnion({ id: nuevoId(), label: label.slice(0, 100), cat: cat || "Otros" }),
  });
}

function abrirDialogoItem(kit, itemId, catSugerida) {
  itemKitEnEdicion = { kitId: kit.id, itemId: itemId || null };
  $("#titulo-kit-item").dataset.plantilla = kit.esPlantilla ? "1" : "";
  const item = itemId ? (kit.items || []).find((i) => i.id === itemId) : null;
  $("#titulo-kit-item").textContent = item ? "Editar ítem" : "Nuevo ítem";
  $("#btn-eliminar-item").hidden = !item;
  $("#kit-item-nombre").value = item?.label ?? "";
  $("#kit-item-cat").value = item?.cat ?? catSugerida ?? "";
  $("#kit-cats").replaceChildren(
    ...categoriasDe(kit).map((c) => { const o = document.createElement("option"); o.value = c.nombre; return o; }),
  );
  $("#dialogo-kit-item").showModal();
}

async function guardarItemKit(ev) {
  ev.preventDefault();
  const kit = buscarKit(itemKitEnEdicion?.kitId);
  if (!kit) return;
  const label = $("#kit-item-nombre").value.trim();
  const cat = $("#kit-item-cat").value.trim() || "Otros";
  if (!label) return;
  const ref = refDe(kit);
  if (itemKitEnEdicion.itemId) {
    const items = (kit.items || []).map((i) =>
      i.id === itemKitEnEdicion.itemId ? { ...i, label: label.slice(0, 100), cat } : i,
    );
    await updateDoc(ref, { items });
  } else {
    await updateDoc(ref, { items: arrayUnion({ id: nuevoId(), label: label.slice(0, 100), cat }) });
  }
  $("#dialogo-kit-item").close();
}

async function eliminarItemKitActual() {
  const kit = buscarKit(itemKitEnEdicion?.kitId);
  if (!kit || !itemKitEnEdicion.itemId) return;
  const items = (kit.items || []).filter((i) => i.id !== itemKitEnEdicion.itemId);
  const cambios = { items };
  // Las plantillas no tienen mapa de marcados.
  if (!kit.esPlantilla) cambios[`checked.${itemKitEnEdicion.itemId}`] = deleteField();
  await updateDoc(refDe(kit), cambios);
  $("#dialogo-kit-item").close();
}

async function desmarcarKit(kit) {
  if (!contarChecked(kit)) return;
  await updateDoc(doc(coleccionKits(), kit.id), { checked: {} });
  avisar(`«${kit.name}» quedó listo para la próxima.`);
}

async function eliminarKit(kit) {
  const que = kit.esPlantilla ? "la plantilla" : "el kit";
  if (!confirm(`¿Eliminar ${que} «${kit.name}»?`)) return;
  if (kit.esPlantilla) plantillaAbiertaId = null;
  else kitAbiertoId = null;
  await deleteDoc(refDe(kit));
  pintarKits();
}

// Duplicar un kit: copia sus ítems (personalizados) en uno nuevo, sin marcar.
// Así tu versión ajustada sirve de plantilla para el próximo.
async function duplicarKit(kit) {
  if (creandoKit) return; // un segundo toque no debe crear otra copia
  creandoKit = true;
  const nombre = `${kit.name} (copia)`;
  const items = (kit.items || []).map((it) => ({ ...it }));
  try {
    const ref = await addDoc(coleccionKits(), {
      name: nombre, items, checked: {}, order: kits.length, createdAt: serverTimestamp(),
    });
    abrirKitNuevo(ref.id);
    avisar(`Se creó «${nombre}» ✓`);
  } catch (err) {
    console.error(err);
    avisar("No se pudo duplicar.");
  } finally {
    creandoKit = false;
  }
}

function abrirDialogoRenombrar(kit) {
  kitRenombrarId = kit.id;
  $("#titulo-kit-renombrar").textContent = kit.esPlantilla ? "Renombrar plantilla" : "Renombrar kit";
  $("#kit-nuevo-nombre").value = kit.name;
  $("#dialogo-kit-renombrar").showModal();
}

async function renombrarKit() {
  const kit = buscarKit(kitRenombrarId);
  const nombre = $("#kit-nuevo-nombre").value.trim();
  if (!kit || !nombre) return;
  await updateDoc(refDe(kit), { name: nombre.slice(0, 80) });
  $("#dialogo-kit-renombrar").close();
}

/* Convierte el kit que ya ajustaste a tu gusto en plantilla, para que la
   próxima vez arranque así. Si ya hay una con el mismo nombre, la reemplaza. */
async function guardarComoPlantilla(kit) {
  if (creandoKit) return;
  creandoKit = true;
  try {
    const items = (kit.items || []).map((it) => ({ ...it }));
    const existente = plantillas.find(
      (p) => p.name.toLowerCase() === kit.name.trim().toLowerCase(),
    );
    if (existente) {
      if (!confirm(`Ya hay una plantilla «${existente.name}». ¿Reemplazarla con este kit?`)) return;
      await updateDoc(doc(coleccionPlantillas(), existente.id), { name: kit.name, items });
    } else {
      await addDoc(coleccionPlantillas(), {
        name: kit.name, items, order: plantillas.length, createdAt: serverTimestamp(),
      });
    }
    avisar(`Plantilla «${kit.name}» guardada ✓`);
  } catch (err) {
    console.error(err);
    avisar("No se pudo guardar la plantilla.");
  } finally {
    creandoKit = false;
  }
}

function abrirDialogoNuevoKit() {
  const ordenadas = [...plantillas].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $("#plantillas-seccion").hidden = ordenadas.length === 0;
  $("#plantillas-kit").replaceChildren(
    ...ordenadas.map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-plantilla";
      b.textContent = p.name;
      b.addEventListener("click", () => crearKitDesdePlantilla(p));
      return b;
    }),
  );
  // Tus propios kits, para partir de una copia de tu versión personalizada.
  const mios = [...kits].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $("#mis-kits-seccion").hidden = mios.length === 0;
  $("#mis-kits-chips").replaceChildren(
    ...mios.map((k) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-plantilla";
      b.textContent = k.name;
      b.addEventListener("click", () => duplicarKit(k));
      return b;
    }),
  );
  $("#kit-nombre").value = "";
  $("#dialogo-kit-nuevo").showModal();
}

/* ── Notificaciones push (FCM) ── */
async function activarNotificaciones() {
  const boton = $("#btn-notificaciones");
  const estado = $("#estado-notificaciones");
  try {
    if (!(await messagingIsSupported()) || !("Notification" in window)) {
      estado.textContent =
        "Este navegador no soporta notificaciones. En iPhone: añade la app a la pantalla de inicio y ábrela desde ahí.";
      return;
    }
    boton.disabled = true;
    const registro = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    const permiso = await Notification.requestPermission();
    if (permiso !== "granted") {
      estado.textContent = "Permiso denegado. Actívalo en los ajustes del navegador.";
      return;
    }
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registro,
    });
    await setDoc(doc(db, "households", codigoHogar, "tokens", token), {
      token,
      userAgent: navigator.userAgent,
      createdAt: serverTimestamp(),
    });
    localStorage.setItem("queJuicio.push", "1");
    estado.textContent = "✓ Este teléfono recibirá avisos cuando algo esté vencido.";
    // Con la app abierta en primer plano el aviso llega aquí, no al service worker.
    onMessage(messaging, (payload) => {
      avisar(payload.notification?.body ?? "Hay tareas pendientes.");
    });
  } catch (err) {
    console.error(err);
    estado.textContent = "No se pudo activar. Revisa la clave VAPID en config.js.";
  } finally {
    boton.disabled = false;
  }
}

/* ── Utilidades UI ── */
let toastTimer = null;
function avisar(mensaje) {
  const toast = $("#toast");
  toast.textContent = mensaje;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 3500);
}

// Aviso con botón "Deshacer" (más tiempo en pantalla).
function avisarDeshacer(mensaje, accion) {
  const toast = $("#toast");
  toast.replaceChildren();
  const span = document.createElement("span");
  span.textContent = mensaje;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-accion";
  btn.textContent = "Deshacer";
  btn.addEventListener("click", () => {
    clearTimeout(toastTimer);
    toast.hidden = true;
    accion();
  });
  toast.append(span, btn);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 6000);
}

/* ── Arranque y eventos ── */
$("#form-entrada").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const codigo = $("#input-codigo").value.trim().toLowerCase().replaceAll(" ", "-");
  if (codigo.length >= 8) entrarAlHogar(codigo);
});

$("#btn-nueva").addEventListener("click", () => abrirDialogoTarea());
$("#btn-primera-tarea").addEventListener("click", () => abrirDialogoTarea());
$("#btn-semilla").addEventListener("click", crearTareasIniciales);
$("#tarea-unidad").addEventListener("change", actualizarCamposFrecuencia);
$("#form-tarea").addEventListener("submit", guardarTarea);
$("#btn-cancelar-tarea").addEventListener("click", () => $("#dialogo-tarea").close());
$("#btn-eliminar").addEventListener("click", eliminarTarea);

$("#btn-ajustes").addEventListener("click", () => {
  if (localStorage.getItem("queJuicio.push") === "1" && Notification.permission === "granted") {
    $("#estado-notificaciones").textContent =
      "✓ Este teléfono recibirá avisos cuando algo esté vencido.";
  }
  $("#dialogo-ajustes").showModal();
});
$("#btn-cerrar-ajustes").addEventListener("click", () => $("#dialogo-ajustes").close());

// Pestañas y lista de compras
$("#tab-tareas").addEventListener("click", () => mostrarVista("tareas"));
$("#tab-compras").addEventListener("click", () => mostrarVista("compras"));
$("#btn-nueva-tienda").addEventListener("click", () => {
  $("#tienda-nombre").value = "";
  $("#dialogo-tienda").showModal();
});
$("#btn-cancelar-tienda").addEventListener("click", () => $("#dialogo-tienda").close());
$("#form-tienda").addEventListener("submit", (ev) => {
  ev.preventDefault();
  agregarTienda($("#tienda-nombre").value);
  $("#dialogo-tienda").close();
});
// Kits
$("#tab-kits").addEventListener("click", () => mostrarVista("kits"));
$("#btn-nuevo-kit").addEventListener("click", abrirDialogoNuevoKit);
$("#btn-plantillas").addEventListener("click", abrirPlantillas);
$("#btn-cancelar-kit").addEventListener("click", () => $("#dialogo-kit-nuevo").close());
$("#form-kit-vacio").addEventListener("submit", (ev) => {
  ev.preventDefault();
  crearKitVacio($("#kit-nombre").value);
});
$("#form-kit-item").addEventListener("submit", guardarItemKit);
$("#btn-cancelar-item").addEventListener("click", () => $("#dialogo-kit-item").close());
$("#btn-eliminar-item").addEventListener("click", eliminarItemKitActual);
$("#form-kit-renombrar").addEventListener("submit", (ev) => { ev.preventDefault(); renombrarKit(); });
$("#btn-cancelar-renombrar").addEventListener("click", () => $("#dialogo-kit-renombrar").close());
$("#btn-notificaciones").addEventListener("click", activarNotificaciones);
$("#btn-salir").addEventListener("click", () => {
  if (confirm("¿Salir del hogar en este teléfono? Las tareas siguen guardadas.")) {
    salirDelHogar();
  }
});

// Registrar el service worker al abrir: cachea la app para que funcione sin
// internet y para que sea instalable como PWA desde el navegador.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./firebase-messaging-sw.js")
    .catch((err) => console.error("SW:", err));
}

// Refresca los anillos si la pestaña quedó abierta de un día para otro.
setInterval(pintarLista, 60 * 60 * 1000);

if (codigoHogar) {
  entrarAlHogar(codigoHogar);
} else {
  $("#pantalla-entrada").hidden = false;
}
