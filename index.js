const express  = require("express");
const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");

// ── Variables de entorno ──────────────────────────────────────────────────────
const TUNNEL_URL    = process.env.TUNNEL_URL    || "";
const SUPABASE_URL  = process.env.SUPABASE_URL  || "https://lbozfbvenchyafyihyso.supabase.co";
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || "";
const NODO_HOST     = TUNNEL_URL.replace(/^https?:\/\//, "").split("/")[0] || "nodo-local";

const app = express();
const db  = new Database(path.join(__dirname, "nodo.db"));

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS productos (
    barcode   TEXT PRIMARY KEY,
    nombre    TEXT NOT NULL,
    marca     TEXT,
    categoria TEXT,
    foto_url  TEXT,
    precio    REAL,
    unidades  INTEGER,
    last_seen TEXT DEFAULT (datetime('now'))
  );
`);

// ── Inventario JSON ───────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, "data");
const INV_PATH = path.join(DATA_DIR, "inventario.json");

function leerInventario() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INV_PATH)) fs.writeFileSync(INV_PATH, "[]", "utf8");
  try { return JSON.parse(fs.readFileSync(INV_PATH, "utf8")); }
  catch { return []; }
}

function guardarInventario(productos) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INV_PATH, JSON.stringify(productos, null, 2), "utf8");
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── GET /health ───────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM productos").get();
  res.json({ status: "ok", productos: total });
});

// ── GET /inventario/stats ─────────────────────────────────────────────────────

app.get("/inventario/stats", (req, res) => {
  const productos = leerInventario();
  const ultima = productos.length > 0
    ? productos.reduce((a, b) => a.actualizado_at > b.actualizado_at ? a : b).actualizado_at
    : null;
  res.json({
    total:                productos.length,
    ultima_actualizacion: ultima,
    archivo:              INV_PATH,
  });
});

// ── GET /inventario ───────────────────────────────────────────────────────────

app.get("/inventario", (req, res) => {
  res.json(leerInventario());
});

// ── GET /inventario/:id ───────────────────────────────────────────────────────

app.get("/inventario/:id", (req, res) => {
  const p = leerInventario().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "no encontrado" });
  res.json(p);
});

// ── POST /inventario/bulk ─────────────────────────────────────────────────────

app.post("/inventario/bulk", (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : (body?.productos ?? []);
  if (!Array.isArray(items)) return res.status(400).json({ error: "array requerido" });

  const productos = leerInventario();
  let insertados = 0, actualizados = 0;

  for (const item of items) {
    const barcode = item.codigo_barras || item.barcode || "";
    const idx = barcode
      ? productos.findIndex(x => x.codigo_barras === barcode)
      : -1;

    const base = {
      nombre:        item.nombre      ?? "Sin nombre",
      precio:        item.precio      ?? 0,
      stock:         item.stock       ?? item.unidades   ?? 0,
      codigo_barras: barcode,
      categoria:     item.categoria   ?? "",
      imagen_url:    item.imagen_url  ?? item.foto_url   ?? "",
      actualizado_at: new Date().toISOString(),
    };

    if (idx >= 0) {
      productos[idx] = { ...productos[idx], ...base };
      actualizados++;
    } else {
      productos.push({ id: crypto.randomUUID(), ...base });
      insertados++;
    }
  }

  guardarInventario(productos);
  // Sync también a SQLite para el sistema de IA
  for (const item of items) {
    const barcode = item.codigo_barras || item.barcode || "";
    if (barcode) {
      upsert.run({
        barcode,
        nombre:    item.nombre    ?? "Sin nombre",
        marca:     item.marca     ?? "",
        categoria: item.categoria ?? "",
        foto_url:  item.imagen_url ?? item.foto_url ?? "",
        precio:    item.precio    ?? 0,
        unidades:  item.stock     ?? item.unidades  ?? 0,
      });
    }
  }

  res.json({ ok: true, insertados, actualizados });
});

// ── POST /inventario ──────────────────────────────────────────────────────────

app.post("/inventario", (req, res) => {
  const { nombre, precio, stock, codigo_barras, categoria, imagen_url } = req.body ?? {};
  if (!nombre) return res.status(400).json({ error: "nombre requerido" });

  const nuevo = {
    id:            crypto.randomUUID(),
    nombre,
    precio:        precio        ?? 0,
    stock:         stock         ?? 0,
    codigo_barras: codigo_barras ?? "",
    categoria:     categoria     ?? "",
    imagen_url:    imagen_url    ?? "",
    actualizado_at: new Date().toISOString(),
  };

  const productos = leerInventario();
  productos.push(nuevo);
  guardarInventario(productos);

  // Sync a SQLite
  if (codigo_barras) {
    upsert.run({
      barcode:   codigo_barras,
      nombre,
      marca:     "",
      categoria: categoria ?? "",
      foto_url:  imagen_url ?? "",
      precio:    precio     ?? 0,
      unidades:  stock      ?? 0,
    });
  }

  console.log(`[inventario] POST — ${nombre}`);
  res.status(201).json(nuevo);
});

// ── PUT /inventario/:id ───────────────────────────────────────────────────────

app.put("/inventario/:id", (req, res) => {
  const productos = leerInventario();
  const idx = productos.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "no encontrado" });

  const actualizado = {
    ...productos[idx],
    ...req.body,
    id:             req.params.id,
    actualizado_at: new Date().toISOString(),
  };
  productos[idx] = actualizado;
  guardarInventario(productos);

  // Sync a SQLite si tiene barcode
  if (actualizado.codigo_barras) {
    upsert.run({
      barcode:   actualizado.codigo_barras,
      nombre:    actualizado.nombre,
      marca:     "",
      categoria: actualizado.categoria ?? "",
      foto_url:  actualizado.imagen_url ?? "",
      precio:    actualizado.precio    ?? 0,
      unidades:  actualizado.stock     ?? 0,
    });
  }

  console.log(`[inventario] PUT ${req.params.id}`);
  res.json(actualizado);
});

// ── DELETE /inventario/:id ────────────────────────────────────────────────────

app.delete("/inventario/:id", (req, res) => {
  const productos = leerInventario();
  const idx = productos.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "no encontrado" });
  const [eliminado] = productos.splice(idx, 1);
  guardarInventario(productos);
  console.log(`[inventario] DELETE ${req.params.id} — ${eliminado.nombre}`);
  res.json({ ok: true });
});

// ── POST /sync ────────────────────────────────────────────────────────────────

const upsert = db.prepare(`
  INSERT INTO productos (barcode, nombre, marca, categoria, foto_url, precio, unidades, last_seen)
  VALUES (@barcode, @nombre, @marca, @categoria, @foto_url, @precio, @unidades, datetime('now'))
  ON CONFLICT(barcode) DO UPDATE SET
    nombre    = excluded.nombre,
    marca     = excluded.marca,
    categoria = excluded.categoria,
    foto_url  = excluded.foto_url,
    precio    = excluded.precio,
    unidades  = excluded.unidades,
    last_seen = datetime('now')
`);

app.post("/sync", (req, res) => {
  const { barcode, nombre, marca, categoria, foto_url, precio, unidades } = req.body ?? {};
  console.log(`[sync] ${barcode} — ${nombre}`);
  if (!barcode || !nombre) return res.status(400).json({ error: "barcode y nombre requeridos" });

  upsert.run({
    barcode,
    nombre,
    marca:     marca     ?? null,
    categoria: categoria ?? null,
    foto_url:  foto_url  ?? null,
    precio:    precio    ?? null,
    unidades:  unidades  ?? null,
  });

  // También actualizar inventario.json
  const productos = leerInventario();
  const idx = productos.findIndex(x => x.codigo_barras === barcode);
  const entry = {
    nombre, precio: precio ?? 0, stock: unidades ?? 0,
    codigo_barras: barcode, categoria: categoria ?? "",
    imagen_url: foto_url ?? "", actualizado_at: new Date().toISOString(),
  };
  if (idx >= 0) {
    productos[idx] = { ...productos[idx], ...entry };
  } else {
    productos.push({ id: crypto.randomUUID(), ...entry });
  }
  guardarInventario(productos);

  res.json({ ok: true });
});

// ── POST /sync-all ────────────────────────────────────────────────────────────

const upsertMany = db.transaction((prods) => {
  for (const p of prods) {
    upsert.run({
      barcode:   p.barcode,
      nombre:    p.nombre    ?? "Sin nombre",
      marca:     p.marca     ?? null,
      categoria: p.categoria ?? null,
      foto_url:  p.foto_url  ?? null,
      precio:    p.precio    ?? null,
      unidades:  p.unidades  ?? null,
    });
  }
});

app.post("/sync-all", (req, res) => {
  const { productos } = req.body ?? {};
  console.log(`[sync-all] ${productos?.length ?? 0} productos`);
  if (!Array.isArray(productos)) {
    return res.status(400).json({ error: "productos array requerido" });
  }
  try {
    if (productos.length === 0) {
      db.prepare("DELETE FROM productos").run();
      return res.json({ ok: true, sincronizados: 0 });
    }
    upsertMany(productos);
    res.json({ ok: true, sincronizados: productos.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /buscar?q=xxx ─────────────────────────────────────────────────────────

app.get("/buscar", (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json({ nodo: NODO_HOST, resultados: [], total: 0 });

  const productos = leerInventario();
  const resultados = productos
    .filter(p =>
      (p.nombre    || "").toLowerCase().includes(q) ||
      (p.categoria || "").toLowerCase().includes(q)
    )
    .map(({ nombre, precio, stock, categoria }) => ({ nombre, precio, stock, categoria }));

  res.json({ nodo: NODO_HOST, resultados, total: resultados.length });
});

// ── POST /query ───────────────────────────────────────────────────────────────

app.post("/query", (req, res) => {
  const { query_type, barcode } = req.body ?? {};
  console.log(`[query] ${query_type} — ${barcode ?? "n/a"}`);
  if (!query_type) return res.status(400).json({ error: "query_type requerido" });

  if (query_type === "product") {
    if (!barcode) return res.status(400).json({ error: "barcode requerido" });
    const row = db.prepare("SELECT * FROM productos WHERE barcode = ?").get(barcode);
    if (!row) return res.json({ found: false });
    return res.json({ found: true, ...row });
  }

  if (query_type === "search") {
    const { query_text } = req.body;
    if (!query_text) return res.status(400).json({ error: "query_text requerido" });
    const rows = db.prepare(`
      SELECT * FROM productos
      WHERE nombre LIKE ? OR marca LIKE ? OR categoria LIKE ?
      ORDER BY last_seen DESC LIMIT 5
    `).all(`%${query_text}%`, `%${query_text}%`, `%${query_text}%`);
    return res.json({ found: rows.length > 0, resultados: rows });
  }

  res.status(400).json({ error: "query_type no soportado" });
});

// ── Heartbeat a Supabase ──────────────────────────────────────────────────────

async function heartbeat() {
  if (!TUNNEL_URL || !SUPABASE_ANON) return;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tiendas?tunnel_url=eq.${encodeURIComponent(TUNNEL_URL)}`,
      {
        method:  "PATCH",
        headers: {
          "apikey":        SUPABASE_ANON,
          "Content-Type":  "application/json",
          "Prefer":        "return=minimal",
        },
        body: JSON.stringify({ last_seen: new Date().toISOString() }),
      }
    );
    if (!r.ok) console.error(`[heartbeat] HTTP ${r.status}`);
    else       console.log(`[heartbeat] OK — ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    console.error("[heartbeat] error:", e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`nodo-server escuchando en http://localhost:${PORT}`);

  // Heartbeat a Supabase cada 60 s
  heartbeat();
  setInterval(heartbeat, 60_000);

  // Comprobar actualizaciones 5 s después de arrancar, y luego cada 24 h
  setTimeout(checkForUpdates, 5_000);
  setInterval(checkForUpdates, 24 * 60 * 60 * 1_000);
});

