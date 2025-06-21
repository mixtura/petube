import { DurableObject } from "cloudflare:workers";
import { jwtVerify } from "jose";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

// StreamRoom Durable Object manages a streaming session (room)
export class StreamRoom extends DurableObject<Env> {
	// Use a Map to track the role of each hibernatable WebSocket.
	sessions: Map<WebSocket, 'publisher' | 'subscriber' | null> = new Map();

	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	// Helper to verify JWT
	async verifyJWT(request: Request, publicKey: string): Promise<any> {
		const url = new URL(request.url);
		const authHeader = request.headers.get("Authorization");
		let token;

		if (authHeader && authHeader.startsWith("Bearer ")) {
			token = authHeader.slice(7);
		} else {
			token = url.searchParams.get('token');
		}

		if (!token) {
			throw new Error("Missing or invalid token");
		}
		
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"spki",
			encoder.encode(publicKey),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"]
		);
		const { payload } = await jwtVerify(token, key);
		return payload;
	}

	// Handle WebSocket upgrade and room logic
	async fetch(request: Request): Promise<Response> {
		// Only handle WebSocket upgrade requests
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		// Extract and verify JWT from Authorization header
		let payload;
		try {
			payload = await this.verifyJWT(request, this.env.JWT_PUBLIC_KEY);
		} catch (err) {
			return new Response("Unauthorized: " + (err as Error).message, { status: 401 });
		}
		const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
		serverSocket.accept();
		// Enable hibernation for this WebSocket connection
		this.ctx.acceptWebSocket(serverSocket);
		// Add to sessions map, but without a role yet
		this.sessions.set(serverSocket, null);

		serverSocket.addEventListener('message', (event) => {
			try {
				if (typeof event.data !== 'string') {
					serverSocket.send(JSON.stringify({ type: 'error', message: 'Message must be a string' }));
					return;
				}
				const data = JSON.parse(event.data);
				if (data.type === 'role' && (data.role === 'publisher' || data.role === 'subscriber')) {
					this.handleRoleAssignment(serverSocket, data.role);
				}
			} catch (e) {
				serverSocket.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
			}
		});

		serverSocket.addEventListener('close', () => {
			this.sessions.delete(serverSocket);
			this.broadcastState();
		});

		return new Response(null, { status: 101, webSocket: clientSocket });
	}

	handleRoleAssignment(socket: WebSocket, role: 'publisher' | 'subscriber') {
		// Prevent multiple publishers
		if (role === 'publisher') {
			for (const [ws, r] of this.sessions.entries()) {
				if (r === 'publisher' && ws !== socket) {
					socket.send(JSON.stringify({ type: 'error', message: 'Publisher already exists' }));
					socket.close(4000, 'Publisher already exists');
					return;
				}
			}
		}
		this.sessions.set(socket, role);
		this.broadcastState();
	}

	broadcastState() {
		let publisher: WebSocket | null = null;
		let subscriberCount = 0;
		for (const [ws, role] of this.sessions.entries()) {
			if (role === 'publisher') {
				publisher = ws;
			} else if (role === 'subscriber') {
				subscriberCount++;
			}
		}

		if (publisher) {
			if (subscriberCount > 0) {
				publisher.send(JSON.stringify({ type: 'control', action: 'start' }));
			} else {
				publisher.send(JSON.stringify({ type: 'control', action: 'pause' }));
			}
		}
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		// Expect path: /room/<roomId>
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "room" || !parts[1]) {
			return new Response("Missing or invalid roomId", { status: 400 });
		}
		const roomId = parts[1];
		// Route to the correct StreamRoom Durable Object instance
		const id: DurableObjectId = env.STREAM_ROOM.idFromName(roomId);
		const stub = env.STREAM_ROOM.get(id);
		// Forward the request (WebSocket upgrade) to the Durable Object
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// Update Env type to use JWT_PUBLIC_KEY
interface Env {
	STREAM_ROOM: DurableObjectNamespace;
	JWT_PUBLIC_KEY: string;
}
