// index.js
import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// =========================
// CONFIG
// =========================
const PORT = Number(process.env.PORT || 3000);

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const WOMPI_PUBLIC_KEY = (process.env.WOMPI_PUBLIC_KEY || "").trim();
const WOMPI_PRIVATE_KEY = (process.env.WOMPI_PRIVATE_KEY || "").trim();
const WOMPI_INTEGRITY_SECRET = (process.env.WOMPI_INTEGRITY_SECRET || "").trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// =========================
// HELPERS
// =========================
function nowISO() {
  return new Date().toISOString();
}

function genOrderReference() {
  return `ord_${crypto.randomBytes(6).toString("hex")}`;
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .toString()
    .split(",")[0]
    .trim();

  const host = (req.headers["x-forwarded-host"] || req.get("host") || "")
    .toString()
    .split(",")[0]
    .trim();

  return `${proto}://${host}`;
}

function isValidQty(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 20;
}

function normalizeText(value, fallback = "") {
  return (value ?? fallback).toString().trim();
}

function wompiEnvFromPublicKey(pub) {
  const key = (pub || "").toLowerCase();
  if (key.startsWith("pub_test_")) return "sandbox";
  if (key.startsWith("pub_prod_")) return "production";
  return "unknown";
}

// =========================
// DEBUG
// =========================
app.get("/debug/wompi", async (req, res) => {
  const env = wompiEnvFromPublicKey(WOMPI_PUBLIC_KEY);

  res.json({
    ok: true,
    env,
    pub_prefix: WOMPI_PUBLIC_KEY ? WOMPI_PUBLIC_KEY.slice(0, 9) : "undefined",
    prv_prefix: WOMPI_PRIVATE_KEY ? WOMPI_PRIVATE_KEY.slice(0, 9) : "undefined",
    integrity_len: WOMPI_INTEGRITY_SECRET ? WOMPI_INTEGRITY_SECRET.length : 0,
    missing: {
      SUPABASE_URL: !SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !SUPABASE_SERVICE_ROLE_KEY,
      WOMPI_PUBLIC_KEY: !WOMPI_PUBLIC_KEY,
      WOMPI_PRIVATE_KEY: !WOMPI_PRIVATE_KEY,
      WOMPI_INTEGRITY_SECRET: !WOMPI_INTEGRITY_SECRET,
    },
  });
});

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase.from("rifas").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true, status: "healthy", at: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Health failed" });
  }
});

// =========================
// CREAR DEMO EN SUPABASE
// =========================
app.get("/crear-demo", async (req, res) => {
  try {
    const ownerId = normalizeText(req.query.owner_id);
    if (!ownerId) {
      return res.status(400).json({
        ok: false,
        error: "Debes enviar owner_id de un profile existente",
      });
    }

    const title = normalizeText(req.query.title, "Rifa Demo Baloto");
    const prize = normalizeText(req.query.prize, "Moto NKD");
    const description = normalizeText(req.query.description, "Rifa de prueba");
    const modality = Number(req.query.modality || 3);
    const pricePerTicket = Number(req.query.price_per_ticket || 10000);
    const maxTickets = Number(req.query.max_tickets || 100);

    if (![2, 3, 4, 5].includes(modality)) {
      return res.status(400).json({ ok: false, error: "modality debe ser 2, 3, 4 o 5" });
    }

    if (!Number.isFinite(pricePerTicket) || pricePerTicket <= 0) {
      return res.status(400).json({ ok: false, error: "price_per_ticket inválido" });
    }

    if (!Number.isInteger(maxTickets) || maxTickets <= 0) {
      return res.status(400).json({ ok: false, error: "max_tickets inválido" });
    }

    const drawDate = req.query.draw_date
      ? new Date(req.query.draw_date.toString()).toISOString()
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
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
        draw_date: drawDate,
        status: "active",
      })
      .select()
      .single();

    if (error) throw error;

    const base = getBaseUrl(req);

    res.json({
      ok: true,
      rifa: data,
      links: {
        ver: `${base}/rifas/${data.id}`,
        comprar: `${base}/rifas/${data.id}/comprar`,
        pagar_demo: `${base}/rifas/${data.id}/comprar?buyer_name=Comprador%20Demo&buyer_phone=3011111111&qty=1`,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Error creando demo" });
  }
});

// =========================
// VER RIFA
// =========================
app.get("/rifas/:rifaId", async (req, res) => {
  try {
    const { rifaId } = req.params;

    const { data, error } = await supabase
      .from("rifa_publica_detalle")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ ok: false, error: "Rifa no existe" });
      }
      throw error;
    }

    res.json({ ok: true, rifa: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Error consultando rifa" });
  }
});

