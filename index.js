const express  = require("express");
const Database = require("better-sqlite3");
const path     = require("path");

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

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── GET /health ───────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM productos").get();
  res.json({ status: "ok", productos: total });
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

  res.json({ ok: true });
});

// ── POST /sync-all ────────────────────────────────────────────────────────────

const upsertMany = db.transaction((productos) => {
  for (const p of productos) {
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
      console.log("[sync-all] inventario limpiado");
      return res.json({ ok: true, sincronizados: 0 });
    }
    upsertMany(productos);
    res.json({ ok: true, sincronizados: productos.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /query ───────────────────────────────────────────────────────────────

app.post("/query", (req, res) => {
  const { query_type, barcode } = req.body ?? {};
  console.log(`[query] ${query_type} — ${barcode ?? "n/a"}`);

  if (!query_type) return res.status(400).json({ error: "query_type requerido" });

  if (query_type === "product") {
    if (!barcode) return res.status(400).json({ error: "barcode requerido para query_type=product" });

    const row = db.prepare("SELECT * FROM productos WHERE barcode = ?").get(barcode);

    if (!row) return res.json({ found: false });

    return res.json({
      found:     true,
      barcode:   row.barcode,
      nombre:    row.nombre,
      marca:     row.marca,
      categoria: row.categoria,
      foto_url:  row.foto_url,
      precio:    row.precio,
      unidades:  row.unidades,
      last_seen: row.last_seen,
    });
  }

  if (query_type === "search") {
    const { query_text } = req.body;
    console.log(`[query] search — "${query_text}"`);
    if (!query_text) return res.status(400).json({ error: "query_text requerido para query_type=search" });

    const rows = db.prepare(`
      SELECT * FROM productos
      WHERE nombre LIKE ? OR marca LIKE ? OR categoria LIKE ?
      ORDER BY last_seen DESC LIMIT 5
    `).all(`%${query_text}%`, `%${query_text}%`, `%${query_text}%`);

    return res.json({ found: rows.length > 0, resultados: rows });
  }

  res.status(400).json({ error: "query_type no soportado" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`nodo-server escuchando en http://localhost:${PORT}`));
