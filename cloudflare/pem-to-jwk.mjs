import { importPKCS8, importSPKI, exportJWK } from 'jose';
import { readFile } from 'fs/promises';

const privatePem = await readFile('jwt-private.pem', 'utf8');
const publicPem = await readFile('jwt-public.pem', 'utf8');

const privateKey = await importPKCS8(privatePem, 'RS256');
const publicKey = await importSPKI(publicPem, 'RS256');

const jwkPrivate = await exportJWK(privateKey);
const jwkPublic = await exportJWK(publicKey);

console.log('Private JWK:', JSON.stringify(jwkPrivate, null, 2));
console.log('Public JWK:', JSON.stringify(jwkPublic, null, 2));