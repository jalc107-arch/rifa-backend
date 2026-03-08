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
  return "ord_" + crypto.randomBytes(6).toString("hex");
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

  <form>
    <script
      src="https://checkout.wompi.co/widget.js"
      data-render="button"
      data-public-key="${WOMPI_PUBLIC_KEY}"
      data-currency="${currency}"
      data-amount-in-cents="${amountInCents}"
      data-reference="${paymentReference}"
      data-signature:integrity="${signature}"
      data-redirect-url="${redirectUrl}">
    </script>
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

    if (status !== "APPROVED" && status !== "DECLINED" && status !== "VOIDED" && status !== "ERROR") {
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
