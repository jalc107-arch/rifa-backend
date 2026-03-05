// index.js
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ type: "*/*" })); // para que Wompi webhook entre bien

// =========================
// CONFIG
// =========================
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = (process.env.DATA_DIR || "./data").trim();
const PRICE_PER_TICKET = Number(process.env.PRICE_PER_TICKET || 5000);

fs.mkdirSync(DATA_DIR, { recursive: true });

function dbFile() {
  return path.join(DATA_DIR, "db.json");
}

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(dbFile(), "utf8"));
  } catch {
    return { rifas: {} };
  }
}

function writeDB(db) {
  fs.writeFileSync(dbFile(), JSON.stringify(db, null, 2), "utf8");
}

function nowISO() {
  return new Date().toISOString();
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function getBaseUrl(req) {
  // Railway suele ir por https detrás de proxy
  const proto =
    (req.headers["x-forwarded-proto"] || req.protocol || "https")
      .toString()
      .split(",")[0]
      .trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString();
  return `${proto}://${host}`;
}

// =========================
// DEBUG WOMPI (MEJORADO)
// =========================
app.get("/debug/wompi", (req, res) => {
  const pub = (process.env.WOMPI_PUBLIC_KEY || "").trim();
  const prv = (process.env.WOMPI_PRIVATE_KEY || "").trim();
  const integ = (process.env.WOMPI_INTEGRITY_SECRET || "").trim();

  const pubIsTest = pub.toLowerCase().startsWith("pub_test_");
  const pubIsProd = pub.toLowerCase().startsWith("pub_prod_");
  const prvIsTest = prv.toLowerCase().startsWith("prv_test_");
  const prvIsProd = prv.toLowerCase().startsWith("prv_prod_");

  const env =
    pubIsTest ? "sandbox" :
    pubIsProd ? "production" :
    "unknown";

  const mismatch =
    (pubIsTest && prvIsProd) || (pubIsProd && prvIsTest);

  res.json({
    env,
    pub_prefix: pub ? pub.slice(0, 9) : "undefined",
    prv_prefix: prv ? prv.slice(0, 9) : "undefined",
    integrity_len: integ ? integ.length : 0,
    mismatch_env: mismatch,
    missing: {
      WOMPI_PUBLIC_KEY: !pub,
      WOMPI_PRIVATE_KEY: !prv,
      WOMPI_INTEGRITY_SECRET: !integ,
      PRICE_PER_TICKET: !process.env.PRICE_PER_TICKET,
      DATA_DIR: !process.env.DATA_DIR,
    },
  });
});

// =========================
// CREAR DEMO
// =========================
// Ejemplo: /crear-demo?org=1032456789
app.get("/crear-demo", (req, res) => {
  const org = (req.query.org || "demo").toString();

  const db = readDB();

  const rifaId = crypto.randomBytes(4).toString("hex"); // corto tipo "20a09c12"
  const totalBoletas = 903;

  db.rifas[rifaId] = db.rifas[rifaId] || {
    createdAt: nowISO(),
    org,
    totalBoletas,
    orders: {},
  };

  writeDB(db);

  const base = getBaseUrl(req);

  res.json({
    ok: true,
    rifaId,
    totalBoletas,
    links: {
      sorteo: `/rifas/${rifaId}/sorteo?baloto=demo&k=2`,
      comprar: `/rifas/${rifaId}/comprar`,
      api_rifa: `${base}/rifas/${rifaId}`,
    },
  });
});

// =========================
// COMPRAR (crea orden)
// =========================
// Crea una orden simple: /rifas/:rifaId/comprar?qty=1
app.get("/rifas/:rifaId/comprar", (req, res) => {
  const { rifaId } = req.params;
  const qty = Math.max(1, Number(req.query.qty || 1));

  const db = readDB();
  const rifa = db.rifas[rifaId];
  if (!rifa) return res.status(404).json({ ok: false, error: "Rifa no existe" });

  const orderId = genId("ord");
  const totalPagar = qty * PRICE_PER_TICKET;

  rifa.orders[orderId] = {
    orderId,
    qty,
    totalPagar,
    currency: "COP",
    status: "CREATED", // CREATED | PAID | FAILED
    createdAt: nowISO(),
    paidAt: null,
    wompi: null,
  };

  writeDB(db);

  const base = getBaseUrl(req);
  res.json({
    ok: true,
    rifaId,
    orderId,
    totalPagar,
    links: {
      pagar: `${base}/rifas/${rifaId}/orden/${orderId}/pagar`,
      ver: `${base}/rifas/${rifaId}/orden/${orderId}`,
    },
  });
});

// =========================
// VER ORDEN
// =========================
app.get("/rifas/:rifaId/orden/:orderId", (req, res) => {
  const { rifaId, orderId } = req.params;

  const db = readDB();
  const rifa = db.rifas[rifaId];
  if (!rifa) return res.status(404).json({ ok: false, error: "Rifa no existe" });

  const order = rifa.orders[orderId];
  if (!order) return res.status(404).json({ ok: false, error: "Orden no existe" });

  res.json({ ok: true, rifaId, order });
});

// =========================
// PAGAR CON WOMPI (WIDGET)
// =========================
app.get("/rifas/:rifaId/orden/:orderId/pagar", (req, res) => {
  const { rifaId, orderId } = req.params;

  const pub = (process.env.WOMPI_PUBLIC_KEY || "").trim();
  const integ = (process.env.WOMPI_INTEGRITY_SECRET || "").trim();

  if (!pub || !integ) {
    return res.status(500).send("Faltan variables WOMPI_PUBLIC_KEY o WOMPI_INTEGRITY_SECRET");
  }

  const db = readDB();
  const rifa = db.rifas[rifaId];
  if (!rifa) return res.status(404).send("Rifa no existe");

  const order = rifa.orders[orderId];
  if (!order) return res.status(404).send("Orden no existe");

 const currency = "COP";
const reference = orderId;

// Wompi requiere string exacto
const amountInCents = String(order.totalPagar * 100);

const signature = crypto
  .createHash("sha256")
  .update(reference + amountInCents + currency + integ)
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
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:20px;">
    <h2 style="margin-top:0;">Pagar con Wompi</h2>
    <div style="opacity:.85;">Orden: <b>${orderId}</b> — Total: <b>$${Number(order.totalPagar).toLocaleString("es-CO")} COP</b></div>

    <div style="margin-top:14px;">
      <script
        src="https://checkout.wompi.co/widget.js"
        data-render="button"
        data-public-key="${pub}"
        data-currency="${currency}"
        data-amount-in-cents="${amountInCents}"
        data-reference="${reference}"
        data-signature-integrity="${signature}"
        data-redirect-url="${redirectUrl}">
      </script>
    </div>

    <div style="margin-top:12px;font-size:12px;opacity:.75;">
      * Al terminar, Wompi te redirige y el backend puede validar por webhook.
    </div>

    <div style="margin-top:12px;">
      <a href="/rifas/${rifaId}/orden/${orderId}" style="text-decoration:none;color:#1a7f37;font-weight:700;">← Volver a la orden</a>
    </div>
  </div>
</body>
</html>
`);
});

// =========================
// WEBHOOK WOMPI (MEJORADO)
// =========================
// Configura en Wompi: URL = https://TU-DOMINIO/wompi/webhook
app.post("/wompi/webhook", (req, res) => {
  const body = req.body;

  try {
    // Estructura típica: { event, data: { transaction: { reference, status, id, ... } } }
    const tx = body?.data?.transaction;
    const reference = tx?.reference; // usamos orderId como reference
    const status = tx?.status;       // APPROVED / DECLINED / VOIDED / ERROR

    if (!reference) {
      return res.status(400).json({ ok: false, error: "Sin reference" });
    }

    const db = readDB();
    let found = false;

    // Buscar la orden en todas las rifas
    for (const rifaId of Object.keys(db.rifas)) {
      const rifa = db.rifas[rifaId];
      const order = rifa?.orders?.[reference];
      if (!order) continue;

      found = true;

      order.wompi = {
        lastEventAt: nowISO(),
        raw: body, // guardamos el payload para auditoría / debug
      };

      if (status === "APPROVED") {
        order.status = "PAID";
        order.paidAt = nowISO();
      } else if (status) {
        order.status = "FAILED";
      }

      writeDB(db);
      break;
    }

    return res.json({ ok: true, found });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Webhook error" });
  }
});

// =========================
// HOME
// =========================
app.get("/", (req, res) => {
  res.send("OK - rifa-backend");
});

// =========================
// START (Railway)
// =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor corriendo en puerto", PORT);
});
