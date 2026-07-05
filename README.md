# QueJuicio 🧹

Una PWA mínima y compartida para las tareas del hogar **poco frecuentes** —
«limpiar la ducha a fondo cada 3 meses», «limpiar los gabinetes de la cocina
cada 4 meses» — pensada para dos personas que ven la misma lista actualizada
en sus propios teléfonos, con notificaciones push cuando algo está vencido.
También admite tareas **de una sola vez** («colgar los cuadros»), que se
quedan en la lista hasta que se hacen y desaparecen al marcarlas.

Además tiene una **lista de compras** compartida (pestaña «Compras» abajo),
al estilo Google Keep pero **agrupada por tiendas** plegables (Edeka, Ikea,
Amazon, Tedi y las que agregues). Marcas un artículo cuando lo compras y
desaparece, pero la app lo recuerda: la próxima vez que empieces a escribirlo
te lo sugiere. Hay «Deshacer» por si marcas uno sin querer.

Todo con servicios en capa gratuita: hosting estático (Vercel/Netlify),
Firestore para sincronizar, Firebase Cloud Messaging (FCM) para el push y
GitHub Actions como "despertador" diario. Sin app store, sin backend pago,
sin sistema de login: un **código de hogar** secreto escrito en ambos
teléfonos hace de llave.

## Estructura

```
quejuicio/
├── index.html                 entrada + pestañas (tareas / compras) + diálogos
├── style.css                  estilo azulejo (crema, cobalto, terracota)
├── app.js                     lógica: Firestore, tareas, lista de compras, push
├── config.js                  ⚠️ pega aquí la config de TU proyecto Firebase
├── firebase-messaging-sw.js   ⚠️ duplica la config (los SW no importan módulos)
├── manifest.webmanifest       para "añadir a pantalla de inicio"
├── icons/                     iconos de la app
├── firestore.rules            reglas de seguridad de Firestore
├── notify/index.js            script diario que manda el push (Admin SDK)
└── .github/workflows/notify.yml   cron de GitHub Actions
```

Modelo de datos en Firestore:

```
households/{codigo}/tasks/{taskId}     { name, once, frequencyDays, lastDone, history[], createdAt, lastNotified? }
households/{codigo}/tokens/{fcmToken}  { token, userAgent, createdAt }
households/{codigo}/shopping/{itemId}  { name, store, createdAt }        ← artículos por comprar
households/{codigo}/stores/{storeId}   { name, createdAt }               ← tiendas agregadas por el usuario
households/{codigo}/pantry/{clave}     { name, store, lastBought }       ← memoria para autocompletar
```

Las tareas recurrentes tienen `once: false` y `frequencyDays` en días; las
de una sola vez tienen `once: true` y `frequencyDays: null`, no generan
avisos push (no tienen fecha límite) y se borran al marcarlas hechas.

La lista de compras: cada artículo activo vive en `shopping` con su `store`.
Las tiendas Edeka/Ikea/Amazon/Tedi están fijas en el código; las demás se
guardan en `stores`. Al marcar un artículo como comprado se borra de
`shopping` y se guarda (deduplicado por nombre) en `pantry`, de donde salen
las sugerencias del autocompletado.

> ⚠️ Si ya tenías las reglas publicadas de antes, **hay que volver a
> publicarlas** — [firestore.rules](firestore.rules) ahora incluye las tres
> colecciones nuevas (`shopping`, `stores`, `pantry`). Sin eso, la lista de
> compras da error de permisos.

---

## Puesta en marcha, paso a paso

### 1. Crear el proyecto de Firebase

