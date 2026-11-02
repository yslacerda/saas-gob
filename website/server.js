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
const asaasApiKey = process.env.ASAAS_API_KEY || "";
const asaasApiBaseUrl = String(process.env.ASAAS_API_BASE_URL || "https://api-sandbox.asaas.com/v3").replace(/\/+$/, "");
const defaultAsaasCheckoutBaseUrl = asaasApiBaseUrl.includes("api-sandbox.asaas.com")
  ? "https://sandbox.asaas.com/checkoutSession/show"
  : "https://asaas.com/checkoutSession/show";
const asaasCheckoutBaseUrl = String(process.env.ASAAS_CHECKOUT_BASE_URL || defaultAsaasCheckoutBaseUrl);
const asaasWebhookToken = process.env.ASAAS_WEBHOOK_TOKEN || "";
const appBaseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const paymentConfigurationReady = Boolean(asaasApiKey && asaasWebhookToken.length >= 32 && /^https?:\/\//i.test(appBaseUrl));
const authRateLimitWindowMs = 15 * 60 * 1000;
const authRateLimitMaxAttempts = 20;
const minPhotoSlideCount = 3;
const maxPhotoSlideCount = 3;
const maxPhotoDataUrlLength = 5_600_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authAttempts = new Map();
const subscriptionPlans = Object.freeze({
  monthly: Object.freeze({ code: "monthly", name: "Acesso mensal", amountCents: 3999, durationDays: 30 }),
  quarterly: Object.freeze({ code: "quarterly", name: "Acesso trimestral", amountCents: 5999, durationDays: 90 })
});
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
  // Coluna legada mantida por compatibilidade; o acesso agora depende de pagamento confirmado.
  await run("ALTER TABLE users ADD COLUMN IF NOT EXISTS access_exempt BOOLEAN NOT NULL DEFAULT TRUE");
  await run("ALTER TABLE users ALTER COLUMN access_exempt SET DEFAULT FALSE");
  await run("ALTER TABLE users ADD COLUMN IF NOT EXISTS access_until TIMESTAMPTZ");
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
  await run(`
    CREATE TABLE IF NOT EXISTS access_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_code TEXT NOT NULL CHECK (plan_code IN ('monthly', 'quarterly')),
      amount_cents INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled', 'expired', 'failed')),
      provider TEXT NOT NULL DEFAULT 'asaas',
      provider_checkout_id TEXT UNIQUE,
      paid_at TIMESTAMPTZ,
      access_from TIMESTAMPTZ,
      access_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run("CREATE INDEX IF NOT EXISTS idx_access_purchases_user_id ON access_purchases(user_id)");
  await run(`
    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
  await run("ALTER TABLE sessions ENABLE ROW LEVEL SECURITY");
  await run("ALTER TABLE identities ENABLE ROW LEVEL SECURITY");
  await run("ALTER TABLE access_purchases ENABLE ROW LEVEL SECURITY");
  await run("ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY");
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

  sendJson(response, 403, { error: "Origem da requisição não permitida." });
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
  sendJson(response, 400, { error: `${label} inválido.` });
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
  const accessUntil = row.access_until ? new Date(row.access_until) : null;
  const hasAccess = (row.role || "user") === "admin" || (accessUntil && accessUntil.getTime() > Date.now());
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role || "user",
    access: {
      active: Boolean(hasAccess),
      exempt: false,
      until: accessUntil ? accessUntil.toISOString() : null
    }
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
    throw new Error("Os dados de edição das fotos são inválidos.");
  }
  const allowedKeys = new Set(["front", "back", "signature"]);
  const result = {};
  for (const [key, edit] of Object.entries(value)) {
    if (!allowedKeys.has(key) || edit === null) continue;
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      throw new Error(`A edição da foto ${key} é inválida.`);
    }
    const source = String(edit.source || "");
    const match = /^data:([^;,]+);base64,[A-Za-z0-9+/=]+$/.exec(source);
    if (!match || !acceptedPhotoMimeTypes.has(match[1]) || source.length > maxPhotoDataUrlLength) {
      throw new Error(`O arquivo-fonte da foto ${key} é inválido ou excede 4 MB.`);
    }
    const brushHistory = Array.isArray(edit.brushHistory) ? edit.brushHistory : [];
    if (brushHistory.length > 500 || brushHistory.some((stroke) => !stroke || !Array.isArray(stroke.points) || stroke.points.length > 50_000)) {
      throw new Error(`O histórico de edição da foto ${key} excede o limite permitido.`);
    }
    result[key] = edit;
  }
  return result;
}

