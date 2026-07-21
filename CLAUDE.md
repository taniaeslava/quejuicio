# CLAUDE.md — guía para modificar QueJuicio sin romperlo

> Este archivo lo lee Claude Code automáticamente. Si vas a tocar el código,
> **léelo completo primero.** Está pensado para que cualquier instancia de
> Claude pueda extender la app con seguridad. Escribe y comenta en **español**
> (es la convención del proyecto).

## Qué es

QueJuicio es una PWA casera y compartida para dos personas (una pareja). Tiene
dos secciones: **Tareas** del hogar (recurrentes y de una sola vez, con avisos)
y **Lista de compras** por tiendas. Todo se sincroniza entre los dos teléfonos
por Firestore. Para el "qué y por qué" en lenguaje humano, ver
[SOBRE-QUEJUICIO.md](SOBRE-QUEJUICIO.md). Para la instalación/configuración, ver
[README.md](README.md).

## Reglas de oro (romper esto rompe la app)

1. **Sin build, sin framework, sin npm en el frontend.** Es HTML + CSS +
   JavaScript puro con módulos ES cargados por CDN. No agregues un empaquetador
   ni dependencias de frontend. Debe seguir siendo desplegable con solo subir
   los archivos. (El único `package.json` es para compilar la app Android en la
   nube — ver más abajo — no lo uses para el frontend.)
2. **UI 100% en español** (español colombiano). Métrico, tono cercano.
3. **Al agregar cualquier colección nueva de Firestore, hay que:**
   (a) añadir su regla en [firestore.rules](firestore.rules), y
   (b) **avisarle al usuario que la republique** en Firebase Console → Firestore
   → Reglas → pegar → Publicar. Si no, Firestore da `permission-denied` y la
   función nueva no lee ni escribe nada. Este es el error #1 más común.
4. **Mantén el estilo azulejo** (ver "Diseño"). No metas un tercer motivo que
   compita con los existentes ni cambies la paleta.
5. **`taskStatus()` en `app.js` y `estaVencida()` en `notify/index.js` deben
   quedar consistentes**: ambos definen cuándo una tarea está vencida. Si
   cambias la regla en uno, cámbiala en el otro.

## Mapa de archivos

# La app WEB (lo que ven los teléfonos) vive en la raíz:
index.html                  Pantalla de entrada + pantalla principal (2 vistas) + diálogos
style.css                   Estilo azulejo; tokens de color en :root
app.js                      TODA la lógica del frontend (un solo módulo)
config.js                   Config de Firebase (claves públicas; no es secreto)
firebase-messaging-sw.js    Service worker: push + caché offline
manifest.webmanifest        Manifiesto PWA
firestore.rules             Reglas de seguridad de Firestore
icons/                      Íconos de la PWA
netlify.toml                Config de Netlify (sitio estático, sin compilación)
notify/index.js             Script diario de notificaciones (Node + Admin SDK, corre en Actions)
.github/workflows/          notify.yml (avisos diarios) y build-android.yml (compila el APK)

# La app ANDROID nativa (Capacitor) vive aparte, en android-app/:
android-app/capacitor.config.json   Config de la app (carga el sitio de Netlify vía System WebView)
android-app/assets/                 Ícono y splash para compilar
android-app/www/                    Placeholder que Capacitor exige (la app carga el sitio en vivo)
android-app/package.json            Dependencias de Capacitor (solo para el build en la nube)

## Cómo está organizado `app.js`

Está en secciones marcadas con comentarios `/* ── ... ── */`, en este orden:

- **Estado** (variables a nivel de módulo): `tareas`, `compras`, `tiendasExtra`,
  `despensa`, etc., y las funciones `desuscribir*` de cada colección.
- **Entrar / salir del hogar**: `entrarAlHogar(codigo)` se suscribe a todas las
  colecciones con `onSnapshot` (tiempo real) y `salirDelHogar()` se desuscribe.
- **Tareas**: `taskStatus`, `pintarLista`, `tarjetaDeTarea`, acciones (marcar
  hecha, guardar, eliminar), semilla de ejemplos.
- **Pestañas**: `mostrarVista(cual)` muestra/oculta las vistas y marca la
  pestaña activa.
- **Lista de compras**: render de tiendas, autocompletado, comprar/eliminar/
  deshacer, reordenar (arrastre), agregar/quitar tiendas.
- **Notificaciones push (FCM)**.
- **Utilidades UI**: `avisar()` (toast) y `avisarDeshacer()` (toast con botón).
- **Arranque y eventos**: `addEventListener` de todos los botones + registro del
  service worker + arranque.

Patrón de sincronización: cada colección tiene un `onSnapshot` que actualiza un
array de estado y llama a su función `pintar*`. Nunca guardes estado en el DOM;
el DOM se reconstruye desde el estado en cada snapshot.

## Modelo de datos (Firestore)

