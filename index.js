import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.set("trust proxy", 1);

// WEBHOOK VERIFICACION WHATSAPP
app.get("/webhook", (req, res) => {
  const verify_token = "rifa_verify_token";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY;
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET;
const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function genReference() {
  return "ord_" + crypto.randomBytes(8).toString("hex");
}

function now() {
  return new Date().toISOString();
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

app.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("rifa_publica")
      .select("*");

    if (error) throw error;

    res.json({
      ok: true,
      rifas: data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("rifas")
      .select("id")
      .limit(1);

    if (error) throw error;

    res.json({
      ok: true,
      status: "healthy",
      at: now(),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

app.get("/debug/wompi", (req, res) => {
  res.json({
    ok: true,
    env: WOMPI_PUBLIC_KEY?.startsWith("pub_test_") ? "sandbox" : "production",
    pub_prefix: WOMPI_PUBLIC_KEY?.slice(0, 9),
    prv_prefix: WOMPI_PRIVATE_KEY?.slice(0, 9),
    integrity_len: WOMPI_INTEGRITY_SECRET?.length,
    missing: {
      SUPABASE_URL: !SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !SUPABASE_SERVICE_ROLE_KEY,
      WOMPI_PUBLIC_KEY: !WOMPI_PUBLIC_KEY,
      WOMPI_PRIVATE_KEY: !WOMPI_PRIVATE_KEY,
      WOMPI_INTEGRITY_SECRET: !WOMPI_INTEGRITY_SECRET,
      WOMPI_EVENTS_SECRET: !WOMPI_EVENTS_SECRET,
    },
  });
});

app.get("/rifas/:rifaId", async (req, res) => {
  try {
    const { rifaId } = req.params;

    const { data, error } = await supabase
      .from("rifa_publica_detalle")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      rifa: data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/comprar-directo/:rifaId", async (req, res) => {
  try {
    const { rifaId } = req.params;

    const buyerName = (req.query.buyer_name || "").toString().trim();
    const buyerPhone = (req.query.buyer_phone || "").toString().trim();
    const buyerEmail = (req.query.buyer_email || "").toString().trim();
    const qty = Number(req.query.qty || 1);

    if (!buyerName || !buyerPhone) {
      return res.status(400).send("Faltan buyer_name o buyer_phone");
    }

    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).send("qty inválido");
    }

    const { data: rifa, error: rifaError } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (rifaError || !rifa) {
      return res.status(404).send("Rifa no existe");
    }

    const total = qty * Number(rifa.price_per_ticket);
    const commission = total * 0.03;

    let buyer = null;

    const { data: existingBuyer, error: existingBuyerError } = await supabase
      .from("buyers")
      .select("*")
      .eq("phone", buyerPhone)
      .maybeSingle();

    if (existingBuyerError) throw existingBuyerError;

    if (existingBuyer) {
      buyer = existingBuyer;
    } else {
      const { data: newBuyer, error: newBuyerError } = await supabase
        .from("buyers")
        .insert({
          full_name: buyerName,
          phone: buyerPhone,
          email: buyerEmail || null,
        })
        .select()
        .single();

      if (newBuyerError) throw newBuyerError;
      buyer = newBuyer;
    }

    const reference = genReference();

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        rifa_id: rifaId,
        buyer_id: buyer.id,
        qty,
        subtotal: total,
        total_paid: total,
        commission,
        payment_status: "created",
      })
      .select()
      .single();

    if (orderError) throw orderError;

    const { error: paymentInsertError } = await supabase
      .from("payments")
      .insert({
        order_id: order.id,
        provider: "wompi",
        external_reference: reference,
        amount: total,
        status: "CREATED",
      });

    if (paymentInsertError) throw paymentInsertError;

    const base = getBaseUrl(req);
    const pagarUrl = `${base}/rifas/${rifaId}/orden/${order.id}/pagar?reference=${reference}`;

    return res.redirect(pagarUrl);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/crear-rifa", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Crear rifa</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
  <div style="max-width:760px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
    <h1 style="margin-top:0;">Crear rifa</h1>

    <form method="POST" action="/crear-rifa">
      <div style="margin-bottom:12px;">
        <label><b>Nombre de la rifa</b></label><br/>
        <input type="text" name="title" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Premio</b></label><br/>
        <input type="text" name="prize" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Descripción</b></label><br/>
        <textarea name="description"
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;min-height:100px;"></textarea>
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Modalidad</b></label><br/>
        <select name="modality"
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;">
          <option value="2">2 balotas</option>
          <option value="3" selected>3 balotas</option>
          <option value="4">4 balotas</option>
          <option value="5">5 balotas</option>
        </select>
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Precio por boleta</b></label><br/>
        <input type="number" name="price_per_ticket" min="1" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Máximo de boletas</b></label><br/>
        <input type="number" name="max_tickets" min="1" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:18px;">
        <label><b>Fecha del sorteo</b></label><br/>
        <input type="datetime-local" name="draw_date" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <button type="submit"
        style="background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;width:100%;">
        Crear rifa
      </button>
    </form>
  </div>
</body>
</html>
  `);
});

app.post("/crear-rifa", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const ownerId = (process.env.DEFAULT_OWNER_ID || "").trim();
    const title = String(req.body.title || "").trim();
    const prize = String(req.body.prize || "").trim();
    const description = String(req.body.description || "").trim();
    const modality = Number(req.body.modality || 3);
    const pricePerTicket = Number(req.body.price_per_ticket || 0);
    const maxTickets = Number(req.body.max_tickets || 0);
    const drawDateRaw = String(req.body.draw_date || "").trim();

    if (!ownerId) {
      return res.status(500).send("Falta DEFAULT_OWNER_ID en Railway");
    }

    if (!title || !prize || !drawDateRaw) {
      return res.status(400).send("Faltan campos obligatorios");
    }

    if (![2, 3, 4, 5].includes(modality)) {
      return res.status(400).send("Modalidad inválida");
    }

    if (!Number.isFinite(pricePerTicket) || pricePerTicket <= 0) {
      return res.status(400).send("Precio inválido");
    }

    if (!Number.isInteger(maxTickets) || maxTickets <= 0) {
      return res.status(400).send("Máximo de boletas inválido");
    }

    const drawDate = new Date(drawDateRaw);
    if (Number.isNaN(drawDate.getTime())) {
      return res.status(400).send("Fecha inválida");
    }

    let slug = slugify(title);
    if (!slug) slug = `rifa-${Date.now()}`;

    const { data: existingSlug } = await supabase
      .from("rifas")
      .select("id, slug")
      .eq("slug", slug)
      .maybeSingle();

    if (existingSlug) {
      slug = `${slug}-${Date.now().toString().slice(-6)}`;
    }

    const { data: rifa, error } = await supabase
      .from("rifas")
      .insert({
        owner_id: ownerId,
        title,
        prize,
        description,
        modality,
        price_per_ticket: pricePerTicket,
        max_tickets: maxTickets,
        sold_tickets: 0,
        available_tickets: maxTickets,
        draw_date: drawDate.toISOString(),
        status: "active",
        slug,
      })
      .select()
      .single();

    if (error) throw error;

    const base = getBaseUrl(req);
    return res.redirect(`${base}/rifa/${rifa.slug}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.post("/registro", express.urlencoded({ extended: true }), async (req, res) => {
  const { email, password, name } = req.body;

  const { error } = await supabase
    .from("users")
    .insert({
      email,
      password,
      name,
    });

  if (error) {
    return res.send("Error creando usuario");
  }

  res.send("Usuario creado");
});

app.post("/login", express.urlencoded({ extended: true }), async (req, res) => {
  const { email, password } = req.body;

  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .eq("password", password)
    .single();

  if (!data) {
    return res.send("Usuario o contraseña incorrectos");
  }

  res.redirect("/panel");
});

app.get("/panel", async (req, res) => {
  try {
    const { data: rifas, error } = await supabase
      .from("rifas")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
const totalRecaudadoGeneral = (rifas || []).reduce((acc, r) => {
  const vendidos = Number(r.sold_tickets || 0);
  const precio = Number(r.price_per_ticket || 0);
  return acc + (vendidos * precio);
}, 0);

const totalComisionGeneral = await supabase
  .from("orders")
  .select("commission, payment_status");

const comisionGeneral = (totalComisionGeneral.data || []).reduce((acc, o) => {
  if (o.payment_status === "paid") {
    return acc + Number(o.commission || 0);
  }
  return acc;
}, 0);
    const base = getBaseUrl(req);

    const rows = (rifas || []).map((r) => {
      const linkPublico = r.slug
        ? `${base}/rifa/${r.slug}`
        : `${base}/rifa-publica/${r.id}`;

      return `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${r.title || ""}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${r.prize || ""}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.modality || ""}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;">$${Number(r.price_per_ticket || 0).toLocaleString("es-CO")}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.max_tickets || 0}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.sold_tickets || 0}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.available_tickets || 0}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.status || ""}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">
            <a href="${base}/panel/rifa/${r.id}" style="color:#2563eb;text-decoration:none;font-weight:700;">Ver panel</a>
            <br/>
            <a href="${linkPublico}" target="_blank" style="color:#16a34a;text-decoration:none;font-weight:700;">Abrir rifa</a>
          </td>
        </tr>
      `;
    }).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Panel de rifas</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f4f7fb;color:#111;">
  <div style="max-width:1200px;margin:30px auto;padding:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
      <div>
        <h1 style="margin:0;">Panel de rifas</h1>
        <div style="margin-top:6px;color:#64748b;">Resumen general de rifas creadas</div>
      </div>

      <a href="${base}/crear-rifa"
         style="background:#16a34a;color:white;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700;">
        + Crear rifa
      </a>
    </div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:18px;">
  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);">
    <div style="font-size:13px;color:#64748b;">Recaudado total</div>
    <div style="font-size:30px;font-weight:800;margin-top:8px;">
      $${Number(totalRecaudadoGeneral).toLocaleString("es-CO")}
    </div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);border:1px solid #fde68a;">
    <div style="font-size:13px;color:#92400e;">Tus comisiones</div>
    <div style="font-size:30px;font-weight:800;margin-top:8px;color:#b45309;">
      $${Number(comisionGeneral).toLocaleString("es-CO")}
    </div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);">
    <div style="font-size:13px;color:#64748b;">Rifas creadas</div>
    <div style="font-size:30px;font-weight:800;margin-top:8px;">
      ${(rifas || []).length}
    </div>
  </div>
</div>
    <div style="background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);overflow:auto;">
      <table style="width:100%;border-collapse:collapse;min-width:1000px;">
        <thead style="background:#0f172a;color:white;">
          <tr>
            <th style="padding:14px;text-align:left;">Rifa</th>
            <th style="padding:14px;text-align:left;">Premio</th>
            <th style="padding:14px;text-align:center;">Modalidad</th>
            <th style="padding:14px;text-align:right;">Precio</th>
            <th style="padding:14px;text-align:center;">Máx.</th>
            <th style="padding:14px;text-align:center;">Vendidas</th>
            <th style="padding:14px;text-align:center;">Disponibles</th>
            <th style="padding:14px;text-align:center;">Estado</th>
            <th style="padding:14px;text-align:left;">Link</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="9" style="padding:18px;">No hay rifas creadas todavía.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
    `);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/panel/rifa/:rifaId", async (req, res) => {
  try {
    const { rifaId } = req.params;

    const { data: rifa, error: rifaError } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (rifaError || !rifa) {
      return res.status(404).send("Rifa no encontrada");
    }

    const { data: lastResult } = await supabase
      .from("raffle_results")
      .select(`
        *,
        buyers:winner_buyer_id (
          full_name,
          phone
        )
      `)
      .eq("rifa_id", rifaId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select(`
        *,
        buyers (*)
      `)
      .eq("rifa_id", rifaId)
      .order("created_at", { ascending: false });

    if (ordersError) throw ordersError;

    const orderIds = (orders || []).map((o) => o.id);

    let tickets = [];
    if (orderIds.length > 0) {
      const { data: ticketRows, error: ticketsError } = await supabase
        .from("tickets")
        .select("*")
        .in("order_id", orderIds);

      if (ticketsError) throw ticketsError;
      tickets = ticketRows || [];
    }

    const ticketsByOrder = {};
    for (const t of tickets) {
      if (!ticketsByOrder[t.order_id]) ticketsByOrder[t.order_id] = [];
      ticketsByOrder[t.order_id].push(t.combination);
    }

    const totalRecaudado = (orders || []).reduce((acc, o) => {
      if (o.payment_status === "paid") {
        return acc + Number(o.total_paid || 0);
      }
      return acc;
    }, 0);
const totalComision = (orders || []).reduce((acc, o) => {
  if (o.payment_status === "paid") {
    return acc + Number(o.commission || 0);
  }
  return acc;
}, 0);

const totalOrganizador = totalRecaudado - totalComision;
    const rows = (orders || []).map((o) => {
      const combinaciones = ticketsByOrder[o.id] || [];
      const buyerName = o.buyers?.full_name || "Sin nombre";
      const buyerPhone = o.buyers?.phone || "Sin teléfono";

      return `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${buyerName}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${buyerPhone}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${o.qty || 0}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;">$${Number(o.total_paid || 0).toLocaleString("es-CO")}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${o.payment_status || ""}</td>
          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${combinaciones.length ? combinaciones.join("<br/>") : "-"}</td>
        </tr>
      `;
    }).join("");

    const base = getBaseUrl(req);
    const linkPublico = rifa.slug
      ? `${base}/rifa/${rifa.slug}`
      : `${base}/rifa-publica/${rifa.id}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Panel de rifa</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f4f7fb;color:#111;">
  <div style="max-width:1200px;margin:30px auto;padding:16px;">

    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px;">
      <div>
        <a href="${base}/panel" style="display:inline-block;margin-bottom:10px;color:#2563eb;text-decoration:none;font-weight:700;">← Volver al panel</a>
        <h1 style="margin:0;">${rifa.title}</h1>
        <div style="margin-top:6px;color:#475569;">Premio: <b>${rifa.prize || ""}</b></div>
        <div style="margin-top:6px;color:#475569;">Estado: <b>${rifa.status || ""}</b></div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <a href="${linkPublico}" target="_blank" style="background:#2563eb;color:white;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700;">
          Abrir rifa pública
        </a>
      </div>
    </div>

    <div style="background:#fff;border-radius:16px;box-shadow:0 10px 24px rgba(0,0,0,.06);padding:18px;margin-bottom:18px;">
      <h2 style="margin-top:0;">Realizar sorteo</h2>
      <form method="POST" action="${base}/panel/rifa/${rifa.id}/sorteo">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;">
          <div style="flex:1;min-width:240px;">
            <label style="display:block;font-size:14px;font-weight:700;margin-bottom:6px;">Combinación ganadora</label>
            <input
              type="text"
              name="winning_combination"
              placeholder="Ej: 12-40-41"
              required
              style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;font-size:15px;"
            />
          </div>

          <button
            type="submit"
            style="background:#dc2626;color:#fff;border:none;padding:12px 18px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;"
          >
            Realizar sorteo
          </button>
        </div>
      </form>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:18px;">
  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);">
    <div style="font-size:13px;color:#64748b;">Precio por boleta</div>
    <div style="font-size:28px;font-weight:800;margin-top:8px;">$${Number(rifa.price_per_ticket || 0).toLocaleString("es-CO")}</div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);">
    <div style="font-size:13px;color:#64748b;">Vendidas</div>
    <div style="font-size:28px;font-weight:800;margin-top:8px;">${rifa.sold_tickets || 0}</div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);">
    <div style="font-size:13px;color:#64748b;">Disponibles</div>
    <div style="font-size:28px;font-weight:800;margin-top:8px;">${rifa.available_tickets || 0}</div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);">
    <div style="font-size:13px;color:#64748b;">Recaudado</div>
    <div style="font-size:28px;font-weight:800;margin-top:8px;">$${Number(totalRecaudado).toLocaleString("es-CO")}</div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);border:1px solid #fde68a;">
    <div style="font-size:13px;color:#92400e;">Tu comisión</div>
    <div style="font-size:28px;font-weight:800;margin-top:8px;color:#b45309;">$${Number(totalComision).toLocaleString("es-CO")}</div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:18px;box-shadow:0 10px 24px rgba(0,0,0,.06);border:1px solid #bbf7d0;">
    <div style="font-size:13px;color:#166534;">Neto organizador</div>
    <div style="font-size:28px;font-weight:800;margin-top:8px;color:#15803d;">$${Number(totalOrganizador).toLocaleString("es-CO")}</div>
  </div>
</div>

    ${lastResult ? `
    <div style="background:#ecfdf5;border:1px solid #86efac;border-radius:16px;padding:18px;margin-bottom:18px;">
      <h3 style="margin-top:0;">Último resultado</h3>

      <div style="margin-bottom:8px;">
        <b>Combinación ganadora:</b> ${lastResult.winning_combination}
      </div>

      <div style="margin-bottom:8px;">
        <b>Ganador:</b> ${lastResult.buyers?.full_name || "Sin ganador"}
      </div>

      <div>
        <b>Teléfono:</b> ${lastResult.buyers?.phone || "-"}
      </div>
    </div>
    ` : ""}

    <div style="background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);overflow:auto;">
      <table style="width:100%;border-collapse:collapse;min-width:1000px;">
        <thead style="background:#0f172a;color:white;">
          <tr>
            <th style="padding:14px;text-align:left;">Comprador</th>
            <th style="padding:14px;text-align:left;">Teléfono</th>
            <th style="padding:14px;text-align:center;">Cantidad</th>
            <th style="padding:14px;text-align:right;">Total</th>
            <th style="padding:14px;text-align:center;">Pago</th>
            <th style="padding:14px;text-align:left;">Combinaciones</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="6" style="padding:18px;">No hay compras registradas todavía.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
    `);
  } catch (e) {
    res.status(500).send(e.message);
  }
});
app.get("/organizers/register", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
  <!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Registro de organizador</title>
  </head>
  <body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
    <div style="max-width:520px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
      <h1 style="margin-top:0;">Crear cuenta de organizador</h1>

      <form method="POST" action="/organizers/register">
        <div style="margin-bottom:12px;">
          <label><b>Nombre completo</b></label><br/>
          <input type="text" name="full_name" required
            style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
        </div>

        <div style="margin-bottom:12px;">
          <label><b>Correo</b></label><br/>
          <input type="email" name="email" required
            style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
        </div>

        <div style="margin-bottom:12px;">
          <label><b>Teléfono</b></label><br/>
          <input type="text" name="phone"
            style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
        </div>

        <div style="margin-bottom:18px;">
          <label><b>Contraseña</b></label><br/>
          <input type="password" name="password" required
            style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
        </div>

        <button type="submit"
          style="background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;width:100%;">
          Crear cuenta
        </button>
      </form>

      <div style="margin-top:14px;">
        <a href="/organizers/login" style="color:#2563eb;text-decoration:none;font-weight:700;">Ya tengo cuenta</a>
      </div>
    </div>
  </body>
  </html>
  `);
});

