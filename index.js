// index.js (ESM) — COMPLETO (borrar y pegar)
// ✅ Plataforma multiusuario (org cédula/NIT)
// ✅ Rifa PROD/DEMO
// ✅ Precio variable por rifa
// ✅ Estado rifa: ABIERTA / CERRADA / FINALIZADA
// ✅ Pago Nequi visible SOLO si ABIERTA
// ✅ Flujo híbrido: Orden PENDIENTE -> Admin APRUEBA -> Asigna boletas consecutivas
// ✅ Botón/link pago por orden: /rifas/:rifaId/orden/:orderId/pagar (Wompi Widget)
// ✅ Confirmación automática (OPCIÓN B SIN WEBHOOK): redirect + consulta API Wompi (private key) -> auto aprueba y asigna boletas
// ✅ Bloqueo automático al acta oficial (Baloto real) + Acta PDF con QR
// ✅ Auditoría pública (/estado) y JSON verificable (/api/sorteo)
// ✅ Plan B: oficial-manual (solo admin) si falla scraping
// ✅ Admin web: panel simple + aprobar/rechazar por LINK (GET) con redirect

import express from "express";
import fs from "fs";
import crypto from "crypto";
import axios from "axios";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import * as cheerio from "cheerio";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

// =========================
// Archivos
// =========================
const RIFAS_DB_FILE = "rifas_db.json";
const ACTA_COUNTER_FILE = "acta_counter.json";
const ACTAS_FILE = "actas.json";
const ORDERS_FILE = "orders.json";

// =========================
// Constantes
// =========================
const DEFAULT_N = 43; // Baloto principal 1..43
const DEFAULT_K_MIN = 1;
const DEFAULT_K_MAX = 5;

// 🔐 Admin único (Secrets / Variables)
const ADMIN_KEY = process.env.ADMIN_KEY || "CAMBIA_ESTE_ADMIN_KEY_LARGA";

// 💳 Nequi + WhatsApp (Secrets / Variables)
const NEQUI_PHONE = process.env.NEQUI_PHONE || "";
const NEQUI_NAME = process.env.NEQUI_NAME || "";
const NEQUI_NOTE = process.env.NEQUI_NOTE || "";
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || "3504438874").replace(
  /\D/g,
  "",
);

// ✅ Wompi (Widget + Opción B)
const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || "";
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET || "";
const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET || "";

// ✅ Opción B SIN WEBHOOK (consulta API con Private Key)
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY || "";

// =========================
// Helpers base
// =========================
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function nowISO() {
  return new Date().toISOString();
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad6(n) {
  return String(n).padStart(6, "0");
}
function safeStr(v) {
  return String(v ?? "").trim();
}
function validateK(k) {
  return Number.isInteger(k) && k >= DEFAULT_K_MIN && k <= DEFAULT_K_MAX;
}
function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}
function hexToBigInt(hex) {
  return BigInt("0x" + hex);
}
function winnerFromHash(hashHex, totalBoletas) {
  const x = hexToBigInt(hashHex);
  const t = BigInt(totalBoletas);
  return Number((x % t) + 1n); // 1..total
}
function formatBoleta(winner, kDigits) {
  const s = String(winner);
  if (s.length >= kDigits) return s;
  return s.padStart(kDigits, "0");
}

// Firma integrity para Wompi Widget
function wompiIntegritySignature({ reference, amountInCents, currency = "COP" }) {
  const raw = `${reference}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`;
  return sha256Hex(raw);
}

// nCk exacto (n=43, k<=5 OK)
function nCk(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let res = 1;
  for (let i = 1; i <= k; i++) {
    res = (res * (n - k + i)) / i;
  }
  return Math.round(res);
}

function publicBaseUrl(req) {
  const proto = (
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "https"
  ).toString();
  const host = (
    req.headers["x-forwarded-host"] ||
    req.get("host") ||
    ""
  ).toString();
  return `${proto}://${host}`;
}

function newId8() {
  return crypto.randomBytes(4).toString("hex"); // 8 chars
}
function newOrderId() {
  return "ord_" + crypto.randomBytes(6).toString("hex"); // ord_xxxxxx...
}

function toCOP(n) {
  const num = Number(n || 0);
  try {
    return num.toLocaleString("es-CO");
  } catch {
    return String(num);
  }
}

// =========================
// DB: Rifas
// =========================
function readRifasDB() {
  return readJSON(RIFAS_DB_FILE, { rifas: {} });
}
function writeRifasDB(db) {
  writeJSON(RIFAS_DB_FILE, db);
}
function getRifaOr404(rifaId, res) {
  const db = readRifasDB();
  const rifa = db.rifas?.[rifaId];
  if (!rifa) {
    res.status(404).send("Rifa no encontrada");
    return null;
  }
  return { db, rifa };
}
function isDemoRifa(rifa) {
  return safeStr(rifa.modo).toUpperCase() === "DEMO";
}
function isLockedAfterOfficial(rifa) {
  return !!rifa.lockedAfterOfficial;
}
function rifaEstado(rifa) {
  return safeStr(rifa.estado || "ABIERTA").toUpperCase();
}
function isRifaAbierta(rifa) {
  return rifaEstado(rifa) === "ABIERTA" && !isLockedAfterOfficial(rifa);
}
function mustDisallowSimulation(rifa, balotoParam) {
  // PROD: no permitir simulación, solo real
  // DEMO: sí permitir demo, pero marcado NO OFICIAL
  const isReal = safeStr(balotoParam).toLowerCase() === "real";
  if (isDemoRifa(rifa)) return false;
  return !isReal;
}

// =========================
// DB: Orders
// =========================
function readOrdersDB() {
  return readJSON(ORDERS_FILE, { byRifa: {} });
}
function writeOrdersDB(db) {
  writeJSON(ORDERS_FILE, db);
}
function ensureOrdersForRifa(ordersDB, rifaId) {
  if (!ordersDB.byRifa) ordersDB.byRifa = {};
  if (!ordersDB.byRifa[rifaId]) {
    ordersDB.byRifa[rifaId] = { orders: {} };
  }
  if (!ordersDB.byRifa[rifaId].orders) ordersDB.byRifa[rifaId].orders = {};
  return ordersDB.byRifa[rifaId];
}

// =========================
// Baloto parsing
// =========================
function parseBalotoParam(param) {
  const clean = safeStr(param);
  if (!clean) return null;
  const parts = clean
    .replace(/,/g, "-")
    .replace(/\s+/g, "-")
    .split("-")
    .map((x) => x.trim())
    .filter(Boolean);

  if (parts.length < 5) return null;
  const nums = parts.slice(0, 5).map((x) => Number(x));
  if (nums.some((x) => !Number.isFinite(x))) return null;

  const superVal = parts.length >= 6 ? Number(parts[5]) : null;
  return { nums, super: Number.isFinite(superVal) ? superVal : null };
}

function validateBalotoNums(nums, min = 1, max = DEFAULT_N) {
  if (!Array.isArray(nums) || nums.length !== 5) return false;
  if (nums.some((x) => !Number.isInteger(x) || x < min || x > max))
    return false;
  const set = new Set(nums);
  if (set.size !== 5) return false;
  return true;
}
function normalizeBalotoNums(nums) {
  return [...nums].sort((a, b) => a - b);
}
function randomUniqueNumbers(count, min, max) {
  const set = new Set();
  while (set.size < count) {
    const x = Math.floor(Math.random() * (max - min + 1)) + min;
    set.add(x);
  }
  return Array.from(set);
}

// =========================
// Baloto REAL (scraping)
// =========================
async function fetchBalotoReal() {
  const url = "https://www.baloto.com/resultados/";
  const { data: html } = await axios.get(url, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; RifaBot/1.0)" },
  });

  const $ = cheerio.load(html);

  const digits = [];
  $("*").each((_, el) => {
    const t = $(el).text().trim();
    if (/^\d{1,2}$/.test(t)) digits.push(Number(t));
  });

  for (let i = 0; i <= digits.length - 6; i++) {
    const candidate = digits.slice(i, i + 5);
    if (validateBalotoNums(candidate)) {
      const superCandidate = digits[i + 5];
      return {
        nums: normalizeBalotoNums(candidate),
        super: Number.isInteger(superCandidate) ? superCandidate : null,
        fuente: url,
      };
    }
  }

  throw new Error(
    "No fue posible extraer resultados reales desde Baloto (estructura cambió).",
  );
}

