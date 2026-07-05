// QueJuicio — módulo principal.
// Habla con Firestore directamente desde el navegador (SDK por CDN, sin build).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot,
  addDoc, updateDoc, deleteDoc, setDoc,
  serverTimestamp, Timestamp, deleteField,
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
let arrastrando = false;  // true mientras se reordena algo (pausa el re-render)
let ordenTiendas = [];    // orden manual de las tiendas (se guarda en prefs/general)
let desuscribirPrefs = null;
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
  const estado = ratio >= 1 ? "vencida" : ratio >= 0.75 ? "pronto" : "fresca";
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
    pintarCompras();
  }, errorCompras);

  // Pintar ya las tiendas por defecto, sin esperar a Firestore.
  pintarCompras();
  mostrarVista(localStorage.getItem("queJuicio.vista") || "tareas");
}

function salirDelHogar() {
  desuscribir?.();
  desuscribirCompras?.();
  desuscribirTiendas?.();
  desuscribirDespensa?.();
  desuscribirPrefs?.();
  desuscribir = desuscribirCompras = desuscribirTiendas = desuscribirDespensa = desuscribirPrefs = null;
  localStorage.removeItem("queJuicio.hogar");
  codigoHogar = "";
  tareas = [];
  compras = [];
  tiendasExtra = [];
  despensa = [];
  ordenTiendas = [];
  mostrarVista("tareas");
  $("#dialogo-ajustes").close();
  $("#pantalla-principal").hidden = true;
  $("#pantalla-entrada").hidden = false;
}

/* ── Render ── */
function pintarLista() {
  const lista = $("#lista-tareas");
  const ahora = Date.now();
  // Vencidas primero, luego las de una sola vez, luego por urgencia.
  const clave = (t) => (t.once ? 1.5 : taskStatus(t, ahora).ratio);
  const ordenadas = [...tareas].sort((a, b) => clave(b) - clave(a));
  lista.replaceChildren(...ordenadas.map((t) => tarjetaDeTarea(t, ahora)));
  $("#estado-vacio").hidden = tareas.length > 0;
}

function tarjetaDeTarea(tarea, ahora) {
  const { ratio, diasRestantes, estado } = taskStatus(tarea, ahora);
  const li = document.createElement("li");
  li.className = `tarjeta ${estado}`;

  // Anillo de frescura: se llena a medida que la tarea envejece.
  // Las de una sola vez llevan anillo punteado con "1×" en vez de cuenta.
  const CIRCUNFERENCIA = 2 * Math.PI * 16;
  const offset = CIRCUNFERENCIA * (1 - Math.min(ratio, 1));
  const etiquetaDias =
    estado === "unica" ? "1×" : estado === "vencida" ? "¡ya!" : `${diasRestantes}d`;

  const detalle =
    estado === "unica"
      ? "una sola vez · pendiente"
      : `${frecuenciaTexto(tarea.frequencyDays)} · última vez ${fechaCorta(tarea.lastDone)} · ` +
        (estado === "vencida"
          ? `<span class="vencida-texto">vencida hace ${Math.max(1, -diasRestantes + 1)} día(s)</span>`
          : `faltan ${diasRestantes} día(s)`);

  li.innerHTML = `
    <svg class="anillo" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="fondo" cx="18" cy="18" r="16"></circle>
      <circle class="progreso" cx="18" cy="18" r="16"
        stroke-dasharray="${CIRCUNFERENCIA.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}"></circle>
      <text class="dias" x="18" y="18">${etiquetaDias}</text>
    </svg>
    <div>
      <p class="tarjeta-nombre"></p>
      <p class="tarjeta-detalle">${detalle}</p>
    </div>
    <button class="btn-hecha" type="button">Hecha ✓</button>
  `;
  li.querySelector(".tarjeta-nombre").textContent = tarea.name;
  li.querySelector(".btn-hecha").addEventListener("click", (ev) => {
    ev.stopPropagation();
    marcarHecha(tarea);
  });
  li.addEventListener("click", () => abrirDialogoTarea(tarea));
  return li;
}

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

