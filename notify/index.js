// QueJuicio — aviso diario de tareas vencidas.
// Corre en GitHub Actions (ver .github/workflows/notify.yml) con el
// Admin SDK y una cuenta de servicio; NO usa el SDK web público.
"use strict";

const admin = require("firebase-admin");

const DIA_MS = 86_400_000;
// El mismo proyecto de config.js (es público, no es secreto).
const PROYECTO = "yatoca-jc-tania";
const EN_ACTIONS = process.env.GITHUB_ACTIONS === "true";
// Al lanzarlo a mano con «solo probar», revisa todo pero no manda ni escribe.
const SOLO_PROBAR = process.env.SOLO_PROBAR === "true";

// Los logs de un repo público los ve cualquiera con cuenta en GitHub, y las
// anotaciones (el resumen de la corrida) incluso sin cuenta. Por eso los
// errores salen con un mensaje propio, sin pedazos del secreto ni del código
// de hogar.
function fallar(mensaje) {
  console.error(EN_ACTIONS ? `::error::${mensaje}` : mensaje);
  process.exit(1);
}

// Pide a GitHub que tape un valor (p. ej. el código de hogar) con *** en el
// resto del log.
function ocultarEnLog(valor) {
  if (EN_ACTIONS) console.log(`::add-mask::${valor}`);
}

const ARREGLO_SECRETO =
  "Genera una clave nueva (Firebase Console → Configuración del proyecto → Cuentas de servicio → " +
  "Generar nueva clave privada) y pega el JSON completo en GitHub → Settings → Secrets and " +
  "variables → Actions → FIREBASE_SERVICE_ACCOUNT.";

function inicializar() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!json) fallar(`El secreto FIREBASE_SERVICE_ACCOUNT no existe o está vacío. ${ARREGLO_SECRETO}`);

  // Ojo: el error de JSON.parse cita un trozo del texto (o sea, de la llave
  // privada). Nunca lo imprimas tal cual.
  let cuenta;
  try {
    cuenta = JSON.parse(json);
  } catch {
    fallar(
      "El secreto FIREBASE_SERVICE_ACCOUNT no es un JSON válido (¿quedó cortado, sin las llaves { } " +
        `o con comillas de más?). ${ARREGLO_SECRETO}`,
    );
  }
  const faltan = ["project_id", "private_key", "client_email"].filter((k) => !cuenta?.[k]);
  if (cuenta?.type !== "service_account" || faltan.length) {
    fallar(
      "El secreto FIREBASE_SERVICE_ACCOUNT no es la clave de una cuenta de servicio" +
        (faltan.length ? ` (le falta ${faltan.join(", ")})` : "") + `. ${ARREGLO_SECRETO}`,
    );
  }
  if (cuenta.project_id !== PROYECTO) {
    fallar(
      `La clave es del proyecto «${cuenta.project_id}», no de «${PROYECTO}» (el de la app). ${ARREGLO_SECRETO}`,
    );
  }

  admin.initializeApp({ credential: admin.credential.cert(cuenta) });
  return admin.firestore();
}

// Traduce los errores de Google a algo accionable. El texto original va
// después, al log completo (para verlo hay que entrar a GitHub con sesión).
function explicarError(err) {
  const texto = `${err?.message ?? err}`;
  if (/invalid_grant|invalid_client|Invalid JWT|UNAUTHENTICATED/i.test(texto)) {
    return "Google rechazó la clave de FIREBASE_SERVICE_ACCOUNT: la borraron, la desactivaron o es " +
      `de otra cuenta. ${ARREGLO_SECRETO}`;
  }
  if (/PERMISSION_DENIED|permission/i.test(texto)) {
    return "La cuenta de servicio entra, pero no tiene permiso sobre Firestore o Cloud Messaging. " +
      "Usa la cuenta «firebase-adminsdk» del proyecto (la que sale en Firebase Console → Cuentas de servicio).";
  }
  return "Falló el aviso de tareas. El detalle está en el log del paso «Enviar notificaciones».";
}

// Fecha de hoy (YYYY-MM-DD) en Europa/Berlín, donde vive la pareja.
function hoyEnBerlin() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}