// =========================
// Semilla y sello
// =========================
function buildSeed({
  rifaId,
  org,
  balotoNums,
  superBalota,
  k,
  totalBoletas,
  modeLabel,
}) {
  const numsStr = balotoNums.map(pad2).join("-");
  const superStr = superBalota == null ? "NA" : pad2(superBalota);
  return [
    `RIFA:${rifaId}`,
    `ORG:${org}`,
    `MODE:${modeLabel}`, // REAL / DEMO / REAL-MANUAL
    `NUMS:${numsStr}`,
    `SUPER:${superStr}`,
    `K:${k}`,
    `BOLETAS:${totalBoletas}`,
  ].join("|");
}

function stampLabel(result) {
  const tipo = safeStr(result.baloto?.tipo);
  const fuente = safeStr(result.baloto?.fuente);

  if (tipo === "real" && fuente === "manual-admin") {
    return "✅ SELLO OFICIAL (MANUAL ADMIN) – ÚNICA Y NO REPETIBLE";
  }
  if (tipo === "real") {
    return "✅ SELLO OFICIAL (BALOTO REAL) – ÚNICA Y NO REPETIBLE";
  }
  return "⚠️ SIMULACIÓN / DEMO – NO OFICIAL (NO VÁLIDA PARA PREMIOS)";
}

// =========================
// Cálculo del sorteo (DEMO / REAL automático)
// =========================
async function computeSorteo({ rifa, rifaId, balotoParam, kParam }) {
  const k = kParam != null ? Number(kParam) : Number(rifa.k);
  if (!validateK(k)) {
    return { ok: false, status: 400, error: "k inválido (1..5)" };
  }

  const wantsReal = safeStr(balotoParam).toLowerCase() === "real";
  if (wantsReal && isLockedAfterOfficial(rifa)) {
    return {
      ok: false,
      status: 400,
      error: "Sorteo oficial ya realizado. Rifa bloqueada.",
    };
  }

  if (mustDisallowSimulation(rifa, balotoParam)) {
    return {
      ok: false,
      status: 400,
      error:
        "Simulación deshabilitada. Solo se permite sorteo oficial (baloto=real).",
    };
  }

  let nums, superBalota, fuente;

  const p = safeStr(balotoParam).toLowerCase();
  if (p === "real") {
    const real = await fetchBalotoReal();
    nums = real.nums;
    superBalota = real.super;
    fuente = real.fuente;
  } else if (p) {
    const parsed = parseBalotoParam(balotoParam);
    if (parsed && validateBalotoNums(parsed.nums)) {
      nums = normalizeBalotoNums(parsed.nums);
      superBalota = parsed.super;
      fuente = null;
    } else {
      nums = normalizeBalotoNums(randomUniqueNumbers(5, 1, DEFAULT_N));
      superBalota = Math.floor(Math.random() * 17);
      fuente = null;
    }
  } else {
    nums = normalizeBalotoNums(randomUniqueNumbers(5, 1, DEFAULT_N));
    superBalota = Math.floor(Math.random() * 17);
    fuente = null;
  }

  const totalBoletas = nCk(DEFAULT_N, k);
  const modeLabel = wantsReal ? "REAL" : "DEMO";

  const seed = buildSeed({
    rifaId,
    org: rifa.org,
    balotoNums: nums,
    superBalota,
    k,
    totalBoletas,
    modeLabel,
  });

  const hash = sha256Hex(seed);
  const winner = winnerFromHash(hash, totalBoletas);

  return {
    ok: true,
    rifaId,
    org: rifa.org,
    rifaNombre: rifa.nombre,
    modo: isDemoRifa(rifa) ? "DEMO" : "PROD",
    baloto: {
      tipo: wantsReal ? "real" : "demo",
      fuente: wantsReal ? "baloto.com" : "demo",
      nums: nums.map(pad2).join("-"),
      numsArray: nums,
      superBalota: superBalota == null ? null : pad2(superBalota),
      fuenteReal: fuente || null,
      nota: null,
    },
    k,
    totalBoletas,
    boletaGanadora: winner,
    boletaGanadoraFmt: formatBoleta(winner, k),
    seed,
    hashSHA256: hash,
    generadoEn: nowISO(),
  };
}

// =========================
// Oficial MANUAL (solo admin)
// =========================
function computeOfficialManual({
  rifa,
  rifaId,
  balotoStr,
  superBalotaStr,
  kParam,
  nota,
}) {
  const k = kParam != null ? Number(kParam) : Number(rifa.k);
  if (!validateK(k)) {
    return { ok: false, status: 400, error: "k inválido (1..5)" };
  }

  const parsed = parseBalotoParam(balotoStr);
  if (!parsed || !validateBalotoNums(parsed.nums)) {
    return {
      ok: false,
      status: 400,
      error: "Baloto manual inválido. Usa: 03-11-19-27-41",
    };
  }

  const nums = normalizeBalotoNums(parsed.nums);

  let superBalota = null;
  if (superBalotaStr != null && safeStr(superBalotaStr) !== "") {
    const sb = Number(superBalotaStr);
    superBalota = Number.isFinite(sb) ? sb : null;
  } else if (parsed.super != null) {
    superBalota = parsed.super;
  }

  const totalBoletas = nCk(DEFAULT_N, k);
  const modeLabel = "REAL-MANUAL";

  const seed = buildSeed({
    rifaId,
    org: rifa.org,
    balotoNums: nums,
    superBalota,
    k,
    totalBoletas,
    modeLabel,
  });

  const hash = sha256Hex(seed);
  const winner = winnerFromHash(hash, totalBoletas);

  return {
    ok: true,
    rifaId,
    org: rifa.org,
    rifaNombre: rifa.nombre,
    modo: "PROD",
    baloto: {
      tipo: "real",
      fuente: "manual-admin",
      nums: nums.map(pad2).join("-"),
      numsArray: nums,
      superBalota: superBalota == null ? null : pad2(superBalota),
      fuenteReal: null,
      nota: safeStr(nota) || null,
    },
    k,
    totalBoletas,
    boletaGanadora: winner,
    boletaGanadoraFmt: formatBoleta(winner, k),
    seed,
    hashSHA256: hash,
    generadoEn: nowISO(),
  };
}

// =========================
// Actas: consecutivo por org
// =========================
function readActaCounter() {
  return readJSON(ACTA_COUNTER_FILE, { byOrg: {} });
}
function writeActaCounter(c) {
  writeJSON(ACTA_COUNTER_FILE, c);
}
function readActas() {
  return readJSON(ACTAS_FILE, {});
}
function writeActas(actas) {
  writeJSON(ACTAS_FILE, actas);
}
function nextActaConsecutivoForOrg(org) {
  const counter = readActaCounter();
  if (!counter.byOrg) counter.byOrg = {};
  const prev = Number(counter.byOrg[org] || 0);
  const next = prev + 1;
  counter.byOrg[org] = next;
  writeActaCounter(counter);
  return `ACTA-${pad6(next)}`;
}

// Guardar lock + oficial + actas.json
function lockRifaAfterOfficial(db, rifaId, officialResult, actaConsecutivo) {
  const rifa = db.rifas[rifaId];

  rifa.lockedAfterOfficial = true;
  rifa.lockedAt = nowISO();
  rifa.officialResult = officialResult;
  rifa.actaConsecutivo = actaConsecutivo;
  rifa.estado = "FINALIZADA";
  writeRifasDB(db);

  const actas = readActas();
  actas[rifaId] = {
    rifaId,
    org: rifa.org,
    actaConsecutivo,
    createdAt: nowISO(),
    sello: stampLabel(officialResult),
    verify: {
      seed: officialResult.seed,
      hashSHA256: officialResult.hashSHA256,
      boletaGanadora: officialResult.boletaGanadora,
      boletaGanadoraFmt: officialResult.boletaGanadoraFmt,
      balotoNums: officialResult.baloto.nums,
      superBalota: officialResult.baloto.superBalota ?? null,
      k: officialResult.k,
      totalBoletas: officialResult.totalBoletas,
      fuente: officialResult.baloto.fuente,
      nota: officialResult.baloto.nota,
    },
  };
  writeActas(actas);
}

// =========================
// Ventas: asignación consecutiva
// =========================
function ensureRifaSalesFields(db, rifaId) {
  const rifa = db.rifas[rifaId];
  if (rifa.totalBoletas == null)
    rifa.totalBoletas = nCk(DEFAULT_N, Number(rifa.k));
  if (rifa.soldCount == null) rifa.soldCount = 0;
  if (rifa.nextTicket == null) rifa.nextTicket = 1;
  if (!Array.isArray(rifa.sales)) rifa.sales = [];
  return rifa;
}