app.post("/organizers/register", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const fullName = String(req.body.full_name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "").trim();

    if (!fullName || !email || !password) {
      return res.status(400).send("Faltan campos obligatorios");
    }

    const { data: existingOrganizer } = await supabase
      .from("organizers")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingOrganizer) {
      return res.status(400).send("Ya existe un organizador con ese correo");
    }

    const { data: organizer, error } = await supabase
      .from("organizers")
      .insert({
        full_name: fullName,
        email,
        phone: phone || null,
        password,
      })
      .select()
      .single();

    if (error) throw error;

    return res.redirect(`/organizers/login?registered=1&email=${encodeURIComponent(email)}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/organizers/login", async (req, res) => {
  const email = String(req.query.email || "").trim();
  const registered = req.query.registered === "1";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
  <!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ingreso organizador</title>
  </head>
  <body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
    <div style="max-width:520px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
      <h1 style="margin-top:0;">Ingreso de organizador</h1>

      ${registered ? `
        <div style="margin-bottom:16px;padding:12px;border-radius:10px;background:#ecfdf5;border:1px solid #86efac;color:#166534;">
          Cuenta creada correctamente. Ahora inicia sesión.
        </div>
      ` : ""}

      <form method="POST" action="/organizers/login">
        <div style="margin-bottom:12px;">
          <label><b>Correo</b></label><br/>
          <input type="email" name="email" value="${email}" required
            style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
        </div>

        <div style="margin-bottom:18px;">
          <label><b>Contraseña</b></label><br/>
          <input type="password" name="password" required
            style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
        </div>

        <button type="submit"
          style="background:#2563eb;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;width:100%;">
          Ingresar
        </button>
      </form>

      <div style="margin-top:14px;">
        <a href="/organizers/register" style="color:#16a34a;text-decoration:none;font-weight:700;">Crear cuenta</a>
      </div>
    </div>
  </body>
  </html>
  `);
});