function validatePhotoSlides(value) {
  if (!Array.isArray(value) || value.length < minPhotoSlideCount || value.length > maxPhotoSlideCount) {
    throw new Error("Anexe exatamente 3 fotos: Frente, Verso e Assinatura. O QR é fixo no simulador.");
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
  sendJson(response, 403, { error: "Permissão insuficiente." });
  return false;
}

function hasProductAccess(user) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return Boolean(user.access_until && new Date(user.access_until).getTime() > Date.now());
}

function requireProductAccess(user, response) {
  if (hasProductAccess(user)) return true;
  sendJson(response, 402, { error: "Assinatura necessária para acessar este recurso.", code: "SUBSCRIPTION_REQUIRED" });
  return false;
}

function safeTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function requestOrigin(request) {
  if (appBaseUrl) return appBaseUrl;
  const protocol = String(request.headers["x-forwarded-proto"] || (secureCookies ? "https" : "http")).split(",")[0];
  return `${protocol}://${request.headers.host}`;
}

async function asaasRequest(pathname, options = {}) {
  if (!asaasApiKey) throw new Error("Pagamento indisponível: ASAAS_API_KEY não configurada.");
  const response = await fetch(`${asaasApiBaseUrl}${pathname}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "GovFake-Simulador/1.0",
      access_token: asaasApiKey,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = Array.isArray(payload.errors) ? payload.errors.map((item) => item.description).filter(Boolean).join(" ") : "";
    throw new Error(description || `Falha na Asaas (${response.status}).`);
  }
  return payload;
}

async function applyPaidCheckout(eventId, checkout) {
  const checkoutId = String(checkout && checkout.id || "");
  if (!checkoutId) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      "INSERT INTO payment_webhook_events (id, event_type) VALUES ($1, 'CHECKOUT_PAID') ON CONFLICT (id) DO NOTHING RETURNING id",
      [eventId]
    );
    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return true;
    }

    const purchaseResult = await client.query(
      "SELECT * FROM access_purchases WHERE provider_checkout_id = $1 FOR UPDATE",
      [checkoutId]
    );
    const purchase = purchaseResult.rows[0];
    if (!purchase) {
      await client.query("ROLLBACK");
      return false;
    }
    if (purchase.status !== "pending") {
      await client.query("COMMIT");
      return true;
    }

    const accessResult = await client.query(`
      UPDATE users
      SET access_until = GREATEST(COALESCE(access_until, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP) + ($1 * INTERVAL '1 day')
      WHERE id = $2
      RETURNING access_until
    `, [purchase.duration_days, purchase.user_id]);
    const accessUntil = accessResult.rows[0].access_until;
    await client.query(`
      UPDATE access_purchases
      SET status = 'paid', paid_at = CURRENT_TIMESTAMP,
          access_from = CURRENT_TIMESTAMP, access_until = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [accessUntil, purchase.id]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
    sendJson(response, 401, { error: "Não autenticado" });
    return null;
  }
  return user;
}

function requireCsrf(request, response, user) {
  const token = request.headers["x-csrf-token"];
  if (token && user.csrf_token && token === user.csrf_token) return true;

  sendJson(response, 403, { error: "Token CSRF inválido." });
  return false;
}

async function handleApi(request, response, url) {
  await ready;

  if (url.pathname === "/api/payments/asaas/webhook" && request.method === "POST") {
    if (!asaasWebhookToken || !safeTokenEquals(request.headers["asaas-access-token"], asaasWebhookToken)) {
      sendJson(response, 401, { error: "Webhook não autorizado." });
      return;
    }

    const payload = await readJsonBody(request);
    const eventId = String(payload.id || "");
    const eventType = String(payload.event || "");
    const checkout = payload.checkout || {};
    if (!eventId || !eventType || !checkout.id) {
      sendJson(response, 400, { error: "Evento de pagamento inválido." });
      return;
    }

    if (eventType === "CHECKOUT_PAID") {
      const matched = await applyPaidCheckout(eventId, checkout);
      if (!matched) {
        sendJson(response, 404, { error: "Checkout não reconhecido." });
        return;
      }
    } else if (eventType === "CHECKOUT_CANCELED" || eventType === "CHECKOUT_EXPIRED") {
      const nextStatus = eventType === "CHECKOUT_CANCELED" ? "canceled" : "expired";
      await run(
        "UPDATE access_purchases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE provider_checkout_id = ? AND status = 'pending'",
        [nextStatus, String(checkout.id)]
      );
      await run(
        "INSERT INTO payment_webhook_events (id, event_type) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
        [eventId, eventType]
      );
    }

    sendJson(response, 200, { ok: true });
    return;
  }

  if (rejectCrossOriginMutation(request, response)) return;

  if (url.pathname.startsWith("/api/identities")) {
    const accessUser = await requireUser(request, response);
    if (!accessUser || !requireProductAccess(accessUser, response)) return;
  }

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
      sendJson(response, 400, { error: "Informe usuário e senha com pelo menos 6 caracteres." });
      return;
    }

    const existing = await get("SELECT id FROM users WHERE username = ?", [username]);
    if (existing) {
      sendJson(response, 409, { error: "Usuário já cadastrado." });
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
    sendJson(response, 201, { user: publicUser({ id: userId, name, username, role, access_exempt: false, access_until: null }), csrfToken: session.csrfToken }, {
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
      sendJson(response, 401, { error: "Usuário ou senha inválido." });
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

  if (url.pathname === "/api/billing/status" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    const latestPurchase = await get(`
      SELECT id, plan_code, amount_cents, status, provider_checkout_id, created_at, paid_at, access_until
      FROM access_purchases
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [user.id]);
    sendJson(response, 200, {
      user: publicUser(user),
      plans: Object.values(subscriptionPlans),
      latestPurchase: latestPurchase ? {
        id: latestPurchase.id,
        planCode: latestPurchase.plan_code,
        amountCents: latestPurchase.amount_cents,
        status: latestPurchase.status,
        checkoutId: latestPurchase.provider_checkout_id,
        createdAt: latestPurchase.created_at,
        paidAt: latestPurchase.paid_at,
        accessUntil: latestPurchase.access_until
      } : null,
      paymentConfigured: paymentConfigurationReady
    });
    return;
  }

  if (url.pathname === "/api/billing/checkout" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    if (isAdmin(user)) {
      sendJson(response, 400, { error: "A conta administrativa não precisa comprar um plano." });
      return;
    }

    const payload = await readJsonBody(request);
    const plan = subscriptionPlans[String(payload.planCode || "")];
    if (!plan) {
      sendJson(response, 400, { error: "Plano inválido." });
      return;
    }
    if (!paymentConfigurationReady) {
      sendJson(response, 503, { error: "Pagamento temporariamente indisponível." });
      return;
    }

    const reusablePurchase = await get(`
      SELECT id, provider_checkout_id
      FROM access_purchases
      WHERE user_id = ? AND plan_code = ? AND status = 'pending'
        AND provider_checkout_id IS NOT NULL
        AND created_at > CURRENT_TIMESTAMP - INTERVAL '60 minutes'
      ORDER BY created_at DESC
      LIMIT 1
    `, [user.id, plan.code]);
    if (reusablePurchase) {
      const checkoutUrl = new URL(asaasCheckoutBaseUrl);
      checkoutUrl.searchParams.set("id", reusablePurchase.provider_checkout_id);
      sendJson(response, 200, { purchaseId: reusablePurchase.id, checkoutUrl: checkoutUrl.toString(), reused: true });
      return;
    }

    const purchaseId = crypto.randomUUID();
    await run(`
      INSERT INTO access_purchases (id, user_id, plan_code, amount_cents, duration_days)
      VALUES (?, ?, ?, ?, ?)
    `, [purchaseId, user.id, plan.code, plan.amountCents, plan.durationDays]);

    const origin = requestOrigin(request);
    try {
      const checkout = await asaasRequest("/checkouts", {
        method: "POST",
        body: JSON.stringify({
          billingTypes: ["PIX"],
          chargeTypes: ["DETACHED"],
          minutesToExpire: 60,
          externalReference: purchaseId,
          callback: {
            successUrl: `${origin}/assinaturas?payment=success`,
            cancelUrl: `${origin}/assinaturas?payment=canceled`,
            expiredUrl: `${origin}/assinaturas?payment=expired`
          },
          items: [{
            name: plan.name,
            description: `${plan.durationDays} dias de acesso ao simulador`,
            quantity: 1,
            value: plan.amountCents / 100
          }]
        })
      });
      const checkoutId = String(checkout.id || "");
      if (!checkoutId) throw new Error("A Asaas não retornou o identificador do checkout.");
      await run(
        "UPDATE access_purchases SET provider_checkout_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [checkoutId, purchaseId]
      );
      const checkoutUrl = new URL(asaasCheckoutBaseUrl);
      checkoutUrl.searchParams.set("id", checkoutId);
      sendJson(response, 201, { purchaseId, checkoutUrl: checkoutUrl.toString() });
    } catch (error) {
      await run("UPDATE access_purchases SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [purchaseId]);
      sendJson(response, 502, { error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireAdmin(user, response)) return;
    const rows = await all("SELECT id, name, username, role, access_until FROM users ORDER BY created_at ASC");
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
    if (!requireUuid(targetUserId, response, "Usuário")) return;
    if (targetUserId === user.id) {
      sendJson(response, 400, { error: "O administrador não pode remover a própria conta." });
      return;
    }

    const result = await run("DELETE FROM users WHERE id = ?", [targetUserId]);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "Usuário não encontrado." });
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

    if (!requireUuid(targetUserId, response, "Usuário de destino")) return;

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
      sendJson(response, 404, { error: "Usuário de destino não encontrado." });
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

  const transferIdentityMatch = /^\/api\/identities\/([^/]+)\/transfer$/.exec(url.pathname);
  if (transferIdentityMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!requireCsrf(request, response, user)) return;
    if (!requireAdmin(user, response)) return;
    const identityId = transferIdentityMatch[1];
    if (!requireUuid(identityId, response, "Identidade")) return;

    const payload = await readJsonBody(request);
    const targetUserId = String(payload.targetUserId || "");
    if (!targetUserId) {
      sendJson(response, 400, { error: "Selecione o usuário de destino." });
      return;
    }
    if (!requireUuid(targetUserId, response, "Usuário de destino")) return;

    const identity = await get("SELECT id, user_id FROM identities WHERE id = ?", [identityId]);
    if (!identity) {
      sendJson(response, 404, { error: "Identidade não encontrada." });
      return;
    }
    if (targetUserId === identity.user_id) {
      sendJson(response, 400, { error: "A identidade já pertence a este usuário." });
      return;
    }

    const targetUser = await get("SELECT id FROM users WHERE id = ?", [targetUserId]);
    if (!targetUser) {
      sendJson(response, 404, { error: "Usuário de destino não encontrado." });
      return;
    }

    await run("UPDATE identities SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [targetUserId, identityId]);
    const row = await get(`
      SELECT identities.*, users.name AS owner_name, users.username AS owner_username
      FROM identities
      JOIN users ON users.id = identities.user_id
      WHERE identities.id = ?
    `, [identityId]);
    sendJson(response, 200, { identity: publicIdentity(row) });
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
        sendJson(response, 400, { error: "Informe um título válido." });
        return;
      }
      updates.push("title = ?");
      params.push(title);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "displayName")) {
      const displayName = String(payload.displayName || "").trim();
      if (!displayName || displayName.length > 180) {
        sendJson(response, 400, { error: "Informe um nome completo válido." });
        return;
      }
      updates.push("full_name = ?");
      params.push(displayName);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "cpf")) {
      const cpf = String(payload.cpf || "").trim();
      if (!cpf || cpf.length > 32) {
        sendJson(response, 400, { error: "Informe um CPF válido." });
        return;
      }
      updates.push("cpf = ?");
      params.push(cpf);
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
      sendJson(response, 400, { error: "Nenhuma alteração informada." });
      return;
    }

    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(identityId);
    const result = isAdmin(user)
      ? await run(`UPDATE identities SET ${updates.join(", ")} WHERE id = ?`, params)
      : await run(`UPDATE identities SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`, [...params, user.id]);
    if (result.changes === 0) {
      sendJson(response, 404, { error: "Identidade não encontrada." });
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
      sendJson(response, 404, { error: "Identidade não encontrada." });
      return;
    }
    sendJson(response, 200, { ok: true, deleted: result.changes });
    return;
  }

  sendJson(response, 404, { error: "Rota não encontrada" });
}

async function serveStatic(request, response, url) {
  await ready;

  if (url.pathname === "/") {
    redirect(response, "/auth");
    return;
  }

  if (url.pathname === "/assinatura") {
    redirect(response, `/assinaturas${url.search}`);
    return;
  }

  const appRoutes = new Set(["/auth", "/assinaturas", "/dashboard", "/identidadefake"]);
  const protectedAppRoutes = new Set(["/assinaturas", "/dashboard", "/identidadefake"]);
  const paidAppRoutes = new Set(["/dashboard", "/identidadefake"]);

  if (protectedAppRoutes.has(url.pathname)) {
    const user = await getUserFromRequest(request);
    if (!user) {
      redirect(response, "/auth");
      return;
    }
    if (paidAppRoutes.has(url.pathname) && !hasProductAccess(user)) {
      redirect(response, "/assinaturas");
      return;
    }
    if (url.pathname === "/assinaturas" && hasProductAccess(user) && url.searchParams.get("preview") !== "1") {
      redirect(response, "/dashboard");
      return;
    }
  }

  if (url.pathname === "/auth") {
    const user = await getUserFromRequest(request);
    if (user) {
      redirect(response, hasProductAccess(user) ? "/dashboard" : "/assinaturas");
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
