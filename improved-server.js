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

// Timeout (3 min)
app.use((req, res, next) => {
  req.setTimeout(180000);
  res.setTimeout(180000);
  next();
});

const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }
});

fs.mkdir('uploads', { recursive: true });

// ============================================
// COLOR SCIENCE - CIE Lab
// ============================================

function srgbToLinear(c) {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearRgbToXyz(r, g, b) {
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    z: r * 0.0193339 + g * 0.1191920 + b * 0.9503041
  };
}

function xyzToLab(x, y, z) {
  const xn = 0.95047, yn = 1.00000, zn = 1.08883;
  function f(t) {
    return t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
  }
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const xyz = linearRgbToXyz(lr, lg, lb);
  return xyzToLab(xyz.x, xyz.y, xyz.z);
}

// On-demand Lab cache
const labCache = new Map();

function rgbToLabCached(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let lab = labCache.get(key);
  if (!lab) {
    lab = rgbToLab(r, g, b);
    if (labCache.size > 500000) labCache.clear();
    labCache.set(key, lab);
  }
  return lab;
}

function deltaE76Fast(r, g, b, bgLab) {
  const lab = rgbToLabCached(r, g, b);
  return Math.sqrt(
    (lab.L - bgLab.L) ** 2 +
    (lab.a - bgLab.a) ** 2 +
    (lab.b - bgLab.b) ** 2
  );
}

// ============================================
// BACKGROUND DETECTION
// ============================================

function detectBackgroundColor(data, width, height, channels) {
  const cornerSamples = [];
  const sampleSize = 10;
  
  const sampleAreas = [
    { x: 0, y: 0 },
    { x: width - sampleSize, y: 0 },
    { x: 0, y: height - sampleSize },
    { x: width - sampleSize, y: height - sampleSize },
    { x: Math.floor(width / 2) - 5, y: 0 },
    { x: Math.floor(width / 2) - 5, y: height - sampleSize },
    { x: 0, y: Math.floor(height / 2) - 5 },
    { x: width - sampleSize, y: Math.floor(height / 2) - 5 },
  ];
  
  sampleAreas.forEach(area => {
    for (let y = area.y; y < Math.min(area.y + sampleSize, height); y++) {
      for (let x = area.x; x < Math.min(area.x + sampleSize, width); x++) {
        const offset = (y * width + x) * channels;
        cornerSamples.push({
          r: data[offset],
          g: data[offset + 1],
          b: data[offset + 2]
        });
      }
    }
  });
  
  const colorCounts = new Map();
  cornerSamples.forEach(color => {
    const key = `${Math.floor(color.r/5)*5}-${Math.floor(color.g/5)*5}-${Math.floor(color.b/5)*5}`;
    if (!colorCounts.has(key)) {
      colorCounts.set(key, { count: 0, totalR: 0, totalG: 0, totalB: 0 });
    }
    const entry = colorCounts.get(key);
    entry.count++;
    entry.totalR += color.r;
    entry.totalG += color.g;
    entry.totalB += color.b;
  });
  
  let maxCount = 0;
  let dominantColor = { r: 255, g: 255, b: 255 };
  
  for (const [key, entry] of colorCounts.entries()) {
    if (entry.count > maxCount) {
      maxCount = entry.count;
      dominantColor = {
        r: Math.round(entry.totalR / entry.count),
        g: Math.round(entry.totalG / entry.count),
        b: Math.round(entry.totalB / entry.count)
      };
    }
  }
  
  return dominantColor;
}

// ============================================
// FLOOD-FILL BACKGROUND REMOVAL
// ============================================

/**
 * Flood-fill based background removal
 * 
 * Mantık:
 * 1. Resmin kenarlarından (4 kenar) başla
 * 2. Arka plan rengine benzer pikselleri BFS ile tara
 * 3. Sadece BAĞLANTILI (connected) arka plan piksellerini kaldır
 * 4. Tasarım içindeki koyu renklere DOKUNMA
 * 
 * Bu sayede "Anyone Can Cook!" yazısı gibi elementler korunur
 * çünkü siyah arka plana doğrudan bağlantıları yok
 */
