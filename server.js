const express=require("express");
const multer=require("multer");
const sharp=require("sharp");
const path=require("path");
const fs=require("fs");
const {fal}=require("@fal-ai/client");

const app=express();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024}});
app.use(express.static(__dirname));

if(!process.env.FAL_KEY){
  console.warn("FAL_KEY is not set. Add it to .env or your hosting environment.");
}
fal.config({credentials:process.env.FAL_KEY||""});

async function uploadBuffer(buf,name,mime){
  return await fal.storage.upload(new File([buf],name,{type:mime||"image/jpeg"}));
}

/*
  The VTO model accepts a person + garment reference. We build a single garment
  reference containing the saree photo plus a clean lace strip. This gives the
  model both the outfit and the lace reference. The final AI stage is responsible
  for putting the outfit on the person.
*/
async function makeGarmentReference(saree,lace){
  const sareeMeta=await sharp(saree.buffer).metadata();
  const width=900;
  const sareeBuf=await sharp(saree.buffer).resize({width,withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
  const laceBuf=await sharp(lace.buffer).resize({width:Math.min(width,1200),height:170,fit:"contain",background:{r:255,g:255,b:255,alpha:1}}).png().toBuffer();
  const canvas=await sharp({
    create:{width,height:1200,channels:3,background:"#ffffff"}
  }).composite([
    {input:sareeBuf,top:0,left:0},
    {input:laceBuf,top:1000,left:0}
  ]).jpeg({quality:92}).toBuffer();
  return canvas;
}

app.post("/api/generate",upload.fields([{name:"person",maxCount:1},{name:"saree",maxCount:1},{name:"lace",maxCount:1}]),async(req,res)=>{
  try{
    const person=req.files?.person?.[0], saree=req.files?.saree?.[0], lace=req.files?.lace?.[0];
    if(!person||!saree||!lace) return res.status(400).json({error:"Customer, saree और lace तीनों photos जरूरी हैं."});
    if(!process.env.FAL_KEY) return res.status(500).json({error:"FAL_KEY configured नहीं है. Server में FAL_KEY डालें."});

    const garment=await makeGarmentReference(saree,lace);
    const personURL=await uploadBuffer(person.buffer,person.originalname,person.mimetype);
    const garmentURL=await uploadBuffer(garment,"lotus-saree-lace-reference.jpg","image/jpeg");

    const placement=req.body.placement||"साड़ी बॉर्डर";
    const design=req.body.design||"";
    const prompt=`Create a photorealistic Indian fashion look. Keep the customer's identity, face, skin tone, body proportions and pose unchanged. Dress the person in the supplied saree/outfit reference. Apply the supplied lace reference accurately as a decorative textile trim on the ${placement}. Preserve the lace's original pattern, width, texture and colour as closely as possible. Design number ${design}. Do not add unrelated jewellery, patterns, text or extra trims. Natural fabric folds, realistic stitching, lighting and shadows.`;

    const result=await fal.subscribe("fal-ai/flux-pro/v1/vto",{
      input:{
        prompt,
        human_image_url:personURL,
        garment_image_url:garmentURL,
        output_format:"jpeg",
        sync_mode:true
      }
    });
    const url=result?.data?.images?.[0]?.url;
    if(!url) return res.status(502).json({error:"AI ने image result नहीं लौटाया."});
    res.json({url});
  }catch(err){
    console.error(err);
    res.status(500).json({error:err.message||"AI generation failed"});
  }
});

const port=process.env.PORT||3000;
app.listen(port,"0.0.0.0",()=>console.log(`Lotus AI Virtual Trial Room running on http://localhost:${port}`));