1. Entra a [console.firebase.google.com](https://console.firebase.google.com)
   y crea un proyecto (el nombre da igual, p. ej. `quejuicio`). Google Analytics
   no hace falta.
2. En **Build → Firestore Database → Crear base de datos**, elige
   **modo de producción** (las reglas del paso 3 se encargan del acceso) y
   una región europea (p. ej. `europe-west3`, Fráncfort).
3. En **Configuración del proyecto (⚙) → Tus apps**, añade una **app web**
   (icono `</>`). No actives hosting. Copia el objeto `firebaseConfig` que te
   muestra.

### 2. Rellenar `config.js` y el service worker

1. Pega los valores del `firebaseConfig` en [config.js](config.js)
   (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId).
2. Pega **los mismos valores** en
   [firebase-messaging-sw.js](firebase-messaging-sw.js). Está duplicado a
   propósito: los service workers no pueden importar módulos ES, así que hay
   que mantenerlos sincronizados a mano.
3. Genera la clave VAPID: **Configuración del proyecto → Cloud Messaging →
   Configuración web → Certificados push web → Generar par de claves**.
   Copia la clave pública en `VAPID_KEY` dentro de `config.js`.

> La `apiKey` de Firebase web **no es un secreto** (identifica el proyecto,
> no autoriza nada); lo que protege los datos son las reglas de Firestore.

### 3. Subir las reglas de Firestore

En la consola: **Firestore Database → Reglas**, borra lo que haya y pega el
contenido de [firestore.rules](firestore.rules). Publica.

Como no hay login, el código del hogar es la única llave: las reglas
bloquean todo excepto las subcolecciones `households/{codigo}/…`, y
Firestore no permite listar hogares desde el cliente, así que nadie puede
descubrir el código por fuerza bruta razonable. Usa un código largo
(mínimo 8 caracteres, mejor una frase: `girasoles-en-berlin-2026`).

### 4. Desplegar el sitio (Vercel o Netlify, gratis)

Es un sitio estático puro, sin build. Dos opciones:

**Netlify (arrastrar y soltar):** entra a
[app.netlify.com/drop](https://app.netlify.com/drop) y arrastra la carpeta
`quejuicio` completa. Listo. Para actualizar, vuelve a arrastrar.

**Vercel (CLI):**
```bash
npm i -g vercel
cd quejuicio
vercel --prod
```

Cualquiera de los dos da HTTPS, que es **obligatorio** para service workers
y notificaciones push.

### 5. Instalar en los teléfonos

Abran la URL en ambos teléfonos y escriban **el mismo código de hogar**.

- **iPhone (obligatorio para el push):** en Safari → botón Compartir →
  **«Añadir a pantalla de inicio»** → abrir la app **desde ese icono**.
  Solo las PWA instaladas pueden recibir push en iOS (16.4+). Luego, en
  Ajustes (⚙ dentro de la app) → **Activar notificaciones**.
- **Android (Chrome):** menú ⋮ → **«Añadir a pantalla de inicio»** /
  «Instalar app». El push funciona incluso sin instalar, pero instalada
  se comporta como app normal. Igual: Ajustes → Activar notificaciones.

### 6. Configurar el aviso diario (GitHub Actions)

1. Sube esta carpeta a un repositorio de GitHub **público** (los repos
   públicos tienen Actions gratis sin límite práctico para esto):
   ```bash
   cd quejuicio
   git init
   git add .
   git commit -m "QueJuicio"
   gh repo create quejuicio --public --source . --push
   ```
2. Descarga la clave de la cuenta de servicio: Firebase Console →
   **Configuración del proyecto → Cuentas de servicio → Generar nueva clave
   privada**. Se descarga un JSON. ⚠️ Este SÍ es secreto: no lo subas al
   repo ni lo compartas.
3. En GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**. Nombre: `FIREBASE_SERVICE_ACCOUNT`. Valor: el contenido
   completo del JSON (ábrelo con un editor de texto y copia todo).
4. El workflow [notify.yml](.github/workflows/notify.yml) corre todos los
   días a las **06:00 UTC** (08:00 en Berlín en verano, 07:00 en invierno).
   Para probarlo ya mismo: pestaña **Actions → Avisar tareas vencidas →
   Run workflow**.

El script recorre todas las tareas, y por cada hogar con tareas vencidas
manda un push a todos los teléfonos registrados. Marca `lastNotified` en la
tarea para no repetir el aviso el mismo día; al marcar la tarea como hecha
(o editarla) el campo se limpia.

---

## Cómo funciona el anillo de frescura

Cada tarjeta tiene un anillo que se va llenando a medida que la tarea
envejece: **verde** (recién hecha) → **ocre** (se acerca, ≥75 % del plazo) →
**terracota** (vencida). La lista se ordena con lo más urgente arriba.

La lógica de "¿está vencida?" vive en dos sitios que deben mantenerse
iguales: `taskStatus()` en [app.js](app.js) (cliente) y `estaVencida()` en
[notify/index.js](notify/index.js) (aviso diario).

## Decisiones deliberadas

- **Sin login.** Es una herramienta casera para dos personas; el código de
  hogar como secreto compartido es suficiente y evita todo el aparato de
  autenticación.
- **Sin framework ni build.** Módulos ES por CDN: para redesplegar basta
  con volver a subir los archivos.
- **Estilo azulejo, inspirado en el juego de mesa "Azul".** Crema `#F5E9D8`,
  tinta índigo `#24344A`, cobalto `#2C5C86` y terracota `#C15A34`; Fraunces
  para títulos, Inter para texto. Motivos: la marca de cuatro cuartos de
  disco (logo, icono, esquinas de cajas y retícula tenue del fondo), la
  cenefa `.tile-frieze` de azulejos con estrella de ocho puntas bajo el
  encabezado, y la franja diagonal `.tile-strip` como remate fino en los
  diálogos. Todo son SVG embebidos en el CSS — sin imágenes externas.

## Solución de problemas

- **«No se pudo conectar con Firestore»** → revisa `config.js` y que las
  reglas estén publicadas.
- **No llega el push al iPhone** → ¿la app está añadida a la pantalla de
  inicio y abierta desde ahí al activar las notificaciones? ¿iOS 16.4 o
  superior?
- **El workflow falla con error de credenciales** → el secreto
  `FIREBASE_SERVICE_ACCOUNT` debe contener el JSON completo, incluidas las
  llaves `{ }`.
- **Llegan avisos repetidos** → verifica que el workflow corre una sola vez
  al día y que el script pudo escribir `lastNotified` (mira el log en
  Actions).
