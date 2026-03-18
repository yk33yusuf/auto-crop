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
  const fx = f(x / xn), fy = f(y / yn), fz = f(z / zn);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const xyz = linearRgbToXyz(lr, lg, lb);
  return xyzToLab(xyz.x, xyz.y, xyz.z);
}

// CIE76 Delta E
const labCache = new Map();
function deltaE76Fast(r1, g1, b1, r2, g2, b2) {
  const key1 = (r1 << 16) | (g1 << 8) | b1;
  let lab1 = labCache.get(key1);
  if (!lab1) { lab1 = rgbToLab(r1, g1, b1); labCache.set(key1, lab1); }
  
  const key2 = (r2 << 16) | (g2 << 8) | b2;
  let lab2 = labCache.get(key2);
  if (!lab2) { lab2 = rgbToLab(r2, g2, b2); labCache.set(key2, lab2); }
  
  return Math.sqrt(
    (lab1.L - lab2.L) ** 2 +
    (lab1.a - lab2.a) ** 2 +
    (lab1.b - lab2.b) ** 2
  );
}

// ============================================
// BACKGROUND DETECTION
// ============================================

function detectBackgroundColor(data, width, height, channels) {
  const edgePixels = [];
  const sampleStep = Math.max(1, Math.floor(Math.min(width, height) / 100));
  
  for (let x = 0; x < width; x += sampleStep) {
    edgePixels.push(getPixelAt(data, x, 0, width, channels));
    edgePixels.push(getPixelAt(data, x, height - 1, width, channels));
  }
  for (let y = 0; y < height; y += sampleStep) {
    edgePixels.push(getPixelAt(data, 0, y, width, channels));
    edgePixels.push(getPixelAt(data, width - 1, y, width, channels));
  }
  
  // Cluster edge pixels - most common color
  const colorMap = new Map();
  for (const px of edgePixels) {
    const qr = Math.round(px.r / 8) * 8;
    const qg = Math.round(px.g / 8) * 8;
    const qb = Math.round(px.b / 8) * 8;
    const key = `${qr},${qg},${qb}`;
    if (!colorMap.has(key)) colorMap.set(key, { r: 0, g: 0, b: 0, count: 0 });
    const entry = colorMap.get(key);
    entry.r += px.r; entry.g += px.g; entry.b += px.b; entry.count++;
  }
  
  let maxCount = 0, bestCluster = null;
  for (const entry of colorMap.values()) {
    if (entry.count > maxCount) {
      maxCount = entry.count;
      bestCluster = entry;
    }
  }
  
  return {
    r: Math.round(bestCluster.r / bestCluster.count),
    g: Math.round(bestCluster.g / bestCluster.count),
    b: Math.round(bestCluster.b / bestCluster.count)
  };
}

