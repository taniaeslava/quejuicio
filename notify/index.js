// QueJuicio — aviso diario de tareas vencidas.
// Corre en GitHub Actions (ver .github/workflows/notify.yml) con el
// Admin SDK y una cuenta de servicio; NO usa el SDK web público.
"use strict";

const admin = require("firebase-admin");

const DIA_MS = 86_400_000;

function inicializar() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) {
    console.error("Falta la variable FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
  return admin.firestore();
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
  const ahora = Date.now();
  const hoy = hoyEnBerlin();

  // collectionGroup recorre households/*/tasks sin depender de que el
  // documento del hogar exista (la app solo escribe subcolecciones).
  const snap = await db.collectionGroup("tasks").get();

  // Agrupar tareas vencidas (y aún no avisadas hoy) por hogar.
  const porHogar = new Map();
  for (const docTarea of snap.docs) {
    const tarea = docTarea.data();
    if (!estaVencida(tarea, ahora)) continue;
    if (tarea.lastNotified === hoy) continue; // ya avisamos hoy
    const refHogar = docTarea.ref.parent.parent;
    if (!porHogar.has(refHogar.id)) porHogar.set(refHogar.id, { refHogar, tareas: [] });
    porHogar.get(refHogar.id).tareas.push({ ref: docTarea.ref, nombre: tarea.name });
  }

  if (porHogar.size === 0) {
    console.log("Nada vencido sin avisar. Listo.");
    return;
  }

  for (const { refHogar, tareas } of porHogar.values()) {
    const tokensSnap = await refHogar.collection("tokens").get();
    const tokens = tokensSnap.docs.map((d) => d.id);
    if (tokens.length === 0) {
      console.log(`Hogar ${refHogar.id}: ${tareas.length} vencida(s) pero ningún teléfono registrado.`);
      continue;
    }

    const nombres = tareas.map((t) => `«${t.nombre}»`);
    const body =
      tareas.length === 1
        ? `${nombres[0]} está pendiente. ¡A ponerse al día!`
        : `Hay ${tareas.length} tareas pendientes: ${nombres.join(", ")}.`;

    const resultado = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: "QueJuicio 🧹", body },
      webpush: {
        fcmOptions: { link: "/" },
        notification: { icon: "icons/icon-192.png", badge: "icons/icon-192.png" },
      },
    });
    console.log(
      `Hogar ${refHogar.id}: ${tareas.length} tarea(s) → ${resultado.successCount} enviada(s), ${resultado.failureCount} fallida(s).`,
    );

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
  process.exit(1);
});
