const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
})

const BUCKET = process.env.R2_BUCKET_NAME

const PRESIGN_TTL_SECONDS = 300 // 5 minutes for the frontend to PUT

async function getPresignedPutUrl({ key, contentType, contentLength }) {
    const cmd = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        CacheControl: 'public, max-age=31536000, immutable',
    })
    return getSignedUrl(r2, cmd, {
        expiresIn: PRESIGN_TTL_SECONDS,
        signableHeaders: new Set(['cache-control']),
    })
}

async function deleteObject({ key }) {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

module.exports = { getPresignedPutUrl, deleteObject }
