# QueJuicio 🧹✨

*Una app casera para llevar el hogar al día entre dos.*

---

## ¿Qué es?

**QueJuicio** es una pequeña aplicación compartida —hecha en casa, no comprada—
que ayuda a dos personas (una pareja, en este caso) a manejar dos cosas del
hogar que siempre se enredan:

1. **Las tareas que se hacen cada tanto** — esas que no son del día a día pero
   que si nadie lleva la cuenta, se olvidan: limpiar la ducha a fondo, lavar
   los gabinetes de la cocina, cambiar un filtro, lavar las brochas de
   maquillaje…
2. **La lista de compras** — organizada por tienda, para que en el súper solo
   veas lo de *ese* lugar.

Lo importante: **los dos ven lo mismo, actualizado al instante, cada uno en su
propio teléfono.** Si tú tachas "arroz", a tu pareja se le tacha también.

El nombre es un guiño colombiano: *"¡qué juicio!"* — esa mezcla de disciplina y
buena voluntad para hacer las cosas de la casa. 😄

---

## ¿Por qué existe?

Se comparó con apps ya hechas (Tody, Sweepy, Cozi), pero se decidió **construirla
a la medida**, por gusto y por aprender, usando solo servicios gratuitos. Así
quedó exactamente como se quería, sin pagar suscripciones ni aguantar publicidad.

---

## ¿Cómo funciona? (la idea en simple)

QueJuicio **no tiene usuarios ni contraseñas**. En vez de eso, usa un **código
de hogar**: una palabra o frase secreta que ustedes inventan y escriben en
ambos teléfonos la primera vez. Ese código es la "llave" que conecta los dos
teléfonos a la misma información.

- Escribes el código una sola vez en cada teléfono; queda guardado.
- Todo lo que uno agregue o marque, al otro le aparece en segundos.
- Como no hay login, el código es lo único que protege sus datos — por eso se
  elige uno difícil de adivinar y no se comparte fuera de casa.

---

## Las dos secciones

Abajo de la pantalla hay dos pestañas: **Tareas** y **Compras**.

### 📋 Tareas

Cada tarea es una tarjeta con un **anillo de frescura** que se va llenando a
medida que pasa el tiempo:

- 🟢 **Verde** — recién hecha, todo tranquilo.
- 🟡 **Ocre** — se acerca la fecha.
- 🔴 **Terracota** — ¡ya toca! (vencida).

Las tarjetas se ordenan solas: lo más urgente arriba. Cada una muestra **cuándo
se hizo por última vez** y cuántos días faltan.

- **Botón "Hecha ✓"** → la marca como hecha hoy y el anillo vuelve a verde.
- **Tocar la tarjeta** → editar el nombre, cada cuánto se repite, o corregir la
  fecha de la última vez.

Hay **dos tipos** de tarea:

