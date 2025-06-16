/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// Extend Env type for required environment variables
interface Env {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	JWT_PRIVATE_KEY: string;
	JWT_PUBLIC_KEY: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		// --- Config ---
		const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
		const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
		const JWT_PRIVATE_KEY = env.JWT_PRIVATE_KEY; // PEM-encoded private key
		const JWT_PUBLIC_KEY = env.JWT_PUBLIC_KEY;   // PEM-encoded public key

		// --- Endpoints ---
		switch (url.pathname) {
			case '/auth/google/login': {
				console.log('[auth] /auth/google/login called');
				const redirect_uri = `${url.origin}/auth/google/callback`;
				const state = crypto.randomUUID();
				const params = new URLSearchParams({
					client_id: GOOGLE_CLIENT_ID,
					redirect_uri,
					response_type: 'code',
					scope: 'openid email profile',
					state,
					access_type: 'offline',
					prompt: 'consent',
				});
				console.log('[auth] Redirecting to Google OAuth', params.toString());
				return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
			}
			case '/auth/google/callback': {
				console.log('[auth] /auth/google/callback called', url.search);
				if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
				const code = url.searchParams.get('code');
				const redirect_uri = `${url.origin}/auth/google/callback`;
				if (!code) {
					console.error('[auth] Missing code in callback');
					return new Response('Missing code', { status: 400 });
				}
				// Exchange code for tokens
				const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						code,
						client_id: GOOGLE_CLIENT_ID,
						client_secret: GOOGLE_CLIENT_SECRET,
						redirect_uri,
						grant_type: 'authorization_code',
					}),
				});
				const tokenData = await tokenRes.json() as { id_token?: string };
				const id_token = tokenData.id_token;
				if (!id_token) {
					console.error('[auth] No id_token in token response', tokenData);
					return new Response('No id_token', { status: 400 });
				}
				// Verify Google ID token
				const { importJWK, jwtVerify, SignJWT } = await import('jose');
				const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
				const { keys } = await googleRes.json() as { keys: any[] };
				let payload;
				for (const jwk of keys) {
					try {
						const pubKey = await importJWK(jwk, 'RS256');
						const { payload: pl } = await jwtVerify(id_token, pubKey, { audience: GOOGLE_CLIENT_ID });
						payload = pl;
						break;
					} catch (e) {
						console.error('[auth] Google token verification failed for a key', e);
					}
				}
				if (!payload) {
					console.error('[auth] Invalid Google token, could not verify');
					return new Response('Invalid Google token', { status: 401 });
				}
				// Issue our own JWT
				console.log('[auth] Google user payload', payload);
				const privateKey = await importJWK(JSON.parse(JWT_PRIVATE_KEY), 'RS256');
				const jwt = await new SignJWT({
					id: payload.sub,
					email: payload.email,
					name: payload.name,
				})
					.setProtectedHeader({ alg: 'RS256' })
					.setIssuedAt()
					.setExpirationTime('7d')
					.sign(privateKey);
				console.log('[auth] Issued JWT for user', payload.email);
				return new Response(JSON.stringify({ token: jwt }), {
					headers: { 'Content-Type': 'application/json' },
				});
			}
			case '/auth/me': {
				console.log('[auth] /auth/me called');
				const { jwtVerify, importJWK } = await import('jose');
				const auth = request.headers.get('authorization');
				if (!auth?.startsWith('Bearer ')) {
					console.error('[auth] Missing token in /auth/me');
					return new Response('Missing token', { status: 401 });
				}
				const token = auth.slice(7);
				try {
					const publicKey = await importJWK(JSON.parse(JWT_PUBLIC_KEY), 'RS256');
					const { payload } = await jwtVerify(token, publicKey);
					console.log('[auth] /auth/me success', payload);
					return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
				} catch (e) {
					console.error('[auth] Invalid token in /auth/me', e);
					return new Response('Invalid token', { status: 401 });
				}
			}
			case '/message':
				return new Response('Hello, World!');
			case '/random':
				return new Response(crypto.randomUUID());
			default:
				return new Response('Not Found', { status: 404 });
		}
	}
};
