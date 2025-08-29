// routes/r2Client.js
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import https from 'https';

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT,
  R2_BUCKET,
} = process.env;

const httpsAgent = new https.Agent({
  keepAlive: true,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
});

export const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({ httpsAgent }),
});

// Presign GET/PUT para o R2
export async function r2GetSignedUrl(method, objectKey, expiresSeconds = 900, contentType) {
  if (!R2_BUCKET) throw new Error('R2_BUCKET não definido');

  if (method === 'GET') {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
    return getSignedUrl(r2, cmd, { expiresIn: expiresSeconds });
  }

  if (method === 'PUT') {
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: objectKey,
      ContentType: contentType || 'application/octet-stream',
    });
    return getSignedUrl(r2, cmd, { expiresIn: expiresSeconds });
  }

  throw new Error(`Método não suportado: ${method}`);
}

// Upload direto (quando não queremos presign)
export async function r2PutObject(objectKey, bodyBuffer, contentType = 'application/octet-stream') {
  if (!R2_BUCKET) throw new Error('R2_BUCKET não definido');
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: objectKey,
      Body: bodyBuffer,
      ContentType: contentType,
      ContentLength: bodyBuffer?.length,
    })
  );
}
