import { MongoClient, ObjectId } from 'mongodb';

// --- CRYPTO UTILS (Native Web Crypto API) ---

async function hashPassword(password, salt) {
  const msgBuffer = new TextEncoder().encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 86400000 })); // 24h
  const unsignedToken = `${header}.${body}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsignedToken));
  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsignedToken}.${signatureBase64}`;
}

async function verifyJWT(request, secret) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) return null;
  
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signatureBin = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const isValid = await crypto.subtle.verify("HMAC", key, signatureBin, new TextEncoder().encode(`${header}.${body}`));
  
  if (!isValid) return null;
  const payload = JSON.parse(atob(body));
  if (Date.now() > payload.exp) return null;
  return payload;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let client; // Definiamo il client qui per averlo a disposizione nel blocco finally
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      // Stabiliamo una nuova connessione per ogni richiesta per evitare "hang" dovuti a connessioni stale.
      client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }); // Aggiunto timeout
      await client.connect();
      const db = client.db("EzGest");
      const resJson = (d) => new Response(JSON.stringify(d), { headers: corsHeaders });

      // --- AUTH & AZIENDE ---
      if (url.pathname === "/api/login" && request.method === "POST") {
        const { email, password } = await request.json();
        const user = await db.collection("users").findOne({ email });
        if (!user || !user.salt) return resJson({ success: false, message: "Credenziali errate" });
        
        const inputHash = await hashPassword(password, user.salt);
        if (inputHash !== user.password) return resJson({ success: false, message: "Credenziali errate" });
        
        const token = await signJWT({ email: user.email, nome: user.nome, cognome: user.cognome, id: user._id }, env.JWT_SECRET);
        return resJson({ success: true, user, token });
      }

      if (url.pathname === "/api/register" && request.method === "POST") {
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
      const userPayload = await verifyJWT(request, env.JWT_SECRET);
      if (!userPayload) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

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
        const result = await db.collection("companies").insertOne({ 
          name: companyName, 
          inviteCode: Math.random().toString(36).substring(2, 8).toUpperCase(), 
          owner: userPayload.email 
        });
        await db.collection("users").updateOne({ email: userPayload.email }, { $addToSet: { companies: result.insertedId.toString() } });
        return resJson({ success: true });
      }

      if (url.pathname === "/api/azienda/unisciti" && request.method === "POST") {
        const { inviteCode } = await request.json();
        const co = await db.collection("companies").findOne({ inviteCode });
        if(!co) return new Response("Codice Errato", { status: 400, headers: corsHeaders });
        await db.collection("users").updateOne({ email: userPayload.email }, { $addToSet: { companies: co._id.toString() } });
        return resJson({ success: true });
      }

      // --- LOGICA CORE (Richiedono companyId) ---
      const companyId = url.searchParams.get("companyId");
      const id = url.searchParams.get("id");

      // --- MIDDLEWARE AUTHORIZATION CHECK ---
      // Se la richiesta specifica un companyId, verifica che l'utente ne faccia parte
      if (companyId) {
        const user = await db.collection("users").findOne({ email: userPayload.email });
        // Verifica se l'array companies dell'utente contiene l'ID richiesto
        if (!user || !user.companies || !user.companies.includes(companyId)) {
          return new Response("Forbidden: Accesso negato a questa azienda", { status: 403, headers: corsHeaders });
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
          const { nome } = await request.json();
          await db.collection("categories").updateOne({ _id: new ObjectId(id) }, { $set: { nome } });
          return resJson({ success: true });
        }
        if (request.method === "DELETE") {
          await db.collection("categories").deleteOne({ _id: new ObjectId(id) });
          return resJson({ success: true });
        }
      }

      if (url.pathname === "/api/prodotti") {
        if (request.method === "GET") return resJson(await db.collection("products").find({ companyId }).toArray());
        if (request.method === "POST") {
          const body = await request.json();
          await db.collection("products").insertOne({ ...body, companyId });
          return resJson({ success: true });
        }
        if (request.method === "PUT") {
          const data = await request.json();
          delete data._id;
          await db.collection("products").updateOne({ _id: new ObjectId(id) }, { $set: data });
          return resJson({ success: true });
        }
        if (request.method === "DELETE") {
          await db.collection("products").deleteOne({ _id: new ObjectId(id) });
          return resJson({ success: true });
        }
      }

      if (url.pathname === "/api/vendite") {
        if (request.method === "GET") return resJson(await db.collection("sales").find({ companyId }).sort({ createdAt: -1 }).toArray());
        if (request.method === "POST") {
          const body = await request.json();
          await db.collection("sales").insertOne({ ...body, companyId, createdAt: new Date() });
          return resJson({ success: true });
        }
      }

      if (url.pathname === "/api/reports") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const category = url.searchParams.get("category");
        const product = url.searchParams.get("product");

        const matchStage = { companyId };
        if (from || to) {
          matchStage.createdAt = {};
          if (from) matchStage.createdAt.$gte = new Date(from);
          if (to) matchStage.createdAt.$lte = new Date(to + 'T23:59:59.999Z');
        }

        const pipeline = [
          { $match: matchStage },
          { $unwind: "$items" }
        ];

        const itemMatch = {};
        if (category && category !== 'TUTTI') itemMatch["items.categoria"] = category;
        if (product && product !== 'TUTTI') itemMatch["items.nome"] = product;
        
        if (Object.keys(itemMatch).length > 0) pipeline.push({ $match: itemMatch });

        pipeline.push({ $addFields: { priceVal: { $toDouble: "$items.prezzo" } } });

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
              { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } }, // Conta oggetti venduti per ora come proxy di attività
              { $sort: { _id: 1 } }
            ],
            "byCategory": [ { $group: { _id: "$items.categoria", total: { $sum: "$priceVal" } } } ],
            "topProducts": [
              { $group: { _id: "$items.nome", q: { $sum: 1 }, t: { $sum: "$priceVal" } } },
              { $sort: { q: -1 } }, { $limit: 5 }
            ]
          }
        });

        const results = await db.collection("sales").aggregate(pipeline).toArray();
        return resJson(results[0]);
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return new Response(e.message, { status: 500, headers: corsHeaders });
    } finally {
      // Assicuriamoci di chiudere la connessione in ogni caso per liberare le risorse.
      if (client) {
        await client.close();
      }
    }
  }
};