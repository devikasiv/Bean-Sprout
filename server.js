// Thesis Garden server: serves the page, stores the garden in Postgres,
// and pushes live updates to open pages over Server-Sent Events.
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const CLASS_CODE = (process.env.CLASS_CODE || "").trim();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. In Railway, add a PostgreSQL database and reference its DATABASE_URL in this service's variables.");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

await pool.query(`
  create table if not exists users (
    id text primary key,
    name text not null,
    name_key text not null unique,
    pin_hash text not null,
    created_at timestamptz not null default now()
  );
  create table if not exists sessions (
    token_hash text primary key,
    user_id text not null references users(id) on delete cascade,
    created_at timestamptz not null default now()
  );
  create table if not exists docs (
    path text primary key,
    collection text not null,
    data jsonb not null,
    updated_at timestamptz not null default now()
  );
  create index if not exists docs_collection_idx on docs (collection);
`);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "300kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

// ---------- helpers ----------
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, error = "Bad request.") => res.status(400).json({ code: "invalid_argument", error });
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const scrypt = (pin, salt) => new Promise((ok, fail) => crypto.scrypt(pin, salt, 32, (e, k) => (e ? fail(e) : ok(k.toString("hex")))));
const cleanName = (n) => String(n || "").trim().replace(/\s+/g, " ");
const cmp = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);

// Paths look like gardens/<uid>/nodes/<id>: even segment count = document, odd = collection.
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function parsePath(p, kind) {
  if (typeof p !== "string" || p.length > 1000) return null;
  const s = p.split("/");
  if (s.length > 16 || !s.every((x) => SEG.test(x) && x !== "." && x !== "..")) return null;
  const isDoc = s.length % 2 === 0;
  return (kind === "doc") === isDoc ? s : null;
}

// Who may write where: your own garden subtree; check-ins you author.
function deny(uid, s, op, data, existing) {
  if (s[0] === "gardens") {
    if (s[1] !== uid) return "You can only change your own garden.";
    if (s.length === 2 && op === "set" && data.owner !== uid) return "A plant's owner must be you.";
    return null;
  }
  if (s[0] === "checkins" && s.length === 2) {
    if (op === "set" && !existing) {
      const ok = data.from === uid && typeof data.plant === "string" && typeof data.message === "string" && data.message.length <= 600;
      return ok ? null : "That check-in isn't valid.";
    }
    if (op === "delete") return existing && existing.from === uid ? null : "You can only delete your own check-ins.";
    return "Check-ins can't be edited.";
  }
  return "Not allowed.";
}

