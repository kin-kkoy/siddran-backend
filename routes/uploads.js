const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const checkAuth = require('../middleware/authMiddleware')
const { uploadLimiter } = require('../middleware/rateLimiter')
const storage = require('../lib/storage')
const logger = require('../utils/logger')

// Keep in sync with frontend ALLOWED_IMAGE_MIME / MAX_IMAGE_BYTES in src/utils/imageUpload.js
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_BYTES = 5 * 1024 * 1024

const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

router.use(checkAuth)

// POST /uploads/presign — issue a presigned PUT URL the frontend uses to upload directly to R2
router.post('/presign', uploadLimiter, async (req, res) => {
    const { mimeType, size } = req.body

    if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
        return res.status(400).json({ error: 'Unsupported image type' })
    }
    if (typeof size !== 'number' || size <= 0) {
        return res.status(400).json({ error: 'Invalid size' })
    }
    if (size > MAX_BYTES) {
        return res.status(413).json({ error: 'File too large' })
    }

    try {
        const ext = MIME_TO_EXT[mimeType]
        const filename = `${crypto.randomUUID()}.${ext}`
        const key = `uploads/${req.user.id}/${filename}`

        const uploadUrl = await storage.getPresignedPutUrl({
            key,
            contentType: mimeType,
            contentLength: size,
        })

        res.status(201).json({
            uploadUrl,
            path: `/${key}`,
            publicUrl: `${process.env.R2_PUBLIC_URL}/${key}`,
            size,
            mimeType,
        })
    } catch (error) {
        logger.error('Failed to presign upload:', error)
        res.status(500).json({ error: 'Failed to generate upload URL' })
    }
})

module.exports = router