function floodFillBackgroundRemoval(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  const bgLab = rgbToLab(bgColor.r, bgColor.g, bgColor.b);
  
  // Lab threshold (UI threshold → Delta E)
  const labThreshold = Math.max(threshold * 0.8, 2);
  
  // Transition zone for soft edges
  const transitionMultiplier = 1.5;
  const transitionThreshold = labThreshold * transitionMultiplier;
  
  console.log(`🌊 Flood-fill: labThreshold=${labThreshold.toFixed(1)}, transition=${transitionThreshold.toFixed(1)}`);
  
  // Mask: 0=unvisited, 1=background, 2=transition(semi-transparent), 3=foreground
  const mask = new Uint8Array(width * height);
  
  // BFS queue
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  let queueHead = 0;
  let queueTail = 0;
  
  // Seed from all 4 edges
  function seedEdge(x, y) {
    const idx = y * width + x;
    if (mask[idx] !== 0) return;
    
    const offset = idx * channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    
    const dE = deltaE76Fast(r, g, b, bgLab);
    
    if (dE <= labThreshold) {
      mask[idx] = 1; // background
      queueX[queueTail] = x;
      queueY[queueTail] = y;
      queueTail++;
    } else if (dE <= transitionThreshold) {
      mask[idx] = 2; // transition zone
      // Transition pikselleri de queue'ya ekle ama sadece bg komşusu varsa yayılsın
      queueX[queueTail] = x;
      queueY[queueTail] = y;
      queueTail++;
    }
  }
  
  // Seed all edges
  for (let x = 0; x < width; x++) {
    seedEdge(x, 0);
    seedEdge(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seedEdge(0, y);
    seedEdge(width - 1, y);
  }
  
  // BFS - 8-directional
  const dx = [-1, 1, 0, 0, -1, -1, 1, 1];
  const dy = [0, 0, -1, 1, -1, 1, -1, 1];
  
  let processedCount = 0;
  
  while (queueHead < queueTail) {
    const cx = queueX[queueHead];
    const cy = queueY[queueHead];
    const currentMask = mask[cy * width + cx];
    queueHead++;
    processedCount++;
    
    // Transition pikselleri yayılmaz (sadece background yayılır)
    if (currentMask === 2) continue;
    
    // Check all 8 neighbors
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      
      const nIdx = ny * width + nx;
      if (mask[nIdx] !== 0) continue;
      
      const nOffset = nIdx * channels;
      const r = data[nOffset];
      const g = data[nOffset + 1];
      const b = data[nOffset + 2];
      
      const dE = deltaE76Fast(r, g, b, bgLab);
      
      if (dE <= labThreshold) {
        mask[nIdx] = 1; // background - continue spreading
        queueX[queueTail] = nx;
        queueY[queueTail] = ny;
        queueTail++;
      } else if (dE <= transitionThreshold) {
        mask[nIdx] = 2; // transition - mark but don't spread
      } else {
        mask[nIdx] = 3; // foreground
      }
    }
  }
  
  // Mark all unvisited pixels as foreground
  for (let i = 0; i < width * height; i++) {
    if (mask[i] === 0) mask[i] = 3;
  }
  
  // Apply mask to alpha channel
  let bgRemoved = 0;
  let transitioned = 0;
  
  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    
    if (mask[i] === 1) {
      result[offset + 3] = 0;
      bgRemoved++;
    } else if (mask[i] === 2) {
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const dE = deltaE76Fast(r, g, b, bgLab);
      
      const ratio = (dE - labThreshold) / (transitionThreshold - labThreshold);
      result[offset + 3] = Math.floor(Math.max(0, Math.min(255, ratio * 255)));
      transitioned++;
    }
  }
  
  console.log(`🌊 Result: ${bgRemoved} bg removed, ${transitioned} transition, ${width*height - bgRemoved - transitioned} foreground kept`);
  
  return { result, mask };
}

// ============================================
// POST-PROCESSING (mask-aware)
// ============================================

/**
 * Smart erosion: sadece arka planla temas eden kenar piksellerinde çalışır
 */
