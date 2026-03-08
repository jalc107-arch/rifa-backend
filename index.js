import express from "express"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"

const app = express()
app.use(express.json())
app.set("trust proxy", 1)

const PORT = process.env.PORT || 3000

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
)

function getBaseUrl(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol
  const host = req.headers["x-forwarded-host"] || req.get("host")
  return `${proto}://${host}`
}

function genReference(){
  return "ord_" + crypto.randomBytes(6).toString("hex")
}

function now(){
  return new Date().toISOString()
}

app.get("/", async(req,res)=>{
  res.json({ok:true})
})

app.get("/debug/wompi",(req,res)=>{

  res.json({
    ok:true,
    env: WOMPI_PUBLIC_KEY?.startsWith("pub_test_") ? "sandbox" : "production",
    pub_prefix: WOMPI_PUBLIC_KEY?.slice(0,9),
    prv_prefix: WOMPI_PRIVATE_KEY?.slice(0,9),
    integrity_len: WOMPI_INTEGRITY_SECRET?.length,
    missing:{
      SUPABASE_URL: !SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !SUPABASE_SERVICE_ROLE_KEY,
      WOMPI_PUBLIC_KEY: !WOMPI_PUBLIC_KEY,
      WOMPI_PRIVATE_KEY: !WOMPI_PRIVATE_KEY,
      WOMPI_INTEGRITY_SECRET: !WOMPI_INTEGRITY_SECRET
    }
  })
})

app.get("/rifas/:rifaId/comprar", async(req,res)=>{

  try{

    const { rifaId } = req.params

    const buyerName = req.query.buyer_name
    const buyerPhone = req.query.buyer_phone
    const qty = Number(req.query.qty || 1)

    const { data: rifa } = await supabase
      .from("rifas")
      .select("*")
      .eq("id", rifaId)
      .single()

    if(!rifa){
      return res.status(404).json({ok:false,error:"Rifa no existe"})
    }

    const total = qty * rifa.price_per_ticket

    let buyer

    const { data: existingBuyer } = await supabase
      .from("buyers")
      .select("*")
      .eq("phone", buyerPhone)
      .maybeSingle()

    if(existingBuyer){
      buyer = existingBuyer
    }else{

      const { data: newBuyer } = await supabase
        .from("buyers")
        .insert({
          full_name: buyerName,
          phone: buyerPhone
        })
        .select()
        .single()

      buyer = newBuyer
    }

    const reference = genReference()

    const { data: order } = await supabase
      .from("orders")
      .insert({
        rifa_id: rifaId,
        buyer_id: buyer.id,
        qty,
        subtotal: total,
        total_paid: total,
        payment_status:"created"
      })
      .select()
      .single()

    await supabase
      .from("payments")
      .insert({
        order_id: order.id,
        provider:"wompi",
        external_reference: reference,
        amount: total,
        status:"CREATED"
      })

    const base = getBaseUrl(req)

    res.json({
      ok:true,
      rifa:{
        id: rifa.id,
        title: rifa.title
      },
      buyer,
      order:{
        id: order.id,
        reference,
        qty,
        total
      },
      links:{
        pagar:`${base}/rifas/${rifaId}/orden/${order.id}/pagar?reference=${reference}`
      }
    })

  }catch(e){

    res.status(500).json({ok:false,error:e.message})

  }

})

app.get("/rifas/:rifaId/orden/:orderId/pagar", async(req,res)=>{

  try{

    const { rifaId, orderId } = req.params
    const reference = req.query.reference

    const { data: order } = await supabase
      .from("orders")
      .select(`
      *,
      rifas(*),
      buyers(*)
      `)
      .eq("id",orderId)
      .single()

    const currency = "COP"
    const amountInCents = String(order.total_paid * 100)

    const signature = crypto
      .createHash("sha256")
      .update(reference + amountInCents + currency + WOMPI_INTEGRITY_SECRET)
      .digest("hex")

    console.log("WOMPI DEBUG",{
      reference,
      amountInCents,
      currency,
      signature
    })

    const base = getBaseUrl(req)
    const redirectUrl = `${base}/rifas/${rifaId}/orden/${orderId}`

    res.send(`

<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Pagar con Wompi</title>
</head>

<body style="font-family:Arial;padding:30px;background:#f5f7fb">

<h2>Pagar con Wompi</h2>

<p>Rifa: ${order.rifas.title}</p>
<p>Comprador: ${order.buyers.full_name}</p>
<p>Total: $${order.total_paid}</p>

<pre>

reference: ${reference}
amountInCents: ${amountInCents}
signature: ${signature}

</pre>

<script src="https://checkout.wompi.co/widget.js"></script>

<button
class="wompi-button"
data-public-key="${WOMPI_PUBLIC_KEY}"
data-currency="${currency}"
data-amount-in-cents="${amountInCents}"
data-reference="${reference}"
data-signature-integrity="${signature}"
data-redirect-url="${redirectUrl}"
>

Pagar con Wompi

</button>

</body>
</html>

`)

  }catch(e){

    res.status(500).send(e.message)

  }

})

app.post("/wompi/webhook", async(req,res)=>{

  try{

    const tx = req.body?.data?.transaction

    if(!tx){
      return res.json({ok:true})
    }

    const reference = tx.reference
    const status = tx.status

    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("external_reference",reference)
      .single()

    if(!payment){
      return res.json({ok:true})
    }

    if(status==="APPROVED"){

      await supabase
        .from("orders")
        .update({
          payment_status:"paid",
          paid_at:now()
        })
        .eq("id",payment.order_id)

    }

    res.json({ok:true})

  }catch(e){

    res.status(500).json({ok:false})

  }

})

app.listen(PORT,"0.0.0.0",()=>{
  console.log("Servidor corriendo en puerto",PORT)
})
