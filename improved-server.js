const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const REMBG_URL = process.env.REMBG_URL || 'http://rembg:7000';

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

// [Tüm mevcut helper fonksiyonlarını koru: colorDistance, isBackgroundColor, detectBackgroundColor, morphologicalClose, simpleBackgroundRemoval, canvaStyleBackgroundRemoval]
// ... (bunları değiştirme, aynı kalsın)

// Basit ve etkili renk benzerlik hesaplama
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const deltaR = Math.abs(r1 - r2);
  const deltaG = Math.abs(g1 - g2);
  const deltaB = Math.abs(b1 - b2);
  
  // Simple weighted distance - prioritize green channel
  return deltaR * 0.3 + deltaG * 0.59 + deltaB * 0.11;
}

// Threshold 0 için hassas background detection
function isBackgroundColor(r, g, b, bgColor, threshold) {
  if (threshold === 0) {
    // Threshold 0: Sadece tam eşleşmeleri kabul et
    return r === bgColor.r && g === bgColor.g && b === bgColor.b;
  }
  
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

// Simple but efficient background removal
function simpleBackgroundRemoval(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  
  console.log('⚡ Simple processing started...');
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const alpha = result[offset + 3];
      
      if (alpha === 0) continue;
      
      if (threshold === 0) {
        // Exact match only
        if (r === bgColor.r && g === bgColor.g && b === bgColor.b) {
          result[offset + 3] = 0;
        }
      } else {
        const distance = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
        if (distance <= threshold) {
          result[offset + 3] = 0;
        } else if (distance <= threshold * 1.3) {
          // Light anti-aliasing
          const fadeRatio = (distance - threshold) / (threshold * 0.3);
          result[offset + 3] = Math.floor(alpha * Math.max(0.2, fadeRatio));
        }
      }
    }
  }
  
  console.log('✅ Simple processing completed');
  return result;
}

// Canva-style advanced background removal
function canvaStyleBackgroundRemoval(data, width, height, channels, bgColor, threshold) {
  const result = Buffer.from(data);
  
  console.log('🎨 Canva-style processing started...');
  
  // Step 1: Create edge map
  const edgeMap = new Array(width * height).fill(false);
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * channels;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      
      // Check 8-directional gradients
      let maxGradient = 0;
      const directions = [[-1,-1], [-1,0], [-1,1], [0,-1], [0,1], [1,-1], [1,0], [1,1]];
      
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        const nOffset = (ny * width + nx) * channels;
        
        const gradient = Math.abs(r - result[nOffset]) + 
                        Math.abs(g - result[nOffset + 1]) + 
                        Math.abs(b - result[nOffset + 2]);
        
        maxGradient = Math.max(maxGradient, gradient);
      }
      
      // High gradient = edge
      if (maxGradient > 40) {
        edgeMap[y * width + x] = true;
      }
    }
  }
  
  // Step 2: Smart background removal with edge protection
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const pixelIndex = y * width + x;
      const r = result[offset];
      const g = result[offset + 1];
      const b = result[offset + 2];
      const alpha = result[offset + 3];
      
      // Skip if already transparent
      if (alpha === 0) continue;
      
      const distance = colorDistance(r, g, b, bgColor.r, bgColor.g, bgColor.b);
      const isEdge = edgeMap[pixelIndex];
      
      if (threshold === 0) {
        // Exact match only
        if (r === bgColor.r && g === bgColor.g && b === bgColor.b) {
          result[offset + 3] = 0;
        }
      } else if (distance <= threshold) {
        if (isEdge) {
          // Edge pixel - be very conservative
          if (distance <= threshold * 0.5) {
            result[offset + 3] = 0;
          } else {
            // Gradual fade for edge pixels
            const fadeRatio = 1 - (distance / threshold);
            result[offset + 3] = Math.floor(alpha * (1 - fadeRatio * 0.7));
          }
        } else {
          // Non-edge pixel - remove more aggressively
          result[offset + 3] = 0;
        }
      } else if (distance <= threshold * 1.2 && !isEdge) {
        // Soft background removal for non-edges
        const fadeRatio = (distance - threshold) / (threshold * 0.2);
        result[offset + 3] = Math.floor(alpha * Math.max(0.3, fadeRatio));
      }
    }
  }
  
  console.log('✅ Canva-style processing completed');
  return result;
}

