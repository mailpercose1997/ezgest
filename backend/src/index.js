import { MongoClient, ObjectId } from 'mongodb';
import { signJWT, verifyJWT } from './auth.js';
import { RateLimiter } from './rateLimiterDO.js';

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\\\]\\]/g, '\\$&');
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    request.headers.get("X-Real-IP") ||
    "unknown"
  );
}

async function rateLimitDO(env, { key, limit, windowMs }) {
  const id = env.RATE_LIMITER.idFromName("global");
  const stub = env.RATE_LIMITER.get(id);
  const res = await stub.fetch("http://rate-limiter/limit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, limit, windowMs }),
  });
  if (!res.ok) return { ok: true };
  return await res.json();
}

// --- Index management (best-effort per isolate) ---
let _indexesEnsured = false;
let _ensureIndexesPromise = null;
async function ensureIndexes(db) {
  if (_indexesEnsured) return;
  if (_ensureIndexesPromise) return _ensureIndexesPromise;
  _ensureIndexesPromise = (async () => {
    try {
      // Core query patterns:
      // - sales by company/date
      // - products by company + soft-delete flag
      // - categories by company
      await Promise.allSettled([
        db.collection("sales").createIndex({ companyId: 1, createdAt: -1 }),
        db.collection("products").createIndex({ companyId: 1, deletedAt: 1 }),
        db.collection("categories").createIndex({ companyId: 1 }),
        db.collection("companies").createIndex({ inviteCode: 1 }, { unique: true }),
        db.collection("users").createIndex({ email: 1 }, { unique: true }),
      ]);
      _indexesEnsured = true;
    } catch (e) {
      // Non-blocking: indexes can be created manually if needed.
      console.warn("Index creation skipped/failed:", e?.message || e);
    }
  })();
  return _ensureIndexesPromise;
}