function smartErosion(data, width, height, channels, mask, radius) {
  const result = Buffer.from(data);
  // Collect pixels to erode first, then apply (avoid cascading)
  const toErode = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const offset = idx * channels;
      
      if (result[offset + 3] === 0) continue;
      
      let touchesBg = false;
      for (let ky = -radius; ky <= radius && !touchesBg; ky++) {
        for (let kx = -radius; kx <= radius && !touchesBg; kx++) {
          if (kx === 0 && ky === 0) continue;
          const ny = y + ky;
          const nx = x + kx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) {
            touchesBg = true;
          } else if (mask[ny * width + nx] === 1) {
            touchesBg = true;
          }
        }
      }
      
      if (touchesBg) toErode.push(idx);
    }
  }
  
  for (const idx of toErode) {
    result[idx * channels + 3] = 0;
    mask[idx] = 1;
  }
  
  console.log(`🔧 Smart erosion: ${toErode.length} pixels eroded`);
  return result;
}

/**
 * Smart color decontamination: sadece transition zone piksellerde
 */
function smartDecontamination(data, width, height, channels, mask, bgColor) {
  const result = Buffer.from(data);
  let cleaned = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const offset = idx * channels;
      const alpha = result[offset + 3];
      
      if (alpha === 0 || alpha === 255) continue;
      if (mask[idx] !== 2) continue;
      
      const a = alpha / 255;
      if (a < 0.1) {
        result[offset + 3] = 0;
        continue;
      }
      
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      
      result[offset]     = Math.max(0, Math.min(255, Math.round((r - bgColor.r * (1 - a)) / a)));
      result[offset + 1] = Math.max(0, Math.min(255, Math.round((g - bgColor.g * (1 - a)) / a)));
      result[offset + 2] = Math.max(0, Math.min(255, Math.round((b - bgColor.b * (1 - a)) / a)));
      cleaned++;
    }
  }
  
  console.log(`🧪 Decontamination: ${cleaned} pixels cleaned`);
  return result;
}

/**
 * Alpha edge softening: sadece bg kenarlarında
 */
function smartEdgeSoftening(data, width, height, channels, mask, radius = 1) {
  const result = Buffer.from(data);
  
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const idx = y * width + x;
      const offset = idx * channels;
      
      if (data[offset + 3] === 0) continue;
      
      // Check if on bg edge
      let isEdge = false;
      for (let ky = -1; ky <= 1 && !isEdge; ky++) {
        for (let kx = -1; kx <= 1 && !isEdge; kx++) {
          if (kx === 0 && ky === 0) continue;
          if (mask[(y + ky) * width + (x + kx)] === 1) isEdge = true;
        }
      }
      
      if (!isEdge) continue;
      
      let totalAlpha = 0;
      let totalWeight = 0;
      
      for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
          const ny = y + ky;
          const nx = x + kx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          
          const nOffset = (ny * width + nx) * channels;
          const dist = Math.sqrt(kx * kx + ky * ky);
          const weight = Math.exp(-(dist * dist) / (2 * 0.8 * 0.8));
          
          totalAlpha += data[nOffset + 3] * weight;
          totalWeight += weight;
        }
      }
      
      result[offset + 3] = Math.round(totalAlpha / totalWeight);
    }
  }
  
  return result;
}

// ============================================
// ENDPOINTS
// ============================================

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Yerlikaya Auto Crop API',
    version: '3.1.0',
    endpoints: { crop: 'POST /crop', trim: 'POST /trim' },
    features: [
      'Flood-fill connected background removal',
      'CIE Lab perceptual color distance',
      'Smart mask-aware post-processing',
      'Preserves dark elements inside design'
    ]
  });
});

