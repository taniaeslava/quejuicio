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

0. **El único código de servidor es `netlify/functions/notion.js`** y existe
   por una razón concreta: Notion no acepta llamadas desde el navegador. No
   metas ahí lógica de la app ni lo uses como excusa para agregar un backend.
   Sus claves (`NOTION_TOKEN`, `CODIGO_HOGAR`) viven en las variables de
   entorno de Netlify, **nunca en el repo** (que es público).
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
5. **En la lista de compras cada gesto tiene un dueño y no se pisan:** la
   casilla marca como comprado (borra y guarda en la despensa), tocar el
   **texto** lo edita en el sitio (`editarItemInline`), deslizar a la derecha
   elimina sin recordar y el asa ⠿ reordena. Si agregas otro gesto, revisa
   `habilitarSwipe` (que ignora `.item-grip` y `.item-edit`) y que
   `pintarCompras()` siga absteniéndose de re-dibujar mientras hay un
   `.item-edit` abierto — si no, un cambio del otro teléfono borra lo que se
   está escribiendo.
6. **`taskStatus()` en `app.js` y `estaVencida()` en `notify/index.js` deben
   quedar consistentes**: ambos definen cuándo una tarea está vencida. Si
   cambias la regla en uno, cámbiala en el otro.
7. **Cuida los créditos de Netlify.** Cada despliegue a producción cuesta ~15
   créditos (el plan gratis da 300/mes, o sea ~20 despliegues). Netlify se
   despliega solo en cada push que toque la app web. Por eso: **agrupa varios
   cambios en un solo push** en vez de subir cambio por cambio. Los cambios que
   NO tocan la web (android-app/, notify/, docs .md, firestore.rules) no gastan
   despliegue — hay una regla `ignore` en `netlify.toml` que los salta.

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
netlify/functions/notion.js Ayudante que habla con Notion (corre en Netlify, tiene la clave)
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
- **Traer de Notion**: `pedirANotion()` llama a `/.netlify/functions/notion`
  (el navegador no puede llamar a Notion directo: lo bloquea por CORS). El
  diálogo `#dialogo-notion` deja escoger semana y tienda, y la importación
  reusa `agregarVariasCompras()`, que ya deduplica.
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
households/{codigo}/kits/{id}       { name, order, createdAt, items:[{id,label,cat}], checked:{itemId:true} }
households/{codigo}/plantillas/{id} { name, order, createdAt, items:[{id,label,cat}] }
```

Kits = listas reutilizables para no olvidar nada (asado, viaje, playa, picnic…).
Los ítems se agrupan por `cat` (categoría); lo marcado vive en el mapa `checked`
(se actualiza con field-path `checked.<itemId>` para no reescribir el array y
evitar choques entre los dos teléfonos); "Desmarcar todo" hace `checked: {}`.
Las plantillas son EDITABLES y viven en `plantillas/` (misma forma que un kit,
sin `checked`). `KITS_PLANTILLA` en app.js es solo la **semilla de fábrica**:
`quizasSembrarPlantillas()` la copia a Firestore la primera vez que se entra a
un hogar (ids fijos = el nombre en minúsculas, para que los dos teléfonos no
creen duplicados) y deja la bandera `plantillasSembradas` en `prefs/general`
para que no reaparezcan si se borran a propósito. De ahí en adelante el código
NO vuelve a mirar `KITS_PLANTILLA`.

`pintarDetalleKit(kit)` sirve para kits y para plantillas: se distingue con
`kit.esPlantilla` (lo pone el snapshot). `refDe(kit)` devuelve el documento en
la colección correcta y `buscarKit(id)` busca en las dos listas — úsalos en
cualquier escritura nueva en vez de `doc(coleccionKits(), id)`.

`{codigo}` es el código de hogar (secreto compartido; **no lo escribas en
ningún archivo del repo**, que es público — solo se teclea en cada teléfono).

## Diseño (tokens en `style.css` → `:root`)

Refresh visual (julio 2026): azulejo más calmado, superficies con sombra en vez
de bordes. Todos los tokens están en `:root` — úsalos, no inventes colores.

- Fondo `#FBF6EE`; superficie de tarjeta `#FFFDF9`; navy principal `#1E4B73`;
  texto `#16344D`; terracota `#C25A38`; meta `#9A9082`; etiquetas `#A08D74`.
  Anillos: verde `#4F7A5B` (lejos), ámbar `#C08A2E` (≤7 días), terracota
  (vencida).
- Fuentes: **Lora** (600) para la marca y los nombres de tienda; **DM Sans**
  para todo lo demás. Tres tamaños: 16 títulos / 15 ítems / 13 meta / 11
  etiquetas de sección.
- Patrones clave: tarjeta por grupo (`.grupo-card`, `.tienda`) sin borde y con
  `--sombra-card`; filas separadas por finas líneas internas (pseudo `::before`);
  franja de azulejo delgada `.tile-band`; anillo conic-gradient con disco
  interior; el logo (baldosa con estrella) se mantiene igual, es SVG inline.
- Las asas de arrastre (⠿) están siempre visibles pero discretas (30% de
  opacidad). Antes había un "modo reordenar" que las escondía; se quitó porque
  nadie lo encontraba.

## RECETA: agregar otra pestaña/sección (p. ej. "Notas")

Ojo: la pestaña Kits ya tiene cuatro pantallas internas (lista de kits,
detalle de kit, lista de plantillas y detalle de plantilla) que `pintarKits()`
muestra y esconde. No es un molde a copiar tal cual.

Ya hay tres pestañas: **Tareas, Compras y Kits**. Compras (accordions) y Kits (lista +
detalle) son los mejores moldes a copiar. Pasos:

1. **HTML** ([index.html](index.html)):
   - Dentro de `<main>`, agrega `<div id="vista-notas" hidden>…</div>` junto a
     las otras vistas.
   - En `<nav id="barra-pestanas">`, agrega un botón `<button id="tab-notas" …>`
     como los demás.

2. **Cambio de pestaña** ([app.js](app.js), función `mostrarVista`):
   - Ya está generalizada: agrega `"notas"` al array `vistas` y listo (recuerda
     que el FAB `#btn-nueva` es solo de Tareas).
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
