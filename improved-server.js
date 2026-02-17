const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));
app.use((req, res, next) => { req.setTimeout(300000); res.setTimeout(300000); next(); }); // 5 min for upscale

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
fs.mkdir('uploads', { recursive: true });

// ============================================
// COLOR SCIENCE
// ============================================
function srgbToLinear(c) { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearRgbToXyz(r, g, b) {
  return { x: r*0.4124564+g*0.3575761+b*0.1804375, y: r*0.2126729+g*0.7151522+b*0.0721750, z: r*0.0193339+g*0.1191920+b*0.9503041 };
}
function xyzToLab(x, y, z) {
  const xn=0.95047,yn=1,zn=1.08883;
  function f(t){return t>0.008856?Math.cbrt(t):(903.3*t+16)/116;}
  return { L: 116*f(y/yn)-16, a: 500*(f(x/xn)-f(y/yn)), b: 200*(f(y/yn)-f(z/zn)) };
}
function rgbToLab(r,g,b) {
  const lr=srgbToLinear(r),lg=srgbToLinear(g),lb=srgbToLinear(b);
  const xyz=linearRgbToXyz(lr,lg,lb);
  return xyzToLab(xyz.x,xyz.y,xyz.z);
}
const labCache = new Map();
function rgbToLabCached(r,g,b) {
  const k=(r<<16)|(g<<8)|b; let l=labCache.get(k);
  if(!l){l=rgbToLab(r,g,b);if(labCache.size>500000)labCache.clear();labCache.set(k,l);} return l;
}
function deltaE76Fast(r,g,b,bgLab) {
  const l=rgbToLabCached(r,g,b);
  return Math.sqrt((l.L-bgLab.L)**2+(l.a-bgLab.a)**2+(l.b-bgLab.b)**2);
}

// ============================================
// BACKGROUND DETECTION
// ============================================
function detectBackgroundColor(data, width, height, channels) {
  const samples = [];
  const s = 10;
  const areas = [
    {x:0,y:0},{x:width-s,y:0},{x:0,y:height-s},{x:width-s,y:height-s},
    {x:Math.floor(width/2)-5,y:0},{x:Math.floor(width/2)-5,y:height-s},
    {x:0,y:Math.floor(height/2)-5},{x:width-s,y:Math.floor(height/2)-5}
  ];
  areas.forEach(a => {
    for(let y=a.y;y<Math.min(a.y+s,height);y++)
      for(let x=a.x;x<Math.min(a.x+s,width);x++){
        const o=(y*width+x)*channels;
        samples.push({r:data[o],g:data[o+1],b:data[o+2]});
      }
  });
  const cc = new Map();
  samples.forEach(c => {
    const k=`${Math.floor(c.r/5)*5}-${Math.floor(c.g/5)*5}-${Math.floor(c.b/5)*5}`;
    if(!cc.has(k)) cc.set(k,{n:0,r:0,g:0,b:0});
    const e=cc.get(k); e.n++; e.r+=c.r; e.g+=c.g; e.b+=c.b;
  });
  let mx=0, dom={r:255,g:255,b:255};
  for(const [,e] of cc) if(e.n>mx){mx=e.n;dom={r:Math.round(e.r/e.n),g:Math.round(e.g/e.n),b:Math.round(e.b/e.n)};}
  return dom;
}

// ============================================
// 5-PHASE BACKGROUND REMOVAL
// ============================================
const dx8=[-1,1,0,0,-1,-1,1,1], dy8=[0,0,-1,1,-1,1,-1,1];

function advancedBackgroundRemoval(data, width, height, channels, bgColor, threshold, minIslandSize) {
  const result = Buffer.from(data);
  const bgLab = rgbToLab(bgColor.r, bgColor.g, bgColor.b);
  const tp = width * height;
  
  const labTh = Math.max(threshold * 0.8, 2);
  const transTh = labTh * 1.3;
  
  console.log(`🌊 labTh=${labTh.toFixed(1)}, transTh=${transTh.toFixed(1)}`);
  
  // Pre-compute deltaE
  const dem = new Float32Array(tp);
  for (let i = 0; i < tp; i++) {
    const o = i * channels;
    dem[i] = deltaE76Fast(data[o], data[o+1], data[o+2], bgLab);
  }
  
  const mask = new Uint8Array(tp);
  
  // === PHASE 1: Edge flood-fill ===
  const queue = new Int32Array(tp);
  let qH = 0, qT = 0;
  
  for (let x = 0; x < width; x++) {
    for (const y of [0, height-1]) {
      const i = y*width+x; if(mask[i]) continue;
      if (dem[i] <= labTh) { mask[i]=1; queue[qT++]=i; }
      else if (dem[i] <= transTh) mask[i]=2;
    }
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width-1]) {
      const i = y*width+x; if(mask[i]) continue;
      if (dem[i] <= labTh) { mask[i]=1; queue[qT++]=i; }
      else if (dem[i] <= transTh) mask[i]=2;
    }
  }
  
  while (qH < qT) {
    const ci = queue[qH++];
    const cx = ci % width, cy = (ci-cx) / width;
    for (let d = 0; d < 8; d++) {
      const nx = cx+dx8[d], ny = cy+dy8[d];
      if (nx<0||nx>=width||ny<0||ny>=height) continue;
      const ni = ny*width+nx;
      if (mask[ni]) continue;
      if (dem[ni] <= labTh) { mask[ni]=1; queue[qT++]=ni; }
      else if (dem[ni] <= transTh) mask[ni]=2;
      else mask[ni]=3;
    }
  }
  for (let i=0; i<tp; i++) if(!mask[i]) mask[i]=3;
  
  let p1=0; for(let i=0;i<tp;i++) if(mask[i]===1) p1++;
  console.log(`🌊 Phase 1 (flood): ${p1} bg`);
  
  // === PHASE 2: Interior islands ===
  const vis = new Uint8Array(tp);
  let islandPx = 0, islandN = 0;
  
  for (let i = 0; i < tp; i++) {
    if (mask[i]!==3 || vis[i] || dem[i]>labTh) continue;
    const rg=[]; const rq=[i]; vis[i]=1; let rh=0;
    while (rh < rq.length) {
      const ci=rq[rh++]; rg.push(ci);
      const cx=ci%width, cy=(ci-cx)/width;
      for(let d=0;d<8;d++){
        const nx=cx+dx8[d],ny=cy+dy8[d];
        if(nx<0||nx>=width||ny<0||ny>=height)continue;
        const ni=ny*width+nx;
        if(vis[ni]||mask[ni]!==3||dem[ni]>labTh)continue;
        vis[ni]=1; rq.push(ni);
      }
    }
    if (rg.length >= minIslandSize) {
      islandN++;
      for(const idx of rg) { mask[idx]=1; islandPx++; }
      for(const idx of rg) {
        const cx=idx%width,cy=(idx-cx)/width;
        for(let d=0;d<8;d++){
          const nx=cx+dx8[d],ny=cy+dy8[d];
          if(nx<0||nx>=width||ny<0||ny>=height)continue;
          const ni=ny*width+nx;
          if(mask[ni]===3&&dem[ni]<=transTh) mask[ni]=2;
        }
      }
    }
  }
  console.log(`🏝️ Phase 2 (islands): ${islandN} found, ${islandPx} px`);
  
  // === PHASE 3: Transition refinement ===
  let prom=0, dem2=0;
  for(let y=1;y<height-1;y++) for(let x=1;x<width-1;x++) {
    const i=y*width+x; if(mask[i]!==2)continue;
    let fg=0,bg=0;
    for(let d=0;d<8;d++){const nm=mask[(y+dy8[d])*width+(x+dx8[d])];if(nm===3)fg++;else if(nm===1)bg++;}
    if(fg>bg&&fg>=3){mask[i]=3;prom++;}
    else if(bg>=5){mask[i]=1;dem2++;}
  }
  console.log(`🔄 Phase 3 (refine): +${prom} fg, +${dem2} bg`);
  
  // === PHASE 4: Boundary cleanup ===
  let bcTotal = 0;
  for (let pass = 0; pass < 5; pass++) {
    let pc = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y*width+x;
        if (mask[i] !== 3 && mask[i] !== 2) continue;
        
        let touchesBg = false;
        for (let d = 0; d < 8 && !touchesBg; d++) {
          const nx=x+dx8[d], ny=y+dy8[d];
          if (nx<0||nx>=width||ny<0||ny>=height) touchesBg=true;
          else if (mask[ny*width+nx] === 1) touchesBg = true;
        }
        if (!touchesBg) continue;
        
        const d = dem[i];
        if (d <= labTh * 1.5) { mask[i]=1; pc++; }
        else if (d <= labTh * 2.2) { mask[i]=2; pc++; }
      }
    }
    bcTotal += pc;
    if (pc === 0) break;
  }
  console.log(`🧹 Phase 4 (boundary): ${bcTotal} px`);
  
  // === PHASE 5: Apply mask ===
  let fBg=0, fTr=0, fFg=0;
  for (let i = 0; i < tp; i++) {
    const o = i * channels;
    if (mask[i] === 1) { result[o+3]=0; fBg++; }
    else if (mask[i] === 2) {
      const ratio = (dem[i]-labTh) / (transTh-labTh);
      result[o+3] = Math.floor(Math.max(0, Math.min(255, ratio*255)));
      fTr++;
    } else { fFg++; }
  }
  console.log(`✅ bg=${fBg}, trans=${fTr}, fg=${fFg}`);
  
  return { result, mask };
}

