const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const webRoot = __dirname;
loadLocalEnv(path.join(webRoot, ".env.local"));
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sessionMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const maxJsonBodyLength = 50_000_000;
const allowBootstrapAdmin = process.env.ALLOW_BOOTSTRAP_ADMIN === "true";
const secureCookies = process.env.NODE_ENV === "production" || process.env.SECURE_COOKIES === "true";
const authRateLimitWindowMs = 15 * 60 * 1000;
const authRateLimitMaxAttempts = 20;
const minPhotoSlideCount = 3;
const maxPhotoSlideCount = 4;
const maxPhotoDataUrlLength = 5_600_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authAttempts = new Map();
const acceptedPhotoMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp"
]);

function loadLocalEnv(filePath) {
  if (process.env.VERCEL || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

if (!databaseUrl) {
  throw new Error("DATABASE_URL precisa apontar para o Postgres/Supabase.");
}

const pool = new Pool({
  connectionString: normalizePostgresUrl(databaseUrl),
  max: Number(process.env.PG_POOL_MAX || 3),
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

function normalizePostgresUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return value;
  }
}

function postgresQuery(sql, params = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => `$${++index}`);
  return pool.query(text, params);
}

async function run(sql, params = []) {
  const result = await postgresQuery(sql, params);
  return { changes: result.rowCount };
}

async function get(sql, params = []) {
  const result = await postgresQuery(sql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await postgresQuery(sql, params);
  return result.rows;
}

const ready = (async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'");
  await run("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT");
  await run("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'))").catch(ignoreDuplicateObject);
  await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      csrf_token TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT");
  await run(`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      full_name TEXT NOT NULL,
      cpf TEXT NOT NULL DEFAULT '',
      photo_data_url TEXT,
      photo_slides_json TEXT,
      photo_edit_states_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run("ALTER TABLE identities ADD COLUMN IF NOT EXISTS photo_data_url TEXT");
  await run("ALTER TABLE identities ADD COLUMN IF NOT EXISTS photo_slides_json TEXT");
  await run("ALTER TABLE identities ADD COLUMN IF NOT EXISTS photo_edit_states_json TEXT");
  await run("CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities(user_id)");
  await run("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
  await run("ALTER TABLE sessions ENABLE ROW LEVEL SECURITY");
  await run("ALTER TABLE identities ENABLE ROW LEVEL SECURITY");
  await removeAutomaticExampleIdentities();
  const admin = await get("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
  if (!admin && allowBootstrapAdmin) {
    const firstUser = await get("SELECT id FROM users ORDER BY created_at ASC LIMIT 1");
    if (firstUser) {
      await run("UPDATE users SET role = 'admin' WHERE id = ?", [firstUser.id]);
    }
  }
})();

function ignoreDuplicateObject(error) {
  if (error && error.code === "42710") return;
  throw error;
}

async function removeAutomaticExampleIdentities() {
  await run(`
    DELETE FROM identities
    WHERE title IN ('Identidade de exemplo', 'Identidade 1')
      AND COALESCE(full_name, '') = ''
      AND COALESCE(cpf, '') = ''
      AND COALESCE(photo_data_url, '') = ''
      AND COALESCE(photo_slides_json, '') = ''
  `);
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxJsonBodyLength) {
        request.destroy();
        reject(new Error("Payload too large"));
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  return Object.fromEntries(header.split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    try {
      return [key, decodeURIComponent(value.join("=") || "")];
    } catch {
      return [key, ""];
    }
  }).filter(([key]) => key));
}

function getClientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function isRateLimited(request, action) {
  const now = Date.now();
  const key = `${action}:${getClientAddress(request)}`;
  const current = authAttempts.get(key);

  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + authRateLimitWindowMs });
    return false;
  }

  current.count += 1;
  return current.count > authRateLimitMaxAttempts;
}

function isSameOriginRequest(request) {
  const origin = request.headers.origin;
  if (!origin) return true;

  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function rejectCrossOriginMutation(request, response) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return false;
  }
  if (isSameOriginRequest(request)) return false;

  sendJson(response, 403, { error: "Origem da requisicao nao permitida." });
  return true;
}

function sessionCookie(token, maxAgeSeconds) {
  return [
    `session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    secureCookies ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function clearSessionCookie() {
  return sessionCookie("", 0);
}

function isUuid(value) {
  return uuidPattern.test(String(value || ""));
}

function requireUuid(value, response, label = "Identificador") {
  if (isUuid(value)) return true;
  sendJson(response, 400, { error: `${label} invalido.` });
  return false;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 150000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const actual = Buffer.from(hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role || "user"
  };
}

function publicIdentity(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    displayName: row.full_name || "",
    cpf: row.cpf || "",
    photoSlides: parsePhotoSlides(row.photo_slides_json),
    photoEditStates: parsePhotoEditStates(row.photo_edit_states_json),
    ownerName: row.owner_name || null,
    ownerUsername: row.owner_username || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parsePhotoSlides(value) {
  if (!value) return [];
  try {
    const slides = JSON.parse(value);
    return Array.isArray(slides) ? slides : [];
  } catch {
    return [];
  }
}

function parsePhotoEditStates(value) {
  if (!value) return {};
  try {
    const edits = JSON.parse(value);
    return edits && typeof edits === "object" && !Array.isArray(edits) ? edits : {};
  } catch {
    return {};
  }
}

function validatePhotoEditStates(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Os dados de edicao das fotos sao invalidos.");
  }
  const allowedKeys = new Set(["front", "back", "signature", "qr"]);
  const result = {};
  for (const [key, edit] of Object.entries(value)) {
    if (!allowedKeys.has(key) || edit === null) continue;
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      throw new Error(`A edicao da foto ${key} e invalida.`);
    }
    const source = String(edit.source || "");
    const match = /^data:([^;,]+);base64,[A-Za-z0-9+/=]+$/.exec(source);
    if (!match || !acceptedPhotoMimeTypes.has(match[1]) || source.length > maxPhotoDataUrlLength) {
      throw new Error(`O arquivo-fonte da foto ${key} e invalido ou excede 4 MB.`);
    }
    const brushHistory = Array.isArray(edit.brushHistory) ? edit.brushHistory : [];
    if (brushHistory.length > 500 || brushHistory.some((stroke) => !stroke || !Array.isArray(stroke.points) || stroke.points.length > 50_000)) {
      throw new Error(`O historico de edicao da foto ${key} excede o limite permitido.`);
    }
    result[key] = edit;
  }
  return result;
}

function validatePhotoSlides(value) {
  if (!Array.isArray(value) || value.length < minPhotoSlideCount || value.length > maxPhotoSlideCount) {
    throw new Error("Anexe 3 fotos obrigatorias: Frente, Verso e Assinatura. O quarto QR e opcional.");
  }

  return value.map((slide, index) => {
    const dataUrl = String(slide || "");
    const match = /^data:([^;,]+);base64,[A-Za-z0-9+/=]+$/.exec(dataUrl);
    if (!match || !acceptedPhotoMimeTypes.has(match[1])) {
      throw new Error(`Foto ${index + 1} deve ser JPG, PNG, WEBP, HEIC, HEIF, GIF ou BMP.`);
    }
    if (dataUrl.length > maxPhotoDataUrlLength) {
      throw new Error(`Foto ${index + 1} excede o limite de 4 MB.`);
    }
    return dataUrl;
  });
}

function isAdmin(user) {
  return user && user.role === "admin";
}

function requireAdmin(user, response) {
  if (isAdmin(user)) return true;
  sendJson(response, 403, { error: "Permissao insuficiente." });
  return false;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionMaxAgeMs).toISOString();
  await run(
    "INSERT INTO sessions (token, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
    [token, userId, csrfToken, expiresAt]
  );
  return { token, csrfToken };
}

async function getUserFromRequest(request) {
  const { session } = parseCookies(request);
  if (!session) return null;

  const row = await get(`
    SELECT users.*, sessions.csrf_token AS csrf_token, sessions.token AS session_token
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > ?
  `, [session, new Date().toISOString()]);

  if (row && !row.csrf_token) {
    row.csrf_token = crypto.randomBytes(32).toString("hex");
    await run("UPDATE sessions SET csrf_token = ? WHERE token = ?", [row.csrf_token, session]);
  }

  return row || null;
}

async function requireUser(request, response) {
  const user = await getUserFromRequest(request);
  if (!user) {
    sendJson(response, 401, { error: "Nao autenticado" });
    return null;
  }
  return user;
}

function requireCsrf(request, response, user) {
  const token = request.headers["x-csrf-token"];
  if (token && user.csrf_token && token === user.csrf_token) return true;

  sendJson(response, 403, { error: "Token CSRF invalido." });
  return false;
}

async function handleApi(request, response, url) {
  await ready;

  if (rejectCrossOriginMutation(request, response)) return;

  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    if (isRateLimited(request, "register")) {
      sendJson(response, 429, { error: "Muitas tentativas. Aguarde alguns minutos." });
      return;
    }

    const payload = await readJsonBody(request);
    const username = normalizeUsername(payload.username || payload.name);
    const name = username;
    const password = String(payload.password || "");

    if (!username || password.length < 6) {
      sendJson(response, 400, { error: "Informe usuario e senha com pelo menos 6 caracteres." });
      return;
    }

    const existing = await get("SELECT id FROM users WHERE username = ?", [username]);
    if (existing) {
      sendJson(response, 409, { error: "Usuario ja cadastrado." });
      return;
    }

    const adminCount = await get("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'");
    const role = allowBootstrapAdmin && adminCount.total === 0 ? "admin" : "user";
    const userId = crypto.randomUUID();
    const { salt, hash } = hashPassword(password);
    await run(
      "INSERT INTO users (id, name, username, password_salt, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, name, username, salt, hash, role]
    );

    const session = await createSession(userId);
    sendJson(response, 201, { user: { id: userId, name, username, role }, csrfToken: session.csrfToken }, {
      "Set-Cookie": sessionCookie(session.token, Math.floor(sessionMaxAgeMs / 1000))
    });
    return;
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (isRateLimited(request, "login")) {
      sendJson(response, 429, { error: "Muitas tentativas. Aguarde alguns minutos." });
      return;
    }

    const payload = await readJsonBody(request);
    const login = normalizeUsername(payload.login || payload.username);
    const password = String(payload.password || "");
    const user = await get("SELECT * FROM users WHERE username = ?", [login]);

    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      sendJson(response, 401, { error: "Usuario ou senha invalido." });
      return;
    }

    const session = await createSession(user.id);
    sendJson(response, 200, { user: publicUser(user), csrfToken: session.csrfToken }, {
      "Set-Cookie": sessionCookie(session.token, Math.floor(sessionMaxAgeMs / 1000))
    });
    return;
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    if (user.session_token) {
      await run("DELETE FROM sessions WHERE token = ?", [user.session_token]);
    }
    sendJson(response, 200, { ok: true }, {
      "Set-Cookie": clearSessionCookie()
    });
    return;
  }

  if (url.pathname === "/api/me" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    sendJson(response, 200, { user: publicUser(user), csrfToken: user.csrf_token });
    return;
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireAdmin(user, response)) return;
    const rows = await all("SELECT id, name, username, role FROM users ORDER BY created_at ASC");
    sendJson(response, 200, { users: rows.map(publicUser) });
    return;
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch && request.method === "DELETE") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    if (!requireAdmin(user, response)) return;
    const targetUserId = userMatch[1];
    if (!requireUuid(targetUserId, response, "Usuario")) return;
    if (targetUserId === user.id) {
      sendJson(response, 400, { error: "O admin nao pode remover a propria conta." });
      return;
    }

    const result = await run("DELETE FROM users WHERE id = ?", [targetUserId]);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "Usuario nao encontrado." });
      return;
    }
    sendJson(response, 200, { ok: true, deleted: result.changes });
    return;
  }

  if (url.pathname === "/api/identities" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    const rows = isAdmin(user)
      ? await all(`
          SELECT identities.*, users.name AS owner_name, users.username AS owner_username
          FROM identities
          JOIN users ON users.id = identities.user_id
          ORDER BY identities.created_at ASC
        `)
      : await all(`
          SELECT identities.*, users.name AS owner_name, users.username AS owner_username
          FROM identities
          JOIN users ON users.id = identities.user_id
          WHERE identities.user_id = ?
          ORDER BY identities.created_at ASC
        `, [user.id]);
    sendJson(response, 200, { identities: rows.map(publicIdentity) });
    return;
  }

  if (url.pathname === "/api/identities" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    const payload = await readJsonBody(request);
    const title = String(payload.title || "").trim() || "Nova identidade";
    const displayName = String(payload.displayName || "").trim();
    const cpf = String(payload.cpf || "").trim();
    const targetUserId = isAdmin(user) && payload.userId ? String(payload.userId) : user.id;
    let photoSlides;
    let photoEditStates;

    if (!requireUuid(targetUserId, response, "Usuario destino")) return;

    if (!displayName || !cpf) {
      sendJson(response, 400, { error: "Informe Nome exibido e CPF." });
      return;
    }

    try {
      photoSlides = validatePhotoSlides(payload.photoSlides);
      photoEditStates = validatePhotoEditStates(payload.photoEditStates);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }

    const targetUser = await get("SELECT id FROM users WHERE id = ?", [targetUserId]);
    if (!targetUser) {
      sendJson(response, 404, { error: "Usuario de destino nao encontrado." });
      return;
    }

    const id = crypto.randomUUID();
    await run(`
      INSERT INTO identities (id, user_id, title, full_name, cpf, photo_slides_json, photo_edit_states_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, targetUserId, title, displayName, cpf, JSON.stringify(photoSlides), JSON.stringify(photoEditStates)]);
    const row = await get(`
      SELECT identities.*, users.name AS owner_name, users.username AS owner_username
      FROM identities
      JOIN users ON users.id = identities.user_id
      WHERE identities.id = ?
    `, [id]);
    sendJson(response, 201, { identity: publicIdentity(row) });
    return;
  }

  const sendIdentityMatch = /^\/api\/identities\/([^/]+)\/send$/.exec(url.pathname);
  if (sendIdentityMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    if (!requireAdmin(user, response)) return;
    const sourceIdentityId = sendIdentityMatch[1];
    if (!requireUuid(sourceIdentityId, response, "Identidade")) return;

    const payload = await readJsonBody(request);
    const targetUserId = String(payload.targetUserId || "");
    if (!targetUserId || targetUserId === user.id) {
      sendJson(response, 400, { error: "Selecione outro usuario destino." });
      return;
    }
    if (!requireUuid(targetUserId, response, "Usuario destino")) return;

    const sourceIdentity = await get(`
      SELECT *
      FROM identities
      WHERE id = ? AND user_id = ?
    `, [sourceIdentityId, user.id]);
    if (!sourceIdentity) {
      sendJson(response, 404, { error: "Identidade do admin nao encontrada." });
      return;
    }

    const targetUser = await get("SELECT id FROM users WHERE id = ?", [targetUserId]);
    if (!targetUser) {
      sendJson(response, 404, { error: "Usuario de destino nao encontrado." });
      return;
    }

    const id = crypto.randomUUID();
    await run(`
      INSERT INTO identities (id, user_id, title, full_name, cpf, photo_slides_json, photo_edit_states_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, targetUserId, sourceIdentity.title, sourceIdentity.full_name, sourceIdentity.cpf, sourceIdentity.photo_slides_json, sourceIdentity.photo_edit_states_json]);
    const row = await get(`
      SELECT identities.*, users.name AS owner_name, users.username AS owner_username
      FROM identities
      JOIN users ON users.id = identities.user_id
      WHERE identities.id = ?
    `, [id]);
    sendJson(response, 201, { identity: publicIdentity(row) });
    return;
  }

  const identityMatch = /^\/api\/identities\/([^/]+)$/.exec(url.pathname);
  if (identityMatch && request.method === "PATCH") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    const identityId = identityMatch[1];
    if (!requireUuid(identityId, response, "Identidade")) return;
    const payload = await readJsonBody(request);
    const updates = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(payload, "title")) {
      const title = String(payload.title || "").trim();
      if (!title) {
        sendJson(response, 400, { error: "Informe um titulo valido." });
        return;
      }
      updates.push("title = ?");
      params.push(title);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "photoSlides")) {
      try {
        const photoSlides = validatePhotoSlides(payload.photoSlides);
        updates.push("photo_slides_json = ?");
        params.push(JSON.stringify(photoSlides));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "photoEditStates")) {
      try {
        const photoEditStates = validatePhotoEditStates(payload.photoEditStates);
        updates.push("photo_edit_states_json = ?");
        params.push(JSON.stringify(photoEditStates));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
    }

    if (!updates.length) {
      sendJson(response, 400, { error: "Nenhuma alteracao informada." });
      return;
    }

    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(identityId);
    const result = isAdmin(user)
      ? await run(`UPDATE identities SET ${updates.join(", ")} WHERE id = ?`, params)
      : await run(`UPDATE identities SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`, [...params, user.id]);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "Identidade nao encontrada." });
      return;
    }

    const row = await get(`
      SELECT identities.*, users.name AS owner_name, users.username AS owner_username
      FROM identities
      JOIN users ON users.id = identities.user_id
      WHERE identities.id = ?
    `, [identityId]);
    sendJson(response, 200, { identity: publicIdentity(row) });
    return;
  }

  if (identityMatch && request.method === "DELETE") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    const identityId = identityMatch[1];
    if (!requireUuid(identityId, response, "Identidade")) return;
    const result = isAdmin(user)
      ? await run("DELETE FROM identities WHERE id = ?", [identityId])
      : await run("DELETE FROM identities WHERE id = ? AND user_id = ?", [identityId, user.id]);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "Identidade nao encontrada." });
      return;
    }
    sendJson(response, 200, { ok: true, deleted: result.changes });
    return;
  }

  sendJson(response, 404, { error: "Rota nao encontrada" });
}

