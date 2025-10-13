const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Auto Crop API',
    version: '1.0.0',
    endpoints: {
      crop: 'POST /crop'
    }
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
    const threshold = parseInt(req.body.threshold) || 1;
    
    console.log('🔍 Step 1: Detecting background color...');

    // Arkaplan rengini tespit et
    const image = sharp(imagePath);
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

    const bgColor = {
      r: data[0],
      g: data[1],
      b: data[2],
      alpha: info.channels === 4 ? data[3] : 255
    };
    
    console.log('🎨 Background detected:', bgColor);

    // ADIM 1: Kırp (trim)
    console.log('✂️ Step 2: Cropping...');
    
    const croppedBuffer = await sharp(imagePath)
      .trim({
        background: bgColor,
        threshold: threshold
      })
      .toBuffer();

    // ADIM 2: Arkaplanı kaldır (transparent yap)
    console.log('🧹 Step 3: Removing background...');
    
    const { data: croppedData, info: croppedInfo } = await sharp(croppedBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = Buffer.from(croppedData);
    
    // Her pikseli kontrol et, arkaplan rengine yakınsa şeffaf yap
    for (let i = 0; i < pixels.length; i += croppedInfo.channels) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      
      // Arkaplan rengine yakın mı?
      const diff = Math.abs(r - bgColor.r) + 
                   Math.abs(g - bgColor.g) + 
                   Math.abs(b - bgColor.b);
      
      if (diff <= threshold * 3) {
        // Şeffaf yap
        pixels[i + 3] = 0; // Alpha = 0
      }
    }

    // Final PNG oluştur
    const result = await sharp(pixels, {
      raw: {
        width: croppedInfo.width,
        height: croppedInfo.height,
        channels: croppedInfo.channels
      }
    })
    .png()
    .toBuffer();

    console.log('✅ Success: Cropped + Background removed');

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="cropped-${Date.now()}.png"`
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
  console.log(`🚀 Auto Crop API running on port ${PORT}`);
});
