import { MercadoPagoConfig, Preference } from "mercadopago";

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});
import express from "express";
import crypto from "crypto";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import session from "express-session";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

app.get("/probar-pago", async (req, res) => {
  try {
    const preference = new Preference(mpClient);

    const response = await preference.create({
      body: {
        items: [
          {
            title: "Cupón Rifa",
            quantity: 1,
            unit_price: 10000,
            currency_id: "COP"
          }
        ]
      }
    });

    return res.redirect(response.init_point);
  } catch (error) {
    console.error("ERROR MERCADO PAGO:", error);
    return res.status(500).send(error.message);
  }
});

app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const data = req.body;

    console.log("WEBHOOK MP:", JSON.stringify(data, null, 2));

    if (data.type !== "payment") {
      return res.sendStatus(200);
    }

    const paymentId = data.data?.id;

    if (!paymentId) {
      console.log("Webhook sin paymentId");
      return res.sendStatus(200);
    }

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = await response.json();

    console.log("DETALLE PAGO:", JSON.stringify(payment, null, 2));

    if (!response.ok) {
      console.error("Error consultando pago en MP:", payment);
      return res.sendStatus(200);
    }

    const mpStatus = payment.status;
    const externalReference = payment.external_reference || null;

    console.log("STATUS MP:", mpStatus);
    console.log("EXTERNAL REFERENCE:", externalReference);

    if (!externalReference) {
      console.log("No llegó external_reference");
      return res.sendStatus(200);
    }

    const { data: paymentRow, error: paymentRowError } = await supabase
      .from("payments")
      .select("*")
      .eq("external_reference", externalReference)
      .maybeSingle();

    if (paymentRowError) {
      console.error("Error buscando payment en Supabase:", paymentRowError);
      return res.sendStatus(200);
    }

    if (!paymentRow) {
      console.log("No se encontró payment en Supabase para esa referencia");
      return res.sendStatus(200);
    }

    await supabase
      .from("payments")
      .update({
        provider: "mercadopago",
        provider_payment_id: String(payment.id),
        status: mpStatus,
        status_detail: payment.status_detail || null,
        raw_response: payment,
        updated_at: now(),
      })
      .eq("id", paymentRow.id);

    if (mpStatus === "approved") {
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: now(),
        })
        .eq("id", paymentRow.order_id);

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .select(`
          *,
          rifas(*)
        `)
        .eq("id", paymentRow.order_id)
        .single();

      if (orderError || !order) {
        console.error("No se encontró la orden:", orderError);
        return res.sendStatus(200);
      }

      const modality = order.rifas?.draw_mode || order.rifas?.modality;

      const { error: assignError } = await supabase.rpc("assign_random_tickets", {
        p_rifa_id: order.rifa_id,
        p_order_id: order.id,
        p_qty: order.qty,
        p_modality: modality,
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

      console.log("Pago aprobado y cupones asignados:", order.id);
    }

    if (mpStatus === "rejected" || mpStatus === "cancelled") {
      await supabase
        .from("orders")
        .update({
          payment_status: "failed",
        })
        .eq("id", paymentRow.order_id);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("ERROR WEBHOOK MP:", error);
    return res.sendStatus(200);
  }
});

app.post("/crear-pago", async (req, res) => {
  try {
    const { rifa_id, quantity, precio, buyer_name, buyer_phone, buyer_email } = req.body;

    const { data: rifa, error: rifaError } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifa_id)
      .single();

    if (rifaError || !rifa) {
      return res.status(404).send("Campaña no encontrada");
    }

    const colombiaNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })
    );

    const today = colombiaNow.toLocaleDateString("en-CA");
    const drawDateOnly = String(rifa.draw_date || "").slice(0, 10);
    const hour = colombiaNow.getHours();

    if (today > drawDateOnly || (today === drawDateOnly && hour >= 18)) {
      return res.status(400).send("Esta campaña ya está cerrada.");
    }

    const preference = new Preference(mpClient);

    const response = await preference.create({
      body: {
        items: [
          {
            title: "Cupón Rifa",
            quantity: Number(quantity),
            unit_price: Number(precio),
            currency_id: "COP"
          }
        ],
        payer: {
          name: buyer_name,
          email: buyer_email || "test@test.com"
        },
        external_reference: `${rifa_id}|${buyer_phone}|${Date.now()}`
      }
    });

    return res.redirect(response.init_point);
  } catch (error) {
    console.error("ERROR MERCADOPAGO:", error.message);
    return res.status(500).json({
      error: "Error creando pago"
    });
  }
});

const ADMIN_KEY = process.env.ADMIN_KEY || "promoclaras_admin_2026";

app.use(session({
  secret: process.env.SESSION_SECRET || "rifasclaras_secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: "lax"
  }
}));

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
const upload = multer({
  storage: multer.memoryStorage()
});

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
function getDayNameEs(date) {
  const days = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  return days[date.getDay()];
}

function getAllowedDays(drawProvider) {
  const map = {
    baloto: ["lunes", "miercoles", "viernes"],
    loteria_meta: ["miercoles"],
    loteria_bogota: ["jueves"],
    loteria_medellin: ["viernes"],
    loteria_boyaca: ["sabado"],
    loteria_tolima: ["lunes"],
    loteria_manizales: ["miercoles"],
    loteria_cauca: ["sabado"],
    loteria_huila: ["martes"],
    loteria_santander: ["viernes"],
    loteria_cruz_roja: ["martes"],
    loteria_risaralda: ["viernes"],
    loteria_quindio: ["jueves"],
    loteria_narino: ["sabado"],
    loteria_valle: ["miercoles"]
  };

  return map[drawProvider] || [];
}
function getMaxTickets(drawProvider, drawMode) {
  if (drawProvider === "baloto") {
    if (drawMode === "baloto_2") return 903;
    if (drawMode === "baloto_3") return 12341;
    if (drawMode === "baloto_4") return 123410;
    if (drawMode === "baloto_5") return 962598;
  }

  if (drawProvider.startsWith("loteria_")) {
    if (drawMode === "loteria_2_primeras") return 100;
    if (drawMode === "loteria_2_ultimas") return 100;
    if (drawMode === "loteria_3_primeras") return 1000;
    if (drawMode === "loteria_3_ultimas") return 1000;
    if (drawMode === "loteria_4_primeras") return 10000;
    if (drawMode === "loteria_4_ultimas") return 10000;
  }

  return 0;
}

function getDrawProviderLabel(drawProvider) {
  if (drawProvider === "baloto") return "Baloto";
  if (drawProvider === "loteria_meta") return "Lotería del Meta";
  if (drawProvider === "loteria_bogota") return "Lotería de Bogotá";
  if (drawProvider === "loteria_medellin") return "Lotería de Medellín";
  if (drawProvider === "loteria_boyaca") return "Lotería de Boyacá";
  if (drawProvider === "loteria_tolima") return "Lotería del Tolima";
  if (drawProvider === "loteria_manizales") return "Lotería de Manizales";
  if (drawProvider === "loteria_cauca") return "Lotería del Cauca";
  if (drawProvider === "loteria_huila") return "Lotería del Huila";
  if (drawProvider === "loteria_santander") return "Lotería de Santander";
  if (drawProvider === "loteria_cruz_roja") return "Lotería de la Cruz Roja";
  if (drawProvider === "loteria_risaralda") return "Lotería de Risaralda";
  if (drawProvider === "loteria_quindio") return "Lotería del Quindío";
  if (drawProvider === "loteria_narino") return "Lotería de Nariño";
  if (drawProvider === "loteria_valle") return "Lotería del Valle";
  return drawProvider || "-";
}

function getDrawModeLabel(drawMode) {
  if (drawMode === "baloto_2") return "2 balotas";
  if (drawMode === "baloto_3") return "3 balotas";
  if (drawMode === "baloto_4") return "4 balotas";
  if (drawMode === "baloto_5") return "5 balotas";

  if (drawMode === "loteria_2_primeras") return "2 primeras cifras";
  if (drawMode === "loteria_2_ultimas") return "2 últimas cifras";
  if (drawMode === "loteria_3_primeras") return "3 primeras cifras";
  if (drawMode === "loteria_3_ultimas") return "3 últimas cifras";
  if (drawMode === "loteria_4_primeras") return "4 primeras cifras";
  if (drawMode === "loteria_4_ultimas") return "4 últimas cifras";

  return drawMode || "-";
}

function getWinningValueFromResult(drawMode, resultValue) {
  const clean = String(resultValue || "").replace(/\D/g, "");

  if (drawMode === "loteria_2_primeras") return clean.slice(0, 2);
  if (drawMode === "loteria_2_ultimas") return clean.slice(-2);
  if (drawMode === "loteria_3_primeras") return clean.slice(0, 3);
  if (drawMode === "loteria_3_ultimas") return clean.slice(-3);
  if (drawMode === "loteria_4_primeras") return clean.slice(0, 4);
  if (drawMode === "loteria_4_ultimas") return clean.slice(-4);

  return clean;
}