async function serveStatic(request, response, url) {
  await ready;

  if (url.pathname === "/") {
    redirect(response, "/auth");
    return;
  }

  const appRoutes = new Set(["/auth", "/dashboard", "/identidadefake"]);
  const protectedAppRoutes = new Set(["/dashboard", "/identidadefake"]);

  if (protectedAppRoutes.has(url.pathname)) {
    const user = await getUserFromRequest(request);
    if (!user) {
      redirect(response, "/auth");
      return;
    }
  }

  if (url.pathname === "/auth") {
    const user = await getUserFromRequest(request);
    if (user) {
      redirect(response, "/dashboard");
      return;
    }
  }

  const relativePath = appRoutes.has(url.pathname)
    ? "index.html"
    : decodeURIComponent(url.pathname).replace(/^\/+/, "");

  if (!relativePath || relativePath === "data" || relativePath.startsWith("data/") || relativePath.startsWith("node_modules/")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const filePath = path.resolve(webRoot, relativePath);
  if (!filePath.startsWith(webRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(data);
  });
}

function requestHandler(request, response) {
  const url = new URL(request.url, `http://localhost:${port}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
    return;
  }

  serveStatic(request, response, url).catch((error) => {
    sendJson(response, 500, { error: error.message });
  });
}

if (require.main === module) {
  http.createServer(requestHandler).listen(port, () => {
    console.log(`Website running at http://localhost:${port}`);
  });
}

module.exports = requestHandler;
