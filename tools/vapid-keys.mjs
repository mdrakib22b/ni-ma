#!/usr/bin/env node
// Generates the VAPID key pair the push reminders need. Run once:
//   npm run vapid
// then paste both lines into Vercel → Settings → Environment Variables
// (and redeploy). Keep VAPID_PRIVATE_KEY secret; the public key is served to
// the app. Changing the pair later just means devices re-subscribe.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
console.log(`VAPID_PUBLIC_KEY=${pub.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
