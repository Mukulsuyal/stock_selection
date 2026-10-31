const express = require('express');
const router = express.Router();
const multer = require('multer');
const { requireAuth, requireFeature } = require('../auth');
const { extractFromImage, isEnabled } = require('../visionImport');
const { analyze } = require('../indicators');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

router.get('/status', (req, res) => {
  res.json({ screenshotAnalysisEnabled: isEnabled() });
});

// Upload one or more screenshots (bulk). Each is extracted independently.
// multipart/form-data with field name "images" (can repeat).
router.post('/screenshot', requireAuth, requireFeature('import'), upload.array('images', 10), async (req, res) => {
  try {
    if (!isEnabled()) {
      return res.status(400).json({ error: 'Screenshot analysis is not enabled. Add ANTHROPIC_API_KEY to your .env to turn it on.' });
    }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Upload at least one image' });

    const results = [];
    for (const file of req.files) {
      try {
        const base64 = file.buffer.toString('base64');
        const extracted = await extractFromImage(base64, file.mimetype);

        let analysis = null;
        if (extracted.candles && extracted.candles.length >= 20) {
          const quote = {
            symbol: extracted.symbol || 'IMPORTED',
            lastPrice: extracted.currentPrice ?? extracted.candles[extracted.candles.length - 1].close,
          };
          analysis = analyze(extracted.candles, quote);
        }

        results.push({
          filename: file.originalname,
          extracted,
          analysis,
          note: extracted.candles?.length
            ? (extracted.candles.length < 20 ? `Only ${extracted.candles.length} data point(s) read from image — not enough for full indicator analysis, showing raw extracted data only.` : null)
            : 'Only current price/change was readable from this image — no historical candles found, so no indicator analysis was run.',
        });
      } catch (err) {
        results.push({ filename: file.originalname, error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Screenshot processing failed' });
  }
});

module.exports = router;