function getPixelAt(data, x, y, width, channels) {
  const idx = (y * width + x) * channels;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

// ============================================
// FLOOD-FILL BACKGROUND REMOVAL
// ============================================

function floodFillBackground(data, width, height, channels, bgColor, threshold) {
  const totalPixels = width * height;
  const mask = new Uint8Array(totalPixels); // 0=unknown, 1=background, 2=foreground
  
  const bgLab = rgbToLab(bgColor.r, bgColor.g, bgColor.b);
  
  // BFS queue - start from all edge pixels
  const queue = [];
  
  // Add edge pixels to queue
  for (let x = 0; x < width; x++) {
    queue.push(x); // top row
    queue.push((height - 1) * width + x); // bottom row
  }
  for (let y = 1; y < height - 1; y++) {
    queue.push(y * width); // left col
    queue.push(y * width + width - 1); // right col
  }
  
  // Mark edge pixels that match bg
  const initialQueue = [];
  for (const pixelIdx of queue) {
    const dataIdx = pixelIdx * channels;
    const r = data[dataIdx], g = data[dataIdx + 1], b = data[dataIdx + 2];
    const dist = deltaE76Fast(r, g, b, bgColor.r, bgColor.g, bgColor.b);
    
    if (dist <= threshold) {
      mask[pixelIdx] = 1;
      initialQueue.push(pixelIdx);
    }
  }
  
  // BFS flood fill
  let head = 0;
  const bfsQueue = initialQueue;
  const dx = [-1, 1, 0, 0];
  const dy = [0, 0, -1, 1];
  
  while (head < bfsQueue.length) {
    const idx = bfsQueue[head++];
    const x = idx % width;
    const y = Math.floor(idx / width);
    
    for (let d = 0; d < 4; d++) {
      const nx = x + dx[d];
      const ny = y + dy[d];
      
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      
      const nIdx = ny * width + nx;
      if (mask[nIdx] !== 0) continue;
      
      const nDataIdx = nIdx * channels;
      const r = data[nDataIdx], g = data[nDataIdx + 1], b = data[nDataIdx + 2];
      const dist = deltaE76Fast(r, g, b, bgColor.r, bgColor.g, bgColor.b);
      
      if (dist <= threshold) {
        mask[nIdx] = 1;
        bfsQueue.push(nIdx);
      }
    }
  }
  
  return mask;
}

// Interior island detection
function removeInteriorIslands(data, mask, width, height, channels, bgColor, threshold, minIslandSize) {
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  let removed = 0;
  
  for (let i = 0; i < totalPixels; i++) {
    if (mask[i] !== 0 || visited[i]) continue;
    
    const dataIdx = i * channels;
    const r = data[dataIdx], g = data[dataIdx + 1], b = data[dataIdx + 2];
    const dist = deltaE76Fast(r, g, b, bgColor.r, bgColor.g, bgColor.b);
    
    if (dist > threshold) {
      visited[i] = 1;
      continue;
    }
    
    // BFS to find connected region of bg-colored unmasked pixels
    const region = [i];
    const regionQueue = [i];
    visited[i] = 1;
    let head = 0;
    
    while (head < regionQueue.length) {
      const idx = regionQueue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      
      const neighbors = [
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1
      ];
      
      for (const nIdx of neighbors) {
        if (nIdx < 0 || visited[nIdx] || mask[nIdx] !== 0) continue;
        
        const nDataIdx = nIdx * channels;
        const nr = data[nDataIdx], ng = data[nDataIdx + 1], nb = data[nDataIdx + 2];
        const nDist = deltaE76Fast(nr, ng, nb, bgColor.r, bgColor.g, bgColor.b);
        
        if (nDist <= threshold * 1.2) {
          visited[nIdx] = 1;
          region.push(nIdx);
          regionQueue.push(nIdx);
        } else {
          visited[nIdx] = 1;
        }
      }
    }
    
    if (region.length >= minIslandSize) {
      for (const idx of region) {
        mask[idx] = 1;
        removed++;
      }
    }
  }
  
  return removed;
}

// ============================================
// POST-PROCESSING
// ============================================

function findEdgePixels(mask, width, height) {
  const edges = new Set();
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 1) continue; // not bg
      
      const neighbors = [
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1
      ];
      
      for (const nIdx of neighbors) {
        if (nIdx >= 0 && mask[nIdx] === 0) {
          edges.add(nIdx);
        }
      }
    }
  }
  
  return edges;
}

