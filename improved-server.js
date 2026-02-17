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
// FLOOD-FILL + INTERIOR ISLAND REMOVAL
// ============================================

const dx8 = [-1, 1, 0, 0, -1, -1, 1, 1];
const dy8 = [0, 0, -1, 1, -1, 1, -1, 1];

/**
 * Phase 1: Flood-fill from edges
 * Phase 2: Interior island scan — find bg-colored regions not reached by flood-fill
 * Phase 3: Transition zone refinement — promote transition pixels with foreground majority
 */
function advancedBackgroundRemoval(data, width, height, channels, bgColor, threshold, minIslandSize) {
  const result = Buffer.from(data);
  const bgLab = rgbToLab(bgColor.r, bgColor.g, bgColor.b);
  const totalPixels = width * height;
  
  const labThreshold = Math.max(threshold * 0.8, 2);
  const transitionThreshold = labThreshold * 1.3; // Tighter transition zone (was 1.5)
  
  console.log(`🌊 labThreshold=${labThreshold.toFixed(1)}, transition=${transitionThreshold.toFixed(1)}`);
  
  // Mask: 0=unvisited, 1=background, 2=transition, 3=foreground
  const mask = new Uint8Array(totalPixels);
  
  // Pre-compute deltaE for all pixels (avoids recomputation)
  const deltaEMap = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const offset = i * channels;
    deltaEMap[i] = deltaE76Fast(data[offset], data[offset + 1], data[offset + 2], bgLab);
  }
  
  // ========== PHASE 1: Edge flood-fill ==========
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;
  
  function seedEdge(x, y) {
    const idx = y * width + x;
    if (mask[idx] !== 0) return;
    
    if (deltaEMap[idx] <= labThreshold) {
      mask[idx] = 1;
      queue[qTail++] = idx;
    } else if (deltaEMap[idx] <= transitionThreshold) {
      mask[idx] = 2;
      // Don't add to queue — transition doesn't spread
    }
  }
  
  for (let x = 0; x < width; x++) {
    seedEdge(x, 0);
    seedEdge(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seedEdge(0, y);
    seedEdge(width - 1, y);
  }
  
  // BFS — only background (mask=1) spreads
  while (qHead < qTail) {
    const cidx = queue[qHead++];
    const cx = cidx % width;
    const cy = (cidx - cx) / width;
    
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d];
      const ny = cy + dy8[d];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      
      const nIdx = ny * width + nx;
      if (mask[nIdx] !== 0) continue;
      
      const dE = deltaEMap[nIdx];
      
      if (dE <= labThreshold) {
        mask[nIdx] = 1;
        queue[qTail++] = nIdx;
      } else if (dE <= transitionThreshold) {
        mask[nIdx] = 2;
      } else {
        mask[nIdx] = 3;
      }
    }
  }
  
  // Mark unvisited as foreground
  for (let i = 0; i < totalPixels; i++) {
    if (mask[i] === 0) mask[i] = 3;
  }
  
  let bgCount = 0, transCount = 0, fgCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (mask[i] === 1) bgCount++;
    else if (mask[i] === 2) transCount++;
    else fgCount++;
  }
  console.log(`🌊 Phase 1 (edge flood): bg=${bgCount}, transition=${transCount}, fg=${fgCount}`);
  
  // ========== PHASE 2: Interior island removal ==========
  // Find connected regions of unvisited bg-colored pixels (mask=3 but deltaE <= labThreshold)
  // If region is larger than minIslandSize, it's an interior bg island → remove it
  
  const visited2 = new Uint8Array(totalPixels); // separate visited tracker
  let islandsFound = 0;
  let islandPixelsRemoved = 0;
  
  for (let i = 0; i < totalPixels; i++) {
    // Only check foreground pixels that look like background color
    if (mask[i] !== 3 || visited2[i] || deltaEMap[i] > labThreshold) continue;
    
    // BFS to find connected region of bg-colored foreground pixels
    const regionPixels = [];
    const rQueue = [i];
    visited2[i] = 1;
    let rHead = 0;
    
    while (rHead < rQueue.length) {
      const cidx = rQueue[rHead++];
      regionPixels.push(cidx);
      
      const cx = cidx % width;
      const cy = (cidx - cx) / width;
      
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d];
        const ny = cy + dy8[d];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        
        const nIdx = ny * width + nx;
        if (visited2[nIdx] || mask[nIdx] !== 3) continue;
        if (deltaEMap[nIdx] > labThreshold) continue;
        
        visited2[nIdx] = 1;
        rQueue.push(nIdx);
      }
    }
    
    // If region is large enough, it's a background island
    if (regionPixels.length >= minIslandSize) {
      islandsFound++;
      for (const idx of regionPixels) {
        mask[idx] = 1; // Mark as background
        islandPixelsRemoved += 1;
      }
      
      // Also mark transition zone around this island
      for (const idx of regionPixels) {
        const cx = idx % width;
        const cy = (idx - cx) / width;
        
        for (let d = 0; d < 8; d++) {
          const nx = cx + dx8[d];
          const ny = cy + dy8[d];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          
          const nIdx = ny * width + nx;
          if (mask[nIdx] !== 3) continue;
          if (deltaEMap[nIdx] <= transitionThreshold) {
            mask[nIdx] = 2; // transition
          }
        }
      }
    }
  }
  
  console.log(`🏝️ Phase 2 (islands): found ${islandsFound} islands, removed ${islandPixelsRemoved} pixels`);
  
  // ========== PHASE 3: Transition zone refinement ==========
  // If a transition pixel has majority foreground (mask=3) neighbors → promote to foreground
  // This preserves text edges like "Anyone Can Cook!"
  
  let promoted = 0;
  let demoted = 0;
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 2) continue;
      
      let fgNeighbors = 0;
      let bgNeighbors = 0;
      let totalNeighbors = 0;
      
      for (let d = 0; d < 8; d++) {
        const nx = x + dx8[d];
        const ny = y + dy8[d];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        
        const nMask = mask[ny * width + nx];
        totalNeighbors++;
        if (nMask === 3) fgNeighbors++;
        else if (nMask === 1) bgNeighbors++;
      }
      
      // Majority foreground → promote to foreground (preserve text edges)
      if (fgNeighbors > bgNeighbors && fgNeighbors >= 3) {
        mask[idx] = 3;
        promoted++;
      }
      // Majority background → demote to background
      else if (bgNeighbors > fgNeighbors && bgNeighbors >= 5) {
        mask[idx] = 1;
        demoted++;
      }
    }
  }
  
  console.log(`🔄 Phase 3 (refinement): promoted ${promoted} to fg, demoted ${demoted} to bg`);
  
  // ========== APPLY MASK ==========
  let finalBg = 0, finalTrans = 0, finalFg = 0;
  
  for (let i = 0; i < totalPixels; i++) {
    const offset = i * channels;
    
    if (mask[i] === 1) {
      result[offset + 3] = 0;
      finalBg++;
    } else if (mask[i] === 2) {
      const dE = deltaEMap[i];
      const ratio = (dE - labThreshold) / (transitionThreshold - labThreshold);
      result[offset + 3] = Math.floor(Math.max(0, Math.min(255, ratio * 255)));
      finalTrans++;
    } else {
      finalFg++;
    }
  }
  
  console.log(`✅ Final: bg=${finalBg}, transition=${finalTrans}, fg=${finalFg}`);
  
  return { result, mask };
}