// 🆕 REMBG HELPER FUNCTION
async function removeBackgroundWithRembg(imageBuffer) {
  try {
    console.log('🤖 Calling rembg API...');
    
    const formData = new FormData();
    formData.append('file', imageBuffer, {
      filename: 'image.png',
      contentType: 'image/png'
    });

    const response = await axios.post(
      `${REMBG_URL}/api/remove`,
      formData,
      {
        headers: formData.getHeaders(),
        responseType: 'arraybuffer',
        timeout: 60000, // 60 saniye timeout
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    console.log('✅ Rembg processing completed');
    return Buffer.from(response.data);
    
  } catch (error) {
    console.error('❌ Rembg error:', error.message);
    throw new Error(`Background removal failed: ${error.message}`);
  }
}

// Health check - güncelle
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Enhanced Auto Crop API with AI Background Removal',
    version: '3.0.0',
    endpoints: {
      crop: 'POST /crop - Smart crop with optional AI background removal',
      trim: 'POST /trim - Simple trim only',
      removeBg: 'POST /remove-bg - AI background removal only',
      process: 'POST /process - AI background removal + auto crop'
    },
    features: [
      'AI-powered background removal (rembg)',
      'Smart background detection',
      'Advanced color similarity',
      'Anti-aliasing cleanup',
      'Edge smoothing',
      'Morphological operations'
    ],
    rembgStatus: REMBG_URL
  });
});