/* La misma regla que taskStatus() en app.js: una tarea está vencida
   cuando han pasado >= frequencyDays desde lastDone (o createdAt si
   nunca se ha hecho). Si cambias esto, cambia también app.js. */
function estaVencida(tarea, ahoraMs) {
  // Las de una sola vez no tienen fecha límite: viven en la lista
  // pero no generan avisos push.
  if (tarea.once) return false;
  const ultima = tarea.lastDone?.toMillis?.() ?? tarea.createdAt?.toMillis?.();
  if (!ultima || !tarea.frequencyDays) return false;
  return (ahoraMs - ultima) / DIA_MS >= tarea.frequencyDays;
}

async function main() {
  const db = inicializar();
  if (SOLO_PROBAR) console.log("Modo «solo probar»: se revisa todo, pero no se manda ni se marca nada.");
  const ahora = Date.now();
  const hoy = hoyEnBerlin();

  // collectionGroup recorre households/*/tasks sin depender de que el
  // documento del hogar exista (la app solo escribe subcolecciones).
  const snap = await db.collectionGroup("tasks").get();

  // Agrupar tareas vencidas (y aún no avisadas hoy) por hogar.
  const porHogar = new Map();
  const ocultos = new Set();
  for (const docTarea of snap.docs) {
    const refHogar = docTarea.ref.parent.parent;
    // El código de hogar es la llave: nunca al log.
    if (!ocultos.has(refHogar.id)) {
      ocultos.add(refHogar.id);
      ocultarEnLog(refHogar.id);
    }
    const tarea = docTarea.data();
    if (!estaVencida(tarea, ahora)) continue;
    if (tarea.lastNotified === hoy) continue; // ya avisamos hoy
    if (!porHogar.has(refHogar.id)) {
      porHogar.set(refHogar.id, { refHogar, nombreLog: `Hogar ${porHogar.size + 1}`, tareas: [] });
    }
    porHogar.get(refHogar.id).tareas.push({ ref: docTarea.ref, nombre: tarea.name });
  }

  console.log(`Conexión con Firestore bien: ${snap.size} tarea(s) leída(s).`);
  if (porHogar.size === 0) {
    console.log("Nada vencido sin avisar. Listo.");
    return;
  }

  for (const { refHogar, nombreLog, tareas } of porHogar.values()) {
    const tokensSnap = await refHogar.collection("tokens").get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (tokens.length === 0) {
      console.log(`${nombreLog}: ${tareas.length} vencida(s) pero ningún teléfono registrado.`);
      continue;
    }

    const nombres = tareas.map((t) => `«${t.nombre}»`);
    const body =
      tareas.length === 1
        ? `${nombres[0]} está pendiente. ¡A ponerse al día!`
        : `Hay ${tareas.length} tareas pendientes: ${nombres.join(", ")}.`;

    // En «solo probar» FCM valida el mensaje y la clave (dryRun) pero no lo
    // entrega, y no se borra ni se marca nada.
    const resultado = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: "QueJuicio 🧹", body },
      webpush: {
        fcmOptions: { link: "/" },
        notification: { icon: "icons/icon-192.png", badge: "icons/icon-192.png" },
      },
    }, SOLO_PROBAR);
    console.log(
      `${nombreLog}: ${tareas.length} tarea(s) → ${resultado.successCount} ` +
        `${SOLO_PROBAR ? "aceptada(s) por FCM (solo prueba, no se mandó nada)" : "enviada(s)"}, ` +
        `${resultado.failureCount} fallida(s).`,
    );
    if (SOLO_PROBAR) continue;

    // Limpiar tokens muertos (app desinstalada, permiso revocado…).
    const lote = db.batch();
    resultado.responses.forEach((res, i) => {
      const codigo = res.error?.code;
      if (codigo === "messaging/registration-token-not-registered" ||
          codigo === "messaging/invalid-argument") {
        console.log(`  Eliminando token inválido ${tokens[i].slice(0, 12)}…`);
        lote.delete(refHogar.collection("tokens").doc(tokens[i]));
      }
    });

    // Marcar lastNotified para no repetir el aviso el mismo día.
    if (resultado.successCount > 0) {
      for (const t of tareas) lote.update(t.ref, { lastNotified: hoy });
    }
    await lote.commit();
  }
}

main().catch((err) => {
  console.error(err);
  fallar(explicarError(err));
});
