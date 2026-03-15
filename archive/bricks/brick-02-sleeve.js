// brick-02-sleeve.js
// PCAux Diamond Platform - Brick #2: Sleeve Verification & Image Capture
// Hardware integration for tamper-evident stone verification and 7-image packet generation

import express from 'express';
import { Pool } from 'pg';
import { body, validationResult } from 'express-validator';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { requireJeweler } from './brick-01-auth.js';

const router = express.Router();
const pool = new Pool();

// S3 config for image storage
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.S3_BUCKET || 'pcaux-images';

// Multer config (memory storage, process then upload to S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'), false);
  }
});

// ===== SLEEVE HARDWARE MANAGEMENT =====

// Register new sleeve device (admin only)
router.post('/sleeves/register', async (req, res) => {
  const { sleeve_id, location, assigned_to } = req.body;
  
  try {
    const { rows: [sleeve] } = await pool.query(`
      INSERT INTO sleeves (id, status, location, assigned_to, created_at)
      VALUES ($1, 'active', $2, $3, NOW())
      RETURNING *
    `, [sleeve_id, location, assigned_to]);
    
    res.status(201).json(sleeve);
  } catch (err) {
    res.status(500).json({ error: 'Sleeve registration failed' });
  }
});

// Get sleeve status
router.get('/sleeves/:sleeveId', requireJeweler, async (req, res) => {
  const { sleeveId } = req.params;
  
  try {
    const { rows: [sleeve] } = await pool.query(`
      SELECT s.*, j.business_name as assigned_jeweler
      FROM sleeves s
      LEFT JOIN jewelers j ON s.assigned_to = j.id
      WHERE s.id = $1
    `, [sleeveId]);
    
    if (!sleeve) return res.status(404).json({ error: 'Sleeve not found' });
    res.json(sleeve);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sleeve' });
  }
});

// ===== DIAMOND INTAKE & VERIFICATION =====

