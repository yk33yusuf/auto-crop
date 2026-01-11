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

// Gelişmiş renk benzerlik hesaplama
function colorDistance(r1, g1, b1, r2, g2, b2) {
  // Orange background için özel optimizasyon
  const deltaR = Math.abs(r1 - r2);
  const deltaG = Math.abs(g1 - g2);
  const deltaB = Math.abs(b1 - b2);
  
  // Orange tonları için weighted distance
  if (r2 > 200 && g2 > 100 && g2 < 200 && b2 < 100) {
    // Orange background detected - use stricter comparison
    return Math.max(deltaR * 0.8, deltaG * 1.2, deltaB * 1.5);
  }
  
  // Standard weighted euclidean distance
  const rMean = (r1 + r2) / 2;
  const weightR = 2 + rMean / 256;
  const weightG = 4;
  const weightB = 2 + (255 - rMean) / 256;
  
  return Math.sqrt(
    weightR * deltaR * deltaR +
    weightG * deltaG * deltaG +
    weightB * deltaB * deltaB
  );
}

// HSV renk uzayında benzerlik kontrolü (orange için)
function isBackgroundColor(r, g, b, bgColor, threshold) {
  // İlk önce normal distance kontrol et
  const distance = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
  if (distance <= threshold) return true;
  
  // Orange background için HSV kontrolü
  if (bgColor.r > 200 && bgColor.g > 100 && bgColor.g < 200 && bgColor.b < 100) {
    // RGB to HSV conversion for current pixel
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;
    
    const max = Math.max(rNorm, gNorm, bNorm);
    const min = Math.min(rNorm, gNorm, bNorm);
    const diff = max - min;
    
    let hue = 0;
    if (diff !== 0) {
      if (max === rNorm) {
        hue = (60 * ((gNorm - bNorm) / diff) + 360) % 360;
      } else if (max === gNorm) {
        hue = 60 * ((bNorm - rNorm) / diff) + 120;
      } else {
        hue = 60 * ((rNorm - gNorm) / diff) + 240;
      }
    }
    
    const saturation = max === 0 ? 0 : diff / max;
    const value = max;
    
    // Orange hue range check (20-40 degrees)
    const isOrangeHue = (hue >= 15 && hue <= 45);
    const isHighSat = saturation > 0.7;
    const isHighVal = value > 0.6;
    
    if (isOrangeHue && isHighSat && isHighVal) {
      return true;
    }
  }
  
  return false;
}

// Arkaplan rengini daha akıllı tespit et
function detectBackgroundColor(data, width, height, channels) {
  const cornerSamples = [];
  const sampleSize = 5; // 5x5 köşe alanı
  
  // Dört köşeden örnekler al
  const corners = [
    { x: 0, y: 0 }, // sol üst
    { x: width - sampleSize, y: 0 }, // sağ üst
    { x: 0, y: height - sampleSize }, // sol alt
    { x: width - sampleSize, y: height - sampleSize } // sağ alt
  ];
  
  corners.forEach(corner => {
    for (let y = corner.y; y < Math.min(corner.y + sampleSize, height); y++) {
      for (let x = corner.x; x < Math.min(corner.x + sampleSize, width); x++) {
        const offset = (y * width + x) * channels;
        cornerSamples.push({
          r: data[offset],
          g: data[offset + 1],
          b: data[offset + 2]
        });
      }
    }
  });
  
  // En yaygın rengi bul (basit clustering)
  const colorCounts = new Map();
  cornerSamples.forEach(color => {
    // Renkleri 10'luk gruplarda topla (tolerance için)
    const key = `${Math.floor(color.r/10)*10}-${Math.floor(color.g/10)*10}-${Math.floor(color.b/10)*10}`;
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
  });
  
  // En yaygın rengi bul
  let maxCount = 0;
  let dominantColor = { r: 255, g: 255, b: 255 };
  
  for (const [key, count] of colorCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      const [r, g, b] = key.split('-').map(Number);
      dominantColor = { r, g, b };
    }
  }
  
  return dominantColor;
}

// Edge cleaning için morphological operations
function morphologicalClose(data, width, height, channels) {
  const result = Buffer.from(data);
  const kernelSize = 3;
  const halfKernel = Math.floor(kernelSize / 2);
  
  // Dilation followed by erosion
  for (let pass = 0; pass < 2; pass++) {
    const temp = Buffer.from(result);
    
    for (let y = halfKernel; y < height - halfKernel; y++) {
      for (let x = halfKernel; x < width - halfKernel; x++) {
        const centerOffset = (y * width + x) * channels;
        
        if (temp[centerOffset + 3] > 0) continue; // Skip non-transparent pixels
        
        let hasOpaqueNeighbor = false;
        
        // Check neighbors
        for (let ky = -halfKernel; ky <= halfKernel; ky++) {
          for (let kx = -halfKernel; kx <= halfKernel; kx++) {
            const ny = y + ky;
            const nx = x + kx;
            const neighborOffset = (ny * width + nx) * channels;
            
            if (temp[neighborOffset + 3] > 128) { // Opaque neighbor
              hasOpaqueNeighbor = true;
              break;
            }
          }
          if (hasOpaqueNeighbor) break;
        }
        
        if (hasOpaqueNeighbor && pass === 0) {
          // Dilation: make transparent pixels opaque if they have opaque neighbors
          result[centerOffset + 3] = 255;
        } else if (!hasOpaqueNeighbor && pass === 1) {
          // Erosion: make opaque pixels transparent if they don't have opaque neighbors
          result[centerOffset + 3] = 0;
        }
      }
    }
  }
  
  return result;
}