app.get("/", async (req, res) => {
  try {
    const { data: rifas, error } = await supabase
      .from("rifas")
      .select("id,title,prize,price_per_ticket,sold_tickets,max_tickets,slug,status")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(6);

    if (error) throw error;

    const cards = (rifas || []).map((r) => {
      const vendidos = Number(r.sold_tickets || 0);
      const maximos = Number(r.max_tickets || 0);
      const porcentaje = maximos > 0
        ? Math.min(100, Math.round((vendidos / maximos) * 100))
        : 0;

      const link = r.slug
        ? `/rifa/${r.slug}`
        : `/rifa-publica/${r.id}`;

      return `
        <a href="${link}" style="text-decoration:none;color:inherit;">
          <div class="card-rifa">
            <div class="card-top">
              <div>
                <div class="card-title">${r.title || "Rifa"}</div>
                <div class="card-prize">Premio: ${r.prize || "Premio"}</div>
              </div>
              <div class="card-price">$${Number(r.price_per_ticket || 0).toLocaleString("es-CO")}</div>
            </div>

            <div class="progress-wrap">
              <div class="progress-bar" style="width:${porcentaje}%;"></div>
            </div>

            <div class="card-meta">
              ${vendidos} vendidas de ${maximos}
            </div>

            <div class="card-btn">Participar</div>
          </div>
        </a>
      `;
    }).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PromoClaras</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f5f7fb;
      color: #111827;
    }

    .page {
      width: 100%;
      min-height: 100vh;
      background: #f5f7fb;
    }

    .topbar {
      background: linear-gradient(90deg, #0b3d91, #0f5cc0);
      color: white;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .brand {
      font-size: 28px;
      font-weight: 900;
      letter-spacing: -0.5px;
    }

    .brand span {
      color: #facc15;
    }

    .top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .top-link {
      text-decoration: none;
      color: white;
      font-weight: 700;
      font-size: 14px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(255,255,255,.12);
      white-space: nowrap;
    }

    .hero {
      padding: 18px 16px 20px 16px;
      background:
        linear-gradient(rgba(10,20,40,.45), rgba(10,20,40,.45)),
        linear-gradient(135deg, #133c8b, #1d4ed8 55%, #f97316);
      color: white;
    }

    .hero-box {
      max-width: 1200px;
      margin: 0 auto;
      padding: 28px 18px;
      border-radius: 24px;
      background: rgba(255,255,255,.08);
      backdrop-filter: blur(4px);
      box-shadow: 0 10px 30px rgba(0,0,0,.18);
    }

    .hero-title {
      font-size: 34px;
      line-height: 1.05;
      font-weight: 900;
      text-align: center;
      margin: 0 0 14px 0;
    }

    .hero-sub {
      font-size: 16px;
      line-height: 1.4;
      text-align: center;
      opacity: .95;
      margin-bottom: 18px;
    }

    .hero-buttons {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 420px;
      margin: 0 auto;
    }

    .btn-main, .btn-secondary {
      text-decoration: none;
      text-align: center;
      padding: 15px 16px;
      border-radius: 14px;
      font-weight: 900;
      font-size: 18px;
      display: block;
    }

    .btn-main {
      background: linear-gradient(180deg, #ff9a1f, #ff6a00);
      color: white;
      box-shadow: 0 8px 18px rgba(255,106,0,.28);
    }

    .btn-secondary {
      background: white;
      color: #0b3d91;
      box-shadow: 0 8px 18px rgba(0,0,0,.12);
    }

    .section {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 16px;
    }

    .section-title {
      font-size: 32px;
      font-weight: 900;
      color: #0b3d91;
      margin: 0 0 16px 0;
    }

    .cards-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }

    .card-rifa {
      background: white;
      border-radius: 20px;
      padding: 16px;
      box-shadow: 0 10px 24px rgba(0,0,0,.08);
      border: 1px solid #e5e7eb;
    }

    .card-top {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 12px;
    }

    .card-title {
      font-size: 28px;
      line-height: 1.05;
      font-weight: 900;
      color: #111827;
      margin-bottom: 6px;
    }

    .card-prize {
      font-size: 18px;
      color: #4b5563;
      font-weight: 700;
    }

    .card-price {
      font-size: 28px;
      font-weight: 900;
      color: #0b3d91;
    }

    .progress-wrap {
      height: 12px;
      background: #e5e7eb;
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #0ea5e9, #22c55e);
      border-radius: 999px;
    }

    .card-meta {
      font-size: 15px;
      color: #6b7280;
      margin-bottom: 14px;
      font-weight: 700;
    }

    .card-btn {
      background: linear-gradient(180deg, #ff9a1f, #ff6a00);
      color: white;
      text-align: center;
      padding: 13px 14px;
      border-radius: 14px;
      font-size: 18px;
      font-weight: 900;
      box-shadow: 0 6px 14px rgba(255,106,0,.22);
    }

    .steps {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }

    .step {
      background: white;
      border-radius: 18px;
      padding: 18px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 8px 20px rgba(0,0,0,.05);
      text-align: center;
    }

    .step-emoji {
      font-size: 52px;
      margin-bottom: 10px;
    }

    .step-title {
      font-size: 22px;
      font-weight: 900;
      color: #0b3d91;
      margin-bottom: 8px;
    }

    .step-text {
      font-size: 16px;
      color: #4b5563;
      line-height: 1.4;
    }

    .footer-cta {
      padding: 10px 16px 34px 16px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .footer-box {
      background: linear-gradient(135deg, #0b3d91, #f97316);
      border-radius: 24px;
      padding: 24px 18px;
      color: white;
      text-align: center;
    }

    .footer-title {
      font-size: 28px;
      font-weight: 900;
      margin-bottom: 12px;
    }

    .footer-text {
      font-size: 16px;
      opacity: .95;
      margin-bottom: 16px;
    }

    .footer-btn {
      display: inline-block;
      text-decoration: none;
      background: white;
      color: #0b3d91;
      padding: 14px 18px;
      border-radius: 14px;
      font-size: 18px;
      font-weight: 900;
    }

    .empty {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 18px;
      padding: 20px;
      color: #6b7280;
      font-weight: 700;
    }

    @media (min-width: 768px) {
      .hero-title {
        font-size: 56px;
      }

      .hero-buttons {
        flex-direction: row;
        max-width: 760px;
      }

      .hero-buttons a {
        flex: 1;
      }

      .cards-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .steps {
        grid-template-columns: repeat(3, 1fr);
      }
    }

    @media (min-width: 1024px) {
      .cards-grid {
        grid-template-columns: repeat(3, 1fr);
      }

      .card-top {
        min-height: 135px;
      }
    }
  </style>
</head>
<body>
  <div class="page">

    <div class="topbar">
      <div class="brand">Promo<span>Claras</span></div>
      <div class="top-actions">
        <a class="top-link" href="/rifas">Ver Campañas</a>
        <a class="top-link" href="/organizers/login">Acceso Organizadores</a>
      </div>
    </div>

    <div class="hero">
      <div class="hero-box">
        <div class="hero-title">La forma fácil de crear campañas promocionales online en Colombia</div>
        <div class="hero-sub">
          Crea y administra campañas promocionales digitales con pagos seguros y asignación automática de cupones.
        </div>

        <div class="hero-buttons">
          <a class="btn-main" href="/organizers/register">Quiero Crear una Campaña</a>
          <a class="btn-secondary" href="/rifas">Participar en una Campaña</a>
        </div>
      </div>
    </div>

    <div class="section">
     <div class="section-title">🎟 Campañas destacadas</div>
      <div class="cards-grid">
        ${cards || `<div class="empty">Aún no hay campañas activas.</div>`}
      </div>
    </div>

    <div class="section">
      <div class="section-title">🔥 ¿Cómo Funciona?</div>
      <div class="steps">
        <div class="step">
          <div class="step-emoji">📱</div>
          <div class="step-title">1. Crea tu cuenta</div>
          <div class="step-text">Regístrate como organizador y administra todo desde tu panel.</div>
        </div>

        <div class="step">
          <div class="step-emoji">📣</div>
          <div class="step-title">2. Publica tu campaña</div>
          <div class="step-text">Configura premio, valor por boleta, cantidad y fecha del sorteo.</div>
        </div>

        <div class="step">
          <div class="step-emoji">💸</div>
          <div class="step-title">3. Comparte tu campaña</div>
          <div class="step-text">Comparte tu link y recibe pagos seguros para crecer tus ventas.</div>
        </div>
      </div>
    </div>

    <div class="footer-cta">
      <div class="footer-box">
        <div class="footer-title">Empieza hoy con PromoClaras</div>
        <div class="footer-text">Crea tu primera campaña y compártela en WhatsApp, Facebook e Instagram.</div>
        <a class="footer-btn" href="/organizers/register">Crear mi cuenta</a>
      </div>
    </div>

 <div style="text-align:center;padding:20px;color:#6b7280;font-size:14px;">
  <a href="/terminos" style="color:#0b3d91;text-decoration:none;font-weight:600;margin-right:15px;">Términos y Condiciones</a>
  <a href="/privacidad" style="color:#0b3d91;text-decoration:none;font-weight:600;margin-right:15px;">Política de Privacidad</a>
  <a href="/contacto" style="color:#0b3d91;text-decoration:none;font-weight:600;">Contacto</a>
</div>

</body>
</html>
    `);
  } catch (e) {
    return res.status(500).send(e.message);
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

    if (error || !rifa) {
  return res.status(404).send("Rifa no encontrada");
}

const colombiaNow = new Date(
  new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })
);

const today = colombiaNow.toLocaleDateString("en-CA");
const drawDateOnly = String(rifa.draw_date || "").slice(0, 10);
const hour = colombiaNow.getHours();

// 🔴 BLOQUEO DE COMPRA
if (today > drawDateOnly || (today === drawDateOnly && hour >= 18)) {
  return res.status(400).send("Esta campaña ya está cerrada.");
}

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
    if (qty > 20) {
  return res.status(400).send("Máximo 20 cupones por compra.");
}
    
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

if (rifa.status !== "approved") {
  return res.status(400).send("Esta campaña aún no está aprobada para recibir compras.");
}
    const colombiaNow = new Date(
  new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })
);

const today = colombiaNow.toLocaleDateString("en-CA");
const drawDateOnly = String(rifa.draw_date || "").slice(0, 10);
const hour = colombiaNow.getHours();

if (today === drawDateOnly && hour >= 18) {
  return res.status(400).send("Las compras para esta campaña cerraron a las 6:00 p. m.");
}
const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

const { data: recentOrders, error: recentOrdersError } = await supabase
  .from("orders")
  .select("id, created_at")
  .eq("buyer_phone", buyerPhone)
  .gte("created_at", tenMinutesAgo);

if (recentOrdersError) throw recentOrdersError;

if ((recentOrders || []).length >= 3) {
  return res.status(429).send("Has realizado demasiados intentos de compra en pocos minutos. Intenta nuevamente más tarde.");
}
    const { data: buyerOrders, error: buyerOrdersError } = await supabase
  .from("orders")
  .select("qty")
  .eq("rifa_id", rifaId)
  .eq("buyer_phone", buyerPhone);

if (buyerOrdersError) throw buyerOrdersError;

const totalBoughtByPhone = (buyerOrders || []).reduce((acc, o) => acc + Number(o.qty || 0), 0);

if (totalBoughtByPhone + qty > 50) {
  return res.status(400).send("No puedes superar 50 cupones en esta campaña con el mismo número.");
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

   const externalReference = `${rifaId}|${buyerPhone}|${Date.now()}`;
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
      provider: "mercadopago",
      external_reference: externalReference,
      amount: total,
      status: "pending",
    });

  if (paymentInsertError) throw paymentInsertError;

  const formHtml = `
    <!DOCTYPE html>
    <html lang="es">
    <body onload="document.forms[0].submit()">
      <form action="/crear-pago" method="POST">
        <input type="hidden" name="rifa_id" value="${rifaId}">
        <input type="hidden" name="quantity" value="${qty}">
        <input type="hidden" name="precio" value="${rifa.price_per_ticket}">
        <input type="hidden" name="buyer_name" value="${buyerName}">
        <input type="hidden" name="buyer_phone" value="${buyerPhone}">
        <input type="hidden" name="buyer_email" value="${buyerEmail || ""}">
      </form>
      <p>Redirigiendo a Mercado Pago...</p>
    </body>
    </html>
  `;

  return res.send(formHtml);
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
        <label><b>Nombre de la campaña</b></label><br/>
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
   const organizerId = req.session.organizerId;

    const { data: organizer, error: organizerError } = await supabase
  .from("organizers")
  .select("profile_id")
  .eq("id", organizerId)
  .single();

if (organizerError || !organizer) {
  return res.status(404).send("Organizador no encontrado");
}

const ownerId = organizer.profile_id;
console.log("organizerId:", organizerId);
console.log("profile_id real:", organizer.profile_id);
console.log("ownerId que voy a insertar:", ownerId);
    console.log("organizerId:", organizerId);
console.log("profile_id:", organizer.profile_id);
    const title = String(req.body.title || "").trim();
    const prize = String(req.body.prize || "").trim();
    const description = String(req.body.description || "").trim();
    const modality = Number(req.body.modality || 3);
    const pricePerTicket = Number(req.body.price_per_ticket || 0);
    const drawMode = req.body.draw_mode;
    const drawProvider = req.body.draw_provider;
    const maxTickets = getMaxTickets(drawProvider, drawMode);
    const drawDateRaw = String(req.body.draw_date || "").trim();

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

const now = new Date();

if (drawDate <= now) {
  return res.status(400).send("La fecha del sorteo debe ser futura.");
}

    
const selectedDay = getDayNameEs(drawDate);
const allowedDays = getAllowedDays(drawProvider);

if (!allowedDays.length) {
  return res.status(400).send("Tipo de sorteo inválido.");
}

if (!allowedDays.includes(selectedDay)) {
  return res.status(400).send(
    `La fecha seleccionada no corresponde a un día válido para este sorteo. Debe ser: ${allowedDays.join(", ")}.`
  );
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
if (!title || title.trim().length < 5) {
  return res.status(400).send("El título debe tener al menos 5 caracteres.");
}

if (!description || description.trim().length < 20) {
  return res.status(400).send("La descripción debe tener al menos 20 caracteres.");
}

if (!prize || prize.trim().length < 3) {
  return res.status(400).send("Debes indicar el premio.");
}

if (!pricePerTicket || Number(pricePerTicket) <= 0) {
  return res.status(400).send("El valor del cupón debe ser mayor a 0.");
}

if (!maxTickets || Number(maxTickets) <= 0) {
  return res.status(400).send("La cantidad de cupones debe ser válida.");
}
    
    const { data: rifa, error } = await supabase
      .from("rifas")
      .insert({
        owner_id: ownerId,
        title,
        prize,
        description,
        draw_provider: drawProvider,
        modality,
        price_per_ticket: pricePerTicket,
        max_tickets: maxTickets,
        sold_tickets: 0,
        available_tickets: maxTickets,
        draw_date: drawDate.toISOString(),
        status: "pending",
        slug,
      })
      .select()
      .single();

    if (error) throw error;

    const base = getBaseUrl(req);
    return res.redirect(`${base}/organizers/${req.session.organizerId}/panel`);
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
            <th style="padding:14px;text-align:left;">Campaña</th>
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
<div style="margin-top:6px;color:#475569;">Sorteo: <b>${getDrawProviderLabel(rifa.draw_provider)}</b></div>
<div style="margin-top:6px;color:#475569;">Modalidad: <b>${getDrawModeLabel(rifa.draw_mode || rifa.modality)}</b></div>
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
            <label style="display:block;font-size:14px;font-weight:700;margin-bottom:6px;">
  ${String(rifa.draw_provider || "").startsWith("loteria_") ? "Resultado oficial de 4 cifras" : "Combinación ganadora"}
</label>
<input
  type="text"
  name="winning_combination"
  placeholder="${String(rifa.draw_provider || "").startsWith("loteria_") ? "Ej: 5837" : "Ej: 12-40-41"}"
  required
  style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;box-sizing:border-box;font-size:15px;"
/>

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

    const profileId = crypto.randomUUID();
    
const { error: profileError } = await supabase
  .from("profiles")
  .insert({
    id: profileId
  });

if (profileError) throw profileError;
    
const { data: organizer, error } = await supabase
  .from("organizers")
  .insert({
    full_name: fullName,
    email,
    phone: phone || null,
    password,
    profile_id: profileId,
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

<div style="margin-top:14px;text-align:center;">
  <a href="/organizers/forgot-password" style="color:#2563eb;text-decoration:none;font-weight:600;">
    ¿Olvidaste tu contraseña?
  </a>
</div>

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

   req.session.organizerId = organizer.id;
return res.redirect(`/organizers/${organizer.id}/panel`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/organizers/forgot-password", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<title>Recuperar contraseña</title>
</head>

<body style="font-family:Arial;background:#f4f7fb;margin:0;padding:40px;">

<div style="max-width:420px;margin:auto;background:#fff;padding:25px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.08);">

<h2>Recuperar contraseña</h2>

<form method="POST" action="/organizers/forgot-password">

<div style="margin-bottom:14px;">
<label>Correo</label><br/>
<input type="email" name="email" required
style="width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;margin-top:5px;">
</div>

<button type="submit"
style="background:#2563eb;color:white;border:none;padding:12px 18px;border-radius:8px;font-weight:bold;width:100%;">
Buscar cuenta
</button>

</form>

<div style="margin-top:14px;text-align:center;">
<a href="/organizers/login">Volver al login</a>
</div>

</div>

</body>
</html>
`);
});

app.post("/organizers/forgot-password", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).send("Falta el correo");
    }

    const { data: organizer, error } = await supabase
      .from("organizers")
      .select("id, email, full_name")
      .eq("email", email)
      .maybeSingle();

    if (error) throw error;

    if (!organizer) {
      return res.status(404).send("No existe un organizador con ese correo");
    }

    return res.redirect(`/organizers/reset-password/${organizer.id}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/organizers/reset-password/:organizerId", async (req, res) => {
  try {
    const { organizerId } = req.params;

    const { data: organizer, error } = await supabase
      .from("organizers")
      .select("id, email, full_name")
      .eq("id", organizerId)
      .single();

    if (error || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Nueva contraseña</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
  <div style="max-width:520px;margin:60px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
    <h1 style="margin-top:0;">Nueva contraseña</h1>
    <div style="margin-bottom:12px;color:#64748b;">Organizador: ${organizer.full_name || organizer.email}</div>

    <form method="POST" action="/organizers/reset-password/${organizer.id}">
      <div style="margin-bottom:14px;">
        <label><b>Nueva contraseña</b></label><br/>
        <input type="password" name="password" required minlength="4"
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:18px;">
        <label><b>Confirmar contraseña</b></label><br/>
        <input type="password" name="confirm_password" required minlength="4"
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <button type="submit"
        style="width:100%;background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;">
        Guardar nueva contraseña
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

app.post("/organizers/reset-password/:organizerId", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { organizerId } = req.params;
    const password = String(req.body.password || "").trim();
    const confirmPassword = String(req.body.confirm_password || "").trim();

    if (!password || !confirmPassword) {
      return res.status(400).send("Faltan datos");
    }

    if (password !== confirmPassword) {
      return res.status(400).send("Las contraseñas no coinciden");
    }

    if (password.length < 4) {
      return res.status(400).send("La contraseña debe tener al menos 4 caracteres");
    }

    const { error } = await supabase
      .from("organizers")
      .update({ password })
      .eq("id", organizerId);

    if (error) throw error;

    return res.redirect("/organizers/login");
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/organizers/:organizerId/panel", async (req, res) => {
  try {
    const { organizerId } = req.params;

if (!req.session.organizerId) {
  return res.redirect("/organizers/login");
}

if (String(req.session.organizerId) !== String(organizerId)) {
  return res.redirect("/organizers/login");
}
    
    const { data: organizer, error: organizerError } = await supabase
      .from("organizers")
      .select("*")
      .eq("id", organizerId)
      .single();
let verificationBadge = "";

if(organizer.verification_status === "verified"){
verificationBadge = `
<div style="
background:#e8f7ee;
color:#1a7f37;
padding:10px;
border-radius:10px;
margin-bottom:10px;
font-weight:600;
">
✔ Organizador verificado
</div>
`;
}
    if (organizerError || !organizer) {
  return res.status(404).send("Organizador no encontrado");
}

if (!organizer.profile_id) {
  return res.status(400).send("El organizador no tiene profile_id asociado");
}
    
let verificationBanner = "";
let requestsBanner = "";
if (organizer.verification_status === "pending") {
  verificationBanner = `
    <div style="
      background:#fff3cd;
      color:#856404;
      border:1px solid #ffe69c;
      padding:14px 16px;
      border-radius:12px;
      margin:18px 0;
      font-weight:600;
    ">
      Tu cuenta está en verificación. Nuestro equipo revisará tus documentos pronto.
    </div>
  `;
} else if (organizer.verification_status === "rejected") {
  verificationBanner = `
    <div style="
      background:#f8d7da;
      color:#842029;
      border:1px solid #f5c2c7;
      padding:14px 16px;
      border-radius:12px;
      margin:18px 0;
      font-weight:600;
    ">
      Tu verificación fue rechazada. Debes cargar nuevamente tus documentos.
      <div style="margin-top:10px;">
        <a href="/organizers/${organizer.id}/verificacion" style="
          display:inline-block;
          background:#dc3545;
          color:white;
          text-decoration:none;
          padding:10px 14px;
          border-radius:10px;
          font-weight:700;
        ">Subir documentos otra vez</a>
      </div>
    </div>
  `;
} else if (organizer.verification_status !== "verified") {
  verificationBanner = `
    <div style="
      background:#fff3cd;
      color:#856404;
      border:1px solid #ffe69c;
      padding:14px 16px;
      border-radius:12px;
      margin:18px 0;
      font-weight:600;
    ">
      Debes completar tu verificación antes de publicar campañas.
      <div style="margin-top:10px;">
        <a href="/organizers/${organizer.id}/verificacion" style="
          display:inline-block;
          background:#0b5ed7;
          color:white;
          text-decoration:none;
          padding:10px 14px;
          border-radius:10px;
          font-weight:700;
        ">Completar verificación</a>
      </div>
    </div>
  `;
}
    
    if (organizerError || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

  const { data: rifas, error: rifasError } = await supabase
  .from("rifas")
  .select("*")
  .eq("owner_id", organizer.profile_id)
  .order("created_at", { ascending: false });

    if (rifasError) throw rifasError;

const { data: pendingRequests, error: pendingRequestsError } = await supabase
  .from("campaign_requests")
  .select("*")
  .eq("organizer_id", organizerId)
  .eq("status", "pending")
  .order("created_at", { ascending: false });

if (pendingRequestsError) throw pendingRequestsError;
    
    const rows = (rifas || []).map((r) => `
  <tr>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${r.title || ""}</td>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${r.prize || ""}</td>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${getDrawProviderLabel(r.draw_provider)}</td>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;">${getDrawModeLabel(r.draw_mode || r.modality)}</td>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.sold_tickets || 0}</td>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.available_tickets || 0}</td>
    <td style="padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;">$${Number(r.price_per_ticket || 0).toLocaleString("es-CO")}</td>
    <td style="padding:14px;text-align:center;">${r.status || ""}</td>
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
        ${organizer.verification_status === "verified" ? 
`<div style="color:green;font-weight:bold;margin-top:8px;">
✔ Organizador verificado
</div>` : ""}
        <div style="margin-bottom:18px;color:#64748b;">Correo: ${organizer.email}</div>
        
<div style="margin-top:10px;font-size:14px;color:#555;">
<b>Rifas realizadas:</b> ${organizer.raffles_created}<br>
<b>Premios entregados:</b> ${organizer.prizes_delivered}<br>
<b>Reputación:</b> ${
organizer.raffles_created === 0
? "100%"
: Math.round((organizer.prizes_delivered / organizer.raffles_created) * 100) + "%"
}
</div>
        ${verificationBanner}
        ${requestsBanner}
${organizer.verification_status === "verified" ? `
<div style="margin-bottom:20px;">
  <a href="/organizers/${organizer.id}/crear-rifa"
     style="background:#16a34a;color:white;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">
    + Crear nueva rifa
  </a>
</div>
` : `
<div style="margin-bottom:20px;background:#fef3c7;color:#92400e;padding:12px 16px;border-radius:8px;font-weight:600;">
  Debes ser aprobado por el administrador para crear rifas.
</div>
`}
        <div style="background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);overflow:auto;">
          <table style="width:100%;border-collapse:collapse;min-width:800px;">
            <thead style="background:#0f172a;color:white;">
             <tr>
  <th style="padding:14px;text-align:left;">Campaña</th>
  <th style="padding:14px;text-align:left;">Premio</th>
  <th style="padding:14px;text-align:left;">Sorteo</th>
  <th style="padding:14px;text-align:left;">Modalidad</th>
  <th style="padding:14px;text-align:center;">Vendidas</th>
  <th style="padding:14px;text-align:center;">Disponibles</th>
  <th style="padding:14px;text-align:right;">Precio</th>
  <th style="padding:14px;text-align:center;">Estado</th>
</tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="8" style="padding:18px;">Este organizador aún no tiene campañas.</td></tr>`}
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
      return res.status(404).send("Campaña no encontrada");
    }

    let normalizedWinningValue = winningCombination;

    if (String(rifa.draw_provider || "").startsWith("loteria_")) {
      const cleanResult = String(winningCombination).replace(/\D/g, "");
      if (cleanResult.length !== 4) {
        return res.status(400).send("Para loterías debes ingresar exactamente 4 cifras.");
      }

      normalizedWinningValue = getWinningValueFromResult(rifa.draw_mode, cleanResult);

      const { error: updateRifaError } = await supabase
        .from("rifas")
        .update({
          result_value: cleanResult,
          result_loaded_manually: true
        })
        .eq("id", rifaId);

      if (updateRifaError) throw updateRifaError;
    }

    const { data: winnerTicket, error: ticketError } = await supabase
      .from("tickets")
      .select("*")
      .eq("rifa_id", rifaId)
      .eq("combination", normalizedWinningValue)
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
        winning_combination: normalizedWinningValue,
        winner_ticket_id: winnerTicket?.id || null,
        winner_buyer_id: winnerBuyerId || null,
      });

    if (insertError) throw insertError;

    return res.redirect(`/panel/rifa/${rifaId}?resultado=${encodeURIComponent(normalizedWinningValue)}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/organizers/:organizerId/crear-rifa", async (req, res) => {
  try {
    const { organizerId } = req.params;

    const { data: organizer, error } = await supabase
      .from("organizers")
      .select("*")
      .eq("id", organizerId)
      .single();
const { data: lotteries } = await supabase
.from("lotteries")
.select("*")
.eq("active", true)
.order("name");
    if (error || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

    if (organizer.verification_status !== "verified") {
      return res.status(403).send("Tu cuenta aún no ha sido aprobada por el administrador.");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const lotteriesOptions = (lotteries || [])
.map(l => `<option value="${l.code}">${l.name}</option>`)
.join("");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Crear campaña</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
  <div style="max-width:760px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
    <h1 style="margin-top:0;">Crear campaña</h1>
    <div style="margin-bottom:16px;color:#64748b;">Organizador: ${organizer.full_name}</div>

    <form method="POST" action="/organizers/${organizer.id}/crear-rifa">
      <div style="margin-bottom:12px;">
        <label><b>Nombre de la campaña</b></label><br/>
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
  <label><b>Tipo de sorteo</b></label><br/>
  <select name="draw_provider" id="draw_provider"
    style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;">
    <option value="baloto">Baloto</option>
    <option value="loteria_meta">Lotería del Meta</option>
    <option value="loteria_bogota">Lotería de Bogotá</option>
    <option value="loteria_medellin">Lotería de Medellín</option>
    <option value="loteria_boyaca">Lotería de Boyacá</option>
    <option value="loteria_tolima">Lotería del Tolima</option>
    <option value="loteria_manizales">Lotería de Manizales</option>
    <option value="loteria_cauca">Lotería del Cauca</option>
    <option value="loteria_huila">Lotería del Huila</option>
    <option value="loteria_santander">Lotería de Santander</option>
    <option value="loteria_cruz_roja">Lotería de la Cruz Roja</option>
    <option value="loteria_risaralda">Lotería de Risaralda</option>
    <option value="loteria_quindio">Lotería del Quindío</option>
    <option value="loteria_narino">Lotería de Nariño</option>
    <option value="loteria_valle">Lotería del Valle</option>
  </select>

  <div id="draw_days_info" style="margin-top:8px;color:#2563eb;font-size:14px;font-weight:600;">
    Baloto juega: lunes, miércoles y viernes
  </div>
</div>

      <div style="margin-bottom:12px;">
        <label><b>Modalidad</b></label><br/>
        <select name="draw_mode" id="draw_mode"
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;">
        </select>
      </div>

      <div id="tickets_info" style="margin-bottom:12px;font-size:13px;color:#6b7280;"></div>

      <div style="margin-bottom:12px;">
        <label><b>Precio por cupón</b></label><br/>
        <input type="number" name="price_per_ticket" min="1" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:18px;">
        <label><b>Fecha del sorteo</b></label><br/>
        <input type="date" name="draw_date" required
          style="width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:6px;box-sizing:border-box;" />
      </div>

      <button type="submit"
        style="background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;width:100%;">
        Crear campaña
      </button>
    </form>
  </div>

<script>
  const drawProvider = document.getElementById("draw_provider");
  const drawMode = document.getElementById("draw_mode");
  const ticketsInfo = document.getElementById("tickets_info");

  function getMaxTicketsFrontend(provider, mode) {
    if (provider === "baloto") {
      if (mode === "baloto_2") return 903;
      if (mode === "baloto_3") return 12341;
      if (mode === "baloto_4") return 123410;
      if (mode === "baloto_5") return 962598;
    }

    if (provider.startsWith("loteria_")) {
      if (mode === "loteria_2_primeras") return 100;
      if (mode === "loteria_2_ultimas") return 100;
      if (mode === "loteria_3_primeras") return 1000;
      if (mode === "loteria_3_ultimas") return 1000;
      if (mode === "loteria_4_primeras") return 10000;
      if (mode === "loteria_4_ultimas") return 10000;
    }

    return 0;
  }

  function reloadModes() {
    const provider = drawProvider.value;

    if (provider === "baloto") {
      drawMode.innerHTML = \`
        <option value="baloto_2">2 balotas</option>
        <option value="baloto_3" selected>3 balotas</option>
        <option value="baloto_4">4 balotas</option>
        <option value="baloto_5">5 balotas</option>
      \`;
    } else {
      drawMode.innerHTML = \`
        <option value="loteria_2_primeras">2 primeras cifras</option>
        <option value="loteria_2_ultimas">2 últimas cifras</option>
        <option value="loteria_3_primeras">3 primeras cifras</option>
        <option value="loteria_3_ultimas">3 últimas cifras</option>
        <option value="loteria_4_primeras">4 primeras cifras</option>
        <option value="loteria_4_ultimas">4 últimas cifras</option>
      \`;
    }

    updateTicketsInfo();
  }

  function updateTicketsInfo() {
    const total = getMaxTicketsFrontend(drawProvider.value, drawMode.value);
    ticketsInfo.innerHTML = "Total automático de cupones posibles: <b>" + total.toLocaleString("es-CO") + "</b>";
  }

  drawProvider.addEventListener("change", reloadModes);
  drawProvider.addEventListener("change", updateDrawDaysInfo);
  drawMode.addEventListener("change", updateTicketsInfo);

  function updateDrawDaysInfo() {
  const map = {
    baloto: "Baloto juega: lunes, miércoles y viernes",

    loteria_meta: "Lotería del Meta juega: miércoles",
    loteria_bogota: "Lotería de Bogotá juega: jueves",
    loteria_medellin: "Lotería de Medellín juega: viernes",
    loteria_boyaca: "Lotería de Boyacá juega: sábado",
    loteria_tolima: "Lotería del Tolima juega: lunes",
    loteria_manizales: "Lotería de Manizales juega: miércoles",
    loteria_cauca: "Lotería del Cauca juega: sábado",
    loteria_huila: "Lotería del Huila juega: martes",
    loteria_santander: "Lotería de Santander juega: viernes",
    loteria_cruz_roja: "Lotería de la Cruz Roja juega: martes",
    loteria_risaralda: "Lotería de Risaralda juega: viernes",
    loteria_quindio: "Lotería del Quindío juega: jueves",
    loteria_narino: "Lotería de Nariño juega: sábado",
    loteria_valle: "Lotería del Valle juega: miércoles"
  };

  drawDaysInfo.textContent = map[drawProvider.value] || "Selecciona un tipo de sorteo";
}
  

  reloadModes();
</script>
</body>
</html>
    `);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.post("/organizers/:organizerId/crear-rifa", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { organizerId } = req.params;
    const title = String(req.body.title || "").trim();
    const prize = String(req.body.prize || "").trim();
    const description = String(req.body.description || "").trim();
    const drawProvider = String(req.body.draw_provider || "baloto").trim();
    const drawMode = String(req.body.draw_mode || "baloto_3").trim();
    const pricePerTicket = Number(req.body.price_per_ticket || 0);
    const drawDateRaw = String(req.body.draw_date || "").trim();
    const drawDateOnly = String(req.body.draw_date || "").slice(0, 10);

    const { data: organizerCheck, error: organizerCheckError } = await supabase
      .from("organizers")
      .select("*")
      .eq("id", organizerId)
      .single();

    if (organizerCheckError || !organizerCheck) {
      return res.status(404).send("Organizador no encontrado");
    }

    if (organizerCheck.verification_status !== "verified") {
      return res.status(403).send("Tu cuenta aún no ha sido aprobada por el administrador.");
    }

    if (!title || !prize || !drawDateRaw) {
      return res.status(400).send("Faltan campos obligatorios");
    }

    if (!Number.isFinite(pricePerTicket) || pricePerTicket <= 0) {
      return res.status(400).send("Precio inválido");
    }

    const maxTickets = getMaxTickets(drawProvider, drawMode);
    if (maxTickets <= 0) {
      return res.status(400).send("Modalidad inválida");
    }

    const drawDate = new Date(drawDateRaw);
    if (Number.isNaN(drawDate.getTime())) {
      return res.status(400).send("Fecha inválida");
    }

    let slug = slugify(title);
    if (!slug) slug = `campana-${Date.now()}`;

    const { data: existingSlug } = await supabase
      .from("rifas")
      .select("id, slug")
      .eq("slug", slug)
      .maybeSingle();

    if (existingSlug) {
      slug = `${slug}-${Date.now().toString().slice(-6)}`;
    }

    const { data: organizer, error: organizerError } = await supabase
      .from("organizers")
      .select("*")
      .eq("id", organizerId)
      .single();

    if (organizerError || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

    if (!organizer.profile_id) {
      return res.status(400).send("El organizador no tiene profile_id asociado");
    }

    if (!title || title.trim().length < 5) {
      return res.status(400).send("El título debe tener al menos 5 caracteres.");
    }

    if (!description || description.trim().length < 20) {
      return res.status(400).send("La descripción debe tener al menos 20 caracteres.");
    }

    if (!prize || prize.trim().length < 3) {
      return res.status(400).send("Debes indicar el premio.");
    }

    const nowDate = new Date();
    const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).toISOString();
    const nextMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 1).toISOString();

    const { data: monthlyCampaigns, error: monthlyError } = await supabase
      .from("rifas")
      .select("id")
      .eq("owner_id", organizer.profile_id)
      .gte("created_at", monthStart)
      .lt("created_at", nextMonthStart);

    if (monthlyError) throw monthlyError;

    const monthlyCount = (monthlyCampaigns || []).length;
   
    if (monthlyCount >= 2) {
      const { error: requestError } = await supabase
        .from("campaign_requests")
        .insert({
          organizer_id: organizerId,
          requested_title: title,
          requested_prize: prize,
          requested_description: description,
          requested_draw_provider: drawProvider,
          requested_draw_mode: drawMode,
          requested_modality: drawMode,
          requested_price_per_ticket: pricePerTicket,
          requested_max_tickets: maxTickets,
          requested_draw_date: drawDate.toISOString(),
          status: "pending"
        });

      if (requestError) throw requestError;

      return res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Solicitud enviada</title>
      </head>
      <body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;">
        <div style="max-width:700px;margin:0 auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;">
          <h1 style="color:#0b5ed7;margin-top:0;">Solicitud enviada</h1>
          <p style="font-size:17px;color:#374151;line-height:1.6;">
            Ya alcanzaste el límite de <b>2 campañas en este mes</b>.
          </p>
          <p style="font-size:16px;color:#6b7280;line-height:1.6;">
            Tu solicitud fue enviada al administrador para revisión.
          </p>
          <a href="/organizers/${organizerId}/panel" style="
            display:inline-block;
            margin-top:16px;
            background:#16a34a;
            color:white;
            text-decoration:none;
            padding:12px 18px;
            border-radius:10px;
            font-weight:700;
          ">Volver al panel</a>
        </div>
      </body>
      </html>
      `);
    }

    const { error: insertError } = await supabase
      .from("rifas")
      .insert({
        owner_id: organizer.profile_id,
        title,
        prize,
        description,
        draw_provider: drawProvider,
        draw_mode: drawMode,
        modality: drawMode,
        price_per_ticket: pricePerTicket,
        max_tickets: maxTickets,
        sold_tickets: 0,
        available_tickets: maxTickets,
        draw_date: drawDateOnly,
        status: "pending",
        slug,
        result_value: null,
        result_loaded_manually: false
      });

    if (insertError) throw insertError;

    return res.redirect(`/organizers/${organizerId}/panel`);
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

    if (!rifa || rifa.status !== "approved") {
  return res.status(404).send("Campaña no disponible");
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
  .from("rifas")
  .select("*")
  .eq("id", rifaId)
  .single();

if (error || !rifa) {
  return res.status(404).send("Rifa no existe");
}

if (rifa.status !== "approved") {
  return res.status(404).send("Campaña no disponible");
}
let estadoTexto = "Campaña";
let estadoColor = "#6c757d";

if (rifa.status === "approved") {
  estadoTexto = "🟢 Campaña activa";
  estadoColor = "#28a745";
} else if (rifa.status === "pending") {
  estadoTexto = "🟡 En revisión";
  estadoColor = "#ffc107";
} else if (rifa.status === "rejected") {
  estadoTexto = "🔴 No aprobada";
  estadoColor = "#dc3545";
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
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f5f7fb;
      color: #111827;
    }

    .page {
      max-width: 520px;
      margin: 0 auto;
      min-height: 100vh;
      background: #f5f7fb;
    }

    .hero {
      background: linear-gradient(135deg, #0b3d91, #1d4ed8 55%, #f97316);
      color: white;
      padding: 18px 16px 26px 16px;
      border-bottom-left-radius: 24px;
      border-bottom-right-radius: 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,.15);
    }

.share-box{
margin-top:14px;
}

.wa-btn{
display:block;
width:100%;
text-align:center;
background:#25D366;
color:white;
text-decoration:none;
border-radius:12px;
padding:12px 14px;
font-size:16px;
font-weight:700;
margin-top:10px;
box-shadow:0 8px 18px rgba(37,211,102,.25);
}

.notice{
margin-top:12px;
padding:12px;
background:#eef3ff;
border-radius:10px;
font-size:13px;
color:#2b3a55;
}

.progress-bg{
height:16px;
background:#e5e7eb;
border-radius:10px;
overflow:hidden;
margin-top:6px;
}

.progress-bar{
height:100%;
background:linear-gradient(90deg,#22c55e,#16a34a);
border-radius:8px;
}

.campaign-info{
margin-top:16px;
background:white;
border-radius:12px;
padding:14px;
box-shadow:0 4px 12px rgba(0,0,0,.06);
}

.info-row{
display:flex;
justify-content:space-between;
font-size:14px;
margin-bottom:6px;
}

.info-label{
font-weight:600;
color:#374151;
}

.info-value{
color:#111827;
font-weight:500;
}

    .badge {
      display: inline-block;
      background: rgba(255,255,255,.18);
      padding: 8px 12px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 12px;
    }

    .title {
      font-size: 34px;
      line-height: 1.05;
      font-weight: 900;
      margin-bottom: 10px;
    }

    .prize {
      font-size: 18px;
      font-weight: 700;
      opacity: .96;
    }

    .content {
      padding: 16px;
    }

    .card {
      background: white;
      border-radius: 20px;
      padding: 16px;
      box-shadow: 0 10px 24px rgba(0,0,0,.08);
      border: 1px solid #e5e7eb;
      margin-bottom: 14px;
    }

    .section-title {
      font-size: 22px;
      font-weight: 900;
      margin: 0 0 12px 0;
      color: #0b3d91;
    }

    .desc {
      font-size: 16px;
      line-height: 1.5;
      color: #4b5563;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-top: 14px;
    }

    .stat {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      padding: 14px;
      text-align: center;
    }

    .stat-label {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 6px;
      font-weight: 700;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 900;
      color: #111827;
    }

    .price {
      color: #0b3d91;
    }

    .progress-wrap {
      margin-top: 14px;
      margin-bottom: 10px;
    }

    .progress-label {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      color: #4b5563;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .progress-bg {
      width: 100%;
      height: 14px;
      background: #e5e7eb;
      border-radius: 999px;
      overflow: hidden;
    }

    .progress-bar {
      height: 100%;
      width: ${porcentaje}%;
      background: linear-gradient(90deg, #22c55e, #16a34a);
      border-radius: 999px;
    }

    .notice {
      background: #eff6ff;
      color: #1e3a8a;
      border: 1px solid #bfdbfe;
      border-radius: 16px;
      padding: 14px;
      font-size: 15px;
      line-height: 1.5;
      font-weight: 600;
    }

    .wa-btn, .buy-btn {
      display: block;
      width: 100%;
      text-decoration: none;
      text-align: center;
      padding: 14px 16px;
      border-radius: 14px;
      font-weight: 900;
      font-size: 17px;
      border: none;
      cursor: pointer;
    }

    .wa-btn {
      background: #25D366;
      color: white;
      margin-bottom: 14px;
    }

    .buy-btn {
      background: linear-gradient(180deg, #ff9a1f, #ff6a00);
      color: white;
      margin-top: 6px;
      box-shadow: 0 8px 18px rgba(255,106,0,.25);
    }

    label {
      display: block;
      font-size: 14px;
      font-weight: 800;
      margin-bottom: 6px;
      color: #374151;
    }

    input {
      width: 100%;
      padding: 12px;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      font-size: 16px;
      margin-bottom: 14px;
      background: white;
    }

    .small-text {
      color: #6b7280;
      font-size: 13px;
      line-height: 1.5;
      margin-top: 12px;
    }

    @media (min-width: 768px) {
      .page {
        max-width: 820px;
      }

      .content-grid {
        display: grid;
        grid-template-columns: 1.1fr .9fr;
        gap: 16px;
      }

      .stats {
        grid-template-columns: repeat(4, 1fr);
      }
    }
  </style>
</head>
<body>
  <div class="page">
   <div class="hero">

<div style="
display:inline-block;
padding:6px 12px;
border-radius:20px;
font-size:14px;
font-weight:600;
background:${estadoColor};
color:white;
">
${estadoTexto}
</div>

<div class="title">${rifa.title}</div>
<div class="prize">Premio: ${rifa.prize || "Premio no definido"}</div>

</div>
    <div class="content">
      <div class="content-grid">
        <div>
         
            <div class="stats">
              <div class="stat">
                <div class="stat-label">Boleta</div>
                <div class="stat-value price">$${Number(rifa.price_per_ticket || 0).toLocaleString("es-CO")}</div>
              </div>

                             
            <div class="progress-wrap">
              <div class="progress-label">
                <span>Progreso de ventas</span>
                <span>${porcentaje}% vendido</span>
              </div>
              <div class="progress-bg">
                <div class="progress-bar"></div>
              </div>
            </div>
          </div>

<div class="campaign-info">

<div class="info-row">
<span class="info-label">Organiza:</span>
<span class="info-value">
${rifa.organizers && rifa.organizers.full_name ? rifa.organizers.full_name : "Organizador verificado"}
</span>
</div>

<div class="info-row">
<span class="info-label">Fecha del sorteo:</span>
<span class="info-value">${rifa.draw_date ? new Date(rifa.draw_date).toLocaleString("es-CO") : "Fecha por confirmar"}</span>
</div>

<div class="info-row">
<span class="info-label">Cierre de campaña:</span>
<span class="info-value" id="countdown">Calculando...</span>
</div>

</div>
  <div class="share-box">
  <a
    href="https://wa.me/?text=${encodeURIComponent(
      '🎁 Participa en esta campaña\n\n' +
      'Premio: ' + (rifa.prize || 'Premio') + '\n' +
      'Cupón: $' + Number(rifa.price_per_ticket || 0).toLocaleString('es-CO') + '\n\n' +
      'Compra aquí:\n' +
      (rifa.slug ? base + '/r/' + rifa.slug : base + '/rifa-publica/' + rifa.id)
    )}"
    target="_blank"
    class="wa-btn"
  >
    📲 Compartir por WhatsApp
  </a>
</div>
          <div class="notice">
            Los cupones de participación se asignan automáticamente después del pago aprobado.
          </div>
        </div>

        <div>
          <div class="card">
            <h2 class="section-title">Adquiere tus cupones de participación</h2>

<form action="/crear-pago" method="POST">

<input type="hidden" name="rifa_id" value="${rifa.id}">
<input type="hidden" name="precio" value="${rifa.price_per_ticket}">

<label>Nombre completo</label>
<input type="text" name="buyer_name" required>

<label>Teléfono</label>
<input type="text" name="buyer_phone" required>

<label>Correo electrónico (opcional)</label>
<input type="email" name="buyer_email">

<label>Cantidad de cupones</label>
<input type="number" name="quantity" value="1" min="1" max="${disponibles || 1}" required>

<button type="submit" class="buy-btn">
Participar en la campaña
</button>

</form>

            <div class="small-text">
  Al continuar, serás redirigido a la pasarela de pago segura de Mercado Pago.
</div>
          </div>
        </div>
      </div>
    </div>
  </div>
<script>
const fechaCierre = new Date("${rifa.draw_date}");

function actualizarContador(){
const ahora = new Date();
const diferencia = fechaCierre - ahora;

if(diferencia <= 0){
document.getElementById("countdown").innerText = "Campaña finalizada";
return;
}

const dias = Math.floor(diferencia / (1000*60*60*24));
const horas = Math.floor((diferencia / (1000*60*60)) % 24);

document.getElementById("countdown").innerText =
dias + " días " + horas + " horas";
}

actualizarContador();
setInterval(actualizarContador,60000);
</script>

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

app.get("/rifas", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("rifas")
      .select("*")
      .eq("status", "approved")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const cards = (data || []).map((r) => {
      const vendidos = Number(r.sold_tickets || 0);
      const maximos = Number(r.max_tickets || 0);
      const porcentaje = maximos > 0 ? Math.round((vendidos / maximos) * 100) : 0;

      return `
        <a href="/rifa/${r.slug}" style="text-decoration:none;color:inherit;">
          <div style="background:#fff;border-radius:18px;padding:16px;margin-bottom:16px;border:1px solid #e5e7eb;">
            <div style="font-size:22px;font-weight:900;margin-bottom:6px;">
              ${r.title}
            </div>

            <div style="color:#6b7280;margin-bottom:10px;">
              Premio: ${r.prize}
            </div>

            <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
              <div>Boleta</div>
              <div style="font-weight:900;">
                $${Number(r.price_per_ticket).toLocaleString("es-CO")}
              </div>
            </div>

            <div style="height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-bottom:8px;">
              <div style="width:${porcentaje}%;height:100%;background:#22c55e;"></div>
            </div>

            <div style="font-size:14px;color:#6b7280;margin-bottom:12px;">
              ${vendidos} vendidas de ${maximos}
            </div>

            <div style="background:#facc15;padding:12px;text-align:center;border-radius:12px;font-weight:900;">
              Ver campaña
            </div>
          </div>
        </a>
      `;
    }).join("");

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Rifas activas</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family:Arial;background:#f4f7fb;margin:0;padding:16px;">
  <h1 style="margin-bottom:20px;">Rifas activas</h1>
  ${cards || "<p>No hay rifas activas.</p>"}
</body>
</html>
    `);
     } catch (e) {
    res.status(500).send(e.message);
  }
});
    app.get("/terminos", (req, res) => {

res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Términos y Condiciones - PromoClaras</title>
<meta name="viewport" content="width=device-width, initial-scale=1">

<style>
body{
font-family:Arial;
background:#f5f7fb;
margin:0;
padding:30px;
max-width:900px;
margin:auto;
line-height:1.6;
}

h1{
color:#0b3d91;
}

p{
margin-bottom:16px;
}
</style>

</head>

<body>

<h1>Términos y Condiciones - PromoClaras</h1>

<p>
PromoClaras actúa únicamente como plataforma tecnológica que permite a emprendedores
y comercios crear campañas promocionales digitales para promocionar
productos o servicios.
</p>

<p>
Los organizadores publican campañas promocionales dentro de la
plataforma y los usuarios pueden adquirir cupones digitales
de participación.
</p>

<p>
La asignación de cupones se realiza automáticamente mediante
el sistema.
</p>

<p>
PromoClaras actúa únicamente como plataforma tecnológica que facilita
la publicación y gestión de campañas promocionales entre organizadores
y participantes.
</p>

<p>
Cada organizador es responsable de la veracidad de la información
publicada y de la entrega de los incentivos o premios ofrecidos.
</p>

</body>
</html>
`);
});

app.get("/privacidad", (req, res) => {

res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Política de Privacidad - PromoClaras</title>
<meta name="viewport" content="width=device-width, initial-scale=1">

<style>
body{
font-family:Arial;
background:#f5f7fb;
margin:0;
padding:30px;
max-width:900px;
margin:auto;
line-height:1.6;
}

h1{
color:#0b3d91;
}

p{
margin-bottom:16px;
}
</style>

</head>

<body>

<h1>Política de Privacidad</h1>

<p>
En PromoClaras respetamos la privacidad de nuestros usuarios y nos comprometemos a proteger la información personal que compartes con nosotros.
</p>

<p>
La información recopilada puede incluir nombre, correo electrónico y datos necesarios para gestionar campañas promocionales dentro de la plataforma.
</p>

<p>
Esta información se utiliza exclusivamente para el funcionamiento de la plataforma, la gestión de campañas y la comunicación con los usuarios.
</p>

<p>
PromoClaras no vende ni comparte información personal con terceros, excepto cuando sea necesario para procesar pagos o cumplir con obligaciones legales.
</p>

<p>
Al utilizar la plataforma, aceptas las prácticas descritas en esta política de privacidad.
</p>

</body>
</html>
`)

})

app.get("/contacto", (req, res) => {

res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Contacto - PromoClaras</title>
<meta name="viewport" content="width=device-width, initial-scale=1">

<style>
body{
font-family:Arial;
background:#f5f7fb;
margin:0;
padding:30px;
max-width:900px;
margin:auto;
line-height:1.6;
}

h1{
color:#0b3d91;
}

p{
margin-bottom:16px;
}
</style>

</head>

<body>

<h1>Contacto</h1>

<p>
Si tienes dudas sobre la plataforma o sobre una campaña promocional, puedes escribirnos a:
</p>

<p>
<b>Correo:</b> promoclaras@gmail.com
</p>

<p>
<b>Sitio web:</b> https://rifasclaras.com
</p>

<p>
Nuestro equipo de soporte atenderá las solicitudes relacionadas con el funcionamiento de la plataforma.
</p>

</body>
</html>
`)

})

app.get("/admin/aprobar/:slug", async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (key !== ADMIN_KEY) {
      return res.status(403).send("Acceso no autorizado");
    }

    const { slug } = req.params;

    const { error } = await supabase
      .from("rifas")
      .update({ status: "approved" })
      .eq("slug", slug);

    if (error) throw error;

    return res.redirect(`/admin?key=${encodeURIComponent(ADMIN_KEY)}&msg=campana_aprobada`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/admin/rechazar/:slug", async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (key !== ADMIN_KEY) {
      return res.status(403).send("Acceso no autorizado");
    }

    const { slug } = req.params;

    const { error } = await supabase
      .from("rifas")
      .update({ status: "rejected" })
      .eq("slug", slug);

    if (error) throw error;

    return res.redirect(`/admin?key=${encodeURIComponent(ADMIN_KEY)}&msg=campana_rechazada`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/admin/pendientes", async (req, res) => {
  try {
const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    const { data, error } = await supabase
      .from("rifas")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const cards = (data || []).map(r => {
      return `
      <div style="background:#fff;border-radius:14px;padding:20px;margin-bottom:16px;border:1px solid #e5e7eb;">
        
        <div style="font-size:20px;font-weight:700;margin-bottom:8px;">
          ${r.title}
        </div>

        <div style="color:#6b7280;margin-bottom:10px;">
          Premio: ${r.prize}
        </div>

        <div style="margin-bottom:14px;">
          Precio participación: $${Number(r.price_per_ticket).toLocaleString("es-CO")}
        </div>

        <div style="display:flex;gap:10px;">
          
          <a href="/admin/aprobar/${r.slug}?key=${ADMIN_KEY}" 
          style="background:#22c55e;color:white;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:600;">
          Aprobar
          </a>

          <a href="/admin/rechazar/${r.slug}?key=${ADMIN_KEY}"
          style="background:#ef4444;color:white;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:600;">
          Rechazar
          </a>

        </div>

      </div>
      `;
    }).join("");

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8">
    <title>Panel Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <style>
    body{
      font-family:Arial;
      background:#f4f7fb;
      margin:0;
      padding:30px;
    }

    h1{
      margin-bottom:25px;
    }

    .container{
      max-width:800px;
      margin:auto;
    }
    </style>

    </head>

    <body>

    <div class="container">

    <h1>Campañas pendientes</h1>

    ${cards || "<p>No hay campañas pendientes.</p>"}

    </div>

    </body>
    </html>
    `);

  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/organizers/:organizerId/verificacion", async (req, res) => {
  try {
    const { organizerId } = req.params;

    const { data: organizer, error } = await supabase
      .from("organizers")
      .select("*")
      .eq("id", organizerId)
      .single();

    if (error || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verificación de organizador</title>
</head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#111;">
  <div style="max-width:760px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);">
    <h1 style="margin-top:0;">Verificación de organizador</h1>
    <div style="margin-bottom:16px;color:#64748b;">Completa esta información para poder publicar campañas.</div>

    <form method="POST" enctype="multipart/form-data">
      <div style="margin-bottom:14px;">
  <label><b>Número de cédula</b></label><br>
  <input type="text" name="document_number" required style="width:100%;padding:10px;">
</div>

<div style="margin-bottom:14px;">
  <label><b>Foto cédula frente</b></label><br>
  <input type="file" name="id_front_file" accept="image/*" capture="environment" required>
</div>

<div style="margin-bottom:14px;">
  <label><b>Foto cédula reverso</b></label><br>
  <input type="file" name="id_back_file" accept="image/*" capture="environment" required>
</div>

<div style="margin-bottom:14px;">
  <label><b>Selfie con cédula</b></label><br>
  <input type="file" name="selfie_id_file" accept="image/*" capture="user" required>
  <div style="font-size:12px;color:#6b7280;margin-top:6px;">
    Debes tomar la selfie en tiempo real con la cámara frontal.
  </div>
</div>

<div style="margin-bottom:14px;">
  <label><b>Método de pago</b></label><br>
  <select id="payout_method" name="payout_method" required style="width:100%;padding:10px;">
  <option value="">Seleccionar método</option>
  <option value="bank_transfer">Transferencia bancaria</option>
  <option value="nequi">Nequi</option>
  <option value="daviplata">Daviplata</option>
</select>
</div>

<div id="bank_block" style="margin-bottom:14px;">
<label><b>Banco</b></label><br>
  <select name="bank_name" style="width:100%;padding:10px;">
  <option value="">Seleccionar banco</option>
  <option value="bancolombia">Bancolombia</option>
  <option value="banco_bogota">Banco de Bogotá</option>
  <option value="davivienda">Davivienda</option>
  <option value="bbva">BBVA</option>
  <option value="banco_popular">Banco Popular</option>
  <option value="scotiabank">Scotiabank Colpatria</option>
  <option value="banco_agrario">Banco Agrario</option>
  <option value="itau">Itaú</option>
  <option value="av_villas">AV Villas</option>
<option value="caja_social">Banco Caja Social</option>
<option value="falabella">Banco Falabella</option>
<option value="pichincha">Banco Pichincha</option>
<option value="serfinanza">Banco Serfinanza</option>
<option value="lulo">Lulo Bank</option>
<option value="movii">Movii</option>
<option value="nequi">Nequi</option>
<option value="daviplata">Daviplata</option>
</select>
</div>

<div id="account_type_block" style="margin-bottom:14px;">
<label><b>Tipo de cuenta</b></label><br>
  <select name="account_type" style="width:100%;padding:10px;">
  <option value="">Tipo de cuenta</option>
  <option value="ahorros">Ahorros</option>
  <option value="corriente">Corriente</option>
</select>
</div>

<div style="margin-bottom:14px;">
  <label><b>Número de cuenta</b></label><br>
  <input type="text" name="account_number" style="width:100%;padding:10px;">
</div>

<div style="margin-bottom:14px;">
  <label><b>Titular de la cuenta</b></label><br>
  <input type="text" name="account_holder" style="width:100%;padding:10px;">
</div>

<div style="margin-bottom:14px;">
  <label><b>Soporte del premio</b></label><br>
  <input type="file" name="prize_proof_file" accept="image/*" capture="environment">
</div>

<div style="margin-bottom:14px;">
  <label>
    <input type="checkbox" name="terms_accepted" value="true" required>
    Acepto términos y confirmo que la información es real
  </label>
</div>

      <button type="submit"
        style="background:#16a34a;color:#fff;border:none;padding:14px 18px;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700;width:100%;">
        Guardar verificación
      </button>
    </form>
  </div>
  <script>

const metodo = document.getElementById("payout_method");
const banco = document.getElementById("bank_block");
const tipoCuenta = document.getElementById("account_type_block");

metodo.addEventListener("change", function(){

    if(this.value === "nequi" || this.value === "daviplata"){

        banco.style.display = "none";
        tipoCuenta.style.display = "none";

    }else{

        banco.style.display = "block";
        tipoCuenta.style.display = "block";

    }

});

</script>
</body>
</html>
    `);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.post(
  "/organizers/:organizerId/verificacion",
  upload.fields([
    { name: "id_front_file", maxCount: 1 },
    { name: "id_back_file", maxCount: 1 },
    { name: "selfie_id_file", maxCount: 1 },
    { name: "prize_proof_file", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const { organizerId } = req.params;

      const {
        document_number,
        payout_method,
        bank_name,
        account_type,
        account_number,
        account_holder,
        terms_accepted
      } = req.body;

      const frontFile = req.files?.id_front_file?.[0];
      const backFile = req.files?.id_back_file?.[0];
      const selfieFile = req.files?.selfie_id_file?.[0];
      const prizeFile = req.files?.prize_proof_file?.[0];

      if (!document_number || !frontFile || !backFile || !selfieFile) {
        return res.status(400).send("Faltan documentos obligatorios");
      }

      const { data: organizer, error: organizerError } = await supabase
        .from("organizers")
        .select("*")
        .eq("id", organizerId)
        .single();

      if (organizerError || !organizer) {
        return res.status(404).send("Organizador no encontrado");
      }

      const uploadOne = async (file, folder) => {
        if (!file) return null;

        const ext = (file.originalname || "jpg").split(".").pop() || "jpg";
        const filePath = `organizers/${organizerId}/${folder}-${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from("verification-docs")
          .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: true
          });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage
          .from("verification-docs")
          .getPublicUrl(filePath);

        return data.publicUrl;
      };

      const id_front_url = await uploadOne(frontFile, "id-front");
      const id_back_url = await uploadOne(backFile, "id-back");
      const selfie_id_url = await uploadOne(selfieFile, "selfie-id");
      const prize_proof_url = await uploadOne(prizeFile, "prize-proof");

      const { error } = await supabase
        .from("organizers")
        .update({
          document_number,
          id_front_url,
          id_back_url,
          selfie_id_url,
          payout_method: payout_method || null,
          bank_name: bank_name || null,
          account_type: account_type || null,
          account_number: account_number || null,
          account_holder: account_holder || null,
          prize_proof_url,
          terms_accepted: terms_accepted === "true" || terms_accepted === "on",
          verification_status: "pending"
        })
        .eq("id", organizerId);

      if (error) throw error;

      return res.redirect(`/organizers/${organizerId}/panel`);
    } catch (e) {
      return res.status(500).send(e.message);
    }
  }
);

app.get("/admin/organizadores", async (req, res) => {
  try {

    const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    
    const { data: organizers, error } = await supabase
      .from("organizers")
      .select("*")
      .eq("verification_status", "pending")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const cards = (organizers || []).map(o => `
      <div style="
        border:1px solid #e2e8f0;
        padding:18px;
        border-radius:12px;
        margin-bottom:14px;
        background:white;
      ">
        <h3 style="margin-top:0">${o.full_name || "Organizador"}</h3>

        <div><b>Email:</b> ${o.email}</div>
        <div><b>Cédula:</b> ${o.document_number || "-"}</div>

        <div style="margin-top:10px">
          <b>Cédula frente:</b><br>
          <a href="${o.id_front_url}" target="_blank">Ver documento</a>
        </div>

        <div style="margin-top:10px">
          <b>Cédula reverso:</b><br>
          <a href="${o.id_back_url}" target="_blank">Ver documento</a>
        </div>

        <div style="margin-top:10px">
          <b>Selfie con cédula:</b><br>
          <a href="${o.selfie_id_url}" target="_blank">Ver selfie</a>
        </div>

        <div style="margin-top:14px">

          <form method="POST" action="/admin/organizadores/${o.id}/aprobar" style="display:inline;">
            <button style="
              background:#16a34a;
              border:none;
              color:white;
              padding:10px 14px;
              border-radius:8px;
              cursor:pointer;
              font-weight:600;
            ">Aprobar</button>
          </form>

          <form method="POST" action="/admin/organizadores/${o.id}/rechazar" style="display:inline;margin-left:8px;">
            <button style="
              background:#dc2626;
              border:none;
              color:white;
              padding:10px 14px;
              border-radius:8px;
              cursor:pointer;
              font-weight:600;
            ">Rechazar</button>
          </form>

        </div>
      </div>
    `).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <html>
      <head>
        <title>Verificación de organizadores</title>
      </head>
      <body style="font-family:Arial;background:#f5f7fb;padding:40px">

        <h1>Organizadores pendientes</h1>

        ${cards || "<p>No hay organizadores pendientes.</p>"}

      </body>
      </html>
    `);

  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/admin/organizadores", async (req, res) => {
  try {

    const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    
    const { data: organizers, error } = await supabase
      .from("organizers")
      .select("*")
      .eq("verification_status", "pending")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const cards = (organizers || []).map(o => `
      <div style="
        border:1px solid #e2e8f0;
        padding:18px;
        border-radius:12px;
        margin-bottom:14px;
        background:white;
      ">
        <h3 style="margin-top:0">${o.full_name || "Organizador"}</h3>

        <div><b>Email:</b> ${o.email}</div>
        <div><b>Cédula:</b> ${o.document_number || "-"}</div>

        <div style="margin-top:10px">
          <b>Cédula frente:</b><br>
          <a href="${o.id_front_url}" target="_blank">Ver documento</a>
        </div>

        <div style="margin-top:10px">
          <b>Cédula reverso:</b><br>
          <a href="${o.id_back_url}" target="_blank">Ver documento</a>
        </div>

        <div style="margin-top:10px">
          <b>Selfie con cédula:</b><br>
          <a href="${o.selfie_id_url}" target="_blank">Ver selfie</a>
        </div>

        <div style="margin-top:14px">

          <form method="POST" action="/admin/organizadores/${o.id}/aprobar" style="display:inline;">
            <button style="
              background:#16a34a;
              border:none;
              color:white;
              padding:10px 14px;
              border-radius:8px;
              cursor:pointer;
              font-weight:600;
            ">Aprobar</button>
          </form>

          <form method="POST" action="/admin/organizadores/${o.id}/rechazar" style="display:inline;margin-left:8px;">
            <button style="
              background:#dc2626;
              border:none;
              color:white;
              padding:10px 14px;
              border-radius:8px;
              cursor:pointer;
              font-weight:600;
            ">Rechazar</button>
          </form>

        </div>
      </div>
    `).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <html>
      <head>
        <title>Verificación de organizadores</title>
      </head>
      <body style="font-family:Arial;background:#f5f7fb;padding:40px">

        <h1>Organizadores pendientes</h1>

        ${cards || "<p>No hay organizadores pendientes.</p>"}

      </body>
      </html>
    `);

  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post("/admin/organizadores/:organizerId/aprobar", async (req, res) => {
  try {
    const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    const { organizerId } = req.params;

    const { error } = await supabase
      .from("organizers")
      .update({
        verification_status: "verified"
      })
      .eq("id", organizerId);

    if (error) throw error;

    return res.redirect(`/admin?key=${ADMIN_KEY}`);

  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.post("/admin/resultados-loterias", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (key !== ADMIN_KEY) {
      return res.status(403).send("Acceso no autorizado");
    }

    const lottery_code = String(req.body.lottery_code || "").trim();
    const draw_date = String(req.body.draw_date || "").trim();
    const dateOnly = draw_date.slice(0, 10);
    const result_value = String(req.body.result_value || "").trim();

    if (!lottery_code || !draw_date || !result_value) {
      return res.status(400).send("Faltan datos");
    }

    if (!/^\d{4}$/.test(result_value)) {
      return res.status(400).send("El resultado debe tener 4 cifras");
    }

   const { error } = await supabase
  .from("lottery_results")
  .upsert(
    {
      lottery_code,
      draw_date: dateOnly,
      result_value,
      loaded_manually: true
    },
    {
      onConflict: "lottery_code,draw_date"
    }
  );

if (error) throw error;

// Buscar rifas aprobadas de esa lotería en esa fecha
const { data: rifas, error: rifasError } = await supabase
  .from("rifas")
  .select("*")
  .eq("status", "approved")
  .eq("draw_provider", lottery_code)
  .gte("draw_date", `${dateOnly}T00:00:00`)
.lte("draw_date", `${dateOnly}T23:59:59`);

if (rifasError) throw rifasError;

for (const rifa of (rifas || [])) {
  const winningValue = getWinningValueFromResult(rifa.draw_mode, result_value);

  if (!winningValue) continue;

  const { data: winnerTicket, error: winnerError } = await supabase
    .from("tickets")
    .select("*")
    .eq("rifa_id", rifa.id)
    .eq("combination", winningValue)
    .eq("payment_status", "approved")
    .maybeSingle();

  if (winnerError) throw winnerError;

  const updatePayload = {
    result_value,
    winning_number: winningValue,
    result_loaded_manually: true,
    status: "finished"
  };

  if (winnerTicket) {
    updatePayload.winner_ticket_id = winnerTicket.id;
    updatePayload.winner_buyer_id = winnerTicket.buyer_id || null;
  }

  const { error: updateRifaError } = await supabase
    .from("rifas")
    .update(updatePayload)
    .eq("id", rifa.id);

  if (updateRifaError) throw updateRifaError;

  if (winnerTicket) {
    const { error: resultInsertError } = await supabase
      .from("raffle_results")
      .upsert({
        rifa_id: rifa.id,
        winning_number: winningValue,
        winning_combination: result_value,
        winner_ticket_id: winnerTicket.id,
        winner_buyer_id: winnerTicket.buyer_id || null
      });

    if (resultInsertError) throw resultInsertError;
  }
}

return res.redirect(`/admin?key=${encodeURIComponent(ADMIN_KEY)}`);

  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.post("/admin/organizadores/:organizerId/rechazar", async (req, res) => {
  try {
    const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    const { organizerId } = req.params;

    const { error } = await supabase
      .from("organizers")
      .update({
        verification_status: "rejected"
      })
      .eq("id", organizerId);

    if (error) throw error;

    return res.redirect(`/admin?key=${ADMIN_KEY}`);

  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/admin/solicitudes-campanas", async (req, res) => {
  try {

    const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    
    const { data: requests, error } = await supabase
      .from("campaign_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const cards = (requests || []).map(r => `
      <div style="
        background:#fff;
        border:1px solid #e5e7eb;
        border-radius:14px;
        padding:18px;
        margin-bottom:16px;
      ">
        <h3 style="margin-top:0;">${r.requested_title || "Solicitud sin título"}</h3>
        <div><b>Premio:</b> ${r.requested_prize || "-"}</div>
        <div><b>Descripción:</b> ${r.requested_description || "-"}</div>
        <div><b>Modalidad:</b> ${r.requested_modality || "-"}</div>
        <div><b>Valor cupón:</b> $${Number(r.requested_price_per_ticket || 0).toLocaleString("es-CO")}</div>
        <div><b>Cantidad:</b> ${r.requested_max_tickets || 0}</div>
        <div><b>Fecha sorteo:</b> ${r.requested_draw_date || "-"}</div>

        <div style="margin-top:14px;">
          <form method="POST" action="/admin/solicitudes-campanas/${r.id}/aprobar?key=${encodeURIComponent(ADMIN_KEY)}" style="display:inline;">
            <button style="
              background:#16a34a;
              color:white;
              border:none;
              padding:10px 14px;
              border-radius:10px;
              cursor:pointer;
              font-weight:700;
            ">Aprobar</button>
          </form>

          <form method="POST" action="/admin/solicitudes-campanas/${r.id}/rechazar?key=${encodeURIComponent(ADMIN_KEY)}" style="display:inline;margin-left:8px;">
            <button style="
              background:#dc2626;
              color:white;
              border:none;
              padding:10px 14px;
              border-radius:10px;
              cursor:pointer;
              font-weight:700;
            ">Rechazar</button>
          </form>
        </div>
      </div>
    `).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Solicitudes de campañas</title>
      </head>
      <body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;">
        <div style="max-width:900px;margin:0 auto;">
          <h1>Solicitudes extra de campañas</h1>
          ${cards || "<p>No hay solicitudes pendientes.</p>"}
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.post("/admin/solicitudes-campanas/:requestId/aprobar", async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (key !== ADMIN_KEY) {
      return res.status(403).send("Acceso no autorizado");
    }

    const { requestId } = req.params;

    const { data: requestData, error: requestError } = await supabase
      .from("campaign_requests")
      .select("*")
      .eq("id", requestId)
      .single();

    if (requestError || !requestData) {
      return res.status(404).send("Solicitud no encontrada");
    }

    let slug = slugify(requestData.requested_title || "campana");
    if (!slug) slug = `campana-${Date.now()}`;

    const { data: existingSlug } = await supabase
      .from("rifas")
      .select("id, slug")
      .eq("slug", slug)
      .maybeSingle();

    if (existingSlug) {
      slug = `${slug}-${Date.now().toString().slice(-6)}`;
    }

    const { data: organizer, error: organizerError } = await supabase
      .from("organizers")
      .select("profile_id")
      .eq("id", requestData.organizer_id)
      .single();

    if (organizerError || !organizer) {
      return res.status(404).send("Organizador no encontrado");
    }

    const drawProvider = requestData.requested_draw_provider || "baloto";
    const drawMode = requestData.requested_draw_mode || requestData.requested_modality;
    const maxTickets = getMaxTickets(drawProvider, drawMode);

    const { error: insertError } = await supabase
      .from("rifas")
      .insert({
        owner_id: organizer.profile_id,
        title: requestData.requested_title,
        prize: requestData.requested_prize,
        description: requestData.requested_description,
        draw_provider: drawProvider,
        draw_mode: drawMode,
        modality: drawMode,
        price_per_ticket: requestData.requested_price_per_ticket,
        max_tickets: maxTickets,
        sold_tickets: 0,
        available_tickets: maxTickets,
        draw_date: requestData.requested_draw_date,
        status: "pending",
        slug,
        result_value: null,
        result_loaded_manually: false
      });

    if (insertError) throw insertError;

    const { error: updateError } = await supabase
      .from("campaign_requests")
      .update({ status: "approved" })
      .eq("id", requestId);

    if (updateError) throw updateError;

    return res.redirect(`/admin?key=${encodeURIComponent(ADMIN_KEY)}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});
app.post("/admin/solicitudes-campanas/:requestId/rechazar", async (req, res) => {
  try {
    const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    const { requestId } = req.params;

    const { error } = await supabase
      .from("campaign_requests")
      .update({ status: "rejected" })
      .eq("id", requestId);

    if (error) throw error;

    return res.redirect(`/admin?key=${encodeURIComponent(ADMIN_KEY)}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get("/admin", async (req, res) => {
  try {
const key = String(req.query.key || "");
if (key !== ADMIN_KEY) {
  return res.status(403).send("Acceso no autorizado");
}
    const { data: organizersPending } = await supabase
      .from("organizers")
      .select("*")
      .neq("verification_status", "verified");

    const { data: campaignsPending } = await supabase
      .from("rifas")
      .select("*")
      .eq("status", "pending");

    const { data: campaignRequests } = await supabase
      .from("campaign_requests")
      .select("*")
      .eq("status", "pending");

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    res.send(`
    <html>
    <head>
      <title>Panel Administrador</title>
    </head>

    <body style="font-family:Arial;background:#f5f7fb;padding:40px;">

      <h1>Panel Administrador</h1>

      <div style="display:flex;gap:20px;margin-bottom:30px;">

        <div style="background:white;padding:20px;border-radius:10px;">
          <h3>Organizadores pendientes</h3>
          <h2>${(organizersPending || []).length}</h2>
        </div>

        <div style="background:white;padding:20px;border-radius:10px;">
          <h3>Campañas pendientes</h3>
          <h2>${(campaignsPending || []).length}</h2>
        </div>

        <div style="background:white;padding:20px;border-radius:10px;">
          <h3>Solicitudes extra</h3>
          <h2>${(campaignRequests || []).length}</h2>
        </div>

      </div>

      <h2>Cargar resultados oficiales de loterías</h2>

<div style="
  background:white;
  padding:18px;
  border-radius:12px;
  border:1px solid #e5e7eb;
  margin-bottom:24px;
">
  <form method="POST" action="/admin/resultados-loterias?key=${encodeURIComponent(ADMIN_KEY)}">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">

      <div>
        <label style="display:block;font-weight:700;margin-bottom:6px;">Lotería</label>
        <select name="lottery_code" required style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;">
          <option value="">Selecciona</option>
          <option value="loteria_meta">Lotería del Meta</option>
          <option value="loteria_bogota">Lotería de Bogotá</option>
          <option value="loteria_medellin">Lotería de Medellín</option>
          <option value="loteria_boyaca">Lotería de Boyacá</option>
          <option value="loteria_tolima">Lotería del Tolima</option>
          <option value="loteria_manizales">Lotería de Manizales</option>
          <option value="loteria_cauca">Lotería del Cauca</option>
          <option value="loteria_huila">Lotería del Huila</option>
          <option value="loteria_santander">Lotería de Santander</option>
          <option value="loteria_cruz_roja">Lotería de la Cruz Roja</option>
          <option value="loteria_risaralda">Lotería de Risaralda</option>
          <option value="loteria_quindio">Lotería del Quindío</option>
          <option value="loteria_narino">Lotería de Nariño</option>
          <option value="loteria_valle">Lotería del Valle</option>
        </select>
      </div>

      <div>
        <label style="display:block;font-weight:700;margin-bottom:6px;">Fecha del sorteo</label>
        <input type="date" name="draw_date" required style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;">
      </div>

      <div>
        <label style="display:block;font-weight:700;margin-bottom:6px;">Resultado oficial (4 cifras)</label>
        <input type="text" name="result_value" maxlength="4" required placeholder="Ej: 5837"
          style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;">
      </div>
    </div>

    <div style="margin-top:14px;">
      <button type="submit" style="
        background:#2563eb;
        color:white;
        border:none;
        padding:12px 16px;
        border-radius:10px;
        font-weight:700;
        cursor:pointer;
      ">
        Guardar resultado
      </button>
    </div>
  </form>
</div>

      <h2>Organizadores por aprobar</h2>
     ${(organizersPending || []).map(o => `
  <div style="
    background:white;
    padding:16px;
    margin-bottom:14px;
    border-radius:12px;
    border:1px solid #e5e7eb;
  ">
    <div style="font-weight:700;font-size:18px;">${o.full_name}</div>
    <div style="color:#6b7280;margin:6px 0;">${o.email}</div>
    <div style="margin:6px 0;"><b>Cédula:</b> ${o.document_number || "-"}</div>
    <div style="margin:6px 0;"><b>Método de pago:</b> ${o.payout_method || "-"}</div>
    <div style="margin:6px 0;"><b>Banco:</b> ${o.bank_name || "-"}</div>
    <div style="margin:6px 0;"><b>Tipo de cuenta:</b> ${o.account_type || "-"}</div>
    <div style="margin:6px 0;"><b>Número de cuenta:</b> ${o.account_number || "-"}</div>
    <div style="margin:6px 0 12px 0;"><b>Titular:</b> ${o.account_holder || "-"}</div>

    <div style="margin:10px 0;">
      <b>Documento frente:</b>
      ${o.id_front_url ? `<a href="${o.id_front_url}" target="_blank" style="margin-left:8px;">Ver archivo</a>` : "No cargado"}
    </div>

    <div style="margin:10px 0;">
      <b>Documento reverso:</b>
      ${o.id_back_url ? `<a href="${o.id_back_url}" target="_blank" style="margin-left:8px;">Ver archivo</a>` : "No cargado"}
    </div>

    <div style="margin:10px 0;">
      <b>Selfie con cédula:</b>
      ${o.selfie_id_url ? `<a href="${o.selfie_id_url}" target="_blank" style="margin-left:8px;">Ver archivo</a>` : "No cargado"}
    </div>

    <div style="margin:10px 0 14px 0;">
      <b>Soporte del premio:</b>
      ${o.prize_proof_url ? `<a href="${o.prize_proof_url}" target="_blank" style="margin-left:8px;">Ver archivo</a>` : "No cargado"}
    </div>

    <form method="POST" action="/admin/organizadores/${o.id}/aprobar?key=${encodeURIComponent(ADMIN_KEY)}" style="display:inline;">
      <button style="
        background:#16a34a;
        color:white;
        border:none;
        padding:10px 14px;
        border-radius:8px;
        cursor:pointer;
        font-weight:700;
      ">Aprobar</button>
    </form>

    <form method="POST" action="/admin/organizadores/${o.id}/rechazar?key=${encodeURIComponent(ADMIN_KEY)}" style="display:inline;margin-left:8px;">
      <button style="
        background:#dc2626;
        color:white;
        border:none;
        padding:10px 14px;
        border-radius:8px;
        cursor:pointer;
        font-weight:700;
      ">Rechazar</button>
    </form>
  </div>
`).join("")}

      <h2>Campañas pendientes</h2>
${(campaignsPending || []).map(c => `
  <div style="
    background:white;
    padding:14px;
    margin-bottom:10px;
    border-radius:10px;
    border:1px solid #e5e7eb;
  ">
    <div style="font-weight:700;">${c.title}</div>

<div style="color:#6b7280;margin:6px 0;">
  Premio: ${c.prize}
</div>

<div style="color:#6b7280;margin:6px 0;">
  Sorteo: ${getDrawProviderLabel(c.draw_provider)}
</div>

<div style="color:#6b7280;margin:6px 0;">
  Modalidad: ${getDrawModeLabel(c.draw_mode || c.modality)}
</div>

<div style="color:#6b7280;margin:0 0 12px 0;">
  Precio: $${Number(c.price_per_ticket || 0).toLocaleString("es-CO")}
</div>

    <a href="/admin/aprobar/${c.slug}?key=${encodeURIComponent(ADMIN_KEY)}" style="
      display:inline-block;
      background:#16a34a;
      color:white;
      padding:10px 14px;
      border-radius:8px;
      font-weight:700;
      text-decoration:none;
    ">
      Aprobar
    </a>

    <a href="/admin/rechazar/${c.slug}?key=${encodeURIComponent(ADMIN_KEY)}" style="
      display:inline-block;
      margin-left:8px;
      background:#dc2626;
      color:white;
      padding:10px 14px;
      border-radius:8px;
      font-weight:700;
      text-decoration:none;
    ">
      Rechazar
    </a>

  </div>
`).join("")}

      <h2>Solicitudes de tercera campaña</h2>
     ${(campaignRequests || []).map(r => `
  <div style="
    background:white;
    padding:14px;
    margin-bottom:10px;
    border-radius:10px;
    border:1px solid #e5e7eb;
  ">
    <div style="font-weight:700;">${r.requested_title}</div>
<div style="color:#6b7280;margin:6px 0;">Premio: ${r.requested_prize}</div>
<div style="color:#6b7280;margin:6px 0;">Sorteo: ${getDrawProviderLabel(r.requested_draw_provider)}</div>
<div style="color:#6b7280;margin:6px 0;">Modalidad: ${getDrawModeLabel(r.requested_draw_mode || r.requested_modality)}</div>
<div style="color:#6b7280;margin:6px 0;">Valor cupón: $${Number(r.requested_price_per_ticket || 0).toLocaleString("es-CO")}</div>
<div style="color:#6b7280;margin:0 0 12px 0;">Cantidad: ${r.requested_max_tickets || 0}</div>

    <form method="POST" action="/admin/solicitudes-campanas/${r.id}/aprobar?key=${encodeURIComponent(ADMIN_KEY)}" style="display:inline;">
      <button style="
        background:#16a34a;
        color:white;
        border:none;
        padding:10px 14px;
        border-radius:8px;
        cursor:pointer;
        font-weight:700;
      ">Aprobar</button>
    </form>

    <form method="POST" action="/admin/solicitudes-campanas/${r.id}/rechazar?key=${encodeURIComponent(ADMIN_KEY)}" style="display:inline;margin-left:8px;">
      <button style="
        background:#dc2626;
        color:white;
        border:none;
        padding:10px 14px;
        border-radius:8px;
        cursor:pointer;
        font-weight:700;
      ">Rechazar</button>
    </form>
  </div>
`).join("")}

    </body>
    </html>
    `);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto", PORT);
});
// update
