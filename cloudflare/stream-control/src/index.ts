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
	// sessions: Map<WebSocket, 'publisher' | 'subscriber' | null> = new Map();

	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		console.log(`[${ctx.id.toString()}] StreamRoom Durable Object created.`);
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
		
		try {
			const { importJWK } = await import('jose');
			const publicKeyObj = await importJWK(JSON.parse(publicKey), 'RS256');
			const { payload } = await jwtVerify(token, publicKeyObj);
			console.log(`[${this.ctx.id.toString()}] JWT verification successful. Payload: ${JSON.stringify(payload)}`);
			return payload;
		} catch (err) {
			console.error(`[${this.ctx.id.toString()}] JWT verification failed: ${(err as Error).message}`);
			throw err;
		}
	}

	// Handle WebSocket upgrade and room logic
	async fetch(request: Request): Promise<Response> {
		console.log(`[${this.ctx.id.toString()}] fetch() called for path: ${new URL(request.url).pathname}`);
		// Only handle WebSocket upgrade requests
		if (request.headers.get("Upgrade") !== "websocket") {
			console.log(`[${this.ctx.id.toString()}] Request is not a WebSocket upgrade request.`);
			return new Response("Expected WebSocket", { status: 426 });
		}
		// Extract and verify JWT from Authorization header
		let payload;
		try {
			if (!this.env.JWT_PUBLIC_KEY) {
				throw new Error("JWT_PUBLIC_KEY is not set.");
			}
			payload = await this.verifyJWT(request, this.env.JWT_PUBLIC_KEY);
		} catch (err) {
			console.error(`[${this.ctx.id.toString()}] Unauthorized access attempt: ${(err as Error).message}`);
			return new Response("Unauthorized: " + (err as Error).message, { status: 401 });
		}
		const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
		// Enable hibernation for this WebSocket connection
		this.ctx.acceptWebSocket(serverSocket);
		// Add to sessions map, but without a role yet
		// this.sessions.set(serverSocket, null);
		serverSocket.serializeAttachment({ role: null });
		console.log(`[${this.ctx.id.toString()}] WebSocket accepted. Total sessions: ${this.ctx.getWebSockets().length}`);

		return new Response(null, { status: 101, webSocket: clientSocket });
	}

	// Handle WebSocket messages
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			console.log(`[${this.ctx.id.toString()}] Received message: ${message}`);
			if (typeof message !== 'string') {
				throw new Error('Message must be a string');
			}

			const data = JSON.parse(message);
			if (data.type === 'role' && (data.role === 'publisher' || data.role === 'subscriber')) {
				console.log(`[${this.ctx.id.toString()}] Role message received: ${data.role}`);
				this.handleRoleAssignment(ws, data.role);
			} else {
				throw new Error('Received unknown message type or role');
			}
		} catch (e) {
			const errorMessage = (e as Error).message;
			console.error(`[${this.ctx.id.toString()}] Error processing message: ${errorMessage}`);
			ws.send(JSON.stringify({ type: 'error', message: errorMessage }));
		}
	}

	// Handle WebSocket closure
	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		const userData = (ws.deserializeAttachment() as { role: 'publisher' | 'subscriber' | null }) || {};
		const role = userData.role;
		console.log(
			`[${this.ctx.id.toString()}] WebSocket with role '${
				role ?? 'unassigned'
			}' closed. Code: ${code}, Reason: ${reason}, WasClean: ${wasClean}. Total sessions: ${this.ctx.getWebSockets().length}`
		);
		this.broadcastState();
	}

	// Handle WebSocket errors
	webSocketError(ws: WebSocket, error: any) {
		const userData = (ws.deserializeAttachment() as { role: 'publisher' | 'subscriber' | null }) || {};
		const role = userData.role;
		console.error(`[${this.ctx.id.toString()}] WebSocket error for role '${role ?? 'unassigned'}':`, error);
	}

	handleRoleAssignment(socket: WebSocket, role: 'publisher' | 'subscriber') {
		console.log(`[${this.ctx.id.toString()}] Handling role assignment for role: ${role}`);
		// Prevent multiple publishers
		if (role === 'publisher') {
			for (const ws of this.ctx.getWebSockets()) {
				const userData = (ws.deserializeAttachment() as { role: 'publisher' | 'subscriber' | null }) || {};
				if (userData.role === 'publisher' && ws !== socket) {
					console.warn(`[${this.ctx.id.toString()}] Publisher role conflict. Closing new connection.`);
					socket.send(JSON.stringify({ type: 'error', message: 'Publisher already exists' }));
					socket.close(4000, 'Publisher already exists');
					return;
				}
			}
		}
		const userData = (socket.deserializeAttachment() as object) || {};
		socket.serializeAttachment({ ...userData, role: role });
		console.log(`[${this.ctx.id.toString()}] Role '${role}' assigned. Total sessions: ${this.ctx.getWebSockets().length}`);
		this.broadcastState();
	}

	broadcastState() {
		const sockets = this.ctx.getWebSockets();
		let publisher: WebSocket | null = null;
		let subscriberCount = 0;
		for (const ws of sockets) {
			const userData = (ws.deserializeAttachment() as { role: 'publisher' | 'subscriber' | null }) || {};
			if (userData.role === 'publisher') {
				publisher = ws;
			} else if (userData.role === 'subscriber') {
				subscriberCount++;
			}
		}

		console.log(
			`[${this.ctx.id.toString()}] Broadcasting state. Publisher: ${!!publisher}, Subscribers: ${subscriberCount}, total sockets: ${
				sockets.length
			}`
		);

		try {
			if (publisher) {
				if (subscriberCount > 0) {
					console.log(`[${this.ctx.id.toString()}] Sending 'start' to publisher.`);
					publisher.send(JSON.stringify({ type: 'control', action: 'start' }));
				} else {
					console.log(`[${this.ctx.id.toString()}] Sending 'pause' to publisher.`);
					publisher.send(JSON.stringify({ type: 'control', action: 'pause' }));
				}
			}
		} catch (error) {
			console.error(`[${this.ctx.id.toString()}] Error sending message to publisher: ${(error as Error).message}`);
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
		console.log(`[Worker] Received request for: ${url.pathname}`);
		// Expect path: /room/<roomId>
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "room" || !parts[1]) {
			console.error(`[Worker] Invalid path: ${url.pathname}`);
			return new Response("Missing or invalid roomId", { status: 400 });
		}
		const roomId = parts[1];
		console.log(`[Worker] Using roomId: ${roomId}`);
		// Route to the correct StreamRoom Durable Object instance
		const id: DurableObjectId = env.STREAM_ROOM.idFromName(roomId);
		const stub = env.STREAM_ROOM.get(id);
		console.log(`[Worker] Forwarding request to Durable Object with ID: ${id.toString()}`);
		// Forward the request (WebSocket upgrade) to the Durable Object
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// Update Env type to use JWT_PUBLIC_KEY
interface Env {
	STREAM_ROOM: DurableObjectNamespace;
	JWT_PUBLIC_KEY: string;
}