app.post('/crop', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    if (!imageFile) return res.status(400).json({ error: 'Image file required' });
    
    const maxSize = 20 * 1024 * 1024;
    if (imageFile.size > maxSize) {
      await fs.unlink(imageFile.path);
      return res.status(400).json({ error: 'File too large', maxSize: '20MB' });
    }
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 15;
    const quality = req.body.quality || 'standard';
    const erosionRadius = parseInt(req.body.erosion) || 1;
    const decontaminate = req.body.decontaminate !== 'false';
    const softenEdges = req.body.softenEdges !== 'false';
    
    console.log('='.repeat(60));
    console.log('🔍 Yerlikaya Auto Crop v3.1 — Flood-Fill Mode');
    console.log(`📊 Quality: ${quality}, Threshold: ${threshold}`);
    console.log(`📊 Erosion: ${erosionRadius}px, Decontaminate: ${decontaminate}, Soften: ${softenEdges}`);
    
    // Load image
    const image = sharp(imagePath);
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    console.log(`📐 Image: ${info.width}x${info.height}, ch: ${info.channels}`);
    
    // Background detection
    console.log('🎨 Background detection...');
    const bgColor = detectBackgroundColor(data, info.width, info.height, info.channels);
    console.log('🎨 Background:', bgColor);
    
    // Sharp trim
    console.log('✂️ Initial trim...');
    const croppedBuffer = await sharp(imagePath)
      .trim({ background: bgColor, threshold: threshold })
      .toBuffer();
    
    const { data: croppedData, info: croppedInfo } = await sharp(croppedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    console.log(`📐 Cropped: ${croppedInfo.width}x${croppedInfo.height}`);
    
    // ===== FLOOD-FILL PIPELINE =====
    const startTime = Date.now();
    
    console.log('🌊 Flood-fill background removal...');
    let { result: processed, mask } = floodFillBackgroundRemoval(
      croppedData, croppedInfo.width, croppedInfo.height,
      croppedInfo.channels, bgColor, threshold
    );
    
    console.log(`⏱️ Flood-fill: ${Date.now() - startTime}ms`);
    
    // Smart erosion (iterative, each pass uses updated mask)
    if (erosionRadius > 0) {
      console.log(`🔧 Smart erosion (${erosionRadius} pass)...`);
      for (let i = 0; i < erosionRadius; i++) {
        processed = smartErosion(
          processed, croppedInfo.width, croppedInfo.height,
          croppedInfo.channels, mask, 1
        );
      }
    }
    
    // Smart decontamination
    if (decontaminate) {
      console.log('🧪 Smart decontamination...');
      processed = smartDecontamination(
        processed, croppedInfo.width, croppedInfo.height,
        croppedInfo.channels, mask, bgColor
      );
    }
    
    // Smart edge softening
    if (softenEdges) {
      console.log('✨ Smart edge softening...');
      processed = smartEdgeSoftening(
        processed, croppedInfo.width, croppedInfo.height,
        croppedInfo.channels, mask
      );
    }
    
    labCache.clear();
    
    // Final PNG
    console.log('🎯 Generating PNG...');
    const result = await sharp(processed, {
      raw: {
        width: croppedInfo.width,
        height: croppedInfo.height,
        channels: croppedInfo.channels
      }
    })
    .png({ compressionLevel: 6, adaptiveFiltering: true, force: true })
    .toBuffer();
    
    console.log(`✅ Done! ${(result.length / 1024).toFixed(0)}KB, total: ${Date.now() - startTime}ms`);
    console.log('='.repeat(60));
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="v3.1-cropped-${Date.now()}.png"`
    });
    res.send(result);
    
  } catch (error) {
    console.error('❌ Error:', error);
    labCache.clear();
    res.status(500).json({ error: 'Failed to process image', details: error.message });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

// Trim-only
app.post('/trim', upload.single('image'), async (req, res) => {
  let imagePath;
  try {
    const imageFile = req.file;
    if (!imageFile) return res.status(400).json({ error: 'Image file required' });
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 10;
    
    const trimmedBuffer = await sharp(imagePath)
      .trim({ threshold })
      .png()
      .toBuffer();
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="trimmed-${Date.now()}.png"`
    });
    res.send(trimmedBuffer);
  } catch (error) {
    console.error('❌ Trim Error:', error);
    res.status(500).json({ error: 'Failed to trim', details: error.message });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Yerlikaya Auto Crop API v3.1 (Flood-Fill) on port ${PORT}`);
});
