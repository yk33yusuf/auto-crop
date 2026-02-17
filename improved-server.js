const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Static files serve et
app.use(express.static('.'));

// Timeout ayarları (3 dakika)
app.use((req, res, next) => {
  req.setTimeout(180000);
  res.setTimeout(180000);
  next();
});

const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// uploads klasörünü oluştur
fs.mkdir('uploads', { recursive: true });

// ============================================
// COLOR SCIENCE - Perceptual Color Distance
// ============================================

// sRGB → Linear RGB
function srgbToLinear(c) {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Linear RGB → CIE XYZ
function linearRgbToXyz(r, g, b) {
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    z: r * 0.0193339 + g * 0.1191920 + b * 0.9503041
  };
}

// CIE XYZ → CIE Lab
function xyzToLab(x, y, z) {
  // D65 white point
  const xn = 0.95047, yn = 1.00000, zn = 1.08883;
  
  function f(t) {
    return t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
  }
  
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

// RGB → CIE Lab (full pipeline)
function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const xyz = linearRgbToXyz(lr, lg, lb);
  return xyzToLab(xyz.x, xyz.y, xyz.z);
}

// CIE76 Delta E - perceptual color distance
function deltaE76(r1, g1, b1, r2, g2, b2) {
  const lab1 = rgbToLab(r1, g1, b1);
  const lab2 = rgbToLab(r2, g2, b2);
  return Math.sqrt(
    Math.pow(lab1.L - lab2.L, 2) +
    Math.pow(lab1.a - lab2.a, 2) +
    Math.pow(lab1.b - lab2.b, 2)
  );
}

// Pre-compute Lab values for background color (optimization)
function precomputeBgLab(bgColor) {
  return rgbToLab(bgColor.r, bgColor.g, bgColor.b);
}

// Fast Delta E using pre-computed bg Lab
function deltaE76Fast(r, g, b, bgLab) {
  const lab = rgbToLab(r, g, b);
  return Math.sqrt(
    Math.pow(lab.L - bgLab.L, 2) +
    Math.pow(lab.a - bgLab.a, 2) +
    Math.pow(lab.b - bgLab.b, 2)
  );
}

// ============================================
// BACKGROUND DETECTION
// ============================================

function detectBackgroundColor(data, width, height, channels) {
  const cornerSamples = [];
  const sampleSize = 10; // Daha geniş örnekleme
  
  // Dört köşe + kenar ortaları (6 nokta)
  const sampleAreas = [
    { x: 0, y: 0 },                                    // sol üst
    { x: width - sampleSize, y: 0 },                   // sağ üst
    { x: 0, y: height - sampleSize },                  // sol alt
    { x: width - sampleSize, y: height - sampleSize }, // sağ alt
    { x: Math.floor(width / 2) - 5, y: 0 },           // üst orta
    { x: Math.floor(width / 2) - 5, y: height - sampleSize }, // alt orta
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
  
  // Daha hassas renk gruplama (5'lik gruplar)
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
  
  // En yaygın renk grubunun ortalamasını al (daha doğru)
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
// POST-PROCESSING PIPELINE
// ============================================

// Step 1: Morphological erosion on alpha mask
// Kenarlardan 1-2px içeri doğru mask'ı küçültür → fringe keser
function morphologicalErosion(data, width, height, channels, radius = 1) {
  const result = Buffer.from(data);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const alpha = data[offset + 3];
      
      // Sadece yarı-saydam veya tam opak kenar piksellerini kontrol et
      if (alpha === 0) continue;
      
      // Komşularda transparent var mı kontrol et
      let hasTransparentNeighbor = false;
      
      for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
          if (kx === 0 && ky === 0) continue;
          
          const ny = y + ky;
          const nx = x + kx;
          
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) {
            hasTransparentNeighbor = true;
            break;
          }
          
          const nOffset = (ny * width + nx) * channels;
          if (data[nOffset + 3] === 0) {
            hasTransparentNeighbor = true;
            break;
          }
        }
        if (hasTransparentNeighbor) break;
      }
      
      // Kenar pikseli ise alpha'yı azalt veya sıfırla
      if (hasTransparentNeighbor) {
        result[offset + 3] = 0; // Kenar pikselini tamamen kaldır
      }
    }
  }
  
  return result;
}

// Step 2: Color decontamination
// Kenar piksellerindeki arka plan renk karışımını temizle
function colorDecontamination(data, width, height, channels, bgColor) {
  const result = Buffer.from(data);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const alpha = result[offset + 3];
      
      // Sadece yarı-saydam pikselleri temizle (kenar pikselleri)
      if (alpha === 0 || alpha === 255) continue;
      
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const a = alpha / 255;
      
      // Un-premultiply: arka plan renginin katkısını çıkar
      // Original = foreground * alpha + background * (1 - alpha)
      // foreground = (Original - background * (1 - alpha)) / alpha
      const cleanR = Math.max(0, Math.min(255, Math.round((r - bgColor.r * (1 - a)) / a)));
      const cleanG = Math.max(0, Math.min(255, Math.round((g - bgColor.g * (1 - a)) / a)));
      const cleanB = Math.max(0, Math.min(255, Math.round((b - bgColor.b * (1 - a)) / a)));
      
      result[offset] = cleanR;
      result[offset + 1] = cleanG;
      result[offset + 2] = cleanB;
    }
  }
  
  return result;
}

