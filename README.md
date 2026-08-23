# QueJuicio 🧹

Una PWA mínima y compartida para las tareas del hogar **poco frecuentes** —
«limpiar la ducha a fondo cada 3 meses», «limpiar los gabinetes de la cocina
cada 4 meses» — pensada para dos personas que ven la misma lista actualizada
en sus propios teléfonos, con notificaciones push cuando algo está vencido.
También admite tareas **de una sola vez** («colgar los cuadros»), que se
quedan en la lista hasta que se hacen y desaparecen al marcarlas.

Además tiene una **lista de compras** compartida (pestaña «Compras» abajo),
al estilo Google Keep pero **agrupada por tiendas** plegables (Edeka, Ikea,
Amazon, Tedi y las que agregues). Dos formas de sacar un artículo de la lista:
**marcar el checkbox** = «ya lo compré» (desaparece pero queda en la memoria
para autocompletar), o **deslizar a la derecha** = «ya no lo quiero» (se
elimina sin guardarlo en memoria). Ambas tienen «Deshacer». Puedes **pegar
varias líneas de golpe** (p. ej. copiadas de Notion) y cada renglón se vuelve
un artículo, y **reordenar** tanto los artículos como las tiendas arrastrando
desde el asa (⠿).

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
├── firebase-messaging-sw.js   service worker: push + caché offline + instalable como WebAPK
│                               ⚠️ duplica la config (los SW no importan módulos)
├── manifest.webmanifest       para "añadir a pantalla de inicio"
├── icons/                     iconos de la app
├── firestore.rules            reglas de seguridad de Firestore
├── notify/index.js            script diario que manda el push (Admin SDK)
├── netlify/functions/notion.js  ayudante que le pide las listas a Notion
└── .github/workflows/notify.yml   cron de GitHub Actions
```

Modelo de datos en Firestore:

```
households/{codigo}/tasks/{taskId}     { name, once, frequencyDays, lastDone, history[], createdAt, lastNotified? }
households/{codigo}/tokens/{fcmToken}  { token, userAgent, createdAt }
households/{codigo}/shopping/{itemId}  { name, store, createdAt }        ← artículos por comprar
households/{codigo}/stores/{storeId}   { name, createdAt }               ← tiendas agregadas por el usuario
households/{codigo}/pantry/{clave}     { name, store, lastBought }       ← memoria para autocompletar
households/{codigo}/prefs/general      { storeOrder: [nombres…] }        ← orden manual de las tiendas
households/{codigo}/kits/{kitId}       { name, order, items:[{id,label,cat}], checked:{id:true} }  ← listas "no olvidar nada"
```

Los artículos llevan un campo `order` numérico para el orden manual; las
tiendas se ordenan según `prefs/general.storeOrder`.

Las tareas recurrentes tienen `once: false` y `frequencyDays` en días; las
de una sola vez tienen `once: true` y `frequencyDays: null`, no generan
avisos push (no tienen fecha límite) y se borran al marcarlas hechas.

La lista de compras: cada artículo activo vive en `shopping` con su `store`.
Las tiendas Edeka/Ikea/Amazon/Tedi están fijas en el código; las demás se
guardan en `stores`. Al marcar un artículo como comprado se borra de
`shopping` y se guarda (deduplicado por nombre) en `pantry`, de donde salen
las sugerencias del autocompletado.

> ⚠️ Cada vez que se agrega una colección nueva **hay que volver a publicar las
> reglas** — [firestore.rules](firestore.rules) cubre `tasks`, `tokens`,
> `shopping`, `stores`, `pantry`, `prefs` y `kits`. Sin eso, esa función da
> error de permisos.

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

### 4. Desplegar el sitio (Netlify, gratis)

Es un sitio estático puro, sin build. La forma recomendada es **conectar el
repositorio de GitHub a Netlify** (sube el repo primero, ver paso 6): en
Netlify → **Add new site → Import an existing project → GitHub** → elige el
repo. Gracias al `netlify.toml` (que declara "sitio estático, sin
compilación"), Netlify publica los archivos tal cual. A partir de ahí **cada
push a GitHub se despliega solo** — no hay que subir nada a mano.

Alternativa rápida sin git: [app.netlify.com/drop](https://app.netlify.com/drop)
y arrastra la carpeta `quejuicio`.

Netlify da HTTPS, que es **obligatorio** para service workers y notificaciones.

### 5. Instalar en los teléfonos

Abran la URL en ambos teléfonos y escriban **el mismo código de hogar**.

- **iPhone (obligatorio para el push):** en Safari → botón Compartir →
  **«Añadir a pantalla de inicio»** → abrir la app **desde ese icono**.
  Solo las PWA instaladas pueden recibir push en iOS (16.4+). Luego, en
  Ajustes (⚙ dentro de la app) → **Activar notificaciones**.
- **Android (Chrome):** menú ⋮ → **«Añadir a pantalla de inicio»** /
  «Instalar app». El push funciona incluso sin instalar, pero instalada
  se comporta como app normal. Igual: Ajustes → Activar notificaciones.
- **App Android nativa (opcional, recomendado):** hay un APK que se instala
  como app de verdad —con su propio paquete, no cuenta como navegador— útil si
  usas apps que limitan el navegador. Se descarga desde la sección **Releases**
  del repo. La compila sola el workflow `build-android.yml`; los archivos de esa
  app viven en [android-app/](android-app/) (ver [CLAUDE.md](CLAUDE.md)).

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

## Traer la lista de compras de Notion (opcional)

En Compras hay un botón **"⬇ Traer lista de Notion"** que lee las páginas
`N-0 Ingredientes` del *Meal Prep Calendar* y las mete en la tienda que elijas,
sin repetir lo que ya esté en la lista.

Notion no deja que una página web lo llame directamente, así que en medio va
`netlify/functions/notion.js`: un archivito que corre en Netlify, guarda la
clave y hace la llamada por la app. Se configura una sola vez:

**1. Crear la integración en Notion**

1. Entra a <https://www.notion.so/my-integrations> → **New integration**.
2. Ponle un nombre (p. ej. `QueJuicio`), escoge el workspace y **Submit**.
3. Copia el **Internal Integration Secret** (empieza por `ntn_` o `secret_`).

**2. Darle acceso al calendario**

Abre la página **Meal Prep Calendar** en Notion → menú `···` (arriba a la
derecha) → **Conexiones** / *Connections* → busca `QueJuicio` y conéctala. Sin
este paso Notion responde "no encuentro la página" (error 404).

**3. Guardar la clave en Netlify**

En Netlify: **Site configuration → Environment variables → Add a variable**.

| Variable        | Valor                                                       |
| --------------- | ----------------------------------------------------------- |
| `NOTION_TOKEN`  | la clave del paso 1 (**obligatoria**)                        |
| `CODIGO_HOGAR`  | el código de hogar (opcional; si está, solo responde a quien lo mande) |
| `NOTION_PAGINA` | id de otra página de Notion, si algún día se cambia de calendario (opcional) |

Después de guardarlas hay que **volver a desplegar** para que el ayudante las
vea (Deploys → Trigger deploy → *Clear cache and deploy site*).

> ⚠️ La clave de Notion **nunca** va en el repo (es público). Solo en Netlify.

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
- **Estilo azulejo "calmado"** (refresh julio 2026). Fondo crema `#FBF6EE`,
  tarjetas `#FFFDF9` con sombra suave (sin bordes), navy `#1E4B73`, texto
  `#16344D`, terracota `#C25A38`. Tipografías: Lora (marca y tiendas) y DM Sans
  (resto). Una tarjeta por grupo, meta en una línea, anillos con significado
  (verde/ámbar/terracota) y una franja de azulejo delgada bajo el encabezado.
  El logo (baldosa con estrella) es SVG inline y no se toca. Los detalles del
  sistema de diseño están en [CLAUDE.md](CLAUDE.md).

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