// ============================================
// SMART POST-PROCESSING (mask-aware)
// ============================================

function smartErosion(data, width, height, channels, mask, radius) {
  const result = Buffer.from(data);
  const toErode = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (result[idx * channels + 3] === 0) continue;
      
      let touchesBg = false;
      for (let ky = -radius; ky <= radius && !touchesBg; ky++) {
        for (let kx = -radius; kx <= radius && !touchesBg; kx++) {
          if (kx === 0 && ky === 0) continue;
          const ny = y + ky, nx = x + kx;
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
  
  console.log(`🔧 Erosion: ${toErode.length} pixels`);
  return result;
}

function smartDecontamination(data, width, height, channels, mask, bgColor) {
  const result = Buffer.from(data);
  let cleaned = 0;
  
  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    const alpha = result[offset + 3];
    
    if (alpha === 0 || alpha === 255) continue;
    if (mask[i] !== 2) continue;
    
    const a = alpha / 255;
    if (a < 0.1) { result[offset + 3] = 0; continue; }
    
    const r = result[offset], g = result[offset + 1], b = result[offset + 2];
    result[offset]     = Math.max(0, Math.min(255, Math.round((r - bgColor.r * (1 - a)) / a)));
    result[offset + 1] = Math.max(0, Math.min(255, Math.round((g - bgColor.g * (1 - a)) / a)));
    result[offset + 2] = Math.max(0, Math.min(255, Math.round((b - bgColor.b * (1 - a)) / a)));
    cleaned++;
  }
  
  console.log(`🧪 Decontamination: ${cleaned} pixels`);
  return result;
}

function smartEdgeSoftening(data, width, height, channels, mask, radius = 1) {
  const result = Buffer.from(data);
  
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const idx = y * width + x;
      const offset = idx * channels;
      if (data[offset + 3] === 0) continue;
      
      let isEdge = false;
      for (let ky = -1; ky <= 1 && !isEdge; ky++) {
        for (let kx = -1; kx <= 1 && !isEdge; kx++) {
          if (kx === 0 && ky === 0) continue;
          if (mask[(y + ky) * width + (x + kx)] === 1) isEdge = true;
        }
      }
      if (!isEdge) continue;
      
      let totalAlpha = 0, totalWeight = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
          const ny = y + ky, nx = x + kx;
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
    version: '3.2.0',
    features: [
      'Flood-fill + interior island removal',
      'Transition zone refinement (text preservation)',
      'CIE Lab perceptual color distance',
      'Smart mask-aware post-processing'
    ]
  });
});