function applyTransitionZone(data, mask, width, height, channels, bgColor, threshold, edgePixels) {
  const result = Buffer.from(data);
  
  // Ensure alpha channel
  const hasAlpha = channels >= 4;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const dataIdx = idx * channels;
      
      if (mask[idx] === 1) {
        // Background - make transparent
        if (hasAlpha) {
          result[dataIdx + 3] = 0;
        }
        continue;
      }
      
      // Edge pixel - apply transition
      if (edgePixels.has(idx)) {
        const r = data[dataIdx], g = data[dataIdx + 1], b = data[dataIdx + 2];
        const dist = deltaE76Fast(r, g, b, bgColor.r, bgColor.g, bgColor.b);
        
        if (dist < threshold * 1.5) {
          // Transition zone
          const alpha = Math.min(255, Math.round((dist / (threshold * 1.5)) * 255));
          
          // Check if foreground neighbors dominate
          let fgCount = 0, bgCount = 0;
          const nx = [x-1, x+1, x, x, x-1, x+1, x-1, x+1];
          const ny = [y, y, y-1, y+1, y-1, y-1, y+1, y+1];
          
          for (let d = 0; d < 8; d++) {
            if (nx[d] >= 0 && nx[d] < width && ny[d] >= 0 && ny[d] < height) {
              const nMask = mask[ny[d] * width + nx[d]];
              if (nMask === 1) bgCount++;
              else fgCount++;
            }
          }
          
          // If mostly foreground neighbors, keep more opaque
          if (fgCount > bgCount * 2) {
            if (hasAlpha) result[dataIdx + 3] = 255;
          } else {
            if (hasAlpha) result[dataIdx + 3] = Math.max(alpha, 30);
          }
        }
      }
    }
  }
  
  return result;
}

function colorDecontaminate(data, mask, width, height, channels, bgColor, edgePixels) {
  if (channels < 4) return data;
  
  const result = Buffer.from(data);
  
  for (const idx of edgePixels) {
    const dataIdx = idx * channels;
    const alpha = result[dataIdx + 3];
    
    if (alpha === 0 || alpha === 255) continue;
    
    const a = alpha / 255;
    const r = result[dataIdx], g = result[dataIdx + 1], b = result[dataIdx + 2];
    
    // Un-premultiply background contamination
    result[dataIdx]     = Math.min(255, Math.max(0, Math.round((r - bgColor.r * (1 - a)) / a)));
    result[dataIdx + 1] = Math.min(255, Math.max(0, Math.round((g - bgColor.g * (1 - a)) / a)));
    result[dataIdx + 2] = Math.min(255, Math.max(0, Math.round((b - bgColor.b * (1 - a)) / a)));
  }
  
  return result;
}

// ============================================
// SPLIT HELPERS
// ============================================

async function detectAndTrimPanel(buffer, trimThreshold, trimPadding) {
  const image = sharp(buffer);
  const meta = await image.metadata();
  const { width, height, channels } = meta;
  
  const raw = await image.raw().toBuffer();
  
  // Sample corner pixels for background color
  const getPixel = (x, y) => {
    const idx = (y * width + x) * channels;
    return [raw[idx], raw[idx + 1], raw[idx + 2]];
  };
  
  const corners = [
    getPixel(0, 0),
    getPixel(width - 1, 0),
    getPixel(0, height - 1),
    getPixel(width - 1, height - 1)
  ];
  
  // Median background color
  const bg = [0, 1, 2].map(ch => {
    const vals = corners.map(c => c[ch]).sort((a, b) => a - b);
    return Math.round((vals[1] + vals[2]) / 2);
  });
  
  // Find bounding box of non-background pixels
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let hasContent = false;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = raw[idx], g = raw[idx + 1], b = raw[idx + 2];
      
      const dist = Math.sqrt(
        (r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2
      );
      
      if (dist > trimThreshold) {
        hasContent = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  
  if (!hasContent) {
    return { buffer, width, height, isEmpty: true };
  }
  
  // Apply padding
  minX = Math.max(0, minX - trimPadding);
  minY = Math.max(0, minY - trimPadding);
  maxX = Math.min(width - 1, maxX + trimPadding);
  maxY = Math.min(height - 1, maxY + trimPadding);
  
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  
  const trimmedBuffer = await sharp(buffer)
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .png()
    .toBuffer();
  
  return {
    buffer: trimmedBuffer,
    width: cropW,
    height: cropH,
    isEmpty: false
  };
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Yerlikaya Auto Crop API',
    version: '3.2.0',
    endpoints: {
      crop: 'POST /crop - Background removal + auto crop (flood-fill)',
      trim: 'POST /trim - Simple whitespace trim',
      split: 'POST /split - Split horizontal image into panels + auto trim'
    }
  });
});

