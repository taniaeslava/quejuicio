// Ayudante que habla con Notion por cuenta de QueJuicio.
//
// ¿Por qué hace falta? Notion no deja que una página web lo llame directamente
// (bloquea al navegador por seguridad). Este archivito corre en los servidores
// de Netlify, al lado de la app, así que para QueJuicio es una llamada "de la
// casa" y para Notion es una llamada de servidor, que sí acepta.
//
// La clave de Notion NUNCA está aquí: se configura en Netlify como variable de
// entorno (Site settings → Environment variables). Ver README.
//
//   /.netlify/functions/notion?accion=semanas
//       → [{ id, semana, titulo }]  las páginas "N-0 Ingredientes"
//   /.netlify/functions/notion?accion=ingredientes&id=<id de la página>
//       → { titulo, lineas: ["3 cebollas", "Perejil", ...] }

const NOTION = "https://api.notion.com/v1";
const VERSION_NOTION = "2022-06-28";

// Página "Meal Prep Calendar". Se puede cambiar sin tocar el código con la
// variable de entorno NOTION_PAGINA.
const PAGINA_POR_DEFECTO = "e1cd17d8-2518-472a-84e5-cfa1424bfebb";

// Reconoce los títulos tipo "7-0 Ingredientes" (con o sin emoji delante).
const TITULO_INGREDIENTES = /(\d{1,2})\s*-\s*0\s+ingredientes/i;
const ES_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const responder = (codigo, cuerpo) => ({
  statusCode: codigo,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(cuerpo),
});

async function notionGet(ruta, token) {
  const r = await fetch(`${NOTION}${ruta}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": VERSION_NOTION,
    },
  });
  if (!r.ok) {
    const detalle = await r.text();
    const err = new Error(`Notion respondió ${r.status}`);
    err.status = r.status;
    err.detalle = detalle.slice(0, 300);
    throw err;
  }
  return r.json();
}

// Trae TODOS los bloques hijos de una página (Notion los entrega de a 100).
async function hijosDe(idPagina, token) {
  const bloques = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notionGet(`/blocks/${idPagina}/children?${q}`, token);
    bloques.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return bloques;
}

// El texto plano de un bloque, venga del tipo que venga (párrafo, viñeta,
// pendiente, encabezado...). Si no tiene texto, devuelve "".
//
// Ojo: al final de cada página de ingredientes hay enlaces a las recetas de la
// semana ("1-1 Chicken fried rice"). Son menciones a otras páginas y NO son
// ingredientes, así que los bloques con menciones se descartan enteros.
function textoDeBloque(bloque) {
  const cuerpo = bloque[bloque.type];
  const rich = cuerpo && cuerpo.rich_text;
  if (!Array.isArray(rich)) return "";
  if (rich.some((t) => t.type === "mention")) return "";
  return rich.map((t) => t.plain_text || "").join("").trim();
}

/* Las páginas de ingredientes casi siempre son subpáginas ("child_page"), pero
   alguna quedó enlazada como mención dentro de un párrafo. Se recogen las dos. */
function paginasDeIngredientes(bloques) {
  const encontradas = new Map(); // semana -> { id, semana, titulo }

  const registrar = (id, titulo) => {
    const m = TITULO_INGREDIENTES.exec(titulo || "");
    if (!id || !m) return;
    const semana = Number(m[1]);
    if (!encontradas.has(semana)) {
      encontradas.set(semana, { id, semana, titulo: titulo.trim() });
    }
  };

  for (const b of bloques) {
    if (b.type === "child_page") {
      registrar(b.id, b.child_page && b.child_page.title);
      continue;
    }
    const cuerpo = b[b.type];
    const rich = cuerpo && cuerpo.rich_text;
    if (!Array.isArray(rich)) continue;
    for (const t of rich) {
      if (t.type === "mention" && t.mention && t.mention.type === "page") {
        registrar(t.mention.page.id, t.plain_text);
      }
    }
  }

  return [...encontradas.values()].sort((a, b) => a.semana - b.semana);
}

exports.handler = async (event) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return responder(500, {
      error: "falta-token",
      mensaje: "Falta configurar NOTION_TOKEN en Netlify.",
    });
  }

  // Candado opcional: si CODIGO_HOGAR está configurado en Netlify, solo
  // responde a quien mande ese mismo código. Si no está, responde a todos.
  const esperado = process.env.CODIGO_HOGAR;
  if (esperado && event.headers["x-codigo-hogar"] !== esperado) {
    return responder(403, { error: "no-autorizado", mensaje: "Código de hogar incorrecto." });
  }

  const params = event.queryStringParameters || {};
  const accion = params.accion || "semanas";
  const idPagina = process.env.NOTION_PAGINA || PAGINA_POR_DEFECTO;

  try {
    if (accion === "semanas") {
      const semanas = paginasDeIngredientes(await hijosDe(idPagina, token));
      return responder(200, { semanas });
    }

    if (accion === "ingredientes") {
      if (!ES_UUID.test(params.id || "")) {
        return responder(400, { error: "id-invalido", mensaje: "Falta el id de la semana." });
      }
      const bloques = await hijosDe(params.id, token);
      const lineas = bloques
        .map(textoDeBloque)
        .map((t) => t.replace(/^[-•*]\s*/, "").trim()) // por si vienen con viñeta
        .filter((t) => t.length > 0 && t.length <= 100);
      return responder(200, { lineas });
    }

    return responder(400, { error: "accion-desconocida" });
  } catch (err) {
    console.error("notion:", err.status, err.message, err.detalle);
    if (err.status === 401) {
      return responder(502, {
        error: "token-malo",
        mensaje: "Notion rechazó la clave. Revisa NOTION_TOKEN en Netlify.",
      });
    }
    if (err.status === 404) {
      return responder(502, {
        error: "sin-acceso",
        mensaje: "Notion no encuentra la página. ¿Le compartiste el calendario a la integración?",
      });
    }
    return responder(502, { error: "notion-falló", mensaje: "Notion no respondió bien." });
  }
};