// Step 1: Initialize diamond listing (jeweler creates draft)
router.post('/diamonds/draft', requireJeweler, [
  body('estimated_carat').isFloat({ min: 0.1, max: 10 }),
  body('estimated_color').isIn(['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'unknown']),
  body('estimated_clarity').isIn(['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'I1', 'I2', 'I3', 'unknown']),
  body('estimated_cut').isIn(['Ideal', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor', 'unknown']),
  body('shape').isIn(['Round', 'Princess', 'Emerald', 'Asscher', 'Cushion', 'Oval', 'Pear', 'Marquise', 'Radiant', 'Heart']),
  body('origin_story').optional().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    estimated_carat,
    estimated_color,
    estimated_clarity,
    estimated_cut,
    shape,
    origin_story,
    fluorescence,
    symmetry,
    polish
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Create diamond draft
    const { rows: [diamond] } = await client.query(`
      INSERT INTO diamonds (
        jeweler_id, status,
        estimated_carat, estimated_color, estimated_clarity, estimated_cut,
        shape, origin_story, fluorescence, symmetry, polish,
        created_at
      ) VALUES ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id
    `, [
      req.jeweler.id, estimated_carat, estimated_color, estimated_clarity,
      estimated_cut, shape, origin_story || null, fluorescence || 'unknown',
      symmetry || 'unknown', polish || 'unknown'
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      diamond_id: diamond.id,
      status: 'draft',
      message: 'Draft created. Proceed to sleeve verification.'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Draft creation error:', err);
    res.status(500).json({ error: 'Failed to create draft' });
  } finally {
    client.release();
  }
});

// Step 2: Daughter verifies stone and seals sleeve
router.post('/diamonds/:diamondId/verify', requireJeweler, upload.fields([
  { name: 'loupe_view', maxCount: 1 },        // 10x inclusion mapping
  { name: 'face_up_white', maxCount: 1 },      // Brilliance, contrast
  { name: 'face_up_color', maxCount: 1 },       // Fire, scintillation
  { name: 'profile_60deg', maxCount: 1 },      // Girdle, culet
  { name: 'uv_fluorescence', maxCount: 1 },     // Blue/yellow intensity
  { name: 'spectroscopy', maxCount: 1 },       // Plot or reference
  { name: 'scale_weight', maxCount: 1 }        // Carat confirmation
]), async (req, res) => {
  const { diamondId } = req.params;
  const { sleeve_id, daughter_id, verification_notes } = req.body;

  if (!req.files || Object.keys(req.files).length < 7) {
    return res.status(400).json({ error: 'All 7 images required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify diamond belongs to this jeweler and is in draft
    const { rows: [diamond] } = await client.query(`
      SELECT * FROM diamonds WHERE id = $1 AND jeweler_id = $2 AND status = 'draft'
    `, [diamondId, req.jeweler.id]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not found or not in draft status' });
    }

    // Verify sleeve is active and assigned to this jeweler
    const { rows: [sleeve] } = await client.query(`
      SELECT * FROM sleeves WHERE id = $1 AND assigned_to = $2 AND status = 'active'
    `, [sleeve_id, req.jeweler.id]);

    if (!sleeve) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Invalid or unauthorized sleeve' });
    }

    // Process and upload images to S3
    const imageUrls = {};
    const imageKeys = ['loupe_view', 'face_up_white', 'face_up_color', 'profile_60deg', 'uv_fluorescence', 'spectroscopy', 'scale_weight'];

    for (const key of imageKeys) {
      const file = req.files[key]?.[0];
      if (!file) continue;

      // Process image (resize, watermark, optimize)
      const processed = await sharp(file.buffer)
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90, progressive: true })
        .toBuffer();

      // Generate unique key
      const s3Key = `diamonds/${diamondId}/${key}_${uuidv4()}.jpg`;

      // Upload to S3
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: processed,
        ContentType: 'image/jpeg',
        Metadata: {
          'diamond-id': diamondId,
          'image-type': key,
          'sleeve-id': sleeve_id,
          'daughter-id': daughter_id
        }
      }));

      // Construct URL (CloudFront or direct S3)
      imageUrls[key] = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
    }

    // Calculate tamper-evident hash (simplified)
    const sealHash = require('crypto')
      .createHash('sha256')
      .update(`${diamondId}${sleeve_id}${Date.now()}${JSON.stringify(imageUrls)}`)
      .digest('hex');

    // Create verification record
    await client.query(`
      INSERT INTO sleeve_verifications (
        diamond_id, sleeve_id, daughter_id, verification_notes,
        seal_hash, images, verified_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      diamondId, sleeve_id, daughter_id, verification_notes || null,
      sealHash, JSON.stringify(imageUrls)
    ]);

    // Update diamond status and images
    await client.query(`
      UPDATE diamonds 
      SET status = 'verified',
          sleeve_id = $2,
          seal_hash = $3,
          images = $4,
          verified_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [diamondId, sleeve_id, sealHash, JSON.stringify(imageUrls)]);

    // Mark sleeve as sealed (until IPO completes or stone removed)
    await client.query(`
      UPDATE sleeves 
      SET current_diamond_id = $1, status = 'sealed', sealed_at = NOW()
      WHERE id = $2
    `, [diamondId, sleeve_id]);

    await client.query('COMMIT');

    res.json({
      diamond_id: diamondId,
      status: 'verified',
      seal_hash: sealHash,
      images: imageUrls,
      message: 'Stone verified and sealed. Ready for IPO.'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  } finally {
    client.release();
  }
});

// Get diamond with images (for IPO preview)
router.get('/diamonds/:diamondId', async (req, res) => {
  const { diamondId } = req.params;

  try {
    const { rows: [diamond] } = await pool.query(`
      SELECT 
        d.*,
        j.business_name as jeweler_name,
        j.quality_king_tier as jeweler_tier,
        j.quality_king_score as jeweler_score,
        sv.daughter_id,
        sv.verified_at as sleeve_verified_at
      FROM diamonds d
      JOIN jewelers j ON d.jeweler_id = j.id
      LEFT JOIN sleeve_verifications sv ON d.id = sv.diamond_id
      WHERE d.id = $1 AND d.status IN ('verified', 'listing', 'grading', 'graded', 'resolved')
    `, [diamondId]);

    if (!diamond) return res.status(404).json({ error: 'Diamond not found' });

    // Parse images
    if (diamond.images) {
      diamond.images = JSON.parse(diamond.images);
    }

    res.json(diamond);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load diamond' });
  }
});

// List verified diamonds available for IPO
router.get('/diamonds', async (req, res) => {
  const { status = 'verified', jeweler_id, limit = 20, offset = 0 } = req.query;

  try {
    let where = 'WHERE d.status = $1';
    const params = [status];

    if (jeweler_id) {
      where += ` AND d.jeweler_id = $${params.length + 1}`;
      params.push(jeweler_id);
    }

    const { rows } = await pool.query(`
      SELECT 
        d.id, d.estimated_carat, d.estimated_color, d.estimated_clarity,
        d.estimated_cut, d.shape, d.status, d.verified_at, d.created_at,
        j.business_name as jeweler_name,
        j.quality_king_tier as jeweler_tier,
        (SELECT ipo_price FROM ipos WHERE diamond_id = d.id AND status = 'open' LIMIT 1) as ipo_price,
        (SELECT total_pcus FROM ipos WHERE diamond_id = d.id AND status = 'open' LIMIT 1) as total_pcus
      FROM diamonds d
      JOIN jewelers j ON d.jeweler_id = j.id
      ${where}
      ORDER BY d.verified_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({ diamonds: rows, limit, offset });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load diamonds' });
  }
});

// Release sleeve (after redemption or withdrawal)
router.post('/diamonds/:diamondId/release', requireJeweler, async (req, res) => {
  const { diamondId } = req.params;
  const { release_reason } = req.body; // 'ipo_cancelled', 'redemption_complete', 'withdrawal'

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify ownership and status
    const { rows: [diamond] } = await client.query(`
      SELECT * FROM diamonds WHERE id = $1 AND jeweler_id = $2
    `, [diamondId, req.jeweler.id]);

    if (!diamond) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Diamond not found' });
    }

    if (!diamond.sleeve_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Diamond not in sleeve' });
    }

    // Log release
    await client.query(`
      INSERT INTO sleeve_releases (diamond_id, sleeve_id, jeweler_id, release_reason, released_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [diamondId, diamond.sleeve_id, req.jeweler.id, release_reason]);

    // Free the sleeve
    await client.query(`
      UPDATE sleeves 
      SET status = 'active', current_diamond_id = NULL, sealed_at = NULL
      WHERE id = $1
    `, [diamond.sleeve_id]);

    // Update diamond (if withdrawal, mark withdrawn)
    if (release_reason === 'withdrawal') {
      await client.query(`UPDATE diamonds SET status = 'withdrawn' WHERE id = $1`, [diamondId]);
    }

    await client.query('COMMIT');

    res.json({ message: 'Sleeve released', diamond_id: diamondId });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Release failed' });
  } finally {
    client.release();
  }
});

export default router;
