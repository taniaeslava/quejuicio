// Configuración de Firebase del proyecto yatoca-jc-tania (ya completa).
// OJO: firebase-messaging-sw.js duplica esta misma configuración
// (los service workers no pueden importar módulos ES) — si cambias algo
// aquí, cámbialo también allá.
export const firebaseConfig = {
  apiKey: "AIzaSyAJnLa_cx4t7R_TYGYsseKWtqT1KM9VfsY",
  authDomain: "yatoca-jc-tania.firebaseapp.com",
  projectId: "yatoca-jc-tania",
  storageBucket: "yatoca-jc-tania.firebasestorage.app",
  messagingSenderId: "222952036200",
  appId: "1:222952036200:web:0f2ad5788a7b52ec28a8dd",
};

// Clave VAPID pública: Firebase Console → Configuración del proyecto →
// Cloud Messaging → Configuración web → Certificados push web → Generar.
export const VAPID_KEY = "BJHRJiNOxISGnzTjDFVs2PpHaIeZ_5r8UuhjkMXhdsvBFK5UV80xhyLuo9BiLVkPuaHdhONHj4dcA1xf_n1WakE";
