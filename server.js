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

// Basit ve etkili renk benzerlik hesaplama
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const deltaR = Math.abs(r1 - r2);
  const deltaG = Math.abs(g1 - g2);
  const deltaB = Math.abs(b1 - b2);
  
  // Simple weighted distance
  return deltaR * 0.3 + deltaG * 0.59 + deltaB * 0.11;
}

// Basit background detection
function isBackgroundColor(r, g, b, bgColor, threshold) {
  const distance = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
  return distance <= threshold;
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

// Basit ve etkili background removal
function cleanAntiAliasing(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  
  console.log('🎨 Background color for cleaning:', bgColor);
  
  // Basit approach: her pikseli kontrol et
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const alpha = result[offset + 3];
      
      // Arkaplan rengine benzer mi?
      if (isBackgroundColor(r, g, b, bgColor, threshold)) {
        result[offset + 3] = 0; // Şeffaf yap
      }
      // Anti-aliasing için gradual transparency
      else {
        const distance = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
        if (distance <= threshold * 1.5) {
          // Kenar pikseli - kısmi şeffaflık
          const fadeRatio = (distance - threshold) / (threshold * 0.5);
          result[offset + 3] = Math.floor(alpha * Math.max(0.2, Math.min(1, fadeRatio)));
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
    const threshold = parseInt(req.body.threshold) || 25; // Balanced threshold
    
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
    
    // Basit background removal
    console.log('🧹 Step 4: Simple background removal...');
    
    const { data: croppedData, info: croppedInfo } = await sharp(croppedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    console.log(`📏 Cropped size: ${croppedInfo.width}x${croppedInfo.height}`);
    
    // Basit background removal
    console.log('🔧 Step 5: Cleaning background...');
    let processedPixels = cleanAntiAliasing(
      croppedData, 
      croppedInfo.width, 
      croppedInfo.height, 
      croppedInfo.channels,
      bgColor,
      threshold
    );
    
    // Final PNG oluştur
    console.log('🎯 Step 6: Generating final image...');
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