function approveOrderAssignTickets({ db, rifaId, order }) {
  const rifa = ensureRifaSalesFields(db, rifaId);

  const qty = Number(order.cantidad || 0);
  if (!Number.isFinite(qty) || qty < 1) {
    return { ok: false, status: 400, error: "Cantidad inválida" };
  }

  const total = Number(rifa.totalBoletas);
  const start = Number(rifa.nextTicket);
  const end = start + qty - 1;

  if (end > total) {
    return {
      ok: false,
      status: 400,
      error: "No hay suficientes boletas disponibles",
    };
  }

  order.asignacion = {
    desde: start,
    hasta: end,
    fmtDesde: formatBoleta(start, Number(rifa.k)),
    fmtHasta: formatBoleta(end, Number(rifa.k)),
  };

  rifa.nextTicket = end + 1;
  rifa.soldCount = Number(rifa.soldCount) + qty;

  // si se agotaron boletas, cerrar automáticamente
  if (Number(rifa.soldCount) >= Number(rifa.totalBoletas)) {
    rifa.estado = "CERRADA";
  }

  rifa.sales.push({
    orderId: order.orderId,
    createdAt: order.createdAt,
    approvedAt: nowISO(),
    nombre: order.nombre,
    telefono: order.telefono,
    cantidad: qty,
    desde: start,
    hasta: end,
    totalPago: order.totalPagar,
    wompiTransactionId: order.wompiTransactionId || null,
  });

  db.rifas[rifaId] = rifa;
  return { ok: true, rifa };
}

// =========================
// Auth admin
// =========================
function isAdmin(req) {
  const headerKey = safeStr(req.headers["x-admin-key"]);
  const queryKey = safeStr(req.query.key);
  const key = headerKey || queryKey;
  return key && key === ADMIN_KEY;
}

// =========================
// HTML: links WA / páginas
// =========================
function waLink({ rifaId, orderId, totalPagar }) {
  const msg = `Hola! Envío comprobante de pago.\nRifaID: ${rifaId}\nOrden: ${orderId}\nTotal: $${toCOP(
    totalPagar,
  )} COP\nMi nombre: ____`;
  const enc = encodeURIComponent(msg);
  return `https://wa.me/57${WHATSAPP_NUMBER}?text=${enc}`;
}

function renderHTML(result, rifa) {
  const sello = stampLabel(result);
  const isOfficial = safeStr(result.baloto?.tipo) === "real";

  const warningBlock = isOfficial
    ? ""
    : `<div style="margin-top:10px;padding:10px;border:2px dashed #c00;background:#fff5f5;border-radius:10px;">
         <b>IMPORTANTE:</b> Esto es una <b>SIMULACIÓN</b>. No corresponde a un sorteo oficial.
       </div>`;

  const selloStyle = isOfficial
    ? "background:#ecfff1;border:2px solid #1f8f3a;color:#0b5b1f;"
    : "background:#fff7ea;border:2px solid #d17a00;color:#7a3f00;";

  const pagoOk = !!NEQUI_PHONE && !!NEQUI_NAME;
  const abierta = isRifaAbierta(rifa);

  const totalBoletas = rifa.totalBoletas ?? nCk(DEFAULT_N, Number(rifa.k));
  const sold = Number(rifa.soldCount || 0);
  const disponibles = Math.max(0, totalBoletas - sold);

  const pagoBloque = `
<hr style="margin:20px 0;border:none;border-top:1px solid #e8edf5;"/>

<div style="margin-top:10px;padding:16px;border-radius:14px;background:#f0f9ff;border:1px solid #cfe8ff;">
  <h3 style="margin-top:0;">💳 Comprar Boletas</h3>

  <div style="margin-bottom:6px;"><b>Estado:</b> ${rifaEstado(rifa)}</div>
  <div style="margin-bottom:6px;"><b>Precio por boleta:</b> $${toCOP(
    rifa.precio,
  )} COP</div>

  <div style="margin-bottom:6px;"><b>Disponibles:</b> ${toCOP(
    disponibles,
  )} de ${toCOP(totalBoletas)}</div>

  <div style="margin-bottom:6px;"><b>Pagar a Nequi:</b> ${NEQUI_PHONE}</div>
  <div style="margin-bottom:10px;"><b>A nombre de:</b> ${NEQUI_NAME}</div>

  <div style="margin-bottom:10px; opacity:.9;">${NEQUI_NOTE || ""}</div>

  <a href="/rifas/${result.rifaId}/comprar"
     style="display:inline-block;padding:10px 16px;border-radius:10px;background:#1a7f37;color:white;font-weight:800;text-decoration:none;">
     Comprar boletas
  </a>

  <div style="margin-top:10px;font-size:12px;opacity:.75;">
    * La compra crea una orden <b>PENDIENTE</b>. Si pagas por Wompi se auto-aprueba por opción B (redirect + consulta API).
  </div>
</div>
`;

  let pagoFooter = "";
  if (!pagoOk) {
    pagoFooter = `<div style="margin-top:16px;opacity:.7;font-size:13px;">(Pago Nequi no configurado: agrega NEQUI_PHONE y NEQUI_NAME)</div>`;
  } else if (!abierta) {
    pagoFooter = `<div style="margin-top:16px;opacity:.75;font-size:13px;">
      (La rifa no está abierta para ventas ahora. Estado: <b>${rifaEstado(
        rifa,
      )}</b>)
    </div>`;
  } else {
    pagoFooter = pagoBloque;
  }

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Resultado del Sorteo</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#f5f7fb; margin:0; padding:20px;">
  <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08); padding:22px;">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
      <h1 style="margin:0;">🎉 Resultado del Sorteo 🎉</h1>
      <div style="padding:10px 12px;border-radius:12px; ${selloStyle}; font-weight:700;">
        ${sello}
      </div>
    </div>

    ${warningBlock}

    <div style="margin-top:14px; color:#333;">
      <div><b>Rifa:</b> ${result.rifaNombre} (Org: ${result.org})</div>
      <div style="opacity:.85; font-size:13px;">RifaID: ${result.rifaId}</div>
    </div>

    <hr style="margin:16px 0;border:none;border-top:1px solid #e8edf5;"/>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
      <div>
        <div><b>Baloto usado (ordenado):</b></div>
        <div style="font-size:28px;font-weight:800;margin-top:4px;">${result.baloto.nums}</div>
        <div style="margin-top:10px;"><b>Superbalota:</b> ${result.baloto.superBalota ?? "NA"}</div>
        <div style="margin-top:10px;"><b>k:</b> ${result.k}</div>
        <div style="margin-top:10px;"><b>Total boletas (C(43,k)):</b> ${result.totalBoletas}</div>
        <div style="margin-top:10px;"><b>Fuente:</b> ${result.baloto.fuente}</div>
      </div>
      <div>
        <div><b>Boleta ganadora:</b></div>
        <div style="font-size:56px;font-weight:900;margin-top:6px;color:#1a7f37;">${result.boletaGanadoraFmt}</div>
        <div style="margin-top:10px;"><b>Generado en:</b> ${result.generadoEn}</div>
        ${
          result.baloto.fuenteReal
            ? `<div style="margin-top:10px;"><b>Fuente Baloto real:</b> <a href="${result.baloto.fuenteReal}" target="_blank" rel="noreferrer">${result.baloto.fuenteReal}</a></div>`
            : ""
        }
      </div>
    </div>

    <hr style="margin:16px 0;border:none;border-top:1px solid #e8edf5;"/>

    <div style="font-size:13px; color:#222; line-height:1.55;">
      <div><b>Semilla usada:</b></div>
      <div style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background:#f6f8ff; padding:10px; border-radius:10px; overflow:auto;">
        ${result.seed}
      </div>
      <div style="margin-top:10px;"><b>Hash SHA256:</b></div>
      <div style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background:#f6f8ff; padding:10px; border-radius:10px; overflow:auto;">
        ${result.hashSHA256}
      </div>

      <div style="margin-top:16px;">
        <div><b>Auditoría pública:</b></div>
        <div>• Ver JSON verificable: <a href="/rifas/${result.rifaId}/api/sorteo?baloto=${result.baloto.tipo}&k=${result.k}">/rifas/${result.rifaId}/api/sorteo?baloto=${result.baloto.tipo}&k=${result.k}</a></div>
        <div>• Estado / sello / bloqueo: <a href="/rifas/${result.rifaId}/estado">/rifas/${result.rifaId}/estado</a></div>
        ${
          isOfficial
            ? `<div>• Acta PDF OFICIAL: <a href="/rifas/${result.rifaId}/acta?baloto=real&k=${result.k}">/rifas/${result.rifaId}/acta?baloto=real&k=${result.k}</a></div>`
            : `<div style="opacity:.7">• Acta PDF: solo para sorteo oficial (baloto=real)</div>`
        }
      </div>
    </div>

    ${pagoFooter}
  </div>
