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

// Crop endpoint
app.post('/crop', upload.single('image'), async (req, res) => {
  let imagePath;
  
  try {
    const imageFile = req.file;
    
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file required' });
    }

    // Dosya boyutu kontrolü
    const maxSize = 20 * 1024 * 1024; // 20MB
    if (imageFile.size > maxSize) {
      await fs.unlink(imageFile.path);
      return res.status(400).json({ 
        error: 'File too large',
        maxSize: '20MB',
        yourSize: `${(imageFile.size / 1024 / 1024).toFixed(2)}MB`
      });
    }

    imagePath = imageFile.path;
    
    console.log('🔍 Cropping image:', {
      originalSize: `${(imageFile.size / 1024).toFixed(2)}KB`,
      mimetype: imageFile.mimetype
    });

    // Beyaz/şeffaf boşlukları kırp
    const result = await sharp(imagePath)
      .trim({
        background: { r: 255, g: 255, b: 255, alpha: 0 }, // Beyaz ve şeffaf
        threshold: 10  // Tolerans (0-255)
      })
      .png()
      .toBuffer();

    console.log('✅ Cropped successfully:', {
      outputSize: `${(result.length / 1024).toFixed(2)}KB`
    });

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="cropped-${Date.now()}.png"`
    });
    res.send(result);

  } catch (error) {
    console.error('❌ Crop error:', error);
    res.status(500).json({ 
      error: 'Failed to crop image',
      details: error.message 
    });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

// Crop endpoint - akıllı arkaplan tespiti
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
    
    console.log('🔍 Detecting background color...');

    // Görseli oku
    const image = sharp(imagePath);
    const { data, info } = await image
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Köşe piksellerinden arkaplan rengini tespit et
    const corners = [
      0, // Sol üst
      info.width - 1, // Sağ üst
      (info.height - 1) * info.width, // Sol alt
      info.height * info.width - 1 // Sağ alt
    ];

    // En çok tekrar eden köşe rengini bul
    const cornerColors = corners.map(pos => {
      const i = pos * info.channels;
      return {
        r: data[i],
        g: data[i + 1],
        b: data[i + 2],
        alpha: info.channels === 4 ? data[i + 3] : 255
      };
    });

    // İlk köşe rengini arkaplan olarak al
    const bgColor = cornerColors[0];
    
    console.log('🎨 Background color detected:', bgColor);

    // Arkaplan rengini kaldır ve kırp
    const result = await sharp(imagePath)
      .trim({
        background: bgColor,
        threshold: 15 // Tolerans (renk farkı)
      })
      .png()
      .toBuffer();

    console.log('✅ Cropped successfully');

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="cropped-${Date.now()}.png"`
    });
    res.send(result);

  } catch (error) {
    console.error('❌ Crop error:', error);
    res.status(500).json({ 
      error: 'Failed to crop image',
      details: error.message 
    });
  } finally {
    if (imagePath) await fs.unlink(imagePath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Auto Crop API running on port ${PORT}`);
});