// 🆕 YENİ ENDPOINT: Sadece Background Removal
app.post('/remove-bg', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file required' });
    }
    
    imagePath = imageFile.path;
    
    console.log('🤖 Step 1: Reading image...');
    const imageBuffer = await fs.readFile(imagePath);
    
    console.log('🤖 Step 2: Removing background with AI...');
    const resultBuffer = await removeBackgroundWithRembg(imageBuffer);
    
    console.log('✅ Success: Background removed');
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="nobg-${Date.now()}.png"`
    });
    res.send(resultBuffer);
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      error: 'Failed to remove background',
      details: error.message 
    });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});







// Yazıları temiz görüntüye ekle
async function overlayText(imageBuffer, textData) {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    // SVG ile yazıları çiz
    const svgTexts = textData.map(word => {
        const { bbox, text } = word;
        return `
            <text 
                x="${bbox.x0}" 
                y="${bbox.y0 + bbox.y1 / 2}" 
                font-size="${bbox.y1 - bbox.y0}"
                fill="black"
                font-family="Arial"
            >${text}</text>
        `;
    }).join('');
    
    const svg = `
        <svg width="${metadata.width}" height="${metadata.height}">
            ${svgTexts}
        </svg>
    `;
    
    return image
        .composite([{
            input: Buffer.from(svg),
            top: 0,
            left: 0
        }])
        .toBuffer();
}


// OCR'ı KALDIR - artık gerek yok

// Color-based removal (GÜNCELLENMIŞ - yazıları koru)
async function removeColorBackground(imageBuffer, targetColor = null, threshold = 30) {
  try {
    console.log('🎨 Color-based background removal...');
    
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    let { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // Auto-detect background color (corners)
    if (!targetColor) {
      // Sol üst köşe
      targetColor = {
        r: data[0],
        g: data[1],
        b: data[2]
      };
      console.log(`🎯 Auto-detected BG: RGB(${targetColor.r}, ${targetColor.g}, ${targetColor.b})`);
    }
    
    // Her pixel için
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Renk farkı
      const colorDiff = Math.sqrt(
        Math.pow(r - targetColor.r, 2) +
        Math.pow(g - targetColor.g, 2) +
        Math.pow(b - targetColor.b, 2)
      );
      
      // Threshold içindeyse transparent yap
      if (colorDiff <= threshold) {
        data[i + 3] = 0; // Transparent
      }
    }
    
    const result = await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4
      }
    })
    .png()
    .toBuffer();
    
    console.log('✅ Color removal completed');
    return result;
    
  } catch (error) {
    console.error('❌ Color removal error:', error);
    throw error;
  }
}


// Edge-aware color removal
async function removeColorBackgroundSmart(imageBuffer, targetColor = null, threshold = 30) {
  try {
    console.log('🎨 Smart color-based removal...');
    
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    // 1. Edge detection için grayscale
    const edgeBuffer = await image
      .clone()
      .greyscale()
      .normalise()
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] // Laplacian edge detection
      })
      .raw()
      .toBuffer();
    
    // 2. Original image data
    let { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // 3. Auto-detect background (corners average)
    if (!targetColor) {
      const corners = [
        { r: data[0], g: data[1], b: data[2] },
        { r: data[info.width * 4 - 4], g: data[info.width * 4 - 3], b: data[info.width * 4 - 2] },
        { r: data[data.length - info.width * 4], g: data[data.length - info.width * 4 + 1], b: data[data.length - info.width * 4 + 2] },
        { r: data[data.length - 4], g: data[data.length - 3], b: data[data.length - 2] }
      ];
      
      targetColor = {
        r: Math.round((corners[0].r + corners[1].r + corners[2].r + corners[3].r) / 4),
        g: Math.round((corners[0].g + corners[1].g + corners[2].g + corners[3].g) / 4),
        b: Math.round((corners[0].b + corners[1].b + corners[2].b + corners[3].b) / 4)
      };
      
      console.log(`🎯 Auto-detected BG: RGB(${targetColor.r}, ${targetColor.g}, ${targetColor.b})`);
    }
    
    // 4. Process each pixel
    for (let i = 0; i < data.length; i += 4) {
      const pixelIndex = i / 4;
      const edgeStrength = edgeBuffer[pixelIndex];
      
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Color difference
      const colorDiff = Math.sqrt(
        Math.pow(r - targetColor.r, 2) +
        Math.pow(g - targetColor.g, 2) +
        Math.pow(b - targetColor.b, 2)
      );
      
      // SMART: Kenar varsa koru, yoksa color threshold uygula
      if (edgeStrength < 50) { // Kenar değil
        if (colorDiff <= threshold) {
          data[i + 3] = 0; // Transparent
        }
      } else {
        // Kenar - muhtemelen yazı/nesne, koru
        // Sadece çok benzer renkteyse sil
        if (colorDiff <= threshold / 2) {
          data[i + 3] = 0;
        }
      }
    }
    
    const result = await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4
      }
    })
    .png()
    .toBuffer();
    
    console.log('✅ Smart removal completed');
    return result;
    
  } catch (error) {
    console.error('❌ Smart removal error:', error);
    throw error;
  }
}

async function removeColorWithDespill(imageBuffer, targetColor, threshold = 30) {
  const image = sharp(imageBuffer);
  let { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  
  if (!targetColor) {
    targetColor = { r: data[0], g: data[1], b: data[2] };
  }
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    const colorDiff = Math.sqrt(
      Math.pow(r - targetColor.r, 2) +
      Math.pow(g - targetColor.g, 2) +
      Math.pow(b - targetColor.b, 2)
    );
    
    if (colorDiff <= threshold) {
      // Tamamen sil
      data[i + 3] = 0;
    } else if (colorDiff <= threshold * 2) {
      // DESPILL: Kenar pixel - arkaplan rengini azalt
      const spillAmount = 1 - (colorDiff / (threshold * 2));
      
      // Arkaplan renginin katkısını çıkar
      data[i] = Math.max(0, r - (targetColor.r * spillAmount * 0.5));
      data[i + 1] = Math.max(0, g - (targetColor.g * spillAmount * 0.5));
      data[i + 2] = Math.max(0, b - (targetColor.b * spillAmount * 0.5));
      
      // Alpha'yı koruyucu azalt
      data[i + 3] = Math.round(255 * (1 - spillAmount * 0.3));
    }
  }
  
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).png().toBuffer();
}

async function removeColorWithMorphology(imageBuffer, targetColor, threshold = 30) {
  // ... normal color removal ...
  
  // Erode (1-2 pixel içe çek)
  const eroded = await sharp(processedBuffer)
    .convolve({
      width: 3,
      height: 3,
      kernel: [0, 1, 0, 1, 1, 1, 0, 1, 0]
    })
    .toBuffer();
  
  // Dilate (geri genişlet)
  const final = await sharp(eroded)
    .convolve({
      width: 3,
      height: 3,
      kernel: [1, 1, 1, 1, 1, 1, 1, 1, 1]
    })
    .toBuffer();
  
  return final;
}


async function removeColorWithFeather(imageBuffer, targetColor, threshold = 30) {
  // ... normal color removal ...
  
  // Alpha channel'ı hafifçe blur yap
  const feathered = await sharp(processedBuffer)
    .blur(0.5) // Çok hafif blur
    .toBuffer();
  
  return feathered;
}



// /process endpoint (BASİTLEŞTİRİLMİŞ - OCR yok)
app.post('/process', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file required' });
    }
    
    imagePath = imageFile.path;
    const removeBg = req.body.remove_bg !== 'false';
    const method = req.body.method || 'color';
    
    console.log('🚀 Starting processing...');
    console.log('🎯 Remove background:', removeBg);
    console.log('🎨 Method:', method);
    
    let imageBuffer = await fs.readFile(imagePath);
    
    // Background Removal
    if (removeBg) {
      if (method === 'ai') {
        console.log('🤖 AI background removal...');
        imageBuffer = await removeBackgroundWithRembg(imageBuffer);
      } else {
        console.log('🎨 Color-based background removal...');
        
        let targetColor = null;
        if (req.body.bg_color) {
          const hex = req.body.bg_color.replace('#', '');
          targetColor = {
            r: parseInt(hex.substr(0, 2), 16),
            g: parseInt(hex.substr(2, 2), 16),
            b: parseInt(hex.substr(4, 2), 16)
          };
        }
        
        const threshold = parseInt(req.body.threshold) || 30;
        imageBuffer = await removeColorWithDespill(imageBuffer, targetColor, threshold);
      }
    }
    
    // Auto Crop
    console.log('✂️ Auto cropping...');
    const croppedBuffer = await sharp(imageBuffer)
      .trim()
      .png()
      .toBuffer();
    
    console.log('✅ Success');
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="processed-${Date.now()}.png"`
    });
    res.send(croppedBuffer);
    
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