</body>
</html>`;
}

function renderComprarPage({ rifaId, rifa }) {
  const totalBoletas = rifa.totalBoletas ?? nCk(DEFAULT_N, Number(rifa.k));
  const sold = Number(rifa.soldCount || 0);
  const disponibles = Math.max(0, totalBoletas - sold);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Comprar boletas</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#f5f7fb; margin:0; padding:20px;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08); padding:22px;">
    <h2 style="margin-top:0;">Comprar boletas</h2>
    <div style="opacity:.85;">RifaID: <b>${rifaId}</b> — Estado: <b>${rifaEstado(
      rifa,
    )}</b></div>
    <hr style="margin:16px 0;border:none;border-top:1px solid #e8edf5;"/>

    <div style="margin-bottom:10px;"><b>Precio por boleta:</b> $${toCOP(
      rifa.precio,
    )} COP</div>
    <div style="margin-bottom:10px;"><b>Disponibles:</b> ${toCOP(
      disponibles,
    )} de ${toCOP(totalBoletas)}</div>

    <div style="padding:14px;border-radius:14px;background:#f0f9ff;border:1px solid #cfe8ff;margin:14px 0;">
      <div><b>Pagar a Nequi:</b> ${NEQUI_PHONE}</div>
      <div><b>A nombre de:</b> ${NEQUI_NAME}</div>
      <div style="margin-top:8px;opacity:.9;">${NEQUI_NOTE || ""}</div>
    </div>

    <form id="f" style="display:grid;gap:10px;">
      <label>Nombre
        <input name="nombre" required style="width:100%;padding:10px;border-radius:10px;border:1px solid #ddd;" />
      </label>
      <label>Teléfono
        <input name="telefono" required style="width:100%;padding:10px;border-radius:10px;border:1px solid #ddd;" />
      </label>
      <label>Cantidad de boletas
        <input name="cantidad" type="number" min="1" required style="width:100%;padding:10px;border-radius:10px;border:1px solid #ddd;" />
      </label>

      <button type="submit" style="padding:12px 16px;border-radius:12px;border:none;background:#1a7f37;color:#fff;font-weight:800;cursor:pointer;">
        Crear orden (PENDIENTE)
      </button>
    </form>

    <div id="out" style="margin-top:12px;"></div>

    <div style="margin-top:14px;font-size:12px;opacity:.7;">
      * Tu orden queda <b>PENDIENTE</b>. Puedes pagar con Wompi y se auto-confirmará por opción B (redirect + consulta API).
    </div>
  </div>

<script>
const f = document.getElementById("f");
const out = document.getElementById("out");

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  out.innerHTML = "Creando orden...";
  const fd = new FormData(f);
  const payload = {
    nombre: fd.get("nombre"),
    telefono: fd.get("telefono"),
    cantidad: Number(fd.get("cantidad")),
  };
  const r = await fetch("/rifas/${rifaId}/ordenes", {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) {
    out.innerHTML = "<div style='color:#c00;font-weight:700;'>Error: " + (j.error||"") + "</div>";
    return;
  }
  window.location.href = "/rifas/${rifaId}/orden/" + j.orderId;
});
</script>
</body>
</html>`;
}

function renderOrdenPage({ rifaId, rifa, order }) {
  const estado = safeStr(order.estado || "PENDIENTE").toUpperCase();
  const wa =
    order.waLink ||
    waLink({ rifaId, orderId: order.orderId, totalPagar: order.totalPagar });

  const payUrl = `/rifas/${rifaId}/orden/${order.orderId}/pagar`;

  let asignacion = "";
  if (estado === "APROBADA" && order.asignacion) {
    asignacion = `<div style="margin-top:10px;padding:12px;border-radius:12px;background:#ecfff1;border:1px solid #bfe8c7;">
      <b>✅ Boletas asignadas:</b><br/>
      Desde: <b>${order.asignacion.fmtDesde}</b> (#{order.asignacion.desde})<br/>
      Hasta: <b>${order.asignacion.fmtHasta}</b> (#{order.asignacion.hasta})
    </div>`;
  }

  const wompiNote =
    order.wompiTransactionId
      ? `<div style="margin-top:10px;font-size:12px;opacity:.75;">Wompi tx: <b>${safeStr(order.wompiTransactionId)}</b> — ${safeStr(order.wompiStatus || "")}</div>`
      : "";

  const payBlock =
    estado === "PENDIENTE" &&
    isRifaAbierta(rifa) &&
    WOMPI_PUBLIC_KEY &&
    WOMPI_INTEGRITY_SECRET
      ? `<div style="margin-top:12px;">
           <a href="${payUrl}"
              style="display:inline-block;padding:10px 16px;border-radius:10px;background:#111827;color:white;font-weight:900;text-decoration:none;">
             Pagar con Wompi
           </a>
           <div style="margin-top:8px;font-size:12px;opacity:.75;">
             * Si pagas por Wompi, al volver a esta pantalla se auto-confirmará (opción B).
           </div>
         </div>`
      : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Orden ${order.orderId}</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#f5f7fb; margin:0; padding:20px;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08); padding:22px;">
    <h2 style="margin-top:0;">Orden de compra</h2>
    <div style="opacity:.85;">RifaID: <b>${rifaId}</b> — Estado rifa: <b>${rifaEstado(
      rifa,
    )}</b></div>
    <hr style="margin:16px 0;border:none;border-top:1px solid #e8edf5;"/>

    <div style="padding:12px;border-radius:12px;background:#f6f8ff;border:1px solid #dfe6ff;">
      <div><b>Orden:</b> ${order.orderId}</div>
      <div><b>Estado orden:</b> ${estado}</div>
      <div><b>Nombre:</b> ${safeStr(order.nombre)}</div>
      <div><b>Teléfono:</b> ${safeStr(order.telefono)}</div>
      <div><b>Cantidad:</b> ${toCOP(order.cantidad)}</div>
      <div><b>Total a pagar:</b> $${toCOP(order.totalPagar)} COP</div>
      ${wompiNote}
    </div>

    ${asignacion}

    ${payBlock}

    <div style="margin-top:14px;padding:14px;border-radius:14px;background:#f0f9ff;border:1px solid #cfe8ff;">
      <div><b>Pagar a Nequi:</b> ${NEQUI_PHONE}</div>
      <div><b>A nombre de:</b> ${NEQUI_NAME}</div>
      <div style="margin-top:8px;opacity:.9;">${NEQUI_NOTE || ""}</div>
      <div style="margin-top:10px;font-size:13px;">
        En el comentario del pago escribe: <b>RifaID ${rifaId} - Orden ${order.orderId}</b>
      </div>
      <div style="margin-top:12px;">
        <a href="${wa}" target="_blank" rel="noreferrer"
           style="display:inline-block;padding:10px 16px;border-radius:10px;background:#0b57d0;color:white;font-weight:800;text-decoration:none;">
          Enviar comprobante por WhatsApp
        </a>
      </div>
    </div>

    <div style="margin-top:12px;font-size:12px;opacity:.7;">
      * Tu orden queda <b>PENDIENTE</b> hasta que el pago sea confirmado (admin o opción B).
    </div>

    <div style="margin-top:12px;">
      <a href="/rifas/${rifaId}/sorteo?baloto=demo&k=${rifa.k}" style="text-decoration:none;color:#1a7f37;font-weight:700;">⬅ Volver al sorteo</a>
    </div>
  </div>
</body>
</html>`;
}

// =========================
// PDF Acta OFICIAL
// =========================
async function generateActaPDF({
  req,
  res,
  rifa,
  rifaId,
  officialResult,
  actaConsecutivo,
}) {
  const base = publicBaseUrl(req);
  const verifyUrl = `${base}/rifas/${rifaId}/api/sorteo?baloto=real&k=${officialResult.k}`;
  const estadoUrl = `${base}/rifas/${rifaId}/estado`;
  const sello = stampLabel(officialResult);

  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, scale: 8 });
  const qrImage = Buffer.from(qrDataUrl.split(",")[1], "base64");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${actaConsecutivo}.pdf"`,
  );

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);

  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("ACTA OFICIAL DE SORTEO", { align: "center" });
  doc.moveDown(0.5);

  doc.roundedRect(50, doc.y, 495, 40, 10).fillAndStroke("#ecfff1", "#1f8f3a");
  doc
    .fillColor("#0b5b1f")
    .fontSize(12)
    .font("Helvetica-Bold")
    .text(sello, 60, doc.y - 28);
  doc.fillColor("#000");
  doc.moveDown(1.5);

  doc.fontSize(12).font("Helvetica").text(`Consecutivo: ${actaConsecutivo}`);
  doc.text(`Fecha y hora (ISO): ${officialResult.generadoEn}`);
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").text("Datos del sorteo");
  doc.font("Helvetica").moveDown(0.4);

  doc.text(`Rifa: ${rifa.nombre}`);
  doc.text(`Organizador (Org / Cédula / NIT): ${rifa.org}`);
  doc.text(`RifaID: ${rifaId}`);
  doc.moveDown(0.6);

  doc.text(`Baloto utilizado (ordenado): ${officialResult.baloto.nums}`);
  doc.text(`Superbalota: ${officialResult.baloto.superBalota ?? "NA"}`);
  doc.text(`Fuente: ${officialResult.baloto.fuente}`);
  if (officialResult.baloto.nota)
    doc.text(`Nota: ${officialResult.baloto.nota}`);
  doc.text(`k: ${officialResult.k}`);
  doc.text(`Total de boletas (C(43,k)): ${officialResult.totalBoletas}`);
  doc
    .font("Helvetica-Bold")
    .text(`Boleta ganadora: ${officialResult.boletaGanadoraFmt}`);
  doc.font("Helvetica").moveDown(0.8);

  doc.font("Helvetica-Bold").text("Auditoría y verificación");
  doc.font("Helvetica").moveDown(0.4);

  doc.text("Semilla:");
  doc.font("Courier").fontSize(9).text(officialResult.seed, { width: 400 });
  doc.font("Helvetica").fontSize(12).moveDown(0.4);

  doc.text("Hash SHA256:");
  doc.font("Courier").fontSize(9).text(officialResult.hashSHA256);
  doc.font("Helvetica").fontSize(12).moveDown(0.6);

  if (officialResult.baloto.fuenteReal)
    doc.text(`Fuente Baloto real: ${officialResult.baloto.fuenteReal}`);

  doc.text(`JSON verificable: ${verifyUrl}`);
  doc.text(`Estado / sello / bloqueo: ${estadoUrl}`);

  doc.image(qrImage, 400, 190, { width: 150, height: 150 });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#333")
    .text("Escanea para verificar el JSON", 395, 345, {
      width: 170,
      align: "center",
    });

  doc.end();
}

