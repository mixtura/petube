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
	AGORA_APP_ID: string;
	AGORA_APP_CERTIFICATE: string;
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
		if (url.pathname === '/auth/google/login') {
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
			return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
		} else if (url.pathname === '/auth/google/callback') {
			if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
			const code = url.searchParams.get('code');
			const redirect_uri = `${url.origin}/auth/google/callback`;
			if (!code) return new Response('Missing code', { status: 400 });
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
			const tokenData = await tokenRes.json();
			if (!tokenData.id_token) {
				return new Response(JSON.stringify(tokenData), { headers: { 'Content-Type': 'application/json' }, status: 400 });
			}
			const id_token = tokenData.id_token;
			// Verify Google ID token
			const { importJWK, jwtVerify, SignJWT } = await import('jose');
			const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
			// Add type assertion for keys
			const { keys } = await googleRes.json() as { keys: any[] };
			let payload;
			for (const jwk of keys) {
				try {
					const pubKey = await importJWK(jwk, 'RS256');
					const { payload: pl } = await jwtVerify(id_token, pubKey, { audience: GOOGLE_CLIENT_ID });
					payload = pl;
					break;
				} catch {}
			}
			if (!payload) return new Response('Invalid Google token', { status: 401 });
			// Issue our own JWT
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
			// Redirect to / with token in fragment
			return Response.redirect(`https://mixtura.github.io/petube/#token=${jwt}`, 302);
		} else if (url.pathname === '/auth/me') {
			const { jwtVerify, importJWK } = await import('jose');
			const auth = request.headers.get('authorization');
			if (!auth?.startsWith('Bearer ')) return new Response('Missing token', { status: 401 });
			const token = auth.slice(7);
			try {
				const publicKey = await importJWK(JSON.parse(JWT_PUBLIC_KEY), 'RS256');
				const { payload } = await jwtVerify(token, publicKey);
				return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response('Invalid token', { status: 401 });
			}
		} else if (url.pathname === '/message') {
			return new Response('Hello, World!');
		} else if (url.pathname === '/random') {
			return new Response(crypto.randomUUID());
		} else if (/^\/auth\/agora\/(publisher|subscriber)\/token$/.test(url.pathname)) {
			// Path: /auth/agora/{role}/token
			const match = url.pathname.match(/^\/auth\/agora\/(publisher|subscriber)\/token$/);
			if (!match) return new Response('Invalid role', { status: 400 });
			const roleStr = match[1];
			const { jwtVerify, importJWK } = await import('jose');
			const auth = request.headers.get('authorization');
			if (!auth?.startsWith('Bearer ')) return new Response('Missing token', { status: 401 });
			const jwtToken = auth.slice(7);
			let userId;
			try {
				const publicKey = await importJWK(JSON.parse(env.JWT_PUBLIC_KEY), 'RS256');
				const { payload } = await jwtVerify(jwtToken, publicKey);
				userId = payload.id;
				if (!userId) return new Response('No user id in token', { status: 400 });
			} catch (e) {
				return new Response('Invalid token', { status: 401 });
			}
			// Agora token generation
			const AGORA_APP_ID = env.AGORA_APP_ID;
			const AGORA_APP_CERTIFICATE = env.AGORA_APP_CERTIFICATE;
			const channelName = String(userId);
			const uid = String(userId);
			const expireInSeconds = 3600; // 1 hour
			const agoraRole = roleStr === 'publisher' ? 1 : 2;

			// Minimal AccessToken2 implementation for Cloudflare Workers
			async function hmacSign(key, message) {
				const enc = new TextEncoder();
				const cryptoKey = await crypto.subtle.importKey(
					'raw',
					enc.encode(key),
					{ name: 'HMAC', hash: 'SHA-256' },
					false,
					['sign']
				);
				return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message)));
			}

			function base64UrlEncode(bytes) {
				return btoa(String.fromCharCode(...bytes))
					.replace(/\+/g, '-')
					.replace(/\//g, '_')
					.replace(/=+$/, '');
			}

			function packUint32(num) {
				return [
					(num >>> 24) & 0xff,
					(num >>> 16) & 0xff,
					(num >>> 8) & 0xff,
					num & 0xff,
				];
			}

			// Build minimal token (not all privileges, but enough for RTC join)
			const ts = Math.floor(Date.now() / 1000);
			const salt = Math.floor(Math.random() * 0xffffffff);
			const message = AGORA_APP_ID + channelName + uid + ts + salt + expireInSeconds + agoraRole;
			const sign = await hmacSign(AGORA_APP_CERTIFICATE, message);
			const tokenPayload = [
				...Array.from(new TextEncoder().encode(AGORA_APP_ID)),
				...Array.from(new TextEncoder().encode(channelName)),
				...Array.from(new TextEncoder().encode(uid)),
				...packUint32(ts),
				...packUint32(salt),
				...packUint32(expireInSeconds),
				agoraRole,
				...sign,
			];
			const token = base64UrlEncode(new Uint8Array(tokenPayload));
			return new Response(JSON.stringify({ token }), { headers: { 'Content-Type': 'application/json' } });
		} else {
			return new Response('Not Found', { status: 404 });
		}
	},
};
