import express from "express"
import fs from "fs"
import crypto from "crypto"
import axios from "axios"

const app = express()
app.use(express.json())

// ======================
// VARIABLES
// ======================

const PORT = process.env.PORT || 3000

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || ""
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY || ""
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET || ""

if (!WOMPI_PUBLIC_KEY) console.log("⚠️ WOMPI_PUBLIC_KEY no configurado")
if (!WOMPI_PRIVATE_KEY) console.log("⚠️ WOMPI_PRIVATE_KEY no configurado")
if (!WOMPI_INTEGRITY_SECRET) console.log("⚠️ WOMPI_INTEGRITY_SECRET no configurado")

// ======================
// DB SIMPLE
// ======================

const DB_FILE = "./orders.json"

function readDB(){
 if(!fs.existsSync(DB_FILE)) return {}
 return JSON.parse(fs.readFileSync(DB_FILE))
}

function writeDB(data){
 fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2))
}

// ======================
// UTILS
// ======================

function sha256(str){
 return crypto.createHash("sha256").update(str).digest("hex")
}

function wompiSignature(reference, amount, currency){
 const raw = `${reference}${amount}${currency}${WOMPI_INTEGRITY_SECRET}`
 return sha256(raw)
}

function money(n){
 return Number(n).toLocaleString("es-CO")
}

// ======================
// HOME
// ======================

app.get("/", (req,res)=>{
 res.send("Servidor rifas funcionando ✅")
})

// ======================
// CREAR ORDEN
// ======================

app.post("/orden", (req,res)=>{

 const nombre = req.body.nombre
 const telefono = req.body.telefono
 const cantidad = Number(req.body.cantidad)

 const precio = 5000

 if(!nombre) return res.json({error:"nombre requerido"})
 if(!telefono) return res.json({error:"telefono requerido"})
 if(!cantidad) return res.json({error:"cantidad requerida"})

 const total = precio * cantidad

 const orderId = "ord_"+crypto.randomBytes(6).toString("hex")

 const db = readDB()

 db[orderId] = {
  orderId,
  nombre,
  telefono,
  cantidad,
  total,
  estado:"PENDIENTE"
 }

 writeDB(db)

 res.json({
  ok:true,
  orderId,
  pagar:`/orden/${orderId}/pagar`
 })

})

// ======================
// PAGAR ORDEN
// ======================

app.get("/orden/:id/pagar",(req,res)=>{

 const id = req.params.id

 const db = readDB()

 const order = db[id]

 if(!order) return res.send("Orden no existe")

 const amountInCents = order.total * 100

 const currency = "COP"

 const signature = wompiSignature(id,amountInCents,currency)

 const redirect = `${req.protocol}://${req.get("host")}/orden/${id}?wompi=1`

 res.send(`

<html>
<head>
<title>Pagar</title>
</head>

<body style="font-family:Arial">

<h2>Pagar orden ${id}</h2>

<h3>Total $${money(order.total)} COP</h3>

<script
src="https://checkout.wompi.co/widget.js"
data-render="button"
data-public-key="${WOMPI_PUBLIC_KEY}"
data-currency="${currency}"
data-amount-in-cents="${amountInCents}"
data-reference="${id}"
data-signature-integrity="${signature}"
data-redirect-url="${redirect}">
</script>

</body>
</html>

`)

})

// ======================
// VER ORDEN + VERIFICAR
// ======================

app.get("/orden/:id", async (req,res)=>{

 const id = req.params.id

 const db = readDB()

 const order = db[id]

 if(!order) return res.send("Orden no existe")

 if(req.query.wompi){

  try{

   const url = `https://production.wompi.co/v1/transactions?reference=${id}`

   const r = await axios.get(url,{
    headers:{
     Authorization:`Bearer ${WOMPI_PRIVATE_KEY}`
    }
   })

   const tx = r.data.data[0]

   if(tx){

    order.estado = tx.status

    db[id] = order

    writeDB(db)

   }

  }catch(e){

   console.log("error consultando wompi")

  }

 }

 res.send(`

<h2>Orden ${id}</h2>

Nombre: ${order.nombre}<br>
Telefono: ${order.telefono}<br>
Cantidad: ${order.cantidad}<br>
Total: $${money(order.total)} COP<br>

Estado pago: <b>${order.estado}</b>

`)

})

// ======================
// START
// ======================

app.listen(PORT,"0.0.0.0",()=>{

 console.log("Servidor iniciado en puerto "+PORT)

})