// =========================
// HOME
// =========================
app.get("/", (req, res) => {
  res.type("text").send(
    `Rifas Bakend OK ✅

Crear rifa PROD:
- POST /api/rifas
  body: { "org":"CEDULA/NIT", "nombre":"...", "k":2, "precio":5000 }

Crear demo:
- GET /crear-demo?org=1032456789

Sorteo:
- GET /rifas/:rifaId/sorteo?baloto=demo&k=2 (HTML)
- GET /rifas/:rifaId/api/sorteo?baloto=demo&k=2 (JSON)
- GET /rifas/:rifaId/sorteo?baloto=real&k=2 (HTML REAL)
- GET /rifas/:rifaId/acta?baloto=real&k=2 (PDF OFICIAL, bloquea y finaliza)

Ventas:
- GET  /rifas/:rifaId/comprar
- POST /rifas/:rifaId/ordenes
- GET  /rifas/:rifaId/orden/:orderId
- GET  /rifas/:rifaId/orden/:orderId/pagar (Wompi Widget)

Confirmación (Opción B):
- Al volver del Widget: /rifas/:rifaId/orden/:orderId?wompi=1
  -> consulta API Wompi con WOMPI_PRIVATE_KEY
  -> si APPROVED: auto-aprueba y asigna boletas

Webhook Wompi (opcional):
- POST /webhooks/wompi

Admin (requiere key):
- GET  /rifas/:rifaId/admin/panel?key=ADMIN_KEY
- GET  /rifas/:rifaId/admin/ordenes?key=ADMIN_KEY
- POST /rifas/:rifaId/admin/ordenes/:orderId/aprobar?key=ADMIN_KEY
- POST /rifas/:rifaId/admin/ordenes/:orderId/rechazar?key=ADMIN_KEY
- GET  /rifas/:rifaId/admin/ordenes/:orderId/aprobar-web?key=ADMIN_KEY
- GET  /rifas/:rifaId/admin/ordenes/:orderId/rechazar-web?key=ADMIN_KEY
- POST /rifas/:rifaId/admin/estado?key=ADMIN_KEY   body: { "estado":"ABIERTA|CERRADA|FINALIZADA" }

Plan B (si falla scraping):
- POST /rifas/:rifaId/oficial-manual?key=ADMIN_KEY
  body: { "baloto":"03-11-19-27-41", "superbalota":"08", "nota":"..." }`,
  );
});

// =========================
// Crear rifa PROD (precio variable)
// =========================
app.post("/api/rifas", (req, res) => {
  try {
    const org = safeStr(req.body.org);
    const nombre = safeStr(req.body.nombre) || "Rifa sin nombre";
    const k = Number(req.body.k ?? 2);
    const precio = Number(req.body.precio ?? 5000);

    if (!org)
      return res
        .status(400)
        .json({ ok: false, error: "Falta org (cédula o NIT)" });
    if (!validateK(k))
      return res.status(400).json({ ok: false, error: "k inválido (1..5)" });
    if (!Number.isFinite(precio) || precio < 1)
      return res.status(400).json({ ok: false, error: "precio inválido" });

    const db = readRifasDB();
    if (!db.rifas) db.rifas = {};

    const rifaId = newId8();
    const totalBoletas = nCk(DEFAULT_N, k);

    db.rifas[rifaId] = {
      rifaId,
      org,
      nombre,
      k,
      precio,
      modo: "PROD",
      estado: "ABIERTA",
      createdAt: nowISO(),
      lockedAfterOfficial: false,
      lockedAt: null,
      officialResult: null,
      actaConsecutivo: null,

      totalBoletas,
      soldCount: 0,
      nextTicket: 1,
      sales: [],
    };

    writeRifasDB(db);
    res.json({ ok: true, rifaId, totalBoletas });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error creando rifa" });
  }
});

// =========================
// Crear rifa DEMO
// =========================
app.get("/crear-demo", (req, res) => {
  try {
    const db = readRifasDB();
    if (!db.rifas) db.rifas = {};

    const rifaId = newId8();
    const org = safeStr(req.query.org) || "1032456789";

    const k = 2;
    const totalBoletas = nCk(DEFAULT_N, k);

    db.rifas[rifaId] = {
      rifaId,
      org,
      nombre: "Rifa Demo",
      k,
      precio: 5000,
      modo: "DEMO",
      estado: "ABIERTA",
      createdAt: nowISO(),
      lockedAfterOfficial: false,
      lockedAt: null,
      officialResult: null,
      actaConsecutivo: null,

      totalBoletas,
      soldCount: 0,
      nextTicket: 1,
      sales: [],
    };

    writeRifasDB(db);
    res.json({ ok: true, rifaId, totalBoletas });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error creando demo" });
  }
});

// =========================
// Estado / auditoría pública
// =========================
app.get("/rifas/:rifaId/estado", (req, res) => {
  const { rifaId } = req.params;
  const got = getRifaOr404(rifaId, res);
  if (!got) return;

  const { rifa } = got;
  const actas = readActas();
  const acta = actas[rifaId] || null;

  const totalBoletas = rifa.totalBoletas ?? nCk(DEFAULT_N, Number(rifa.k));
  const sold = Number(rifa.soldCount || 0);

  res.json({
    ok: true,
    rifaId,
    org: rifa.org,
    nombre: rifa.nombre,
    modo: rifa.modo,
    estado: rifaEstado(rifa),
    precio: rifa.precio,
    createdAt: rifa.createdAt,

    totalBoletas,
    soldCount: sold,
    disponibles: Math.max(0, totalBoletas - sold),

    lockedAfterOfficial: !!rifa.lockedAfterOfficial,
    lockedAt: rifa.lockedAt || null,
    actaConsecutivo: rifa.actaConsecutivo || null,

    sello: rifa.lockedAfterOfficial
      ? rifa.officialResult
        ? stampLabel(rifa.officialResult)
        : "✅ SELLO OFICIAL – ÚNICA Y NO REPETIBLE"
      : isDemoRifa(rifa)
        ? "⚠️ DEMO – NO OFICIAL"
        : "⏳ AÚN SIN SELLO OFICIAL (no se ha ejecutado baloto=real)",
    verificacion: acta ? acta.verify : null,
  });
});

