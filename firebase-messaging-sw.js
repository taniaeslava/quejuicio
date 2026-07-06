// Service worker de QueJuicio. Hace dos cosas:
//  1) Recibe push cuando la app está cerrada (Firebase Messaging).
//  2) Cachea la app (más abajo) para que funcione sin internet Y para que
//     Chrome la instale como WebAPK independiente (app propia, no un simple
//     acceso directo que abre Chrome).
// Los service workers no pueden importar módulos ES, así que la
// configuración de Firebase está DUPLICADA aquí a mano — si cambias
// config.js, cambia también estos valores.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAJnLa_cx4t7R_TYGYsseKWtqT1KM9VfsY",
  authDomain: "yatoca-jc-tania.firebaseapp.com",
  projectId: "yatoca-jc-tania",
  storageBucket: "yatoca-jc-tania.firebasestorage.app",
  messagingSenderId: "222952036200",
  appId: "1:222952036200:web:0f2ad5788a7b52ec28a8dd",
});

const messaging = firebase.messaging();

// Los mensajes con payload "notification" los muestra el navegador solo;
// este handler cubre mensajes de datos por si acaso.
messaging.onBackgroundMessage((payload) => {
  if (payload.notification) return;
  self.registration.showNotification(payload.data?.title || "QueJuicio", {
    body: payload.data?.body || "Hay tareas pendientes.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  });
});

// Al tocar la notificación: enfocar la app si ya está abierta, o abrirla.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((abiertas) => {
      const app = abiertas.find((c) => "focus" in c);
      return app ? app.focus() : clients.openWindow("./");
    }),
  );
});

/* ── Caché de la app (para instalar como WebAPK y funcionar sin internet) ──
   Sube el número de versión cuando cambies archivos y quieras forzar caché
   nueva. La estrategia es "red primero": si hay internet siempre ves lo
   último; si no, se sirve lo guardado. */
const CACHE = "quejuicio-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Solo manejamos lo del propio sitio; Firestore, FCM y las fuentes pasan
  // directo a la red sin tocarlos.
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))),
  );
});