// Step 3: Alpha edge softening
// Kenar alpha değerlerini yumuşat (jagged edges'ı önler)
function alphaEdgeSoftening(data, width, height, channels, radius = 1) {
  const result = Buffer.from(data);
  
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const offset = (y * width + x) * channels;
      const alpha = data[offset + 3];
      
      // Sadece kenar piksellerini yumuşat (tam opak veya tam transparent değil)
      // Ayrıca opak pikselleri de kontrol et - eğer komşuları transparent ise kenar pikseli
      let isEdge = (alpha > 0 && alpha < 255);
      
      if (!isEdge && alpha === 255) {
        // Tam opak ama komşusu transparent olan piksel → kenar
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (kx === 0 && ky === 0) continue;
            const nOffset = ((y + ky) * width + (x + kx)) * channels;
            if (data[nOffset + 3] === 0) {
              isEdge = true;
              break;
            }
          }
          if (isEdge) break;
        }
      }
      
      if (!isEdge) continue;
      
      // Gaussian-weighted alpha averaging
      let totalAlpha = 0;
      let totalWeight = 0;
      
      for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
          const ny = y + ky;
          const nx = x + kx;
          const nOffset = (ny * width + nx) * channels;
          
          // Gaussian weight
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
// MAIN BACKGROUND REMOVAL ALGORITHMS
// ============================================

// V3 Standard: CIE Lab + basic cleanup
function standardRemovalV3(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  const bgLab = precomputeBgLab(bgColor);
  
  // Lab threshold eşleme (UI threshold → Delta E threshold)
  // UI 15 ≈ Delta E 12 (just noticeable difference is ~2.3)
  const labThreshold = threshold * 0.8;
  
  console.log('⚡ V3 Standard: CIE Lab removal, labThreshold:', labThreshold);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const alpha = result[offset + 3];
      
      if (alpha === 0) continue;
      
      if (threshold === 0) {
        if (r === bgColor.r && g === bgColor.g && b === bgColor.b) {
          result[offset + 3] = 0;
        }
        continue;
      }
      
      const dE = deltaE76Fast(r, g, b, bgLab);
      
      if (dE <= labThreshold) {
        // Kesin arka plan → tamamen şeffaf
        result[offset + 3] = 0;
      } else if (dE <= labThreshold * 1.5) {
        // Geçiş bölgesi → gradual fade
        const ratio = (dE - labThreshold) / (labThreshold * 0.5);
        result[offset + 3] = Math.floor(alpha * Math.min(1, ratio));
      }
    }
  }
  
  return result;
}

// V3 Premium: CIE Lab + edge protection + full post-processing pipeline
function premiumRemovalV3(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  const bgLab = precomputeBgLab(bgColor);
  
  const labThreshold = threshold * 0.8;
  
  console.log('🎨 V3 Premium: CIE Lab + Edge Protection, labThreshold:', labThreshold);
  
  // Step 1: Edge map oluştur (Sobel-like)
  const edgeStrength = new Float32Array(width * height);
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * channels;
      
      // Sobel X
      const leftOffset = (y * width + (x - 1)) * channels;
      const rightOffset = (y * width + (x + 1)) * channels;
      const gx = (result[rightOffset] - result[leftOffset]) * 0.3 +
                 (result[rightOffset + 1] - result[leftOffset + 1]) * 0.59 +
                 (result[rightOffset + 2] - result[leftOffset + 2]) * 0.11;
      
      // Sobel Y
      const topOffset = ((y - 1) * width + x) * channels;
      const bottomOffset = ((y + 1) * width + x) * channels;
      const gy = (result[bottomOffset] - result[topOffset]) * 0.3 +
                 (result[bottomOffset + 1] - result[topOffset + 1]) * 0.59 +
                 (result[bottomOffset + 2] - result[topOffset + 2]) * 0.11;
      
      edgeStrength[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  
  // Step 2: Smart removal with edge-aware thresholding
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const alpha = result[offset + 3];
      
      if (alpha === 0) continue;
      
      if (threshold === 0) {
        if (r === bgColor.r && g === bgColor.g && b === bgColor.b) {
          result[offset + 3] = 0;
        }
        continue;
      }
      
      const dE = deltaE76Fast(r, g, b, bgLab);
      const edge = edgeStrength[y * width + x];
      const isStrongEdge = edge > 30;
      
      if (dE <= labThreshold) {
        if (isStrongEdge) {
          // Güçlü kenar → daha koruyucu
          if (dE <= labThreshold * 0.4) {
            result[offset + 3] = 0;
          } else {
            const ratio = dE / labThreshold;
            result[offset + 3] = Math.floor(alpha * ratio);
          }
        } else {
          // Kenar değil → agresif kaldır
          result[offset + 3] = 0;
        }
      } else if (dE <= labThreshold * 1.3 && !isStrongEdge) {
        // Yumuşak geçiş (sadece kenar olmayan bölgeler)
        const ratio = (dE - labThreshold) / (labThreshold * 0.3);
        result[offset + 3] = Math.floor(alpha * Math.min(1, ratio));
      }
    }
  }
  
  return result;
}