// --- CRYPTO UTILS (Native Web Crypto API) ---

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: enc.encode(salt),
    iterations: 100000,
    hash: "SHA-256"
  }, keyMaterial, 256);
  return [...new Uint8Array(derivedBits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let client; // Definiamo il client qui per averlo a disposizione nel blocco finally
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Helper per risposte JSON coerenti (spostato fuori dal try per usarlo anche nel catch)
    const resJson = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      // Endpoint di health-check / root (nessuna auth richiesta)
      if (url.pathname === "/" && request.method === "GET") {
        return new Response("EzGest API OK", {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // Evita 401 inutili per /favicon.ico
      if (url.pathname === "/favicon.ico" && request.method === "GET") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Stabiliamo una nuova connessione per ogni richiesta per evitare "hang" dovuti a connessioni stale.
      client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }); // Aggiunto timeout
      await client.connect();
      const db = client.db(env.DB_NAME || "EzGest");
      await ensureIndexes(db);

      // --- AUTH & AZIENDE ---
      if (url.pathname === "/api/login" && request.method === "POST") {
        const ip = getClientIp(request);
        const rl = await rateLimitDO(env, { key: `login:${ip}`, limit: 10, windowMs: 60_000 });
        if (!rl.ok) return resJson({ success: false, message: "Troppi tentativi. Riprova tra poco." }, 429);
        const { email, password } = await request.json();
        const user = await db.collection("users").findOne({ email });
        if (!user || !user.salt) return resJson({ success: false, message: "Credenziali errate" });
        
        const inputHash = await hashPassword(password, user.salt);
        if (inputHash !== user.password) return resJson({ success: false, message: "Credenziali errate" });
        
        const token = await signJWT({ email: user.email, nome: user.nome, cognome: user.cognome, id: user._id }, env.JWT_SECRET);
        return resJson({ success: true, user, token });
      }

      if (url.pathname === "/api/register" && request.method === "POST") {
        const ip = getClientIp(request);
        const rl = await rateLimitDO(env, { key: `register:${ip}`, limit: 5, windowMs: 60_000 });
        if (!rl.ok) return resJson({ success: false, message: "Troppi tentativi. Riprova tra poco." }, 429);
        const { nome, cognome, dob, email, password } = await request.json();
        
        if (!nome || !cognome) return resJson({ success: false, message: "Nome e Cognome richiesti" });
        if (!dob) return resJson({ success: false, message: "Data di nascita richiesta" });
        if (!email || !email.includes('@')) return resJson({ success: false, message: "Email non valida" });
        if (!password || password.length < 6) return resJson({ success: false, message: "Password min 6 caratteri" });

        const exists = await db.collection("users").findOne({ email });
        if (exists) return resJson({ success: false, message: "Email già registrata" });
        
        const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
        const passwordHash = await hashPassword(password, salt);
        await db.collection("users").insertOne({ 
          nome, cognome, dob, email, 
          password: passwordHash, salt, 
          companies: [], createdAt: new Date() 
        });
        return resJson({ success: true });
      }

      // --- MIDDLEWARE AUTH CHECK ---
      // Tutte le rotte sotto richiedono un token valido
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) return resJson({ success: false, message: "Unauthorized" }, 401);
      const token = authHeader.split(" ")[1];
      const userPayload = await verifyJWT(token, env.JWT_SECRET);
      if (!userPayload) return resJson({ success: false, message: "Unauthorized" }, 401);

      if (url.pathname === "/api/user/companies" && request.method === "GET") {
        const email = userPayload.email;
        const user = await db.collection("users").findOne({ email });
        if (!user || !user.companies || !Array.isArray(user.companies)) return resJson([]);
        
        // Conversione sicura degli ID per evitare crash/hang se un ID è invalido
        const companyIds = user.companies
          .map(id => { try { return new ObjectId(id); } catch (e) { return null; } })
          .filter(id => id !== null);

        const companies = await db.collection("companies").find({ 
          _id: { $in: companyIds } 
        }).toArray();
        return resJson(companies);
      }

      if (url.pathname === "/api/azienda/crea" && request.method === "POST") {
        const { companyName } = await request.json();
        if (!companyName) return resJson({ success: false, message: "Nome azienda richiesto" }, 400);
        const newCompany = { 
          name: companyName, 
          inviteCode: Math.random().toString(36).substring(2, 8).toUpperCase(), 
          owner: userPayload.email 
        };
        const result = await db.collection("companies").insertOne(newCompany);
        await db.collection("users").updateOne({ email: userPayload.email }, { $addToSet: { companies: result.insertedId.toString() } });
        return resJson({ success: true, company: { ...newCompany, _id: result.insertedId } });
      }

      if (url.pathname === "/api/azienda/unisciti" && request.method === "POST") {
        const { inviteCode } = await request.json();
        const co = await db.collection("companies").findOne({ inviteCode });
        if(!co) return resJson({ success: false, message: "Codice Errato" }, 400);
        await db.collection("users").updateOne({ email: userPayload.email }, { $addToSet: { companies: co._id.toString() } });
        return resJson({ success: true });
      }

      // --- LOGICA CORE (Richiedono companyId) ---
      const companyId = url.searchParams.get("companyId");
      const id = url.searchParams.get("id");

      // --- MIDDLEWARE AUTHORIZATION CHECK ---
      // Se la richiesta specifica un companyId, verifica che l'utente ne faccia parte
      if (companyId) {
        if (!ObjectId.isValid(companyId)) return resJson({ success: false, message: "Invalid Company ID" }, 400);
        const user = await db.collection("users").findOne({ email: userPayload.email });
        // Verifica se l'array companies dell'utente contiene l'ID richiesto
        if (!user || !user.companies || !user.companies.includes(companyId)) {
          return resJson({ success: false, message: "Forbidden: Accesso negato a questa azienda" }, 403);
        }
      }

      if (url.pathname === "/api/categorie") {
        if (request.method === "GET") return resJson(await db.collection("categories").find({ companyId }).toArray());
        if (request.method === "POST") {
          const body = await request.json();
          await db.collection("categories").insertOne({ ...body, companyId });
          return resJson({ success: true });
        }
        if (request.method === "PUT") {
          if (!id || !ObjectId.isValid(id)) return resJson({ success: false, message: "ID non valido" }, 400);
          const { nome } = await request.json();
          // FIX SICUREZZA: Aggiunto companyId al filtro per evitare modifiche tra aziende diverse
          const result = await db.collection("categories").updateOne({ _id: new ObjectId(id), companyId }, { $set: { nome } });
          if (result.matchedCount === 0) return resJson({ success: false, message: "Categoria non trovata" }, 404);
          return resJson({ success: true });
        }
        if (request.method === "DELETE") {
          if (!id || !ObjectId.isValid(id)) return resJson({ success: false, message: "ID non valido" }, 400);
          const result = await db.collection("categories").deleteOne({ _id: new ObjectId(id), companyId });
          if (result.deletedCount === 0) return resJson({ success: false, message: "Categoria non trovata" }, 404);
          return resJson({ success: true });
        }
      }

      if (url.pathname === "/api/prodotti") {
        if (request.method === "GET") {
          const page = parseInt(url.searchParams.get("page")) || 1;
          const limit = parseInt(url.searchParams.get("limit")) || 50;
          const skip = (page - 1) * limit;
          const search = url.searchParams.get("search");
          const query = { companyId, deletedAt: { $exists: false } }; // Soft Delete: Escludi eliminati
          if (search) query.nome = { $regex: escapeRegex(search), $options: 'i' }; // Security: Escape regex
          return resJson(await db.collection("products").find(query).skip(skip).limit(limit).toArray());
        }
        if (request.method === "POST") {
          const body = await request.json();
          await db.collection("products").insertOne({ ...body, companyId });
          return resJson({ success: true });
        }
        if (request.method === "PUT") {
          if (!id || !ObjectId.isValid(id)) return resJson({ success: false, message: "ID non valido" }, 400);
          const data = await request.json();
          delete data._id;
          // FIX SICUREZZA: Aggiunto companyId al filtro
          const result = await db.collection("products").updateOne({ _id: new ObjectId(id), companyId, deletedAt: { $exists: false } }, { $set: data });
          if (result.matchedCount === 0) return resJson({ success: false, message: "Prodotto non trovato" }, 404);
          return resJson({ success: true });
        }
        if (request.method === "DELETE") {
          if (!id || !ObjectId.isValid(id)) return resJson({ success: false, message: "ID non valido" }, 400);
          // Soft Delete: Imposta deletedAt invece di cancellare
          const result = await db.collection("products").updateOne({ _id: new ObjectId(id), companyId }, { $set: { deletedAt: new Date() } });
          if (result.matchedCount === 0) return resJson({ success: false, message: "Prodotto non trovato" }, 404);
          return resJson({ success: true });
        }
      }

      if (url.pathname === "/api/vendite") {
        if (request.method === "GET") {
          const date = url.searchParams.get("date"); // YYYY-MM-DD (usato dallo storico nel frontend)
          const query = { companyId };
          if (date) {
            const start = new Date(date + "T00:00:00.000Z");
            const end = new Date(date + "T23:59:59.999Z");
            if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
              query.createdAt = { $gte: start, $lte: end };
            }
          }
          return resJson(await db.collection("sales").find(query).sort({ createdAt: -1 }).toArray());
        }
        if (request.method === "POST") {
          const body = await request.json();
          // Miglioramento: Convertiamo i prezzi in numeri per performance e pulizia dati
          if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
             return resJson({ success: false, message: "Il carrello è vuoto" }, 400);
          }

          if (body.items && Array.isArray(body.items)) {
            body.items = body.items.map(i => ({
              ...i,
              prezzo: parseFloat(i.prezzo) || 0,
              qty: Number.isFinite(i.qty) && i.qty > 0 ? i.qty : 1
            }));
          }
          await db.collection("sales").insertOne({ ...body, companyId, createdAt: new Date() });
          return resJson({ success: true });
        }
      }

      if (url.pathname === "/api/reports") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const category = url.searchParams.get("category");
        const product = url.searchParams.get("product");

        // Ottimizzazione: Prepariamo i filtri prodotto PRIMA della pipeline
        const itemMatch = {};
        if (category && category !== 'TUTTI') itemMatch["items.categoria"] = category;
        if (product && product !== 'TUTTI') itemMatch["items.nome"] = product;

        // Applichiamo i filtri anche al primo match per ridurre i documenti da processare (Performance Boost)
        const matchStage = { companyId, ...itemMatch };

        if (from || to) {
          matchStage.createdAt = {};
          if (from) matchStage.createdAt.$gte = new Date(from);
          if (to) matchStage.createdAt.$lte = new Date(to + 'T23:59:59.999Z');
        } else {
          // Default: Ultimi 7 giorni
          const d = new Date();
          d.setDate(d.getDate() - 7);
          d.setHours(0, 0, 0, 0);
          matchStage.createdAt = { $gte: d };
        }

        const pipeline = [
          { $match: matchStage },
          { $unwind: "$items" }
        ];

        if (Object.keys(itemMatch).length > 0) pipeline.push({ $match: itemMatch });

        pipeline.push({
          $addFields: {
            qtyVal: {
              $cond: [
                { $and: [ { $ne: ["$items.qty", null] }, { $gt: ["$items.qty", 0] } ] },
                "$items.qty",
                1
              ]
            }
          }
        });

        pipeline.push({ $addFields: { priceVal: { $multiply: [ { $toDouble: "$items.prezzo" }, "$qtyVal" ] } } });

        pipeline.push({
          $facet: {
            "totals": [
              { $group: { _id: null, totalRevenue: { $sum: "$priceVal" } } }
            ],
            "receiptsCount": [
              { $group: { _id: "$_id" } },
              { $count: "count" }
            ],
            "trend": [
              { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, dailyTotal: { $sum: "$priceVal" } } },
              { $sort: { _id: 1 } }
            ],
            "trendBreakdown": [
              { $group: { _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, p: "$items.nome" }, dailyTotal: { $sum: "$priceVal" } } },
              { $sort: { "_id.d": 1 } }
            ],
            "hourly": [
              { $group: { _id: { $hour: "$createdAt" }, count: { $sum: "$qtyVal" } } }, // Conta quantità vendute per ora
              { $sort: { _id: 1 } }
            ],
            "byCategory": [ { $group: { _id: "$items.categoria", total: { $sum: "$priceVal" } } } ],
            "topProducts": [
              { $group: { _id: "$items.nome", q: { $sum: "$qtyVal" }, t: { $sum: "$priceVal" } } },
              { $sort: { q: -1 } }, { $limit: 5 }
            ]
          }
        });

        const results = await db.collection("sales").aggregate(pipeline).toArray();
        return resJson(results[0]);
      }

      return resJson({ success: false, message: "Not Found" }, 404);
    } catch (e) {
      console.error("Server Error:", e); // Logga l'errore nella console di Wrangler
      return resJson({ success: false, message: e.message || "Errore interno del server" }, 500);
    } finally {
      // Assicuriamoci di chiudere la connessione in ogni caso per liberare le risorse.
      if (client) {
        await client.close();
      }
    }
  }
};

export { RateLimiter };