app.post("/organizers/login", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "").trim();

    if (!email || !password) {
      return res.status(400).send("Faltan credenciales");
    }

    const { data: organizer, error } = await supabase
      .from("organizers")
      .select("*")
      .eq("email", email)
      .eq("password", password)
      .maybeSingle();

    if (error) throw error;

    if (!organizer) {
      return res.status(401).send("Correo o contraseña incorrectos");
    }

    return res.redirect(`/organizers/${organizer.id}/panel`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/organizers/:organizerId/panel", async (req, res) => {
  try {
    const { organizerId } = req.params;

    const { data: organizer, error: organizerError } = await supabase
      .from("organizers")
      .select("*")
      .eq("id", organizerId)
      .single();

    if (organizerError || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

    const { data: rifas, error: rifasError } = await supabase
      .from("rifas")
      .select("*")
      .eq("owner_id", organizerId)
      .order("created_at", { ascending: false });

    if (rifasError) throw rifasError;

    const rows = (rifas || []).map((r) => `
      <tr>
        <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${r.title || ""}</td>
        <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${r.prize || ""}</td>
        <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.sold_tickets || 0}</td>
        <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.available_tickets || 0}</td>
        <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;">$${Number(r.price_per_ticket || 0).toLocaleString("es-CO")}</td>
      </tr>
    `).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Panel del organizador</title>
    </head>
    <body style="margin:0;font-family:Arial,sans-serif;background:#f4f7fb;color:#111;">
      <div style="max-width:1100px;margin:30px auto;padding:16px;">
        <h1 style="margin-top:0;">Panel de ${organizer.full_name}</h1>
        <div style="margin-bottom:18px;color:#64748b;">Correo: ${organizer.email}</div>

<div style="margin-bottom:20px;">
  <a href="/panel/rifa/nueva" 
     style="background:#16a34a;color:white;padding:10px 18px;
     text-decoration:none;border-radius:8px;font-weight:bold;">
     + Crear nueva rifa
  </a>
</div>

        <div style="background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);overflow:auto;">
          <table style="width:100%;border-collapse:collapse;min-width:800px;">
            <thead style="background:#0f172a;color:white;">
              <tr>
                <th style="padding:14px;text-align:left;">Rifa</th>
                <th style="padding:14px;text-align:left;">Premio</th>
                <th style="padding:14px;text-align:center;">Vendidas</th>
                <th style="padding:14px;text-align:center;">Disponibles</th>
                <th style="padding:14px;text-align:right;">Precio</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="5" style="padding:18px;">Este organizador aún no tiene rifas.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
    `);
  } catch (e) {
    res.status(500).send(e.message);
  }
});
app.post("/panel/rifa/:rifaId/sorteo", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { rifaId } = req.params;
    const winningCombination = String(req.body.winning_combination || "").trim();

    if (!winningCombination) {
      return res.status(400).send("Falta la combinación ganadora");
    }

    const { data: rifa, error: rifaError } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (rifaError || !rifa) {
      return res.status(404).send("Rifa no encontrada");
    }

    const { data: winnerTicket, error: ticketError } = await supabase
      .from("tickets")
      .select("*")
      .eq("rifa_id", rifaId)
      .eq("combination", winningCombination)
      .maybeSingle();

    if (ticketError) throw ticketError;

    let winnerBuyerId = null;
    if (winnerTicket?.buyer_id) {
      winnerBuyerId = winnerTicket.buyer_id;
    } else if (winnerTicket?.order_id) {
      const { data: orderRow } = await supabase
        .from("orders")
        .select("buyer_id")
        .eq("id", winnerTicket.order_id)
        .maybeSingle();

      winnerBuyerId = orderRow?.buyer_id || null;
    }

    const { error: insertError } = await supabase
      .from("raffle_results")
      .insert({
        rifa_id: rifaId,
        winning_combination: winningCombination,
        winner_ticket_id: winnerTicket?.id || null,
        winner_buyer_id: winnerBuyerId || null,
      });

    if (insertError) throw insertError;

    return res.redirect(`/panel/rifa/${rifaId}?resultado=${encodeURIComponent(winningCombination)}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/rifa/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: rifa, error } = await supabase
      .from("rifas")
      .select("*")
      .eq("slug", slug)
      .single();

    if (error || !rifa) {
      return res.status(404).send("Rifa no encontrada");
    }

    const base = getBaseUrl(req);

    return res.redirect(`${base}/rifa-publica/${rifa.id}`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/r/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: rifa } = await supabase
      .from("rifas")
      .select("*")
      .eq("slug", slug)
      .single();

    if (!rifa) {
      return res.status(404).send("Rifa no encontrada");
    }

    const base = getBaseUrl(req);

    return res.redirect(`${base}/rifa-publica/${rifa.id}`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/resultado/:slug", async (req, res) => {
  const { slug } = req.params;

  const { data: rifa } = await supabase
    .from("rifas")
    .select("*")
    .eq("slug", slug)
    .single();

  if (!rifa) {
    return res.send("Rifa no encontrada");
  }

  const { data: result } = await supabase
    .from("raffle_results")
    .select(`
      *,
      buyers:winner_buyer_id (
        full_name,
        phone
      )
    `)
    .eq("rifa_id", rifa.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  res.send(`
  <html>
  <body style="font-family:Arial;background:#f6f7fb;padding:40px">
    <div style="max-width:600px;margin:auto;background:white;padding:30px;border-radius:16px">
      <h2>${rifa.title}</h2>

      ${result ? `
      <h3>Ganador</h3>
      <p><b>Combinación:</b> ${result.winning_combination}</p>
      <p><b>Nombre:</b> ${result.buyers?.full_name}</p>
      <p><b>Teléfono:</b> ${result.buyers?.phone}</p>
      ` : `
      <h3>La rifa aún no tiene ganador</h3>
      `}
    </div>
  </body>
  </html>
  `);
});

app.get("/rifa-publica/:rifaId", async (req, res) => {
  try {
    const { rifaId } = req.params;

    const { data: rifa, error } = await supabase
      .from("rifa_publica_detalle")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (error || !rifa) {
      return res.status(404).send("Rifa no existe");
    }

    const base = getBaseUrl(req);
    const vendidos = Number(rifa.sold_tickets || 0);
    const disponibles = Number(rifa.available_tickets || 0);
    const maximos = Number(rifa.max_tickets || 0);
    const porcentaje = maximos > 0 ? Math.round((vendidos / maximos) * 100) : 0;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${rifa.title}</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f4f7fb;color:#111;">
  <div style="max-width:900px;margin:30px auto;padding:16px;">
    
    <div style="background:#ffffff;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.08);overflow:hidden;">
      
      <div style="background:linear-gradient(135deg,#0f172a,#1e293b);color:white;padding:28px;">
        <div style="font-size:13px;opacity:.85;margin-bottom:8px;">Rifa activa</div>
        <h1 style="margin:0 0 10px 0;font-size:34px;">${rifa.title}</h1>
        <div style="font-size:18px;opacity:.95;"><b>Premio:</b> ${rifa.prize || "Premio no definido"}</div>
      </div>

      <div style="padding:24px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px;">
          
          <div>
            <div style="margin-bottom:18px;">
              <div style="font-size:15px;color:#475569;margin-bottom:6px;">Descripción</div>
              <div style="font-size:17px;line-height:1.5;">
                ${rifa.description || "Sin descripción"}
              </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:18px;">
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
                <div style="font-size:13px;color:#64748b;">Valor por boleta</div>
                <div style="font-size:28px;font-weight:800;margin-top:6px;">$${Number(rifa.price_per_ticket).toLocaleString("es-CO")}</div>
                <div style="font-size:13px;color:#64748b;">COP</div>
              </div>

              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
                <div style="font-size:13px;color:#64748b;">Disponibles</div>
                <div style="font-size:28px;font-weight:800;margin-top:6px;">${disponibles}</div>
                <div style="font-size:13px;color:#64748b;">de ${maximos}</div>
              </div>
            </div>

            <div style="margin-bottom:18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:16px;">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
    <div style="font-size:15px;font-weight:700;">Progreso de ventas</div>
    <div style="font-size:14px;color:#475569;"><b>${porcentaje}%</b> vendido</div>
  </div>

  <div style="width:100%;height:16px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-bottom:12px;">
    <div style="width:${porcentaje}%;height:100%;background:linear-gradient(90deg,#16a34a,#22c55e);transition:width .4s ease;"></div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;text-align:center;">
    
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px;">
      <div style="font-size:12px;color:#64748b;">Vendidas</div>
      <div style="font-size:22px;font-weight:800;">${vendidos}</div>
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px;">
      <div style="font-size:12px;color:#64748b;">Disponibles</div>
      <div style="font-size:22px;font-weight:800;">${disponibles}</div>
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px;">
      <div style="font-size:12px;color:#64748b;">Total</div>
      <div style="font-size:22px;font-weight:800;">${maximos}</div>
    </div>

  </div>
</div>

            <div style="padding:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;color:#1e3a8a;font-size:14px;">
              Los números <b>no se eligen manualmente</b>. Se asignan <b>automáticamente después del pago aprobado</b>.
            </div>
          </div>
<div style="margin-top:12px;margin-bottom:14px;">
  <a
    href="https://wa.me/?text=${encodeURIComponent(`🎟️ Participa en la rifa: ${rifa.title} - Premio: ${rifa.prize || "Premio"} - Boleta: $${Number(rifa.price_per_ticket).toLocaleString("es-CO")} - Vendidas: ${vendidos}/${maximos} - Compra aquí ${rifa.slug ? `${base}/r/${rifa.slug}` : `${base}/rifa-publica/${rifa.id}`}`)}"
    target="_blank"
    style="display:block;width:100%;text-align:center;background:#25D366;color:white;text-decoration:none;padding:14px;border-radius:12px;font-weight:800;font-size:16px;"
  >
    Compartir por WhatsApp
  </a>
</div>
          <div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:18px;box-shadow:0 8px 24px rgba(0,0,0,.04);">
              <h2 style="margin-top:0;margin-bottom:14px;font-size:22px;">Compra tus boletas</h2>

              <form method="GET" action="${base}/comprar-directo/${rifa.id}">
                <div style="margin-bottom:12px;">
                  <label style="display:block;font-size:14px;font-weight:700;margin-bottom:6px;">Nombre completo</label>
                  <input
                    type="text"
                    name="buyer_name"
                    required
                    style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;font-size:15px;"
                  />
                </div>

                <div style="margin-bottom:12px;">
                  <label style="display:block;font-size:14px;font-weight:700;margin-bottom:6px;">Teléfono</label>
                  <input
                    type="text"
                    name="buyer_phone"
                    required
                    style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;font-size:15px;"
                  />
                </div>

                <div style="margin-bottom:12px;">
                  <label style="display:block;font-size:14px;font-weight:700;margin-bottom:6px;">Correo electrónico (opcional)</label>
                  <input
                    type="email"
                    name="buyer_email"
                    style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;font-size:15px;"
                  />
                </div>

                <div style="margin-bottom:16px;">
                  <label style="display:block;font-size:14px;font-weight:700;margin-bottom:6px;">Cantidad de boletas</label>
                  <input
                    type="number"
                    name="qty"
                    min="1"
                    max="${disponibles || 1}"
                    value="1"
                    required
                    style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;font-size:15px;"
                  />
                </div>

                <button
                  type="submit"
                  style="width:100%;background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:12px;font-size:17px;font-weight:800;cursor:pointer;"
                >
                  Comprar ahora
                </button>
              </form>

              <div style="margin-top:14px;font-size:13px;color:#64748b;line-height:1.5;">
                Al continuar, serás redirigido a la pasarela de pago segura de Wompi.
              </div>
            </div>
          </div>

        </div>
      </div>

    </div>
  </div>
</body>
</html>
    `);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/rifas/:rifaId/comprar", async (req, res) => {
  try {
    const { rifaId } = req.params;

    const buyerName = (req.query.buyer_name || "").toString().trim();
    const buyerPhone = (req.query.buyer_phone || "").toString().trim();
    const qty = Number(req.query.qty || 1);

    if (!buyerName || !buyerPhone) {
      return res.status(400).json({
        ok: false,
        error: "buyer_name y buyer_phone son obligatorios",
      });
    }

    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({
        ok: false,
        error: "qty inválido",
      });
    }

    const { data: rifa, error: rifaError } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (rifaError || !rifa) {
      return res.status(404).json({
        ok: false,
        error: "Rifa no existe",
      });
    }

    const total = qty * Number(rifa.price_per_ticket);
    const commission = total * 0.03;

    let buyer = null;

    const { data: existingBuyer, error: existingBuyerError } = await supabase
      .from("buyers")
      .select("*")
      .eq("phone", buyerPhone)
      .maybeSingle();

    if (existingBuyerError) throw existingBuyerError;

    if (existingBuyer) {
      buyer = existingBuyer;
    } else {
      const { data: newBuyer, error: newBuyerError } = await supabase
        .from("buyers")
        .insert({
          full_name: buyerName,
          phone: buyerPhone,
        })
        .select()
        .single();

      if (newBuyerError) throw newBuyerError;
      buyer = newBuyer;
    }

    const reference = genReference();

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        rifa_id: rifaId,
        buyer_id: buyer.id,
        qty,
        subtotal: total,
        total_paid: total,
        commission,
        payment_status: "created",
      })
      .select()
      .single();

    if (orderError) throw orderError;

    const { error: paymentInsertError } = await supabase
      .from("payments")
      .insert({
        order_id: order.id,
        provider: "wompi",
        external_reference: reference,
        amount: total,
        status: "CREATED",
      });

    if (paymentInsertError) throw paymentInsertError;

    const base = getBaseUrl(req);

    res.json({
      ok: true,
      rifa: {
        id: rifa.id,
        title: rifa.title,
        modality: rifa.modality,
        price_per_ticket: rifa.price_per_ticket,
      },
      buyer,
      order: {
        id: order.id,
        reference,
        qty,
        total,
      },
      links: {
        pagar: `${base}/rifas/${rifaId}/orden/${order.id}/pagar?reference=${reference}`,
        ver: `${base}/rifas/${rifaId}/orden/${order.id}`,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/rifas/:rifaId/orden/:orderId", async (req, res) => {
  try {
    const { rifaId, orderId } = req.params;

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        *,
        rifas(*),
        buyers(*)
      `)
      .eq("id", orderId)
      .eq("rifa_id", rifaId)
      .single();

    if (orderError) throw orderError;

    const { data: tickets, error: ticketsError } = await supabase
      .from("tickets")
      .select("*")
      .eq("order_id", orderId);

    if (ticketsError) throw ticketsError;

    const { data: messages, error: messagesError } = await supabase
      .from("message_logs")
      .select("*")
      .eq("order_id", orderId);

    if (messagesError) throw messagesError;

    res.json({
      ok: true,
      order,
      tickets: tickets || [],
      message_logs: messages || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/rifas/:rifaId/orden/:orderId/pagar", async (req, res) => {
  try {
    const { rifaId, orderId } = req.params;
    const reference = (req.query.reference || "").toString().trim();

    if (!WOMPI_PUBLIC_KEY || !WOMPI_INTEGRITY_SECRET) {
      return res.status(500).send("Faltan variables de Wompi");
    }

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        *,
        rifas(*),
        buyers(*)
      `)
      .eq("id", orderId)
      .eq("rifa_id", rifaId)
      .single();

    if (orderError || !order) {
      return res.status(404).send("Orden no existe");
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", orderId)
      .eq("provider", "wompi")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (paymentError || !payment) {
      return res.status(404).send("Pago no existe");
    }

    const paymentReference = reference || payment.external_reference;
    const currency = "COP";
    const amountInCents = Math.round(Number(order.total_paid) * 100).toString();

    const signature = crypto
      .createHash("sha256")
      .update(`${paymentReference}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`)
      .digest("hex");

    console.log("WOMPI DEBUG", {
      paymentReference,
      amountInCents,
      currency,
      integritySecretLength: WOMPI_INTEGRITY_SECRET.length,
      publicKeyPrefix: WOMPI_PUBLIC_KEY.slice(0, 9),
      signature,
      orderTotalPaid: order.total_paid,
      orderId: order.id,
      paymentId: payment.id,
      externalReferenceFromDb: payment.external_reference,
    });

    const base = getBaseUrl(req);
    const redirectUrl = `${base}/rifas/${rifaId}/orden/${orderId}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pagar con Wompi</title>
</head>
<body style="font-family: Arial, sans-serif; padding: 30px; background: #f5f7fb;">
  <h2>Pagar con Wompi</h2>

  <p>Rifa: ${order.rifas.title}</p>
  <p>Comprador: ${order.buyers.full_name}</p>
  <p>Total: $${order.total_paid}</p>

  <pre style="background:#f3f4f6;padding:12px;border-radius:8px;font-size:12px;overflow:auto;white-space:pre-wrap;margin-bottom:16px;">
reference: ${paymentReference}
amountInCents: ${amountInCents}
currency: ${currency}
signature: ${signature}
publicKeyPrefix: ${WOMPI_PUBLIC_KEY.slice(0, 20)}...
integritySecretLength: ${WOMPI_INTEGRITY_SECRET.length}
  </pre>

  <form action="https://checkout.wompi.co/p/" method="GET">
    <input type="hidden" name="public-key" value="${WOMPI_PUBLIC_KEY}" />
    <input type="hidden" name="currency" value="${currency}" />
    <input type="hidden" name="amount-in-cents" value="${amountInCents}" />
    <input type="hidden" name="reference" value="${paymentReference}" />
    <input type="hidden" name="signature:integrity" value="${signature}" />
    <input type="hidden" name="redirect-url" value="${redirectUrl}" />

    <button type="submit" style="background:#2f6df6;color:white;border:none;padding:12px 18px;border-radius:8px;cursor:pointer;font-size:16px;">
      Paga con Wompi
    </button>
  </form>

  <div style="margin-top:18px;font-size:12px;opacity:.75;">
    * Al terminar el pago, Wompi redirige al detalle de la orden y el webhook confirma la compra.
  </div>

  <div style="margin-top:14px;">
    <a href="${redirectUrl}" style="text-decoration:none;color:#1a7f37;font-weight:700;">← Ver orden</a>
  </div>
</body>
</html>
    `);
  } catch (e) {
    res.status(500).send(e.message);
  }
});
async function sendWhatsAppText(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error("Faltan variables de WhatsApp");
  }

 const cleanTo = String(to || "").replace(/\D/g, "");
const toInternational = cleanTo.startsWith("57") ? cleanTo : `57${cleanTo}`;

const resp = await fetch(
  `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toInternational,
      type: "text",
      text: { body }
    })
  }
);

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`WhatsApp error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function sendPurchaseWhatsApp(orderId) {
  const { data: orderFull, error: orderFullError } = await supabase
    .from("orders")
    .select(`
      *,
      buyers(*),
      rifas(*)
    `)
    .eq("id", orderId)
    .single();

  if (orderFullError) throw orderFullError;

  const { data: assignedTickets, error: assignedTicketsError } = await supabase
    .from("tickets")
    .select("*")
    .eq("order_id", orderId);

  if (assignedTicketsError) throw assignedTicketsError;

  const combinaciones = (assignedTickets || []).map(t => t.combination).join("\n");

  const mensaje = `Hola ${orderFull.buyers?.full_name || "cliente"}

Tu compra fue confirmada en la rifa: ${orderFull.rifas?.title || "Rifa"}

Tus combinaciones son:
${combinaciones || "Sin combinaciones registradas"}

Guarda este mensaje como comprobante. ¡Suerte!`;

  const waResp = await sendWhatsAppText(orderFull.buyers?.phone, mensaje);

  const { data: lastLog, error: lastLogError } = await supabase
  .from("message_logs")
  .select("id")
  .eq("order_id", orderId)
  .eq("channel", "whatsapp")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (lastLogError) throw lastLogError;

if (lastLog?.id) {
  const { error: updateLogError } = await supabase
    .from("message_logs")
    .update({
      send_status: "sent",
      provider_message_id: waResp?.messages?.[0]?.id || null,
    })
    .eq("id", lastLog.id);

  if (updateLogError) throw updateLogError;
}

  return waResp;
}
app.post("/wompi/webhook", async (req, res) => {
  try {

    const tx = req.body?.data?.transaction;

    if (!tx) {
      return res.json({ ok: true });
    }

    const reference = tx.reference;
    const status = tx.status;
    const providerPaymentId = tx.id || null;

    const { data: payment, error: paymentLookupError } = await supabase
      .from("payments")
      .select("*")
      .eq("external_reference", reference)
      .maybeSingle();

    if (paymentLookupError) throw paymentLookupError;

    if (!payment) {
      return res.json({ ok: true, found: false });
    }

    await supabase
      .from("payments")
      .update({
        provider_payment_id: providerPaymentId,
        status,
        status_detail: tx.status_message || null,
        raw_response: req.body,
        updated_at: now(),
      })
      .eq("id", payment.id);

    if (status === "APPROVED") {

      const { data: order } = await supabase
        .from("orders")
        .select(`
          *,
          rifas(*)
        `)
        .eq("id", payment.order_id)
        .single();

      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: now(),
        })
        .eq("id", payment.order_id);

      const { error: assignError } = await supabase.rpc("assign_random_tickets", {
        p_rifa_id: order.rifa_id,
        p_order_id: order.id,
        p_qty: order.qty,
        p_modality: order.rifas.modality,
      });

      if (assignError) {
        console.error("assign_random_tickets error:", assignError.message);
      }

      const { error: messageError } = await supabase.rpc("log_ticket_message", {
        p_order_id: order.id,
        p_channel: "whatsapp",
      });

      if (messageError) {
        console.error("log_ticket_message error:", messageError.message);
      }

      try {
        await sendPurchaseWhatsApp(order.id);
      } catch (waError) {
        console.error("sendPurchaseWhatsApp error:", waError.message);
      }

    }

    if (status === "DECLINED" || status === "VOIDED" || status === "ERROR") {

      await supabase
        .from("orders")
        .update({
          payment_status: "failed",
        })
        .eq("id", payment.order_id);

    }

    res.json({ ok: true });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e.message,
    });

  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto", PORT);
});
// update
