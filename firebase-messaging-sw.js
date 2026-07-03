// Service worker de QueJuicio: recibe push cuando la app está cerrada.
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