// ── Auto-actualización desde GitHub ──────────────────────────────────────────

const { execSync } = require("child_process");
const REPO_URL = "https://github.com/marin1882/yagui-nodo.git";

function checkForUpdates() {
  try {
    const gitDir = path.join(__dirname, ".git");

    // Si el directorio no es un repo git (instalado via ZIP), inicializarlo
    if (!fs.existsSync(gitDir)) {
      console.log("[update] Inicializando repo git para auto-actualizaciones...");
      execSync("git init", { cwd: __dirname, stdio: "ignore" });
      execSync(`git remote add origin ${REPO_URL}`, { cwd: __dirname, stdio: "ignore" });
      execSync("git fetch origin master --depth=1", { cwd: __dirname, stdio: "ignore" });
      // Marcar el estado actual como origin/master sin reemplazar archivos de datos
      execSync("git reset --hard origin/master", { cwd: __dirname, stdio: "ignore" });
      console.log("[update] Repo git inicializado. Próxima comprobación en 24 h.");
      return;
    }

    // Obtener SHA actual
    const before = execSync("git rev-parse HEAD", { cwd: __dirname }).toString().trim();

    // Descargar cambios de origin
    execSync("git fetch origin master --depth=1", { cwd: __dirname, stdio: "pipe" });

    // SHA en origin
    const after = execSync("git rev-parse origin/master", { cwd: __dirname }).toString().trim();

    if (before === after) {
      console.log("[update] Sin cambios en GitHub.");
      return;
    }

    console.log(`[update] Nueva versión: ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
    execSync("git reset --hard origin/master", { cwd: __dirname, stdio: "inherit" });
    execSync("npm install --omit=dev",         { cwd: __dirname, stdio: "inherit" });
    console.log("[update] Actualizado. Reiniciando proceso...");
    process.exit(0); // yagui-desktop lo relanzará automáticamente

  } catch (e) {
    // Git no disponible o sin red — continuar sin actualizar
    console.error("[update] No disponible:", e.message?.split("\n")[0]);
  }
}