// ============================================
// /crop - FLOOD-FILL BACKGROUND REMOVAL + CROP
// ============================================

app.post('/crop', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    if (!imageFile) return res.status(400).json({ error: 'Image file required' });
    
    imagePath = imageFile.path;
    const startTime = Date.now();
    
    // Parameters
    const threshold = parseFloat(req.body.threshold) || 15;
    const enableErosion = req.body.erosion !== 'false';
    const erosionRadius = parseInt(req.body.erosionRadius) || 1;
    const enableDecontamination = req.body.decontamination !== 'false';
    const enableSoftening = req.body.softening !== 'false';
    const minIslandSize = parseInt(req.body.minIslandSize) || 100;
    
    console.log('='.repeat(60));
    console.log(`🔍 v3.2 Flood-Fill Processing`);
    console.log(`📊 Threshold: ${threshold}, Erosion: ${enableErosion}(${erosionRadius}px)`);
    console.log(`🎨 Decontamination: ${enableDecontamination}, Softening: ${enableSoftening}`);
    
    // Load image with alpha
    const image = sharp(imagePath).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    
    console.log(`📏 Size: ${width}x${height}, channels: ${channels}`);
    
    // Step 1: Detect background
    const bgColor = detectBackgroundColor(data, width, height, channels);
    console.log(`🎨 Background: rgb(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`);
    
    // Step 2: Flood-fill from edges
    const mask = floodFillBackground(data, width, height, channels, bgColor, threshold);
    
    let bgCount = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) bgCount++;
    console.log(`🌊 Flood-fill: ${bgCount} bg pixels (${(bgCount / mask.length * 100).toFixed(1)}%)`);
    
    // Step 3: Interior islands
    const removed = removeInteriorIslands(data, mask, width, height, channels, bgColor, threshold * 1.2, minIslandSize);
    if (removed > 0) console.log(`🏝️ Interior islands removed: ${removed} pixels`);
    
    // Step 4: Find edge pixels
    const edgePixels = findEdgePixels(mask, width, height);
    console.log(`🔲 Edge pixels: ${edgePixels.size}`);
    
    // Step 5: Apply transition zone + transparency
    let processedData = applyTransitionZone(data, mask, width, height, channels, bgColor, threshold, edgePixels);
    
    // Step 6: Color decontamination
    if (enableDecontamination) {
      processedData = colorDecontaminate(processedData, mask, width, height, channels, bgColor, edgePixels);
    }
    
    // Step 7: Morphological erosion on alpha
    if (enableErosion) {
      for (let pass = 0; pass < erosionRadius; pass++) {
        const eroded = Buffer.from(processedData);
        for (const idx of edgePixels) {
          const x = idx % width;
          const y = Math.floor(idx / width);
          const dataIdx = idx * channels;
          
          // Check 3x3 neighborhood
          let minAlpha = 255;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const nDataIdx = (ny * width + nx) * channels;
                minAlpha = Math.min(minAlpha, processedData[nDataIdx + 3]);
              }
            }
          }
          eroded[dataIdx + 3] = minAlpha;
        }
        processedData = eroded;
      }
    }
    
    // Step 8: Crop to content
    labCache.clear();
    
    const result = await sharp(processedData, {
      raw: { width, height, channels }
    })
    .trim()
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();
    
    console.log(`✅ Done: ${(result.length / 1024).toFixed(0)}KB, ${Date.now() - startTime}ms`);
    console.log('='.repeat(60));
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="cropped-${Date.now()}.png"`
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

// ============================================
// /trim - SIMPLE WHITESPACE TRIM
// ============================================

app.post('/trim', upload.single('image'), async (req, res) => {
  let imagePath;
  try {
    const imageFile = req.file;
    if (!imageFile) return res.status(400).json({ error: 'Image file required' });
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 10;
    
    console.log('✂️ Trim-only, threshold:', threshold);
    
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

// ============================================
// /split - SPLIT HORIZONTAL IMAGE INTO PANELS
// ============================================
// Yatay görselleri (2 panel yan yana) ortadan böler
// Her paneli auto-trim eder (boşlukları kırpar)
// Boş panelleri atlar (skipEmpty)
// n8n'den multipart/form-data ile kullanılır

app.post('/split', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    if (!imageFile) return res.status(400).json({ error: 'Image file required' });
    
    imagePath = imageFile.path;
    const startTime = Date.now();
    
    // Parameters
    const trimThreshold = parseInt(req.body.threshold) || 30;
    const trimPadding = parseInt(req.body.padding) || 10;
    const skipEmpty = req.body.skipEmpty !== 'false'; // default true
    const outputFormat = req.body.format || 'json'; // 'json' veya 'first' (ilk paneli binary döner)
    
    console.log('='.repeat(60));
    console.log(`✂️ Split Processing`);
    console.log(`📊 Threshold: ${trimThreshold}, Padding: ${trimPadding}, SkipEmpty: ${skipEmpty}`);
    
    // Get image dimensions
    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;
    console.log(`📏 Input: ${width}x${height}`);
    
    const mid = Math.floor(width / 2);
    
    // Extract left panel
    const leftBuffer = await sharp(imagePath)
      .extract({ left: 0, top: 0, width: mid, height })
      .png()
      .toBuffer();
    
    // Extract right panel
    const rightBuffer = await sharp(imagePath)
      .extract({ left: mid, top: 0, width: width - mid, height })
      .png()
      .toBuffer();
    
    const panels = [];
    
    for (const [idx, buffer] of [leftBuffer, rightBuffer].entries()) {
      const panelName = idx === 0 ? 'left' : 'right';
      
      const trimmed = await detectAndTrimPanel(buffer, trimThreshold, trimPadding);
      
      if (skipEmpty && trimmed.isEmpty) {
        console.log(`⏭️ ${panelName} panel is empty - skipping`);
        continue;
      }
      
      console.log(`✅ ${panelName}: ${trimmed.width}x${trimmed.height}`);
      
      panels.push({
        name: panelName,
        buffer: trimmed.buffer,
        width: trimmed.width,
        height: trimmed.height
      });
    }
    
    console.log(`📦 Result: ${panels.length} panel(s), ${Date.now() - startTime}ms`);
    console.log('='.repeat(60));
    
    // Output mode
    if (outputFormat === 'first' && panels.length > 0) {
      // Binary mode - direkt ilk paneli PNG olarak döner (n8n için kolay)
      res.set({
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="panel-${panels[0].name}-${Date.now()}.png"`,
        'X-Panel-Name': panels[0].name,
        'X-Panel-Width': panels[0].width.toString(),
        'X-Panel-Height': panels[0].height.toString(),
        'X-Panel-Count': panels.length.toString()
      });
      res.send(panels[0].buffer);
      return;
    }
    
    // JSON mode - tüm panelleri base64 olarak döner
    res.json({
      success: true,
      originalSize: { width, height },
      panelCount: panels.length,
      panels: panels.map(p => ({
        name: p.name,
        width: p.width,
        height: p.height,
        image: p.buffer.toString('base64')
      }))
    });
    
  } catch (error) {
    console.error('❌ Split Error:', error);
    res.status(500).json({ error: 'Failed to split image', details: error.message });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Yerlikaya Auto Crop API v3.2 running on port ${PORT}`);
  console.log(`📡 Endpoints: /crop, /trim, /split`);
});