// ============================================
// ENDPOINTS
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Yerlikaya Auto Crop API',
    version: '3.0.0',
    endpoints: {
      crop: 'POST /crop',
      trim: 'POST /trim'
    },
    features: [
      'CIE Lab perceptual color distance',
      'Morphological erosion (fringe removal)',
      'Color decontamination (halo removal)',
      'Alpha edge softening',
      'Edge-aware premium mode',
      'Smart background detection'
    ]
  });
});

app.post('/crop', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file required' });
    }
    
    const maxSize = 20 * 1024 * 1024;
    if (imageFile.size > maxSize) {
      await fs.unlink(imageFile.path);
      return res.status(400).json({ error: 'File too large', maxSize: '20MB' });
    }
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 15;
    const quality = req.body.quality || 'standard';
    const erosionRadius = parseInt(req.body.erosion) || 1;
    const decontaminate = req.body.decontaminate !== 'false'; // default true
    const softenEdges = req.body.softenEdges !== 'false';     // default true
    
    console.log('='.repeat(60));
    console.log('🔍 Step 1: Loading image...');
    console.log(`📊 Quality: ${quality}, Threshold: ${threshold}`);
    console.log(`📊 Erosion: ${erosionRadius}px, Decontaminate: ${decontaminate}, Soften: ${softenEdges}`);
    
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    
    console.log(`📐 Image: ${info.width}x${info.height}, channels: ${info.channels}`);
    
    // Background detection
    console.log('🎨 Step 2: Background detection...');
    const bgColor = detectBackgroundColor(data, info.width, info.height, info.channels);
    console.log('🎨 Background:', bgColor);
    
    // Sharp trim
    console.log('✂️ Step 3: Initial trim...');
    const croppedBuffer = await sharp(imagePath)
      .trim({ background: bgColor, threshold: threshold })
      .toBuffer();
    
    // Ensure alpha channel
    const { data: croppedData, info: croppedInfo } = await sharp(croppedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    console.log(`📐 Cropped: ${croppedInfo.width}x${croppedInfo.height}`);
    
    // ===== MAIN PIPELINE =====
    
    // Phase 1: Background removal
    console.log('🧹 Step 4: Background removal (CIE Lab)...');
    let processed;
    
    if (quality === 'premium') {
      processed = premiumRemovalV3(
        croppedData, croppedInfo.width, croppedInfo.height, 
        croppedInfo.channels, bgColor, threshold
      );
    } else {
      processed = standardRemovalV3(
        croppedData, croppedInfo.width, croppedInfo.height, 
        croppedInfo.channels, bgColor, threshold
      );
    }
    
    // Phase 2: Morphological erosion (fringe kaldırma)
    if (erosionRadius > 0) {
      console.log(`🔧 Step 5: Morphological erosion (${erosionRadius}px)...`);
      processed = morphologicalErosion(
        processed, croppedInfo.width, croppedInfo.height, 
        croppedInfo.channels, erosionRadius
      );
    }
    
    // Phase 3: Color decontamination (halo temizleme)
    if (decontaminate) {
      console.log('🧪 Step 6: Color decontamination...');
      processed = colorDecontamination(
        processed, croppedInfo.width, croppedInfo.height, 
        croppedInfo.channels, bgColor
      );
    }
    
    // Phase 4: Alpha edge softening
    if (softenEdges) {
      console.log('✨ Step 7: Alpha edge softening...');
      processed = alphaEdgeSoftening(
        processed, croppedInfo.width, croppedInfo.height, 
        croppedInfo.channels
      );
    }
    
    // Final PNG
    console.log('🎯 Step 8: Generating final PNG...');
    const result = await sharp(processed, {
      raw: {
        width: croppedInfo.width,
        height: croppedInfo.height,
        channels: croppedInfo.channels
      }
    })
    .png({ compressionLevel: 6, adaptiveFiltering: true, force: true })
    .toBuffer();
    
    console.log(`✅ Done! Output: ${result.length} bytes`);
    console.log('='.repeat(60));
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="v3-cropped-${Date.now()}.png"`
    });
    res.send(result);
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Failed to process image', details: error.message });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

// Trim-only endpoint
app.post('/trim', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file required' });
    }
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 10;
    
    console.log('✂️ Trim-only, threshold:', threshold);
    
    const trimmedBuffer = await sharp(imagePath)
      .trim({ threshold })
      .png()
      .toBuffer();
    
    console.log('✅ Trimmed');
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="trimmed-${Date.now()}.png"`
    });
    res.send(trimmedBuffer);
    
  } catch (error) {
    console.error('❌ Trim Error:', error);
    res.status(500).json({ error: 'Failed to trim image', details: error.message });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Yerlikaya Auto Crop API v3.0 running on port ${PORT}`);
});
