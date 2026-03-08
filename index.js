import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.set("trust proxy", 1);

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
        <label><b>Owner ID</b></label><br/>
        <input type="text" name="owner_id" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

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

app.post("/crear-rifa", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const ownerId = String(req.body.owner_id || "").trim();
    const title = String(req.body.title || "").trim();
    const prize = String(req.body.prize || "").trim();
    const description = String(req.body.description || "").trim();
    const modality = Number(req.body.modality || 3);
    const pricePerTicket = Number(req.body.price_per_ticket || 0);
    const maxTickets = Number(req.body.max_tickets || 0);
    const drawDateRaw = String(req.body.draw_date || "").trim();

    if (!ownerId || !title || !prize || !drawDateRaw) {
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
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9\\s-]/g, "")
    .trim()
    .replace(/\\s+/g, "-")
    .replace(/-+/g, "-");
}

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

    return res.redirect(
      `${base}/rifa-publica/${rifa.id}`
    );

  } catch (e) {
    res.status(500).send(e.message);
  }
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

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${rifa.title}</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
  <div style="max-width:760px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
    
    <h1 style="margin-top:0;">${rifa.title}</h1>
    <p style="font-size:18px;margin:8px 0;"><b>Premio:</b> ${rifa.prize || "Premio no definido"}</p>
    <p style="margin:8px 0;"><b>Descripción:</b> ${rifa.description || "Sin descripción"}</p>
    <p style="margin:8px 0;"><b>Valor por boleta:</b> $${Number(rifa.price_per_ticket).toLocaleString("es-CO")} COP</p>
    <p style="margin:8px 0;"><b>Boletas vendidas:</b> ${rifa.sold_tickets}</p>
    <p style="margin:8px 0;"><b>Boletas disponibles:</b> ${rifa.available_tickets}</p>
    <p style="margin:8px 0;"><b>Estado:</b> ${rifa.status}</p>

    <div style="margin-top:18px;padding:14px;background:#eef6ff;border-radius:10px;font-size:14px;">
      Los números <b>no se eligen manualmente</b>. Se asignan <b>automáticamente después del pago</b>.
    </div>

    <form method="GET" action="${base}/comprar-directo/${rifa.id}" style="margin-top:24px;">
      <div style="margin-bottom:12px;">
        <label><b>Nombre completo</b></label><br/>
        <input
          type="text"
          name="buyer_name"
          required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;"
        />
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Teléfono</b></label><br/>
        <input
          type="text"
          name="buyer_phone"
          required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;"
        />
      </div>

      <div style="margin-bottom:12px;">
        <label><b>Correo electrónico</b> (opcional)</label><br/>
        <input
          type="email"
          name="buyer_email"
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;"
        />
      </div>

      <div style="margin-bottom:18px;">
        <label><b>Cantidad de boletas</b></label><br/>
        <input
          type="number"
          name="qty"
          min="1"
          max="${rifa.available_tickets || 1}"
          value="1"
          required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;"
        />
      </div>

      <button
        type="submit"
        style="background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;width:100%;"
      >
        Comprar ahora
      </button>
    </form>
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

    // Referencia única por cada compra, como exige Wompi.
    const reference = genReference();

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        rifa_id: rifaId,
        buyer_id: buyer.id,
        qty,
        subtotal: total,
        total_paid: total,
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

    // Firma: <Reference><Amount><Currency><IntegritySecret>
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

    const { error: paymentUpdateError } = await supabase
      .from("payments")
      .update({
        provider_payment_id: providerPaymentId,
        status,
        status_detail: tx.status_message || null,
        raw_response: req.body,
        updated_at: now(),
      })
      .eq("id", payment.id);

    if (paymentUpdateError) throw paymentUpdateError;

    if (status === "APPROVED") {
      const { data: order, error: orderLookupError } = await supabase
        .from("orders")
        .select(`
          *,
          rifas(*)
        `)
        .eq("id", payment.order_id)
        .single();

      if (orderLookupError) throw orderLookupError;

      const { error: orderUpdateError } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: now(),
        })
        .eq("id", payment.order_id);

      if (orderUpdateError) throw orderUpdateError;

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
    }

    if (status === "DECLINED" || status === "VOIDED" || status === "ERROR") {
      const { error: orderFailError } = await supabase
        .from("orders")
        .update({
          payment_status: "failed",
        })
        .eq("id", payment.order_id);

      if (orderFailError) throw orderFailError;
    }

    if (
      status !== "APPROVED" &&
      status !== "DECLINED" &&
      status !== "VOIDED" &&
      status !== "ERROR"
    ) {
      const { error: orderPendingError } = await supabase
        .from("orders")
        .update({
          payment_status: "pending",
        })
        .eq("id", payment.order_id);

      if (orderPendingError) throw orderPendingError;
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto", PORT);
});