app.post('/crop', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    if (!imageFile) return res.status(400).json({ error: 'Image file required' });
    
    if (imageFile.size > 20 * 1024 * 1024) {
      await fs.unlink(imageFile.path);
      return res.status(400).json({ error: 'File too large', maxSize: '20MB' });
    }
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 15;
    const erosionRadius = parseInt(req.body.erosion) || 1;
    const decontaminate = req.body.decontaminate !== 'false';
    const softenEdges = req.body.softenEdges !== 'false';
    const minIslandSize = parseInt(req.body.minIsland) || 100;
    
    console.log('='.repeat(60));
    console.log('🔍 Yerlikaya Auto Crop v3.2');
    console.log(`📊 Threshold: ${threshold}, Erosion: ${erosionRadius}px`);
    console.log(`📊 Decontaminate: ${decontaminate}, Soften: ${softenEdges}`);
    console.log(`📊 Min island size: ${minIslandSize}px`);
    
    // Load
    const { data, info } = await sharp(imagePath)
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    console.log(`📐 Image: ${info.width}x${info.height}`);
    
    // Background detection
    const bgColor = detectBackgroundColor(data, info.width, info.height, info.channels);
    console.log('🎨 Background:', bgColor);
    
    // Trim
    console.log('✂️ Trimming...');
    const croppedBuffer = await sharp(imagePath)
      .trim({ background: bgColor, threshold })
      .toBuffer();
    
    const { data: croppedData, info: ci } = await sharp(croppedBuffer)
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    console.log(`📐 Cropped: ${ci.width}x${ci.height}`);
    
    // ===== MAIN PIPELINE =====
    const t0 = Date.now();
    
    // Advanced removal (flood-fill + islands + refinement)
    let { result: processed, mask } = advancedBackgroundRemoval(
      croppedData, ci.width, ci.height, ci.channels,
      bgColor, threshold, minIslandSize
    );
    
    console.log(`⏱️ Removal: ${Date.now() - t0}ms`);
    
    // Smart erosion
    if (erosionRadius > 0) {
      for (let i = 0; i < erosionRadius; i++) {
        processed = smartErosion(processed, ci.width, ci.height, ci.channels, mask, 1);
      }
    }
    
    // Decontamination
    if (decontaminate) {
      processed = smartDecontamination(processed, ci.width, ci.height, ci.channels, mask, bgColor);
    }
    
    // Edge softening
    if (softenEdges) {
      processed = smartEdgeSoftening(processed, ci.width, ci.height, ci.channels, mask);
    }
    
    labCache.clear();
    
    // PNG output
    const result = await sharp(processed, {
      raw: { width: ci.width, height: ci.height, channels: ci.channels }
    })
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();
    
    console.log(`✅ Done! ${(result.length / 1024).toFixed(0)}KB, total: ${Date.now() - t0}ms`);
    console.log('='.repeat(60));
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="cropped-${Date.now()}.png"`
    });
    res.send(result);
    
  } catch (error) {
    console.error('❌ Error:', error);
    labCache.clear();
    res.status(500).json({ error: 'Failed to process', details: error.message });
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
    
    const trimmedBuffer = await sharp(imagePath)
      .trim({ threshold: parseInt(req.body.threshold) || 10 })
      .png().toBuffer();
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="trimmed-${Date.now()}.png"`
    });
    res.send(trimmedBuffer);
  } catch (error) {
    res.status(500).json({ error: 'Failed to trim', details: error.message });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Yerlikaya Auto Crop API v3.2 on port ${PORT}`);
});