- **Recurrentes** — se repiten cada X días/semanas/meses (ej. "lavar ducha cada
  3 meses").
- **De una sola vez** — cosas puntuales como "colgar los cuadros". Se quedan en
  la lista con un anillo punteado ("1×") hasta que las haces, y ahí desaparecen.

Cuando una tarea recurrente se vence, la app **manda una notificación** al
teléfono (ver más abajo).

### 🛒 Compras

Una lista de compras al estilo Google Keep, pero **agrupada por tiendas**. Cada
tienda es un menú **plegable**: abres solo la que te interesa (Edeka, Ikea,
Amazon, Tedi… y las que quieras agregar).

Cada artículo tiene dos formas de salir de la lista, y **significan cosas
distintas**:

- ☑️ **Marcar la casilla** = *"ya lo compré"* → desaparece, pero la app lo
  **recuerda**. La próxima vez que empieces a escribirlo, te lo sugiere.
- 👉 **Deslizar a la derecha (swipe)** = *"esto ya no lo quiero"* → se elimina
  del todo, **sin** guardarlo en la memoria.

Ambas acciones muestran un botón **"Deshacer"** por si te equivocas.

Otras cosas que puedes hacer:

- **Pegar una lista entera** (por ejemplo copiada de Notion): cada renglón se
  vuelve un artículo separado, automáticamente.
- **Reordenar** artículos y tiendas arrastrándolos desde el asa (⠿).
- **Autocompletado inteligente**: sugiere cosas que ya has comprado antes, para
  no reescribir "pañitos húmedos" cada vez.

---

## 🔔 Notificaciones

QueJuicio te avisa cuando una tarea se vence. Un pequeño programa se despierta
**una vez al día** en la nube, revisa si hay algo vencido, y si sí, manda la
notificación a los teléfonos que hayan activado los avisos.

- Solo las tareas **recurrentes** avisan (las de una sola vez no tienen fecha
  límite).
- No repite el mismo aviso dos veces el mismo día.

*(En iPhone hay que agregar la app a la pantalla de inicio y activarlas desde
ahí; en Android funcionan una vez instalada.)*

---

## 🎨 El diseño: estilo "azulejo", inspirado en el juego *Azul*

La estética está inspirada en los **azulejos** —la cerámica decorativa
española y portuguesa— y en particular en el juego de mesa **Azul**, con sus
baldosas de colores y estrellas.

**Paleta:**

| Color | Uso |
|---|---|
| Crema `#F5E9D8` | Fondo (como yeso cálido) |
| Tinta índigo `#24344A` | Texto |
| Cobalto `#2C5C86` | Acento principal (azul de azulejo) |
| Terracota `#C15A34` | Acento cálido (rojo cerámico) |

**Tipografías:** *Fraunces* (con serifas, para títulos) e *Inter* (limpia, para
el texto).

**Motivos que se repiten:**

- 🔷 **El logo** — una baldosa cobalto enmarcada, con una estrella de cuatro
  puntas en terracota. Es también el ícono de la app en el teléfono.
- 〰️ **La cenefa** — la franja de azulejos con estrellas de ocho puntas que va
  bajo el encabezado.
- ⭕ **El anillo de frescura** — el indicador circular de cada tarea, que además
  usa los mismos colores para que todo se sienta de una sola pieza.
- 🔳 **La retícula tenue** del fondo, con cuartos de disco en las esquinas.

Todo el patrón está dibujado dentro del propio código (sin imágenes externas),
así que la app es liviana y se ve nítida en cualquier pantalla.

---

## 🛠️ ¿Cómo está hecha por dentro?

Sin frameworks ni herramientas complicadas: es **HTML, CSS y JavaScript puro**,
que se puede volver a publicar con solo subir los archivos. Se apoya en tres
servicios gratuitos, cada uno con su papel:

| Servicio | Su papel (en cristiano) |
|---|---|
| 🗄️ **GitHub** | La **bodega**: guarda el respaldo y el historial de todos los cambios, y corre el programita diario de notificaciones. |
| 🍽️ **Netlify** | El **local**: es la dirección de internet que los teléfonos abren para usar la app (la *cara*). |
| 📓 **Firebase** | El **cuaderno mágico compartido**: guarda las tareas y las compras, y las sincroniza entre los dos teléfonos al instante (la *memoria*). |

Firebase, por dentro, hace tres cosas: **guarda los datos** (Firestore), **manda
las notificaciones** (Cloud Messaging) y **protege el acceso** con reglas que
solo dejan entrar a quien conoce el código de hogar.

---

## 📱 ¿Es una "app de verdad"?

Aunque está hecha con tecnología de páginas web, se **instala como una app
normal** en el teléfono, con su propio ícono, y funciona **incluso sin
internet** (guarda una copia de la lista para consultarla con mala señal).

Para que Android la trate como app totalmente independiente —y no como una
página del navegador— se empaqueta como una app de Android propia. Así aparece
separada de Chrome en el teléfono.

---

## 🧭 Decisiones deliberadas (la filosofía)

- **Sin login.** Es una herramienta casera para dos personas; el código de hogar
  compartido es suficiente y evita todo el aparato de cuentas y contraseñas.
- **Sin framework ni "build".** Para actualizarla basta con volver a subir los
  archivos — trivial de mantener en el tiempo.
- **Gratis de punta a punta.** Todo vive en las capas gratuitas de los
  servicios; no hay nada que pagar.
- **Bonita a propósito.** No tenía que ser un tablero gris más: el estilo
  azulejo la hace agradable de abrir todos los días.
- **Un idioma: español.** Toda la app y su documentación están en español
  (colombiano), que es el idioma de trabajo del proyecto.

---

## 🔒 Sobre los datos y la privacidad

- Los datos (tareas y compras) viven en Firebase, protegidos por el código de
  hogar. No hay anuncios ni terceros mirando.
- La lista de compras **se vacía sola** al marcar lo comprado; nunca se llena.
- La memoria de autocompletado crece muy despacio (un registro por cosa nueva,
  sin repetir) — es imposible que llene el espacio gratuito.
- El código de hogar es la única llave: no se comparte fuera de casa.

---

*Hecho con juicio, para tener la casa al día. 💛*