// ---------- live updates ----------
const clients = new Set();
function broadcast(p) {
  const msg = `data: ${JSON.stringify({ path: p })}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25000);

// ---------- sign-in: name + PIN ----------
const WINDOW = 15 * 60 * 1000;
const fails = new Map();

app.get("/api/config", (req, res) => res.json({ needsCode: Boolean(CLASS_CODE) }));

app.post("/api/enter", ah(async (req, res) => {
  const name = cleanName(req.body?.name);
  const pin = String(req.body?.pin || "");
  if (!name || name.length > 40) return bad(res, "Enter a name (up to 40 characters).");
  if (!/^\d{4,8}$/.test(pin)) return bad(res, "PIN must be 4 to 8 digits.");
  if (CLASS_CODE && String(req.body?.code || "").trim() !== CLASS_CODE) return res.status(403).json({ error: "That class code isn't right." });

  const key = name.toLowerCase();
  const f = fails.get(key);
  const recent = f && Date.now() - f.t < WINDOW;
  if (recent && f.n >= 8) return res.status(429).json({ error: "Too many wrong PINs. Try again in 15 minutes." });

  let user = (await pool.query("select id, name, pin_hash from users where name_key = $1", [key])).rows[0];
  if (user) {
    const [salt, hash] = user.pin_hash.split(":");
    const got = await scrypt(pin, salt);
    if (!crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(hash, "hex"))) {
      fails.set(key, { n: recent ? f.n + 1 : 1, t: recent ? f.t : Date.now() });
      return res.status(401).json({ error: "That name is taken, and the PIN doesn't match." });
    }
    fails.delete(key);
  } else {
    const salt = crypto.randomBytes(16).toString("hex");
    user = { id: "u_" + crypto.randomBytes(12).toString("hex"), name };
    try {
      await pool.query("insert into users (id, name, name_key, pin_hash) values ($1, $2, $3, $4)", [user.id, name, key, salt + ":" + (await scrypt(pin, salt))]);
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "Someone just took that name. Try again." });
      throw e;
    }
  }
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("insert into sessions (token_hash, user_id) values ($1, $2)", [sha(token), user.id]);
  res.json({ uid: user.id, name: user.name, token });
}));

const auth = ah(async (req, res, next) => {
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : String(req.query.token || "");
  const row = token && (await pool.query("select user_id from sessions where token_hash = $1", [sha(token)])).rows[0];
  if (!row) return res.status(401).json({ error: "Enter the garden first." });
  req.uid = row.user_id;
  next();
});

// ---------- data ----------
app.get("/api/doc", auth, ah(async (req, res) => {
  if (!parsePath(req.query.path, "doc")) return bad(res);
  const row = (await pool.query("select data from docs where path = $1", [req.query.path])).rows[0];
  res.json(row ? { exists: true, data: row.data } : { exists: false });
}));

app.get("/api/query", auth, ah(async (req, res) => {
  const coll = req.query.collection;
  if (!parsePath(coll, "collection")) return bad(res);
  let where = [];
  try { where = req.query.where ? JSON.parse(req.query.where) : []; } catch { return bad(res); }
  if (!Array.isArray(where) || where.length > 10 || !where.every((w) => Array.isArray(w) && w.length === 3 && typeof w[0] === "string" && w[1] === "==")) {
    return bad(res, "Only == filters are supported.");
  }
  const rows = (await pool.query("select path, data from docs where collection = $1", [coll])).rows;
  let docs = rows
    .map((r) => ({ id: r.path.split("/").pop(), data: r.data }))
    .filter((d) => where.every(([field, , value]) => d.data[field] === value));
  const ob = req.query.orderBy;
  if (ob) {
    const dir = req.query.dir === "desc" ? -1 : 1;
    docs.sort((a, b) => cmp(a.data[ob], b.data[ob]) * dir);
  } else docs.sort((a, b) => cmp(a.id, b.id));
  const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000);
  res.json({ docs: docs.slice(0, lim) });
}));

app.post("/api/write", auth, ah(async (req, res) => {
  const { op, path: p, data } = req.body || {};
  const segs = parsePath(p, "doc");
  if (!segs || !["set", "update", "delete"].includes(op)) return bad(res);
  if (op !== "delete" && (!data || typeof data !== "object" || Array.isArray(data))) return bad(res, "Body must be an object.");
  const existing = (await pool.query("select data from docs where path = $1", [p])).rows[0]?.data;
  const why = deny(req.uid, segs, op, data, existing);
  if (why) return res.status(403).json({ code: "invalid_argument", error: why });

  if (op === "set") {
    await pool.query(
      `insert into docs (path, collection, data, updated_at) values ($1, $2, $3::jsonb, now())
       on conflict (path) do update set data = excluded.data, updated_at = now()`,
      [p, segs.slice(0, -1).join("/"), JSON.stringify(data)],
    );
  } else if (op === "update") {
    if (!existing) return res.status(404).json({ code: "invalid_argument", error: "That document doesn't exist." });
    await pool.query("update docs set data = $2::jsonb, updated_at = now() where path = $1", [p, JSON.stringify({ ...existing, ...data })]);
  } else {
    await pool.query("delete from docs where path = $1", [p]);
  }
  broadcast(p);
  res.json({ ok: true });
}));

app.get("/api/stream", auth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.get("/health", (req, res) => res.send("ok"));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, () => console.log(`Thesis Garden listening on :${PORT}`));
