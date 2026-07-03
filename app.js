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
}

function salirDelHogar() {
  desuscribir?.();
  desuscribir = null;
  localStorage.removeItem("queJuicio.hogar");
  codigoHogar = "";
  tareas = [];
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