// ============================================
// POST-PROCESSING
// ============================================
function smartErosion(data, w, h, ch, mask, r) {
  const res = Buffer.from(data); const toE=[];
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x; if(res[i*ch+3]===0)continue;
    let tb=false;
    for(let ky=-r;ky<=r&&!tb;ky++) for(let kx=-r;kx<=r&&!tb;kx++){
      if(!kx&&!ky)continue;
      const ny=y+ky,nx=x+kx;
      if(ny<0||ny>=h||nx<0||nx>=w)tb=true;
      else if(mask[ny*w+nx]===1)tb=true;
    }
    if(tb) toE.push(i);
  }
  for(const i of toE){res[i*ch+3]=0;mask[i]=1;}
  console.log(`🔧 Erosion: ${toE.length} px`);
  return res;
}

function smartDecontamination(data, w, h, ch, mask, bg) {
  const res=Buffer.from(data); let n=0;
  for(let i=0;i<w*h;i++){
    const o=i*ch; const a=res[o+3];
    if(a===0||a===255||mask[i]!==2)continue;
    const af=a/255; if(af<0.1){res[o+3]=0;continue;}
    res[o]=Math.max(0,Math.min(255,Math.round((res[o]-bg.r*(1-af))/af)));
    res[o+1]=Math.max(0,Math.min(255,Math.round((res[o+1]-bg.g*(1-af))/af)));
    res[o+2]=Math.max(0,Math.min(255,Math.round((res[o+2]-bg.b*(1-af))/af)));
    n++;
  }
  console.log(`🧪 Decontam: ${n} px`);
  return res;
}

