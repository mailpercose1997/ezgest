import { MongoClient, ObjectId } from 'mongodb';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const client = new MongoClient(env.MONGODB_URI);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      await client.connect();
      const db = client.db("EzGest");
      const resJson = (d) => new Response(JSON.stringify(d), { headers: corsHeaders });

      // --- AZIENDE ---
      if (url.pathname === "/api/user/companies" && request.method === "GET") {
        const username = url.searchParams.get("username");
        const user = await db.collection("users").findOne({ username });
        if (!user || !user.companies) return resJson([]);
        // Convertiamo gli ID stringa in ObjectId per la query
        const companies = await db.collection("companies").find({ 
          _id: { $in: user.companies.map(id => new ObjectId(id)) } 
        }).toArray();
        return resJson(companies);
      }

      if (url.pathname === "/api/azienda/crea" && request.method === "POST") {
        const { companyName, ownerUsername } = await request.json();
        const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const result = await db.collection("companies").insertOne({ 
          name: companyName, 
          inviteCode, 
          owner: ownerUsername 
        });
        // Salviamo l'ID come stringa nell'array dell'utente per semplicità
        await db.collection("users").updateOne(
          { username: ownerUsername }, 
          { $addToSet: { companies: result.insertedId.toString() } }
        );
        return resJson({ success: true });
      }

      // --- CATEGORIE ---
      if (url.pathname === "/api/categorie") {
        const companyId = url.searchParams.get("companyId");
        if (request.method === "GET") {
          return resJson(await db.collection("categories").find({ companyId }).toArray());
        }
        if (request.method === "POST") {
          const body = await request.json();
          await db.collection("categories").insertOne({ ...body, companyId });
          return resJson({ success: true });
        }
        if (request.method === "PUT") {
          const id = url.searchParams.get("id");
          const { nome } = await request.json();
          await db.collection("categories").updateOne({ _id: new ObjectId(id) }, { $set: { nome } });
          return resJson({ success: true });
        }
        if (request.method === "DELETE") {
          await db.collection("categories").deleteOne({ _id: new ObjectId(url.searchParams.get("id")) });
          return resJson({ success: true });
        }
      }

      // --- PRODOTTI ---
      if (url.pathname === "/api/prodotti") {
        const companyId = url.searchParams.get("companyId");
        if (request.method === "GET") {
          return resJson(await db.collection("products").find({ companyId }).toArray());
        }
        if (request.method === "POST") {
          const body = await request.json();
          await db.collection("products").insertOne({ ...body, companyId });
          return resJson({ success: true });
        }
        if (request.method === "PUT") {
          const id = url.searchParams.get("id");
          const data = await request.json();
          delete data._id; // Protezione: non sovrascrivere l'ID
          await db.collection("products").updateOne({ _id: new ObjectId(id) }, { $set: data });
          return resJson({ success: true });
        }
        if (request.method === "DELETE") {
          await db.collection("products").deleteOne({ _id: new ObjectId(url.searchParams.get("id")) });
          return resJson({ success: true });
        }
      }

      // Fallback per Login
      if (url.pathname === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const user = await db.collection("users").findOne({ username, password });
        return resJson({ success: !!user, user });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    } finally {
      await client.close();
    }
  }
};