/* ── Pestañas: Tareas / Compras ── */
function mostrarVista(cual) {
  const esTareas = cual === "tareas";
  $("#vista-tareas").hidden = !esTareas;
  $("#vista-compras").hidden = esTareas;
  $("#btn-nueva").hidden = !esTareas; // el FAB "+" es solo para tareas
  $("#tab-tareas").classList.toggle("activa", esTareas);
  $("#tab-compras").classList.toggle("activa", !esTareas);
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
  if (arrastrando) return; // no re-renderizar en medio de un arrastre
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
  const sec = document.createElement("section");
  sec.className = "tienda" + (abierta ? " abierta" : "");
  sec.dataset.store = nombre;

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
  chevron.textContent = "▸";
  const nom = document.createElement("span");
  nom.className = "tienda-nombre";
  nom.textContent = nombre;
  const conteo = document.createElement("span");
  conteo.className = "tienda-conteo";
  conteo.textContent = items.length ? String(items.length) : "";
  header.append(grip, chevron, nom, conteo);
  habilitarArrastreTienda(grip, sec);
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
  sec.append(header);

  const cuerpo = document.createElement("div");
  cuerpo.className = "tienda-cuerpo";
  cuerpo.hidden = !abierta;

  const ul = document.createElement("ul");
  ul.className = "lista-items";
  // Orden manual (campo order); si falta, por fecha de creación.
  const ordenados = [...items].sort(
    (a, b) => (a.order ?? aMilis(a.createdAt) ?? 0) - (b.order ?? aMilis(b.createdAt) ?? 0),
  );
  for (const item of ordenados) ul.append(filaItem(item));
  habilitarArrastre(ul, nombre);
  cuerpo.append(ul);

  const form = document.createElement("form");
  form.className = "form-item";
  const input = document.createElement("input");
  input.className = "input-item";
  input.type = "text";
  input.maxLength = 100;
  input.autocomplete = "off";
  input.placeholder = `Agregar a ${nombre}…`;
  const sug = document.createElement("div");
  sug.className = "sugerencias";
  form.append(input, sug);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    agregarCompra(nombre, input.value);
    input.value = "";
    sug.replaceChildren();
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
      sug.replaceChildren();
    }
  });
  cuerpo.append(form);

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

  const label = document.createElement("label");
  const chk = document.createElement("input");
  chk.type = "checkbox";
  const txt = document.createElement("span");
  txt.textContent = item.name;
  label.append(chk, txt);
  chk.addEventListener("change", () => { if (chk.checked) comprarItem(item); });

  li.append(grip, label);
  return li;
}

// Arrastre táctil/mouse para reordenar; el asa (grip) inicia el gesto.
function habilitarArrastre(ul, tienda) {
  let arrastrado = null;
  for (const grip of ul.querySelectorAll(".item-grip")) {
    grip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      arrastrado = grip.closest(".item");
      arrastrando = true;
      arrastrado.classList.add("arrastrando");
      grip.setPointerCapture(ev.pointerId);
    });
    grip.addEventListener("pointermove", (ev) => {
      if (!arrastrado) return;
      const y = ev.clientY;
      const otros = [...ul.querySelectorAll(".item:not(.arrastrando)")];
      const siguiente = otros.find((s) => {
        const r = s.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (siguiente) ul.insertBefore(arrastrado, siguiente);
      else ul.append(arrastrado);
    });
    const fin = async (ev) => {
      if (!arrastrado) return;
      arrastrado.classList.remove("arrastrando");
      arrastrado = null;
      try { grip.releasePointerCapture(ev.pointerId); } catch {}
      try { await guardarOrden(ul); } finally { arrastrando = false; }
    };
    grip.addEventListener("pointerup", fin);
    grip.addEventListener("pointercancel", fin);
  }
}

// Arrastre para reordenar TIENDAS (asa en el encabezado).
function habilitarArrastreTienda(grip, sec) {
  grip.style.touchAction = "none";
  // Un toque en el asa no debe plegar/desplegar la tienda.
  grip.addEventListener("click", (ev) => ev.stopPropagation());
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const cont = sec.parentElement;
    if (!cont) return;
    arrastrando = true;
    sec.classList.add("arrastrando");
    grip.setPointerCapture(ev.pointerId);

    const mover = (e) => {
      const y = e.clientY;
      const otras = [...cont.querySelectorAll(".tienda:not(.arrastrando)")];
      const siguiente = otras.find((s) => {
        const r = s.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (siguiente) cont.insertBefore(sec, siguiente);
      else cont.append(sec);
    };
    const fin = async (e) => {
      grip.removeEventListener("pointermove", mover);
      grip.removeEventListener("pointerup", fin);
      grip.removeEventListener("pointercancel", fin);
      sec.classList.remove("arrastrando");
      try { grip.releasePointerCapture(e.pointerId); } catch {}
      try { await guardarOrdenTiendas(cont); } finally { arrastrando = false; }
    };
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
  const sug = input.nextElementSibling;
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
$("#btn-notificaciones").addEventListener("click", activarNotificaciones);
$("#btn-salir").addEventListener("click", () => {
  if (confirm("¿Salir del hogar en este teléfono? Las tareas siguen guardadas.")) {
    salirDelHogar();
  }
});

// Refresca los anillos si la pestaña quedó abierta de un día para otro.
setInterval(pintarLista, 60 * 60 * 1000);

if (codigoHogar) {
  entrarAlHogar(codigoHogar);
} else {
  $("#pantalla-entrada").hidden = false;
}