// =========================
// CREAR ORDEN + BUYER EN SUPABASE
// =========================
// Ejemplo:
// /rifas/:rifaId/comprar?buyer_name=Juan&buyer_phone=3001234567&buyer_email=a@a.com&qty=2
app.get("/rifas/:rifaId/comprar", async (req, res) => {
  try {
    const { rifaId } = req.params;

    if (!isValidQty(req.query.qty || 1)) {
      return res.status(400).json({ ok: false, error: "qty inválido. Usa enteros entre 1 y 20" });
    }

    const qty = Number(req.query.qty || 1);
    const buyerName = normalizeText(req.query.buyer_name);
    const buyerPhone = normalizeText(req.query.buyer_phone);
    const buyerEmail = normalizeText(req.query.buyer_email);

    if (!buyerName || !buyerPhone) {
      return res.status(400).json({
        ok: false,
        error: "Debes enviar buyer_name y buyer_phone",
      });
    }

    // 1) Consultar rifa
    const { data: rifa, error: rifaError } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifaId)
      .single();

    if (rifaError) {
      if (rifaError.code === "PGRST116") {
        return res.status(404).json({ ok: false, error: "Rifa no existe" });
      }
      throw rifaError;
    }

    if (rifa.status !== "active") {
      return res.status(400).json({ ok: false, error: "La rifa no está activa" });
    }

    if (Number(rifa.available_tickets) < qty) {
      return res.status(400).json({ ok: false, error: "No hay suficientes boletas disponibles" });
    }

    const pricePerTicket = Number(rifa.price_per_ticket);
    const subtotal = qty * pricePerTicket;
    const totalPaid = subtotal;

    // 2) Buscar buyer existente por teléfono o crearlo
    let buyer = null;

    const { data: existingBuyer, error: buyerLookupError } = await supabase
      .from("buyers")
      .select("*")
      .eq("phone", buyerPhone)
      .limit(1)
      .maybeSingle();

    if (buyerLookupError) throw buyerLookupError;

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

    // 3) Crear orden
    const orderReference = genOrderReference();

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        id: crypto.randomUUID(),
        rifa_id: rifaId,
        buyer_id: buyer.id,
        qty,
        subtotal,
        total_paid: totalPaid,
        payment_status: "created",
        paid_at: null,
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // 4) Crear registro de pago preliminar
    const { error: paymentError } = await supabase
      .from("payments")
      .insert({
        order_id: order.id,
        provider: "wompi",
        external_reference: orderReference,
        amount: totalPaid,
        status: "CREATED",
      });

    if (paymentError) throw paymentError;

    const base = getBaseUrl(req);

    res.json({
      ok: true,
      rifa: {
        id: rifa.id,
        title: rifa.title,
        modality: rifa.modality,
        price_per_ticket: rifa.price_per_ticket,
      },
      buyer: {
        id: buyer.id,
        full_name: buyer.full_name,
        phone: buyer.phone,
      },
      order: {
        id: order.id,
        reference: orderReference,
        qty,
        total_pagar: totalPaid,
        payment_status: order.payment_status,
      },
      links: {
        pagar: `${base}/rifas/${rifaId}/orden/${order.id}/pagar?reference=${encodeURIComponent(orderReference)}`,
        ver: `${base}/rifas/${rifaId}/orden/${order.id}`,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Error creando compra" });
  }
});

// =========================
// VER ORDEN
// =========================
app.get("/rifas/:rifaId/orden/:orderId", async (req, res) => {
  try {
    const { rifaId, orderId } = req.params;

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        *,
        buyers (*),
        rifas (*)
      `)
      .eq("id", orderId)
      .eq("rifa_id", rifaId)
      .single();

    if (orderError) {
      if (orderError.code === "PGRST116") {
        return res.status(404).json({ ok: false, error: "Orden no existe" });
      }
      throw orderError;
    }

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
    res.status(500).json({ ok: false, error: e.message || "Error consultando orden" });
  }
});

// =========================
// PAGAR CON WOMPI
// =========================
app.get("/rifas/:rifaId/orden/:orderId/pagar", async (req, res) => {
  try {
    const { rifaId, orderId } = req.params;
    const reference = normalizeText(req.query.reference);

    if (!WOMPI_PUBLIC_KEY || !WOMPI_INTEGRITY_SECRET) {
      return res.status(500).send("Faltan WOMPI_PUBLIC_KEY o WOMPI_INTEGRITY_SECRET");
    }

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        *,
        rifas (*),
        buyers (*)
      `)
      .eq("id", orderId)
      .eq("rifa_id", rifaId)
      .single();

    if (orderError) {
      if (orderError.code === "PGRST116") return res.status(404).send("Orden no existe");
      throw orderError;
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", orderId)
      .eq("provider", "wompi")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (paymentError) throw paymentError;

    const paymentReference = reference || payment.external_reference;
    const currency = "COP";
    const amountInCents = String(Number(order.total_paid) * 100);

    const signature = crypto
      .createHash("sha256")
      .update(paymentReference + amountInCents + currency + WOMPI_INTEGRITY_SECRET)
      .digest("hex");

    const base = getBaseUrl(req);
    const redirectUrl = `${base}/rifas/${rifaId}/orden/${orderId}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pagar con Wompi</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f5f7fb;margin:0;padding:24px;">
  <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:20px;">
    <h2 style="margin-top:0;">Pagar con Wompi</h2>
    <div style="opacity:.85;margin-bottom:8px;">Rifa: <b>${order.rifas.title}</b></div>
    <div style="opacity:.85;margin-bottom:8px;">Comprador: <b>${order.buyers.full_name}</b></div>
    <div style="opacity:.85;margin-bottom:8px;">Orden: <b>${orderId}</b></div>
    <div style="opacity:.85;margin-bottom:16px;">Total: <b>$${Number(order.total_paid).toLocaleString("es-CO")} COP</b></div>

    <script
      src="https://checkout.wompi.co/widget.js"
      data-render="button"
      data-public-key="${WOMPI_PUBLIC_KEY}"
      data-currency="${currency}"
      data-amount-in-cents="${amountInCents}"
      data-reference="${paymentReference}"
      data-signature-integrity="${signature}"
      data-redirect-url="${redirectUrl}">
    </script>

    <div style="margin-top:18px;font-size:12px;opacity:.75;">
      * Al terminar el pago, Wompi redirige al detalle de la orden y el webhook confirma la compra.
    </div>

    <div style="margin-top:14px;">
      <a href="${redirectUrl}" style="text-decoration:none;color:#1a7f37;font-weight:700;">← Ver orden</a>
    </div>
  </div>
</body>
</html>
    `);
  } catch (e) {
    res.status(500).send(e.message || "Error generando checkout");
  }
});

// =========================
// WEBHOOK WOMPI
// =========================
app.post("/wompi/webhook", async (req, res) => {
  try {
    const body = req.body;
    const tx = body?.data?.transaction;

    if (!tx?.reference) {
      return res.status(400).json({ ok: false, error: "Sin reference" });
    }

    const reference = tx.reference;
    const status = tx.status || null;
    const wompiTxId = tx.id || null;

    // 1) Buscar payment por reference
    const { data: payment, error: paymentLookupError } = await supabase
      .from("payments")
      .select("*")
      .eq("external_reference", reference)
      .eq("provider", "wompi")
      .limit(1)
      .maybeSingle();

    if (paymentLookupError) throw paymentLookupError;

    if (!payment) {
      return res.json({ ok: true, found: false });
    }

    // 2) Actualizar payment
    const { error: paymentUpdateError } = await supabase
      .from("payments")
      .update({
        provider_payment_id: wompiTxId,
        status: status || "UNKNOWN",
        status_detail: tx?.status_message || null,
        raw_response: body,
        updated_at: nowISO(),
      })
      .eq("id", payment.id);

    if (paymentUpdateError) throw paymentUpdateError;

    // 3) Buscar orden
    const { data: order, error: orderLookupError } = await supabase
      .from("orders")
      .select(`
        *,
        rifas (*)
      `)
      .eq("id", payment.order_id)
      .single();

    if (orderLookupError) throw orderLookupError;

    // 4) Aplicar lógica según estado
    if (status === "APPROVED") {
      const { error: orderUpdateError } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: nowISO(),
        })
        .eq("id", order.id);

      if (orderUpdateError) throw orderUpdateError;

      // Asignar boletas
      const { error: assignError } = await supabase.rpc("assign_random_tickets", {
        p_rifa_id: order.rifa_id,
        p_order_id: order.id,
        p_qty: order.qty,
        p_modality: order.rifas.modality,
      });

      if (assignError) {
        console.error("Error asignando tickets:", assignError.message);
      }

      // Registrar mensaje
      const { error: messageError } = await supabase.rpc("log_ticket_message", {
        p_order_id: order.id,
        p_channel: "whatsapp",
      });

      if (messageError) {
        console.error("Error registrando message_logs:", messageError.message);
      }
    } else if (status === "DECLINED" || status === "VOIDED" || status === "ERROR") {
      const { error: orderUpdateError } = await supabase
        .from("orders")
        .update({
          payment_status: "failed",
        })
        .eq("id", order.id);

      if (orderUpdateError) throw orderUpdateError;
    } else {
      const { error: orderUpdateError } = await supabase
        .from("orders")
        .update({
          payment_status: "pending",
        })
        .eq("id", order.id);

      if (orderUpdateError) throw orderUpdateError;
    }

    return res.json({ ok: true, found: true, status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Webhook error" });
  }
});

// =========================
// HOME
// =========================
app.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase.from("rifa_publica").select("*").limit(10);
    if (error) throw error;
    res.json({ ok: true, rifas: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Error en home" });
  }
});

// =========================
// START
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto", PORT);
});