// =========================
// JSON verificable del sorteo
// =========================
app.get("/rifas/:rifaId/api/sorteo", async (req, res) => {
  try {
    const { rifaId } = req.params;
    const balotoParam = String(req.query.baloto || "").trim() || "real";
    const kParam = req.query.k != null ? Number(req.query.k) : null;

    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { rifa } = got;

    const wantsReal = safeStr(balotoParam).toLowerCase() === "real";
    if (wantsReal && isLockedAfterOfficial(rifa) && rifa.officialResult) {
      return res.json(rifa.officialResult);
    }

    const result = await computeSorteo({ rifa, rifaId, balotoParam, kParam });
    if (!result.ok)
      return res
        .status(result.status || 400)
        .json({ ok: false, error: result.error });

    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Error en sorteo" });
  }
});

// =========================
// HTML del sorteo
// =========================
app.get("/rifas/:rifaId/sorteo", async (req, res) => {
  try {
    const { rifaId } = req.params;
    const balotoParam = String(req.query.baloto || "").trim() || "demo";
    const kParam = req.query.k != null ? Number(req.query.k) : null;

    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { rifa } = got;

    const wantsReal = safeStr(balotoParam).toLowerCase() === "real";
    if (wantsReal && isLockedAfterOfficial(rifa) && rifa.officialResult) {
      return res.type("html").send(renderHTML(rifa.officialResult, rifa));
    }

    const result = await computeSorteo({ rifa, rifaId, balotoParam, kParam });
    if (!result.ok) return res.status(result.status || 400).send(result.error);

    res.type("html").send(renderHTML(result, rifa));
  } catch (e) {
    res.status(500).send(e?.message || "Error mostrando sorteo");
  }
});

// =========================
// Página: Comprar (form)
// =========================
app.get("/rifas/:rifaId/comprar", (req, res) => {
  const { rifaId } = req.params;
  const got = getRifaOr404(rifaId, res);
  if (!got) return;

  const { rifa } = got;

  if (!NEQUI_PHONE || !NEQUI_NAME)
    return res.status(400).send("Pago Nequi no configurado.");
  if (!isRifaAbierta(rifa))
    return res
      .status(400)
      .send(`Rifa no abierta para ventas. Estado: ${rifaEstado(rifa)}`);

  res.type("html").send(renderComprarPage({ rifaId, rifa }));
});