function smartEdgeSoftening(data, w, h, ch, mask, r=1) {
  const res=Buffer.from(data);
  for(let y=r;y<h-r;y++) for(let x=r;x<w-r;x++){
    const i=y*w+x,o=i*ch; if(data[o+3]===0)continue;
    let isE=false;
    for(let ky=-1;ky<=1&&!isE;ky++) for(let kx=-1;kx<=1&&!isE;kx++){
      if(!kx&&!ky)continue; if(mask[(y+ky)*w+(x+kx)]===1) isE=true;
    }
    if(!isE) continue;
    let tA=0,tW=0;
    for(let ky=-r;ky<=r;ky++) for(let kx=-r;kx<=r;kx++){
      const ny=y+ky,nx=x+kx; if(ny<0||ny>=h||nx<0||nx>=w)continue;
      const d=Math.sqrt(kx*kx+ky*ky), wt=Math.exp(-(d*d)/(2*0.8*0.8));
      tA+=data[(ny*w+nx)*ch+3]*wt; tW+=wt;
    }
    res[o+3]=Math.round(tA/tW);
  }
  return res;
}

// ============================================
// ENDPOINTS
// ============================================
app.get('/', (req, res) => {
  res.json({ status:'ok', service:'Yerlikaya Auto Crop API', version:'3.5.0',
    features:['Upscale pipeline (2x-4x)','Flood-fill + island removal','Boundary cleanup','CIE Lab','Smart post-processing'] });
});