```
households/{codigo}/tasks/{id}      { name, once, frequencyDays, lastDone, history[], createdAt, lastNotified? }
households/{codigo}/tokens/{token}  { token, userAgent, createdAt }
households/{codigo}/shopping/{id}   { name, store, order, createdAt }
households/{codigo}/stores/{id}     { name, createdAt }
households/{codigo}/pantry/{clave}  { name, store, lastBought }
households/{codigo}/prefs/general   { storeOrder: [...] }
```

`{codigo}` es el código de hogar (secreto compartido; **no lo escribas en
ningún archivo del repo**, que es público — solo se teclea en cada teléfono).

## Diseño (tokens en `style.css` → `:root`)

- Crema `#F5E9D8` (fondo), tinta índigo `#24344A` (texto), cobalto `#2C5C86` y
  terracota `#C15A34` (acentos). Fuentes: Fraunces (títulos), Inter (texto).
- Motivos (reutilízalos, no inventes otros): el logo de baldosa enmarcada con
  estrella, la cenefa `.tile-frieze`, la franja `.tile-strip`, el anillo de
  frescura, y la retícula tenue del fondo. Todo son SVG embebidos en el CSS
  como `data:` URI — sin imágenes externas.

## RECETA: agregar una tercera pestaña (p. ej. "Notas")

La lista de compras es el mejor molde a copiar. Pasos:

1. **HTML** ([index.html](index.html)):
   - Dentro de `<main>`, agrega `<div id="vista-notas" hidden>…</div>` junto a
     `#vista-tareas` y `#vista-compras`.
   - En `<nav id="barra-pestanas">`, agrega un botón `<button id="tab-notas" …>`
     como los otros dos.

2. **Cambio de pestaña** ([app.js](app.js), función `mostrarVista`):
   - Esa función hoy asume dos vistas. Generalízala: oculta TODAS las vistas y
     muestra solo la elegida; quita `.activa` de todas las pestañas y pónsela a
     la elegida. Recuerda: el FAB `#btn-nueva` es solo de Tareas (`$("#btn-nueva").hidden`).
   - Agrega el listener: `$("#tab-notas").addEventListener("click", () => mostrarVista("notas"));`

3. **Datos** (si la pestaña guarda cosas en Firestore):
   - Agrega un helper de colección: `const coleccionNotas = () => collection(db, "households", codigoHogar, "notas");`
   - En `entrarAlHogar`, suscríbete con `onSnapshot(coleccionNotas(), snap => { notas = …; pintarNotas(); }, errorCompras)`.
   - En `salirDelHogar`, agrega `desuscribirNotas?.()` y resetea el array.
   - Escribe `pintarNotas()` copiando el patrón de `pintarCompras()`.

4. **Reglas** ([firestore.rules](firestore.rules)):
   - Agrega un bloque `match /households/{code}/notas/{id} { … }` con validación
     de campos (copia el de `shopping`).
   - ⚠️ **Dile al usuario que republique las reglas** (ver Regla de oro #3).

5. **Estilo**: usa los tokens y componentes existentes (tarjetas, botones) para
   que combine con el resto.

6. **Probar** localmente (ver abajo) y luego desplegar (ver abajo).

## Cómo probar localmente

No hay Node para el frontend. Sirve la carpeta con Python y ábrela:

```
python -m http.server 4173
```

Luego abre `http://localhost:4173`. Para probar contra Firestore real hay que
entrar con el código de hogar real (pídeselo al usuario; NO está en el repo) y
tener las reglas publicadas.

## Despliegue (hay TRES destinos, con roles distintos)

1. **GitHub** = respaldo + dispara todo lo demás. Haz commit y push de cada
   cambio. **Netlify está conectado a este repo: al hacer push, se despliega
   solo** (no hay que arrastrar nada).
2. **Netlify** = el sitio que ven los teléfonos (se actualiza solo con el push).
   **La app Android carga este sitio en vivo**, así que los cambios de
   HTML/CSS/JS llegan a la app con solo hacer push — NO hace falta recompilar el
   APK ni reinstalar.
3. **APK (Capacitor)** = la app Android nativa. Solo hay que **recompilarla** si
   cambian archivos dentro de `android-app/` (config o íconos) — el workflow
   `build-android.yml` lo hace en la nube y publica el APK en "Releases". Para
   cambios normales del frontend NO se recompila.

## Notas / limitaciones conocidas

- **Push en la app nativa**: el System WebView de Android no soporta
  notificaciones web, así que dentro del APK las notificaciones push
  probablemente no lleguen. Para tenerlas de forma nativa habría que integrar el
  plugin `@capacitor/push-notifications` (FCM nativo) — trabajo aparte.
- La config de Firebase está **duplicada** en `config.js` y en
  `firebase-messaging-sw.js` (los service workers no importan módulos ES). Si
  cambias una, cambia la otra.
- `firestore.rules` bloquea todo por defecto y solo permite las rutas
  `households/{code}/…`. No hay login: el código de hogar es la llave.
```