// =========================
// Crear orden (PENDIENTE)
// =========================
app.post("/rifas/:rifaId/ordenes", (req, res) => {
  try {
    const { rifaId } = req.params;
    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { db, rifa } = got;

    if (!NEQUI_PHONE || !NEQUI_NAME)
      return res
        .status(400)
        .json({ ok: false, error: "Pago Nequi no configurado" });
    if (!isRifaAbierta(rifa))
      return res.status(400).json({
        ok: false,
        error: `Rifa no abierta. Estado: ${rifaEstado(rifa)}`,
      });

    const nombre = safeStr(req.body.nombre);
    const telefono = safeStr(req.body.telefono);
    const cantidad = Number(req.body.cantidad);

    if (!nombre)
      return res.status(400).json({ ok: false, error: "Falta nombre" });
    if (!telefono)
      return res.status(400).json({ ok: false, error: "Falta teléfono" });
    if (!Number.isFinite(cantidad) || cantidad < 1)
      return res.status(400).json({ ok: false, error: "Cantidad inválida" });

    ensureRifaSalesFields(db, rifaId);

    const totalBoletas = Number(db.rifas[rifaId].totalBoletas);
    const sold = Number(db.rifas[rifaId].soldCount || 0);
    const disponibles = Math.max(0, totalBoletas - sold);
    if (cantidad > disponibles) {
      return res
        .status(400)
        .json({ ok: false, error: "No hay suficientes boletas disponibles" });
    }

    const orderId = newOrderId();
    const totalPagar = Number(db.rifas[rifaId].precio) * cantidad;

    const ordersDB = readOrdersDB();
    const slot = ensureOrdersForRifa(ordersDB, rifaId);

    const order = {
      orderId,
      rifaId,
      org: rifa.org,
      nombre,
      telefono,
      cantidad,
      precioUnidad: Number(db.rifas[rifaId].precio),
      totalPagar,
      estado: "PENDIENTE",
      createdAt: nowISO(),
      approvedAt: null,
      rejectedAt: null,
      asignacion: null,
      waLink: waLink({ rifaId, orderId, totalPagar }),

      // Wompi
      wompiTransactionId: null,
      wompiStatus: null,
    };

    slot.orders[orderId] = order;
    writeOrdersDB(ordersDB);
    writeRifasDB(db);

    res.json({
      ok: true,
      orderId,
      estado: order.estado,
      totalPagar,
      waLink: order.waLink,
      verOrden: `/rifas/${rifaId}/orden/${orderId}`,
      pagarWompi: `/rifas/${rifaId}/orden/${orderId}/pagar`,
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error creando orden" });
  }
});

// =========================
// ✅ Ver orden (HTML) + Opción B (auto-confirmación sin webhook)
// =========================
app.get("/rifas/:rifaId/orden/:orderId", async (req, res) => {
  const { rifaId, orderId } = req.params;

  const got = getRifaOr404(rifaId, res);
  if (!got) return;
  const { rifa } = got;

  const ordersDB = readOrdersDB();
  const slot = ordersDB.byRifa?.[rifaId];
  const order = slot?.orders?.[orderId];
  if (!order) return res.status(404).send("Orden no encontrada");

  // =========================
  // 🔥 OPCIÓN B: al regresar del widget (?wompi=1), consultamos Wompi API
  // =========================
  const wantsCheck = String(req.query.wompi || "") === "1";
  if (wantsCheck && safeStr(order.estado).toUpperCase() === "PENDIENTE") {
    try {
      if (WOMPI_PRIVATE_KEY) {
        const txUrl = `https://production.wompi.co/v1/transactions?reference=${encodeURIComponent(
          orderId,
        )}`;

        const { data } = await axios.get(txUrl, {
          headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` },
          timeout: 15000,
        });

        const tx = data?.data?.[0] || null;
        const status = safeStr(tx?.status).toUpperCase();

        // guardar estado wompi aunque no esté aprobado
        if (status) order.wompiStatus = status;
        if (tx?.id) order.wompiTransactionId = safeStr(tx.id);

        if (status === "APPROVED") {
          const db = readRifasDB();

          const r = approveOrderAssignTickets({ db, rifaId, order });
          if (r.ok) {
            order.estado = "APROBADA";
            order.approvedAt = nowISO();

            // persistir
            ordersDB.byRifa[rifaId].orders[orderId] = order;
            writeOrdersDB(ordersDB);
            writeRifasDB(db);
          }
        } else if (["DECLINED", "ERROR", "VOIDED"].includes(status)) {
          order.estado = "RECHAZADA";
          order.rejectedAt = nowISO();

          ordersDB.byRifa[rifaId].orders[orderId] = order;
          writeOrdersDB(ordersDB);
        } else {
          // PENDING u otros: solo persistimos wompiStatus/tx id
          ordersDB.byRifa[rifaId].orders[orderId] = order;
          writeOrdersDB(ordersDB);
        }
      }
    } catch (e) {
      console.log("Opción B: error consultando Wompi:", e?.message || e);
    }
  }

  res.type("html").send(renderOrdenPage({ rifaId, rifa, order }));
});

// =========================
// ✅ Pagar con Wompi (Widget) por orden
// =========================
app.get("/rifas/:rifaId/orden/:orderId/pagar", (req, res) => {
  const { rifaId, orderId } = req.params;

  const got = getRifaOr404(rifaId, res);
  if (!got) return;
  const { rifa } = got;

  const ordersDB = readOrdersDB();
  const slot = ordersDB.byRifa?.[rifaId];
  const order = slot?.orders?.[orderId];
  if (!order) return res.status(404).send("Orden no encontrada");

  if (!WOMPI_PUBLIC_KEY || !WOMPI_INTEGRITY_SECRET) {
    return res.status(400).send("Wompi no está configurado (public/integrity).");
  }
  if (!isRifaAbierta(rifa)) {
    return res.status(400).send(`Rifa no abierta. Estado: ${rifaEstado(rifa)}`);
  }

  const reference = orderId; // ✅ referencia única
  const amountInCents = Math.round(Number(order.totalPagar || 0) * 100);
  const currency = "COP";

  const signature = wompiIntegritySignature({
    reference,
    amountInCents,
    currency,
  });

  const base = publicBaseUrl(req);

  // ✅ Opción B: volvemos a la orden con ?wompi=1 para validar pago
  const redirectUrl = ${base}/rifas/${rifaId}/orden/${orderId}?wompi=1;

  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Pagar orden ${orderId}</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f5f7fb;margin:0;padding:20px;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:22px;">
    <h2 style="margin-top:0;">Pagar con Wompi</h2>
    <div style="opacity:.85;">Orden: <b>${orderId}</b> — Total: <b>$${toCOP(
    order.totalPagar,
  )} COP</b></div>

    <div style="margin-top:14px;">
      <form>
       <script
  src="https://checkout.wompi.co/widget.js"
  data-render="button"
  data-public-key="${WOMPI_PUBLIC_KEY}"
  data-currency="${currency}"
  data-amount-in-cents="${amountInCents}"
  data-reference="${reference}"
  data-signature:integrity="${signature}"
  data-redirect-url="${redirectUrl}">
</script>
      </form>
    </div>

    <div style="margin-top:12px;font-size:12px;opacity:.75;">
      * Al terminar, Wompi te redirige y el backend valida la transacción automáticamente (opción B).
    </div>

    <div style="margin-top:12px;">
      <a href="/rifas/${rifaId}/orden/${orderId}" style="text-decoration:none;color:#1a7f37;font-weight:700;">⬅ Volver a la orden</a>
    </div>
  </div>
</body>
</html>`);
});

// =========================
// ✅ Webhook Wompi (sigue existiendo, opcional)
// =========================
app.post("/webhooks/wompi", express.json({ type: "*/*" }), (req, res) => {
  try {
    if (!WOMPI_EVENTS_SECRET) {
      return res.status(400).send("WOMPI_EVENTS_SECRET no configurado.");
    }

    const event = req.body;
    const data = event?.data || event?.transaction || event;

    const tx = data?.transaction || data;
    const reference = safeStr(tx?.reference || "");
    const status = safeStr(tx?.status || "").toUpperCase();
    const transactionId = safeStr(tx?.id || tx?.transaction_id || "");

    if (!reference || !reference.startsWith("ord_")) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const ordersDB = readOrdersDB();
    const rifasDB = readRifasDB();

    let found = null;
    let foundRifaId = null;

    for (const [rifaId, slot] of Object.entries(ordersDB.byRifa || {})) {
      if (slot?.orders?.[reference]) {
        found = slot.orders[reference];
        foundRifaId = rifaId;
        break;
      }
    }

    if (!found || !foundRifaId) {
      return res.status(200).json({ ok: true, notFound: true });
    }

    // Guardar estado Wompi
    found.wompiStatus = status || found.wompiStatus || null;
    if (transactionId) found.wompiTransactionId = transactionId;

    // Solo actuar si está PENDIENTE
    if (safeStr(found.estado).toUpperCase() !== "PENDIENTE") {
      ordersDB.byRifa[foundRifaId].orders[reference] = found;
      writeOrdersDB(ordersDB);
      return res.status(200).json({ ok: true, alreadyProcessed: true });
    }

    if (status === "APPROVED") {
      const db = rifasDB;

      const r = approveOrderAssignTickets({
        db,
        rifaId: foundRifaId,
        order: found,
      });
      if (!r.ok) {
        console.error("approveOrderAssignTickets error:", r.error);
        ordersDB.byRifa[foundRifaId].orders[reference] = found;
        writeOrdersDB(ordersDB);
        return res.status(200).json({ ok: false, error: r.error });
      }

      found.estado = "APROBADA";
      found.approvedAt = nowISO();

      ordersDB.byRifa[foundRifaId].orders[reference] = found;
      writeOrdersDB(ordersDB);
      writeRifasDB(db);

      return res.status(200).json({ ok: true, approved: true, orderId: reference });
    }

    if (["DECLINED", "ERROR", "VOIDED"].includes(status)) {
      found.estado = "RECHAZADA";
      found.rejectedAt = nowISO();
      ordersDB.byRifa[foundRifaId].orders[reference] = found;
      writeOrdersDB(ordersDB);
      return res.status(200).json({ ok: true, rejected: true, orderId: reference });
    }

    ordersDB.byRifa[foundRifaId].orders[reference] = found;
    writeOrdersDB(ordersDB);
    return res.status(200).json({ ok: true, status });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(200).json({ ok: false, error: e?.message || "webhook error" });
  }
});

// =========================
// Admin: listar órdenes (JSON)
// =========================
app.get("/rifas/:rifaId/admin/ordenes", (req, res) => {
  const { rifaId } = req.params;
  if (!isAdmin(req))
    return res.status(403).json({ ok: false, error: "No autorizado" });

  const got = getRifaOr404(rifaId, res);
  if (!got) return;

  const ordersDB = readOrdersDB();
  const slot = ordersDB.byRifa?.[rifaId];
  const orders = slot?.orders ? Object.values(slot.orders) : [];

  orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  res.json({ ok: true, rifaId, orders });
});

// =========================
// Admin panel (HTML) con links aprobar/rechazar
// =========================
app.get("/rifas/:rifaId/admin/panel", (req, res) => {
  const { rifaId } = req.params;
  if (!isAdmin(req)) return res.status(403).send("No autorizado");

  const got = getRifaOr404(rifaId, res);
  if (!got) return;
  const { rifa } = got;

  const ordersDB = readOrdersDB();
  const slot = ordersDB.byRifa?.[rifaId];
  const orders = slot?.orders ? Object.values(slot.orders) : [];
  orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const key = encodeURIComponent(String(req.query.key || ""));
  const rows = orders
    .map((o) => {
      const estado = safeStr(o.estado).toUpperCase();
      const canAct = estado === "PENDIENTE";
      const approveLink = `/rifas/${rifaId}/admin/ordenes/${o.orderId}/aprobar-web?key=${key}`;
      const rejectLink = `/rifas/${rifaId}/admin/ordenes/${o.orderId}/rechazar-web?key=${key}`;
      const verOrden = `/rifas/${rifaId}/orden/${o.orderId}`;

      return `
<tr>
  <td style="padding:10px;border-top:1px solid #eee;font-family:ui-monospace,monospace;">${o.orderId}</td>
  <td style="padding:10px;border-top:1px solid #eee;">${safeStr(o.nombre)}</td>
  <td style="padding:10px;border-top:1px solid #eee;">${safeStr(o.telefono)}</td>
  <td style="padding:10px;border-top:1px solid #eee;text-align:right;">${toCOP(o.cantidad)}</td>
  <td style="padding:10px;border-top:1px solid #eee;text-align:right;">$${toCOP(o.totalPagar)}</td>
  <td style="padding:10px;border-top:1px solid #eee;"><b>${estado}</b></td>
  <td style="padding:10px;border-top:1px solid #eee;">
    <a href="${verOrden}" target="_blank" rel="noreferrer">Ver</a>
    ${
      canAct
        ? ` &nbsp;|&nbsp; <a href="${approveLink}" style="color:#1a7f37;font-weight:800;">Aprobar</a>
            &nbsp;|&nbsp; <a href="${rejectLink}" style="color:#b00020;font-weight:800;">Rechazar</a>`
        : ""
    }
  </td>
</tr>`;
    })
    .join("");

  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Admin Panel</title>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f5f7fb;margin:0;padding:20px;">
  <div style="max-width:1100px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:20px;">
    <h2 style="margin:0;">Admin Panel — ${rifa.nombre}</h2>
    <div style="opacity:.8;margin-top:6px;">RifaID: <b>${rifaId}</b> — Estado rifa: <b>${rifaEstado(
      rifa,
    )}</b></div>
    <div style="margin-top:10px;">
      <a href="/rifas/${rifaId}/estado" target="_blank" rel="noreferrer">Ver /estado</a>
      &nbsp;|&nbsp;
      <a href="/rifas/${rifaId}/sorteo?baloto=demo&k=${rifa.k}" target="_blank" rel="noreferrer">Ver sorteo</a>
    </div>
    <hr style="margin:16px 0;border:none;border-top:1px solid #e8edf5;"/>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;padding:10px;">Orden</th>
          <th style="text-align:left;padding:10px;">Nombre</th>
          <th style="text-align:left;padding:10px;">Teléfono</th>
          <th style="text-align:right;padding:10px;">Cant.</th>
          <th style="text-align:right;padding:10px;">Total</th>
          <th style="text-align:left;padding:10px;">Estado</th>
          <th style="text-align:left;padding:10px;">Acciones</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="7" style="padding:12px;">Sin órdenes.</td></tr>`}</tbody>
    </table>
  </div>
</body>
</html>`);
});

// =========================
// Admin: aprobar orden (POST)
// =========================
app.post("/rifas/:rifaId/admin/ordenes/:orderId/aprobar", (req, res) => {
  try {
    const { rifaId, orderId } = req.params;
    if (!isAdmin(req))
      return res.status(403).json({ ok: false, error: "No autorizado" });

    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { db } = got;

    const ordersDB = readOrdersDB();
    const slot = ensureOrdersForRifa(ordersDB, rifaId);
    const order = slot.orders[orderId];
    if (!order)
      return res.status(404).json({ ok: false, error: "Orden no encontrada" });

    if (safeStr(order.estado).toUpperCase() !== "PENDIENTE") {
      return res
        .status(400)
        .json({ ok: false, error: "Orden no está en PENDIENTE" });
    }

    const r = approveOrderAssignTickets({ db, rifaId, order });
    if (!r.ok)
      return res.status(r.status || 400).json({ ok: false, error: r.error });

    order.estado = "APROBADA";
    order.approvedAt = nowISO();
    slot.orders[orderId] = order;

    writeOrdersDB(ordersDB);
    writeRifasDB(db);

    res.json({
      ok: true,
      mensaje: "Orden aprobada y boletas asignadas",
      orderId,
      asignacion: order.asignacion,
      estadoRifa: rifaEstado(db.rifas[rifaId]),
      soldCount: db.rifas[rifaId].soldCount,
      nextTicket: db.rifas[rifaId].nextTicket,
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error aprobando orden" });
  }
});

// =========================
// Admin: rechazar orden (POST)
// =========================
app.post("/rifas/:rifaId/admin/ordenes/:orderId/rechazar", (req, res) => {
  try {
    const { rifaId, orderId } = req.params;
    if (!isAdmin(req))
      return res.status(403).json({ ok: false, error: "No autorizado" });

    const ordersDB = readOrdersDB();
    const slot = ensureOrdersForRifa(ordersDB, rifaId);
    const order = slot.orders[orderId];
    if (!order)
      return res.status(404).json({ ok: false, error: "Orden no encontrada" });

    if (safeStr(order.estado).toUpperCase() !== "PENDIENTE") {
      return res
        .status(400)
        .json({ ok: false, error: "Orden no está en PENDIENTE" });
    }

    order.estado = "RECHAZADA";
    order.rejectedAt = nowISO();
    slot.orders[orderId] = order;
    writeOrdersDB(ordersDB);

    res.json({ ok: true, mensaje: "Orden rechazada", orderId });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error rechazando orden" });
  }
});

// =========================
// Admin: aprobar por LINK (GET) + redirect a la orden
// =========================
app.get("/rifas/:rifaId/admin/ordenes/:orderId/aprobar-web", (req, res) => {
  try {
    const { rifaId, orderId } = req.params;
    if (!isAdmin(req)) return res.status(403).send("No autorizado");

    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { db } = got;

    const ordersDB = readOrdersDB();
    const slot = ensureOrdersForRifa(ordersDB, rifaId);
    const order = slot.orders[orderId];
    if (!order) return res.status(404).send("Orden no encontrada");

    if (safeStr(order.estado).toUpperCase() !== "PENDIENTE") {
      return res.status(400).send("Orden no está en PENDIENTE");
    }

    const r = approveOrderAssignTickets({ db, rifaId, order });
    if (!r.ok) return res.status(r.status || 400).send(r.error);

    order.estado = "APROBADA";
    order.approvedAt = nowISO();
    slot.orders[orderId] = order;

    writeOrdersDB(ordersDB);
    writeRifasDB(db);

    return res.redirect(`/rifas/${rifaId}/orden/${orderId}`);
  } catch (e) {
    res.status(500).send(e?.message || "Error aprobando (web)");
  }
});

// =========================
// Admin: rechazar por LINK (GET) + redirect a la orden
// =========================
app.get("/rifas/:rifaId/admin/ordenes/:orderId/rechazar-web", (req, res) => {
  try {
    const { rifaId, orderId } = req.params;
    if (!isAdmin(req)) return res.status(403).send("No autorizado");

    const ordersDB = readOrdersDB();
    const slot = ensureOrdersForRifa(ordersDB, rifaId);
    const order = slot.orders[orderId];
    if (!order) return res.status(404).send("Orden no encontrada");

    if (safeStr(order.estado).toUpperCase() !== "PENDIENTE") {
      return res.status(400).send("Orden no está en PENDIENTE");
    }

    order.estado = "RECHAZADA";
    order.rejectedAt = nowISO();
    slot.orders[orderId] = order;
    writeOrdersDB(ordersDB);

    return res.redirect(`/rifas/${rifaId}/orden/${orderId}`);
  } catch (e) {
    res.status(500).send(e?.message || "Error rechazando (web)");
  }
});

// =========================
// Admin: cambiar estado rifa (ABIERTA/CERRADA/FINALIZADA)
// =========================
app.post("/rifas/:rifaId/admin/estado", (req, res) => {
  try {
    const { rifaId } = req.params;
    if (!isAdmin(req))
      return res.status(403).json({ ok: false, error: "No autorizado" });

    const estado = safeStr(req.body.estado).toUpperCase();
    if (!["ABIERTA", "CERRADA", "FINALIZADA"].includes(estado)) {
      return res.status(400).json({
        ok: false,
        error: "Estado inválido (ABIERTA|CERRADA|FINALIZADA)",
      });
    }

    const db = readRifasDB();
    const rifa = db.rifas?.[rifaId];
    if (!rifa)
      return res.status(404).json({ ok: false, error: "Rifa no encontrada" });

    rifa.estado = estado;
    writeRifasDB(db);

    res.json({ ok: true, rifaId, estado });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error cambiando estado" });
  }
});

// =========================
// Acta PDF (solo OFICIAL). Aquí se "sella" y se bloquea.
// =========================
app.get("/rifas/:rifaId/acta", async (req, res) => {
  try {
    const { rifaId } = req.params;
    const balotoParam = String(req.query.baloto || "").trim() || "real";
    const kParam = req.query.k != null ? Number(req.query.k) : null;

    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { db, rifa } = got;

    if (safeStr(balotoParam).toLowerCase() !== "real") {
      return res
        .status(400)
        .send("Acta solo se genera para sorteo oficial (baloto=real).");
    }

    // Si ya bloqueada: reimprime
    if (
      isLockedAfterOfficial(rifa) &&
      rifa.officialResult &&
      rifa.actaConsecutivo
    ) {
      return generateActaPDF({
        req,
        res,
        rifa,
        rifaId,
        officialResult: rifa.officialResult,
        actaConsecutivo: rifa.actaConsecutivo,
      });
    }

    // Ejecutar sorteo oficial automático (scraping)
    const officialResult = await computeSorteo({
      rifa,
      rifaId,
      balotoParam: "real",
      kParam,
    });

    if (!officialResult.ok)
      return res
        .status(officialResult.status || 400)
        .send(officialResult.error);

    const actaConsecutivo = nextActaConsecutivoForOrg(rifa.org);
    lockRifaAfterOfficial(db, rifaId, officialResult, actaConsecutivo);

    return generateActaPDF({
      req,
      res,
      rifa: db.rifas[rifaId],
      rifaId,
      officialResult,
      actaConsecutivo,
    });
  } catch (e) {
    res.status(500).send(e?.message || "Error generando acta");
  }
});

// =========================
// OFICIAL MANUAL (solo admin)
// =========================
app.post("/rifas/:rifaId/oficial-manual", (req, res) => {
  try {
    const { rifaId } = req.params;
    if (!isAdmin(req))
      return res.status(403).json({ ok: false, error: "No autorizado" });

    const { baloto, superbalota, nota, k } = req.body || {};
    const balotoStr = safeStr(baloto);

    const got = getRifaOr404(rifaId, res);
    if (!got) return;
    const { db, rifa } = got;

    if (isLockedAfterOfficial(rifa)) {
      return res.status(400).json({
        ok: false,
        error: "Rifa ya bloqueada (ya tiene sorteo oficial).",
      });
    }

    const officialResult = computeOfficialManual({
      rifa,
      rifaId,
      balotoStr,
      superBalotaStr: superbalota,
      kParam: k != null ? Number(k) : null,
      nota,
    });

    if (!officialResult.ok) {
      return res
        .status(officialResult.status || 400)
        .json({ ok: false, error: officialResult.error });
    }

    const actaConsecutivo = nextActaConsecutivoForOrg(rifa.org);
    lockRifaAfterOfficial(db, rifaId, officialResult, actaConsecutivo);

    res.json({
      ok: true,
      mensaje: "✅ Sorteo oficial MANUAL sellado y rifa bloqueada.",
      rifaId,
      actaConsecutivo,
      links: {
        html: `/rifas/${rifaId}/sorteo?baloto=real&k=${officialResult.k}`,
        json: `/rifas/${rifaId}/api/sorteo?baloto=real&k=${officialResult.k}`,
        estado: `/rifas/${rifaId}/estado`,
        actaPdf: `/rifas/${rifaId}/acta?baloto=real&k=${officialResult.k}`,
      },
      official: officialResult,
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e?.message || "Error en oficial-manual" });
  }
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto", PORT));