app.post('/crop', upload.single('image'), async (req, res) => {
  let imagePath;
  try {
    const f = req.file;
    if(!f) return res.status(400).json({error:'Image file required'});
    if(f.size>20*1024*1024){await fs.unlink(f.path);return res.status(400).json({error:'File too large'});}
    
    imagePath = f.path;
    const threshold = parseInt(req.body.threshold)||15;
    const erosionRadius = parseInt(req.body.erosion)||1;
    const decontaminate = req.body.decontaminate!=='false';
    const softenEdges = req.body.softenEdges!=='false';
    const minIslandSize = parseInt(req.body.minIsland)||100;
    const upscaleFactor = parseInt(req.body.upscale)||2; // 1=off, 2=2x, 3=3x, 4=4x
    
    console.log('='.repeat(60));
    console.log(`🔍 v3.5 | th:${threshold} ero:${erosionRadius} island:${minIslandSize} upscale:${upscaleFactor}x`);
    
    // Load original
    const originalMeta = await sharp(imagePath).metadata();
    const origW = originalMeta.width;
    const origH = originalMeta.height;
    console.log(`📐 Original: ${origW}x${origH}`);
    
    // === STEP 1: Detect background on original ===
    const {data: origData, info: origInfo} = await sharp(imagePath).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const bgColor = detectBackgroundColor(origData, origInfo.width, origInfo.height, origInfo.channels);
    console.log('🎨 BG:', bgColor);
    
    // === STEP 2: Upscale ===
    let workBuffer;
    if (upscaleFactor > 1) {
      const upW = origW * upscaleFactor;
      const upH = origH * upscaleFactor;
      console.log(`🔎 Upscaling ${upscaleFactor}x → ${upW}x${upH}`);
      workBuffer = await sharp(imagePath)
        .resize(upW, upH, { kernel: 'lanczos3', fit: 'fill' })
        .toBuffer();
    } else {
      workBuffer = await sharp(imagePath).toBuffer();
    }
    
    // === STEP 3: Trim on upscaled ===
    console.log('✂️ Trimming...');
    const trimmedBuffer = await sharp(workBuffer)
      .trim({ background: bgColor, threshold })
      .toBuffer();
    
    // Get trimmed dimensions for downscale ratio
    const trimMeta = await sharp(trimmedBuffer).metadata();
    
    const {data: cd, info: ci} = await sharp(trimmedBuffer)
      .ensureAlpha().raw().toBuffer({resolveWithObject:true});
    console.log(`📐 Work size: ${ci.width}x${ci.height}`);
    
    const t0 = Date.now();
    
    // === STEP 4: Background removal on upscaled ===
    // Scale island size with upscale factor
    const scaledIslandSize = minIslandSize * upscaleFactor * upscaleFactor;
    
    let {result: processed, mask} = advancedBackgroundRemoval(
      cd, ci.width, ci.height, ci.channels, bgColor, threshold, scaledIslandSize
    );
    
    console.log(`⏱️ Removal: ${Date.now()-t0}ms`);
    
    // === STEP 5: Post-processing on upscaled ===
    if (erosionRadius > 0) {
      for (let i = 0; i < erosionRadius; i++)
        processed = smartErosion(processed, ci.width, ci.height, ci.channels, mask, 1);
    }
    if (decontaminate)
      processed = smartDecontamination(processed, ci.width, ci.height, ci.channels, mask, bgColor);
    if (softenEdges)
      processed = smartEdgeSoftening(processed, ci.width, ci.height, ci.channels, mask);
    
    labCache.clear();
    
    // === STEP 6: Create PNG from processed pixels ===
    let finalBuffer = await sharp(processed, {
      raw: { width: ci.width, height: ci.height, channels: ci.channels }
    }).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
    
    // === STEP 7: Downscale back to original proportions ===
    if (upscaleFactor > 1) {
      // Calculate target size: trimmed size / upscale factor
      const targetW = Math.round(ci.width / upscaleFactor);
      const targetH = Math.round(ci.height / upscaleFactor);
      console.log(`🔽 Downscaling → ${targetW}x${targetH}`);
      
      finalBuffer = await sharp(finalBuffer)
        .resize(targetW, targetH, { kernel: 'lanczos3', fit: 'fill' })
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toBuffer();
    }
    
    console.log(`✅ ${(finalBuffer.length/1024).toFixed(0)}KB in ${Date.now()-t0}ms`);
    console.log('='.repeat(60));
    
    res.set({'Content-Type':'image/png','Content-Disposition':`attachment; filename="cropped-${Date.now()}.png"`});
    res.send(finalBuffer);
    
  } catch(e) {
    console.error('❌',e); labCache.clear();
    res.status(500).json({error:'Failed',details:e.message});
  } finally { if(imagePath) await fs.unlink(imagePath).catch(()=>{}); }
});

app.post('/trim', upload.single('image'), async (req, res) => {
  let imagePath;
  try {
    const f=req.file; if(!f) return res.status(400).json({error:'Image required'});
    imagePath=f.path;
    const buf = await sharp(imagePath).trim({threshold:parseInt(req.body.threshold)||10}).png().toBuffer();
    res.set({'Content-Type':'image/png','Content-Disposition':`attachment; filename="trimmed-${Date.now()}.png"`});
    res.send(buf);
  } catch(e) { res.status(500).json({error:'Failed',details:e.message}); }
  finally { if(imagePath) await fs.unlink(imagePath).catch(()=>{}); }
});

app.listen(PORT, () => console.log(`🚀 Yerlikaya Auto Crop v3.5 (Upscale Pipeline) on port ${PORT}`));
