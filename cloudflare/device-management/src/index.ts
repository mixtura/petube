import { DurableObject } from "cloudflare:workers";
import { jwtVerify } from "jose";

/**
 * DeviceManager Durable Object handles device registration and exclusive pairing groups
 * Each device can only be in one pairing group at a time
 * Groups can contain devices from different accounts (cross-account sharing)
 * 
 * Now uses SQLite for better performance and relational queries
 */

// Data interfaces
interface Device {
	device_id: string;
	device_name: string;
	owner_id: string;
	current_group_id: string | null; // Exclusive membership - only one group per device
	device_type: 'ios' | 'web';
	created_at: number;
	last_seen: number;
	is_active: boolean;
	device_identifier?: string; // Optional for backward compatibility
}

interface PairingGroup {
	group_id: string;
	group_name: string;
	device_ids: string[]; // All devices currently in this group
	created_by: string;
	created_at: number;
}

interface PairingSession {
	session_id: string;
	group_id: string;
	created_by: string;
	expires_at: number;
	qr_code_data: string;
}

interface PairingInvite {
	session_id: string;
	group_id: string;
	group_name: string;
	inviter_name: string;
}

export class DeviceManager extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.initializeSchema();
		console.log(`[DeviceManager] SQLite-backed Durable Object created`);
	}

	// Initialize SQLite schema
	private initializeSchema(): void {
		// Create devices table
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS devices (
				device_id TEXT PRIMARY KEY,
				device_name TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				current_group_id TEXT,
				device_type TEXT NOT NULL CHECK (device_type IN ('ios', 'web')),
				created_at INTEGER NOT NULL,
				last_seen INTEGER NOT NULL,
				is_active BOOLEAN NOT NULL DEFAULT TRUE,
				device_identifier TEXT, -- For persistent device identification across app reinstalls
				FOREIGN KEY (current_group_id) REFERENCES pairing_groups(group_id) ON DELETE SET NULL
			)
		`);

		// Create pairing groups table
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS pairing_groups (
				group_id TEXT PRIMARY KEY,
				group_name TEXT NOT NULL,
				created_by TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);

		// Create pairing sessions table
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS pairing_sessions (
				session_id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				created_by TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				qr_code_data TEXT NOT NULL,
				FOREIGN KEY (group_id) REFERENCES pairing_groups(group_id) ON DELETE CASCADE
			)
		`);

		// Create indexes for better query performance
		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_devices_owner_id ON devices(owner_id)`);
		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_devices_current_group_id ON devices(current_group_id)`);
		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_devices_identifier ON devices(device_identifier)`);
		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires_at ON pairing_sessions(expires_at)`);
		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_pairing_sessions_group_id ON pairing_sessions(group_id)`);

		console.log(`[DeviceManager] SQLite schema initialized`);
	}

	// Helper to verify JWT and extract user info
	async verifyJWT(request: Request): Promise<any> {
		const authHeader = request.headers.get("Authorization");
		if (!authHeader || !authHeader.startsWith("Bearer ")) {
			throw new Error("Missing or invalid authorization header");
		}

		const token = authHeader.slice(7);
		if (!this.env.JWT_PUBLIC_KEY) {
			throw new Error("JWT_PUBLIC_KEY is not configured");
		}

		try {
			const { importJWK } = await import('jose');
			const publicKeyObj = await importJWK(JSON.parse(this.env.JWT_PUBLIC_KEY), 'RS256');
			const { payload } = await jwtVerify(token, publicKeyObj);
			return payload;
		} catch (err) {
			console.error(`[DeviceManager] JWT verification failed: ${(err as Error).message}`);
			throw new Error("Invalid token");
		}
	}

	// Helper to verify device ownership
	private async verifyDeviceOwnership(device_id: string, user_id: string): Promise<Device> {
		const deviceResult = this.sql.exec(`
			SELECT device_id, device_name, owner_id, current_group_id, device_type, created_at, last_seen, is_active, device_identifier
			FROM devices 
			WHERE device_id = ? AND owner_id = ?
		`, device_id, user_id).one();

		if (!deviceResult) {
			throw new Error("Device not found or not owned by user");
		}

		return {
			device_id: deviceResult.device_id as string,
			device_name: deviceResult.device_name as string,
			owner_id: deviceResult.owner_id as string,
			current_group_id: deviceResult.current_group_id as string | null,
			device_type: deviceResult.device_type as 'ios' | 'web',
			created_at: deviceResult.created_at as number,
			last_seen: deviceResult.last_seen as number,
			is_active: Boolean(deviceResult.is_active),
			device_identifier: deviceResult.device_identifier as string | undefined
		};
	}

	// Register device on login - handles device identity persistence across app reinstalls
	async registerDevice(device_name: string, device_type: 'ios' | 'web', owner_id: string, device_identifier?: string): Promise<Device> {
		const now = Date.now();
		
		// If device_identifier is provided, check if this device was previously registered
		if (device_identifier) {
			const existingDevice = this.sql.exec(`
				SELECT device_id, device_name, owner_id, current_group_id, device_type, created_at, last_seen, is_active
				FROM devices 
				WHERE device_identifier = ? AND owner_id = ?
			`, device_identifier, owner_id).one();

			if (existingDevice) {
				// Reactivate existing device and update info
				this.sql.exec(`
					UPDATE devices 
					SET device_name = ?, last_seen = ?, is_active = true
					WHERE device_identifier = ? AND owner_id = ?
				`, device_name, now, device_identifier, owner_id);

				console.log(`[DeviceManager] Reactivated existing device: ${existingDevice.device_id} for user: ${owner_id}`);
				
				return {
					device_id: existingDevice.device_id as string,
					device_name: device_name, // Use updated name
					owner_id: existingDevice.owner_id as string,
					current_group_id: existingDevice.current_group_id as string | null,
					device_type: existingDevice.device_type as 'ios' | 'web',
					created_at: existingDevice.created_at as number,
					last_seen: now,
					is_active: true
				};
			}
		}

		// Create new device
		const device_id = crypto.randomUUID();
		const device: Device = {
			device_id,
			device_name,
			owner_id,
			current_group_id: null,
			device_type,
			created_at: now,
			last_seen: now,
			is_active: true
		};

		this.sql.exec(`
			INSERT INTO devices (device_id, device_name, owner_id, current_group_id, device_type, created_at, last_seen, is_active, device_identifier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, device_id, device_name, owner_id, null, device_type, now, now, true, device_identifier);

		console.log(`[DeviceManager] New device registered: ${device_id} for user: ${owner_id}`);
		return device;
	}

	// Get all devices owned by a user
	async getUserDevices(user_id: string): Promise<Device[]> {
		const results = this.sql.exec(`
			SELECT device_id, device_name, owner_id, current_group_id, device_type, created_at, last_seen, is_active, device_identifier
			FROM devices 
			WHERE owner_id = ? 
			ORDER BY last_seen DESC
		`, user_id);

		const devices: Device[] = [];
		for (const row of results) {
			devices.push({
				device_id: row.device_id as string,
				device_name: row.device_name as string,
				owner_id: row.owner_id as string,
				current_group_id: row.current_group_id as string | null,
				device_type: row.device_type as 'ios' | 'web',
				created_at: row.created_at as number,
				last_seen: row.last_seen as number,
				is_active: Boolean(row.is_active),
				device_identifier: row.device_identifier as string | undefined
			});
		}

		return devices;
	}

	// Generate QR code for pairing (automatically creates group if device isn't in one)
	async generatePairingQR(device_id: string, user_id: string): Promise<PairingInvite> {
		// Verify device ownership
		const device = await this.verifyDeviceOwnership(device_id, user_id);

		let group_id = device.current_group_id;
		let group_name: string;

		// If device is not in a group, create one automatically
		if (!group_id) {
			group_id = crypto.randomUUID();
			group_name = `${device.device_name}'s Group`;
			const now = Date.now();

			// Insert new group
			this.sql.exec(`
				INSERT INTO pairing_groups (group_id, group_name, created_by, created_at)
				VALUES (?, ?, ?, ?)
			`, group_id, group_name, user_id, now);

			// Update device's current group
			this.sql.exec(`
				UPDATE devices 
				SET current_group_id = ?, last_seen = ? 
				WHERE device_id = ?
			`, group_id, now, device_id);

			console.log(`[DeviceManager] Auto-created pairing group: ${group_id} for device: ${device_id}`);
		} else {
			// Get existing group info
			const groupResult = this.sql.exec(`
				SELECT group_name FROM pairing_groups WHERE group_id = ?
			`, group_id).one();
			
			if (!groupResult) {
				throw new Error("Device's pairing group not found");
			}
			group_name = groupResult.group_name as string;
		}

		const session_id = crypto.randomUUID();
		const expires_at = Date.now() + (10 * 60 * 1000); // 10 minutes
		const qr_code_data = JSON.stringify({ 
			session_id, 
			group_id, 
			group_name 
		});

		// Clean up expired sessions first
		this.sql.exec(`DELETE FROM pairing_sessions WHERE expires_at < ?`, Date.now());

		// Insert new session
		this.sql.exec(`
			INSERT INTO pairing_sessions (session_id, group_id, created_by, expires_at, qr_code_data)
			VALUES (?, ?, ?, ?, ?)
		`, session_id, group_id, user_id, expires_at, qr_code_data);

		console.log(`[DeviceManager] Pairing QR generated for group: ${group_id}`);

		return {
			session_id,
			group_id,
			group_name,
			inviter_name: device.device_name
		};
	}

	// Pair device via QR code scan
	async pairDevice(session_id: string, device_id: string, user_id: string): Promise<PairingGroup> {
		// Get session and verify it exists and is not expired
		const sessionResult = this.sql.exec(`
			SELECT session_id, group_id, created_by, expires_at, qr_code_data
			FROM pairing_sessions 
			WHERE session_id = ?
		`, session_id).one();

		if (!sessionResult) {
			throw new Error("Invalid or expired pairing session");
		}

		if (Date.now() > Number(sessionResult.expires_at)) {
			// Clean up expired session
			this.sql.exec(`DELETE FROM pairing_sessions WHERE session_id = ?`, session_id);
			throw new Error("Pairing session has expired");
		}

		// Get group info
		const groupResult = this.sql.exec(`
			SELECT group_id, group_name, created_by, created_at
			FROM pairing_groups 
			WHERE group_id = ?
		`, sessionResult.group_id).one();

		if (!groupResult) {
			throw new Error("Pairing group not found");
		}

		// Verify device ownership
		const device = await this.verifyDeviceOwnership(device_id, user_id);

		// Remove device from current group if it's in one
		await this.removeDeviceFromCurrentGroup(device_id);

		// Add device to new group
		const now = Date.now();
		this.sql.exec(`
			UPDATE devices 
			SET current_group_id = ?, last_seen = ? 
			WHERE device_id = ?
		`, groupResult.group_id, now, device_id);

		// Clean up session
		this.sql.exec(`DELETE FROM pairing_sessions WHERE session_id = ?`, session_id);

		// Get all devices in the group for the response
		const groupDevices = this.sql.exec(`
			SELECT device_id FROM devices WHERE current_group_id = ?
		`, groupResult.group_id);

		const device_ids: string[] = [];
		for (const row of groupDevices) {
			device_ids.push(row.device_id as string);
		}

		console.log(`[DeviceManager] Device ${device_id} (${device.device_name}) paired to group ${groupResult.group_id}`);
		
		return {
			group_id: groupResult.group_id as string,
			group_name: groupResult.group_name as string,
			device_ids,
			created_by: groupResult.created_by as string,
			created_at: groupResult.created_at as number
		};
	}

	// Leave current pairing group
	async leavePairingGroup(device_id: string, user_id: string): Promise<void> {
		// Verify device ownership
		await this.verifyDeviceOwnership(device_id, user_id);

		await this.removeDeviceFromCurrentGroup(device_id);
		console.log(`[DeviceManager] Device ${device_id} left pairing group`);
	}

	// Helper: Remove device from its current group
	private async removeDeviceFromCurrentGroup(device_id: string): Promise<void> {
		// Get current group for the device
		const deviceResult = this.sql.exec(`
			SELECT current_group_id FROM devices WHERE device_id = ?
		`, device_id).one();

		if (!deviceResult || !deviceResult.current_group_id) {
			return;
		}

		const current_group_id = deviceResult.current_group_id as string;

		// Remove device from group
		const now = Date.now();
		this.sql.exec(`
			UPDATE devices 
			SET current_group_id = NULL, last_seen = ? 
			WHERE device_id = ?
		`, now, device_id);

		// Check if group is now empty and delete if so
		const remainingDevices = this.sql.exec(`
			SELECT COUNT(*) as count FROM devices WHERE current_group_id = ?
		`, current_group_id).one();

		if (remainingDevices && remainingDevices.count === 0) {
			// Delete empty group and related sessions
			this.sql.exec(`DELETE FROM pairing_sessions WHERE group_id = ?`, current_group_id);
			this.sql.exec(`DELETE FROM pairing_groups WHERE group_id = ?`, current_group_id);
		}
	}

	// Get device's current active group and all devices in that group
	async getDeviceActiveGroup(device_id: string, user_id: string): Promise<{ group: PairingGroup | null, devices_in_group: Device[] }> {
		// Verify device ownership
		const device = await this.verifyDeviceOwnership(device_id, user_id);

		const current_group_id = device.current_group_id;

		// If device is not in a group, return empty result
		if (!current_group_id) {
			return { group: null, devices_in_group: [] };
		}

		// Get group info
		const groupResult = this.sql.exec(`
			SELECT group_id, group_name, created_by, created_at
			FROM pairing_groups 
			WHERE group_id = ?
		`, current_group_id).one();

		if (!groupResult) {
			return { group: null, devices_in_group: [] };
		}

		// Get ALL devices in the group (with full device info)
		const allGroupDevicesResults = this.sql.exec(`
			SELECT device_id, device_name, owner_id, current_group_id, device_type, created_at, last_seen, is_active, device_identifier
			FROM devices 
			WHERE current_group_id = ?
			ORDER BY last_seen DESC
		`, current_group_id);

		const devices_in_group: Device[] = [];
		const device_ids: string[] = [];

		for (const row of allGroupDevicesResults) {
			const device: Device = {
				device_id: row.device_id as string,
				device_name: row.device_name as string,
				owner_id: row.owner_id as string,
				current_group_id: row.current_group_id as string | null,
				device_type: row.device_type as 'ios' | 'web',
				created_at: row.created_at as number,
				last_seen: row.last_seen as number,
				is_active: Boolean(row.is_active),
				device_identifier: row.device_identifier as string | undefined
			};
			devices_in_group.push(device);
			device_ids.push(device.device_id);
		}

		const group: PairingGroup = {
			group_id: groupResult.group_id as string,
			group_name: groupResult.group_name as string,
			device_ids,
			created_by: groupResult.created_by as string,
			created_at: groupResult.created_at as number
		};

		return { group, devices_in_group };
	}

	// HTTP request handler
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS headers
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': '*',
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// Verify JWT for all requests
			const user = await this.verifyJWT(request);
			const user_id = user.id as string;
			const user_name = user.name as string;

			// Route handling
			if (path === '/devices/register' && request.method === 'POST') {
				const { device_name, device_type, device_identifier } = await request.json() as { 
					device_name: string; 
					device_type: 'ios' | 'web'; 
					device_identifier?: string 
				};
				const device = await this.registerDevice(device_name, device_type, user_id, device_identifier);
				return new Response(JSON.stringify(device), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

			} else if (path === '/devices/my' && request.method === 'GET') {
				const devices = await this.getUserDevices(user_id);
				return new Response(JSON.stringify(devices), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

			} else if (path === '/generate-qr' && request.method === 'POST') {
				const { device_id } = await request.json() as { device_id: string };
				const invite = await this.generatePairingQR(device_id, user_id);
				return new Response(JSON.stringify(invite), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

			} else if (path === '/pair-device' && request.method === 'POST') {
				const { session_id, device_id } = await request.json() as { session_id: string; device_id: string };
				const group = await this.pairDevice(session_id, device_id, user_id);
				return new Response(JSON.stringify(group), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

			} else if (path === '/leave-group' && request.method === 'POST') {
				const { device_id } = await request.json() as { device_id: string };
				await this.leavePairingGroup(device_id, user_id);
				return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

			} else if (path === '/my-group' && request.method === 'GET') {
				const device_id = url.searchParams.get('device_id');
				if (!device_id) {
					return new Response(JSON.stringify({ error: "device_id parameter is required" }), { 
						status: 400, 
						headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
					});
				}
				const result = await this.getDeviceActiveGroup(device_id, user_id);
				return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

			} else {
				return new Response('Not Found', { status: 404, headers: corsHeaders });
			}

		} catch (error) {
			console.error(`[DeviceManager] Error:`, error);
			return new Response(JSON.stringify({ error: (error as Error).message }), { 
				status: 400, 
				headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
			});
		}
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Single global DeviceManager instance to coordinate all devices
		const id: DurableObjectId = env.DEVICE_MANAGER.idFromName("global");
		const stub = env.DEVICE_MANAGER.get(id);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

interface Env {
	DEVICE_MANAGER: DurableObjectNamespace;
	JWT_PUBLIC_KEY: string;
}
