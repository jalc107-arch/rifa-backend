// ===============================
// RIFA BACKEND FINAL COMPLETO
// ===============================

import express from "express";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.set("trust proxy", 1);

// ===============================
// SECRETS
// ===============================
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const NEQUI_PHONE = process.env.NEQUI_PHONE || "";
const NEQUI_NAME = process.env.NEQUI_NAME || "";
const NEQUI_NOTE = process.env.NEQUI_NOTE || "";
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || "").replace(/\D/g, "");
const CHECKOUT_URL = process.env.CHECKOUT_URL || "";

// ===============================
const DB_FILE = "rifas_db.json";
const ORDERS_FILE = "orders.json";

// ===============================
// Helpers
// ===============================
function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function newId() {
  return crypto.randomBytes(4).toString("hex");
}

function newOrderId() {
  return "ord_" + crypto.randomBytes(6).toString("hex");
}

function formatCOP(n) {
  return Number(n).toLocaleString("es-CO");
}

// ===============================
// HOME
// ===============================
app.get("/", (req, res) => {
  res.send("Rifa Backend OK ✅");
});

// ===============================
// CREAR DEMO
// ===============================
app.get("/crear-demo", (req, res) => {
  const db = readJSON(DB_FILE, { rifas: {} });

  const rifaId = newId();

  db.rifas[rifaId] = {
    rifaId,
    nombre: "Rifa Demo",
    org: "1032456789",
    precio: 5000,
    estado: "ABIERTA",
    createdAt: new Date().toISOString(),
  };

  writeJSON(DB_FILE, db);

  res.json({ ok: true, rifaId });
});

// ===============================
// ESTADO
// ===============================
app.get("/rifas/:rifaId/estado", (req, res) => {
  const db = readJSON(DB_FILE, { rifas: {} });
  const rifa = db.rifas[req.params.rifaId];

  if (!rifa) return res.status(404).send("No existe");

  res.json(rifa);
});

// ===============================
// SORTEO (HTML)
// ===============================
app.get("/rifas/:rifaId/sorteo", (req, res) => {
  const db = readJSON(DB_FILE, { rifas: {} });
  const rifa = db.rifas[req.params.rifaId];
  if (!rifa) return res.status(404).send("No existe");

  const pagoBloque =
    rifa.estado === "ABIERTA"
      ? `
<hr/>
<h3>Comprar Boletas</h3>
<div>Precio: $${formatCOP(rifa.precio)} COP</div>
<div>Pagar a Nequi: ${NEQUI_PHONE}</div>
<div>A nombre de: ${NEQUI_NAME}</div>
<div>${NEQUI_NOTE}</div>

${
  CHECKOUT_URL
    ? `<a href="${CHECKOUT_URL}" target="_blank"
        style="display:inline-block;margin-top:10px;padding:10px 15px;
        background:#1a7f37;color:white;border-radius:10px;text-decoration:none;font-weight:bold;">
        Pagar ahora (Wompi/Nequi)
       </a>`
    : ""
}

<br/><br/>
<a href="/rifas/${rifa.rifaId}/comprar"
   style="padding:8px 12px;background:#000;color:white;border-radius:8px;text-decoration:none;">
   Comprar boletas
</a>
`
      : `<div>Rifa no disponible para ventas</div>`;

  res.send(`
  <h2>Resultado del Sorteo</h2>
  <div>RifaID: ${rifa.rifaId}</div>
  <div>Estado: ${rifa.estado}</div>
  ${pagoBloque}
  `);
});

// ===============================
// COMPRAR
// ===============================
app.get("/rifas/:rifaId/comprar", (req, res) => {
  const db = readJSON(DB_FILE, { rifas: {} });
  const rifa = db.rifas[req.params.rifaId];
  if (!rifa) return res.status(404).send("No existe");

  res.send(`
  <h2>Comprar Boletas</h2>
  <div>Precio: $${formatCOP(rifa.precio)} COP</div>
  <div>Pagar a Nequi: ${NEQUI_PHONE}</div>
  <div>A nombre de: ${NEQUI_NAME}</div>

  ${
    CHECKOUT_URL
      ? `<a href="${CHECKOUT_URL}" target="_blank"
          style="display:inline-block;margin:10px 0;padding:10px 15px;
          background:#1a7f37;color:white;border-radius:10px;text-decoration:none;font-weight:bold;">
          Pagar ahora (Wompi/Nequi)
         </a>`
      : ""
  }

  <form method="POST" action="/rifas/${rifa.rifaId}/ordenes">
    <input name="nombre" placeholder="Nombre" required/><br/><br/>
    <input name="telefono" placeholder="Teléfono" required/><br/><br/>
    <input name="cantidad" type="number" placeholder="Cantidad" required/><br/><br/>
    <button type="submit">Crear orden</button>
  </form>
  `);
});

// ===============================
// CREAR ORDEN
// ===============================
app.post(
  "/rifas/:rifaId/ordenes",
  express.urlencoded({ extended: true }),
  (req, res) => {
    const db = readJSON(DB_FILE, { rifas: {} });
    const rifa = db.rifas[req.params.rifaId];
    if (!rifa) return res.status(404).send("No existe");

    const orders = readJSON(ORDERS_FILE, {});

    const orderId = newOrderId();
    const total = Number(req.body.cantidad) * rifa.precio;

    orders[orderId] = {
      orderId,
      rifaId: rifa.rifaId,
      nombre: req.body.nombre,
      telefono: req.body.telefono,
      cantidad: req.body.cantidad,
      total,
      estado: "PENDIENTE",
    };

    writeJSON(ORDERS_FILE, orders);

    res.redirect(`/rifas/${rifa.rifaId}/orden/${orderId}`);
  },
);

// ===============================
// VER ORDEN
// ===============================
app.get("/rifas/:rifaId/orden/:orderId", (req, res) => {
  const orders = readJSON(ORDERS_FILE, {});
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).send("No existe");

  res.send(`
  <h2>Orden de compra</h2>
  <div>Orden: ${order.orderId}</div>
  <div>Estado: ${order.estado}</div>
  <div>Nombre: ${order.nombre}</div>
  <div>Total: $${formatCOP(order.total)} COP</div>

  <hr/>

  <div>Pagar a Nequi: ${NEQUI_PHONE}</div>
  <div>A nombre de: ${NEQUI_NAME}</div>

  ${
    CHECKOUT_URL
      ? `<a href="${CHECKOUT_URL}" target="_blank"
          style="display:inline-block;margin-top:10px;padding:10px 15px;
          background:#1a7f37;color:white;border-radius:10px;text-decoration:none;font-weight:bold;">
          Pagar ahora (Wompi/Nequi)
         </a>`
      : ""
  }

  <br/><br/>

  <a href="https://wa.me/57${WHATSAPP_NUMBER}?text=RifaID ${order.rifaId} - Orden ${order.orderId}"
     target="_blank"
     style="padding:8px 12px;background:#0b57d0;color:white;border-radius:8px;text-decoration:none;">
     Enviar comprobante por WhatsApp
  </a>
  `);
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));