// Gelişmiş anti-aliasing temizleme ve orange halo fix
function cleanAntiAliasing(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  
  console.log('🎨 Background color for cleaning:', bgColor);
  
  // İlk pass: Kesin arkaplan piksellerini temizle
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      
      if (isBackgroundColor(r, g, b, bgColor, threshold)) {
        result[offset + 3] = 0; // Tamamen şeffaf
      }
    }
  }
  
  // İkinci pass: Kenar temizleme (orange halo fix)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const alpha = result[offset + 3];
      
      // Skip already transparent pixels
      if (alpha === 0) continue;
      
      // Orange background specific halo detection
      const isOrangeish = r > 150 && g > 80 && g < 180 && b < 80;
      
      if (isOrangeish) {
        // Çevreyi kontrol et
        let transparentNeighbors = 0;
        let totalNeighbors = 0;
        
        // 3x3 neighborhood check
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nOffset = (ny * width + nx) * channels;
              const nAlpha = result[nOffset + 3];
              
              totalNeighbors++;
              if (nAlpha === 0) {
                transparentNeighbors++;
              }
            }
          }
        }
        
        const transparentRatio = transparentNeighbors / totalNeighbors;
        
        // Eğer çevrenin %40+ şeffaf ise bu piksel muhtemelen halo
        if (transparentRatio >= 0.4) {
          result[offset + 3] = 0;
        } else if (transparentRatio >= 0.25) {
          // Partial transparency for edge softening
          result[offset + 3] = Math.floor(alpha * 0.3);
        }
      }
      
      // Genel anti-aliasing kontrolü
      const distance = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
      
      if (distance <= threshold * 1.5 && distance > threshold) {
        // Bu bölge anti-aliasing olabilir
        let solidNeighbors = 0;
        let totalNeighbors = 0;
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nOffset = (ny * width + nx) * channels;
              const nR = result[nOffset];
              const nG = result[nOffset + 1];
              const nB = result[nOffset + 2];
              const nAlpha = result[nOffset + 3];
              
              totalNeighbors++;
              
              const nDistance = colorDistance(nR, nG, nB, bgColor.r, bgColor.g, bgColor.b);
              if (nDistance > threshold * 2 && nAlpha > 128) {
                solidNeighbors++;
              }
            }
          }
        }
        
        const solidRatio = solidNeighbors / totalNeighbors;
        
        if (solidRatio < 0.2) {
          // Çoğunlukla arkaplan, şeffaf yap
          result[offset + 3] = 0;
        } else if (solidRatio < 0.5) {
          // Gradual fade
          const fadeAlpha = Math.floor(alpha * solidRatio * 2);
          result[offset + 3] = Math.min(255, Math.max(0, fadeAlpha));
        }
      }
    }
  }
  
  return result;
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Enhanced Auto Crop API',
    version: '2.0.0',
    endpoints: {
      crop: 'POST /crop'
    },
    features: [
      'Smart background detection',
      'Advanced color similarity',
      'Anti-aliasing cleanup',
      'Edge smoothing',
      'Morphological operations'
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
      return res.status(400).json({ 
        error: 'File too large',
        maxSize: '20MB'
      });
    }
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 35; // Orange için increased threshold
    
    console.log('🔍 Step 1: Loading and analyzing image...');
    
    // İlk olarak resmi yükle ve bilgilerini al
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    
    console.log(`📏 Image size: ${info.width}x${info.height}, channels: ${info.channels}`);
    
    // Gelişmiş arkaplan tespiti
    console.log('🎨 Step 2: Smart background detection...');
    const bgColor = detectBackgroundColor(data, info.width, info.height, info.channels);
    console.log('🎨 Background detected:', bgColor);
    
    // ADIM 1: Sharp'ın trim fonksiyonu ile kaba kırpma
    console.log('✂️ Step 3: Initial cropping...');
    const croppedBuffer = await sharp(imagePath)
      .trim({
        background: bgColor,
        threshold: threshold
      })
      .toBuffer();
    
    // ADIM 2: Daha hassas background removal
    console.log('🧹 Step 4: Advanced background removal...');
    
    const { data: croppedData, info: croppedInfo } = await sharp(croppedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    console.log(`📏 Cropped size: ${croppedInfo.width}x${croppedInfo.height}`);
    
    // Gelişmiş anti-aliasing temizleme
    console.log('🔧 Step 5: Cleaning anti-aliasing...');
    let processedPixels = cleanAntiAliasing(
      croppedData, 
      croppedInfo.width, 
      croppedInfo.height, 
      croppedInfo.channels,
      bgColor,
      threshold
    );
    
    // Morphological operations ile edge temizleme
    console.log('🪄 Step 6: Edge smoothing...');
    processedPixels = morphologicalClose(
      processedPixels,
      croppedInfo.width,
      croppedInfo.height,
      croppedInfo.channels
    );
    
    // Final PNG oluştur
    console.log('🎯 Step 7: Generating final image...');
    const result = await sharp(processedPixels, {
      raw: {
        width: croppedInfo.width,
        height: croppedInfo.height,
        channels: croppedInfo.channels
      }
    })
    .png({
      compressionLevel: 6,
      adaptiveFiltering: true,
      force: true
    })
    .toBuffer();
    
    console.log('✅ Success: Enhanced cropped + Background removed');
    console.log(`📦 Output size: ${result.length} bytes`);
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="enhanced-cropped-${Date.now()}.png"`
    });
    res.send(result);
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      error: 'Failed to process image',
      details: error.message 
    });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Enhanced Auto Crop API running on port ${PORT}`);
});