// Mevcut /crop endpoint'i koru (değiştirme)
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
    const threshold = parseInt(req.body.threshold) || 15;
    const quality = req.body.quality || 'standard'; // standard or premium
    
    console.log('🔍 Step 1: Loading and analyzing image...');
    console.log('📊 Quality mode:', quality);
    
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
    
    // Quality-based background removal
    console.log('🔧 Step 5: Quality-based cleaning...');
    let processedPixels;
    
    if (quality === 'premium') {
      // Premium: Canva-style algorithm
      processedPixels = canvaStyleBackgroundRemoval(
        croppedData, 
        croppedInfo.width, 
        croppedInfo.height, 
        croppedInfo.channels,
        bgColor,
        threshold
      );
    } else {
      // Standard: Simple but fast
      processedPixels = simpleBackgroundRemoval(
        croppedData, 
        croppedInfo.width, 
        croppedInfo.height, 
        croppedInfo.channels,
        bgColor,
        threshold
      );
    }
    
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


// OCR ile yazıları tespit et
async function detectText(imagePath) {
    try {
        const { data: { words } } = await Tesseract.recognize(
            imagePath,
            'eng',
            { 
                logger: m => console.log('📖 OCR:', m.status) 
            }
        );
        
        return words.filter(w => w.confidence > 60); // Güvenilir yazılar
    } catch (error) {
        console.error('❌ OCR error:', error);
        return [];
    }
}










// Mevcut /trim endpoint'i koru (değiştirme)
app.post('/trim', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file required' });
    }
    
    imagePath = imageFile.path;
    const threshold = parseInt(req.body.threshold) || 10;
    
    console.log('✂️ Step 1: Trim-only processing...');
    console.log('📊 Threshold:', threshold);
    
    // Basit trim işlemi - Sharp'ın default behavior'ı
    console.log('✂️ Step 2: Simple trimming...');
    
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    
    console.log(`📏 Original size: ${metadata.width}x${metadata.height}`);
    
    const trimmedBuffer = await image
      .trim({
        threshold: threshold
      })
      .png()
      .toBuffer();
    
    console.log('✅ Success: Image trimmed (background preserved)');
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="trimmed-${Date.now()}.png"`
    });
    res.send(trimmedBuffer);
    
  } catch (error) {
    console.error('❌ Trim Error Details:', error);
    res.status(500).json({ 
      error: 'Failed to trim image',
      details: error.message 
    });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Yerlikaya Auto Crop API v3.0 running on port ${PORT}`);
  console.log(`🤖 Rembg service: ${REMBG_URL}`);
  console.log(`📡 Health check: http://localhost:${PORT}/`);
});
