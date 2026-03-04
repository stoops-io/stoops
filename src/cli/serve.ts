/**
 * stoops serve — dumb room server.
 *
 * One room, one HTTP API, SSE broadcasting, authority enforcement.
 * No EventProcessor, no tmux, no agent lifecycle — those live client-side.
 * Humans connect via `stoops join`, agents via `stoops run claude`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { Room } from "../core/room.js";
import { InMemoryStorage } from "../core/storage.js";
import { randomRoomName, randomName } from "../core/names.js";
import { createEvent, type ActivityEvent, type AuthorityChangedEvent, type ParticipantKickedEvent, type RoomEvent } from "../core/events.js";
import type { AuthorityLevel } from "../core/types.js";
import type { Channel } from "../core/channel.js";
import { formatTimestamp } from "../agent/prompts.js";
import { TokenManager, buildShareUrl } from "./auth.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectedParticipant {
  id: string;
  name: string;
  authority: AuthorityLevel;
  channel: Channel;
  sessionToken: string;
}

interface ConnectedGuest {
  id: string;
  authority: "guest";
  channel: Channel;
  sessionToken: string;
}

export interface ServeOptions {
  room?: string;
  port?: number;
  share?: boolean;
  quiet?: boolean;
  /** Suppress all human-readable output; emit one JSON line with server info on stdout. */
  headless?: boolean;
}

export interface ServeResult {
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
}

// ── SSE helper ───────────────────────────────────────────────────────────────

async function enrichAndSend(res: ServerResponse, event: RoomEvent, room: Room): Promise<void> {
  if (event.type === "MessageSent" && event.message.reply_to_id) {
    const replyMsg = await room.getMessage(event.message.reply_to_id);
    const enriched = {
      ...event,
      _replyToName: replyMsg?.sender_name ?? null,
    };
    res.write(`data: ${JSON.stringify(enriched)}\n\n`);
    return;
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Main serve command ───────────────────────────────────────────────────────

export async function serve(options: ServeOptions): Promise<ServeResult> {
  const roomName = options.room ?? randomRoomName();
  const port = options.port ?? 7890;
  const serverUrl = `http://127.0.0.1:${port}`;
  const log = options.headless ? () => {} : logServer;

  let publicUrl = serverUrl;
  let tunnelProcess: ChildProcess | null = null;

  // Create room
  const storage = new InMemoryStorage();
  const room = new Room(roomName, storage);

  // Auth
  const tokens = new TokenManager();

  // Connected participants and guests (by session token for lookup)
  const participants = new Map<string, ConnectedParticipant>();
  const guests = new Map<string, ConnectedGuest>();
  // Reverse lookup: participantId → sessionToken
  const idToSession = new Map<string, string>();

  // Track active SSE connections for cleanup
  const sseConnections = new Map<string, ServerResponse>();

  // ── JSON body parser helper ──────────────────────────────────────────────

  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
  }

  // ── Auth helper ──────────────────────────────────────────────────────────

  function getSession(token: string | null) {
    if (!token) return null;
    const p = participants.get(token);
    if (p) return { ...p, kind: "participant" as const };
    const g = guests.get(token);
    if (g) return { ...g, kind: "guest" as const };
    return null;
  }

  function jsonError(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  }

  function jsonOk(res: ServerResponse, data: Record<string, unknown> = {}): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...data }));
  }

  // ── HTTP API ────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // ── SSE event stream ───────────────────────────────────────────────────
    // ⚠️  MUST accept POST — DO NOT change to GET-only.
    // Cloudflare Quick Tunnels buffer GET streaming responses and only flush
    // when the connection closes. POST streams in real-time. (cloudflared#1449)
    // https://github.com/cloudflare/cloudflared/issues/1449
    if (url.pathname === "/events" && (req.method === "GET" || req.method === "POST")) {
      const authHeader = req.headers.authorization;
      const sessionToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      const session = getSession(sessionToken);

      if (!session) {
        jsonError(res, 401, "Invalid session token");
        return;
      }

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();

      // Disable Nagle's algorithm so SSE events flush immediately.
      // Without this, small writes may be delayed up to ~200ms waiting
      // for more data, which can cause events to appear "stuck" until
      // the next event (e.g. a MentionedEvent) pushes the buffer.
      res.socket?.setNoDelay(true);

      sseConnections.set(session.id, res);

      // Send recent history so the joiner has context
      const history = await room.listEvents(undefined, 50);
      for (const event of [...history.items].reverse()) {
        await enrichAndSend(res, event, room);
      }

      // Live event stream
      const streamEvents = async () => {
        try {
          for await (const event of session.channel) {
            await enrichAndSend(res, event, room);
          }
        } catch {
          // Channel disconnected
        }
      };
      streamEvents();

      // Cleanup on client disconnect
      req.on("close", () => {
        sseConnections.delete(session.id);
      });
      return;
    }

    // ── GET endpoints ─────────────────────────────────────────────────────

    if (req.method === "GET") {
      const sessionToken = url.searchParams.get("token");
      const session = getSession(sessionToken);

      // ── GET /participants ────────────────────────────────────────────────
      if (url.pathname === "/participants") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const list = room.listParticipants().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          authority: p.authority ?? "member",
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ participants: list }));
        return;
      }

      // ── GET /message/:id ─────────────────────────────────────────────────
      if (url.pathname.startsWith("/message/")) {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const messageId = url.pathname.slice("/message/".length);
        const msg = await room.getMessage(messageId);
        if (!msg) return jsonError(res, 404, "Message not found");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: msg }));
        return;
      }

      // ── GET /messages ────────────────────────────────────────────────────
      if (url.pathname === "/messages") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const count = parseInt(url.searchParams.get("count") ?? "30", 10);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.listMessages(count, cursor);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // ── GET /events/history ──────────────────────────────────────────────
      if (url.pathname === "/events/history") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const category = url.searchParams.get("category") ?? null;
        const count = parseInt(url.searchParams.get("count") ?? "50", 10);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.listEvents(category as any, count, cursor);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // ── GET /search ──────────────────────────────────────────────────────
      if (url.pathname === "/search") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const query = url.searchParams.get("query") ?? "";
        if (!query) return jsonError(res, 400, "Missing query parameter");
        const count = parseInt(url.searchParams.get("count") ?? "10", 10);
        const cursor = url.searchParams.get("cursor") ?? null;
        const result = await room.searchMessages(query, count, cursor);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
    }

    // ── POST endpoints ────────────────────────────────────────────────────

    if (req.method === "POST") {
      const body = await parseBody(req);

      // ── POST /join ──────────────────────────────────────────────────────
      if (url.pathname === "/join") {
        // Accept share token OR legacy type-based join
        const shareToken = String(body.token ?? "");
        const legacyType = String(body.type ?? "");

        let authority: AuthorityLevel;

        if (shareToken) {
          const tokenAuthority = tokens.validateShareToken(shareToken);
          if (!tokenAuthority) return jsonError(res, 403, "Invalid share token");
          authority = tokenAuthority;
        } else if (legacyType === "guest") {
          authority = "guest";
        } else if (legacyType === "human") {
          authority = "member";
        } else {
          // Default: agent joins as member
          authority = "member";
        }

        const participantType = String(body.type ?? "human") as "human" | "agent";
        const name = String(body.name ?? randomName());

        if (authority === "guest") {
          const id = `obs_${randomUUID().slice(0, 8)}`;
          const channel = room.observe();
          const sessionToken = tokens.createSessionToken(id, "guest");

          guests.set(sessionToken, { id, authority: "guest", channel, sessionToken });
          idToSession.set(id, sessionToken);

          const participantList = room.listParticipants().map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            authority: p.authority ?? "member",
          }));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sessionToken,
            participantId: id,
            roomName,
            roomId: room.roomId,
            participants: participantList,
            authority: "guest",
          }));
          return;
        }

        // admin or participant — connect as a real participant
        const id = `${participantType}_${randomUUID().slice(0, 8)}`;
        const channel = await room.connect(id, name, { type: participantType, authority });
        const sessionToken = tokens.createSessionToken(id, authority);

        participants.set(sessionToken, { id, name, authority, channel, sessionToken });
        idToSession.set(id, sessionToken);

        const participantList = room.listParticipants().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          authority: p.authority ?? "member",
        }));

        log(`${name} joined (${authority})`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessionToken,
          participantId: id,
          roomName,
          roomId: room.roomId,
          participants: participantList,
          authority,
        }));
        return;
      }

      // ── All remaining POST endpoints require a session token ────────────

      const sessionToken = String(body.token ?? "");
      const session = getSession(sessionToken);

      // ── POST /message ───────────────────────────────────────────────────
      if (url.pathname === "/message") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot send messages");
        const content = String(body.content ?? "");
        const replyTo = body.replyTo ? String(body.replyTo) : undefined;
        if (!content) return jsonError(res, 400, "Empty message");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        const msg = await p.channel.sendMessage(content, replyTo);
        jsonOk(res, { messageId: msg.id });
        return;
      }

      // ── POST /event ─────────────────────────────────────────────────────
      if (url.pathname === "/event") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot emit events");
        const event = body.event as RoomEvent | undefined;
        if (!event) return jsonError(res, 400, "Missing event");

        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        await p.channel.emit(event);
        jsonOk(res);
        return;
      }

      // ── POST /set-mode ──────────────────────────────────────────────────
      if (url.pathname === "/set-mode") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        const targetId = body.participantId ? String(body.participantId) : session.id;
        const mode = String(body.mode ?? "");
        if (!mode) return jsonError(res, 400, "Missing mode");

        // Setting someone else's mode requires admin
        if (targetId !== session.id && session.authority !== "admin") {
          return jsonError(res, 403, "Only admins can change other participants' modes");
        }

        // Emit mode_changed activity event
        const p = participants.get(sessionToken);
        if (!p) return jsonError(res, 403, "Not a participant");

        await p.channel.emit(createEvent<ActivityEvent>({
          type: "Activity",
          category: "ACTIVITY",
          room_id: room.roomId,
          participant_id: targetId,
          action: "mode_changed",
          detail: { mode },
        }));

        jsonOk(res);
        return;
      }

      // ── POST /set-authority ──────────────────────────────────────────────
      if (url.pathname === "/set-authority") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority !== "admin") return jsonError(res, 403, "Only admins can change authority");
        const targetId = String(body.participantId ?? "");
        const newAuthority = String(body.authority ?? "") as AuthorityLevel;
        if (!targetId) return jsonError(res, 400, "Missing participantId");
        if (!["admin", "member", "guest"].includes(newAuthority)) {
          return jsonError(res, 400, "Invalid authority. Must be admin, member, or guest.");
        }
        if (targetId === session.id) return jsonError(res, 400, "Cannot change own authority");

        // Update all three places: ConnectedParticipant, TokenManager session, Room participant
        const targetSession = idToSession.get(targetId);
        if (!targetSession) return jsonError(res, 404, "Participant not found");
        const target = participants.get(targetSession);
        if (!target) return jsonError(res, 404, "Participant not found");

        target.authority = newAuthority;
        tokens.updateSessionAuthority(targetSession, newAuthority);
        room.setParticipantAuthority(targetId, newAuthority);

        // Emit AuthorityChanged event
        const adminP = participants.get(sessionToken);
        const targetParticipant = room.listParticipants().find(p => p.id === targetId);
        if (adminP && targetParticipant) {
          await adminP.channel.emit(createEvent<AuthorityChangedEvent>({
            type: "AuthorityChanged",
            category: "PRESENCE",
            room_id: room.roomId,
            participant_id: targetId,
            participant: targetParticipant,
            new_authority: newAuthority,
            changed_by: adminP.name,
          }));
        }

        log(`${target.name} authority → ${newAuthority}`);
        jsonOk(res);
        return;
      }

      // ── POST /kick ──────────────────────────────────────────────────────
      if (url.pathname === "/kick") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority !== "admin") return jsonError(res, 403, "Only admins can kick");
        const targetId = String(body.participantId ?? "");
        if (!targetId) return jsonError(res, 400, "Missing participantId");

        // Find and disconnect the target
        const targetSession = idToSession.get(targetId);
        if (targetSession) {
          const target = participants.get(targetSession) ?? guests.get(targetSession);
          if (target) {
            // Emit ParticipantKicked before disconnect so all participants see it
            const adminP = participants.get(sessionToken);
            const targetParticipant = room.listParticipants().find(p => p.id === targetId);
            if (adminP && targetParticipant) {
              await adminP.channel.emit(createEvent<ParticipantKickedEvent>({
                type: "ParticipantKicked",
                category: "PRESENCE",
                room_id: room.roomId,
                participant_id: targetId,
                participant: targetParticipant,
                kicked_by: adminP.name,
              }));
            }
            // Silent disconnect — the kicked event replaces ParticipantLeft
            await target.channel.disconnect(true);
            participants.delete(targetSession);
            guests.delete(targetSession);
            idToSession.delete(targetId);
            tokens.revokeSessionToken(targetSession);
            // Close SSE connection
            const sse = sseConnections.get(targetId);
            if (sse) {
              sse.end();
              sseConnections.delete(targetId);
            }
            log(`kicked ${targetId}`);
          }
        }

        jsonOk(res);
        return;
      }

      // ── POST /share ─────────────────────────────────────────────────────
      if (url.pathname === "/share") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority === "guest") return jsonError(res, 403, "Guests cannot create share links");

        const targetAuthority = (body.authority as AuthorityLevel) ?? undefined;

        const links: Record<string, string> = {};

        if (targetAuthority) {
          // Generate a specific link
          const token = tokens.generateShareToken(session.authority, targetAuthority);
          if (!token) return jsonError(res, 403, `Cannot generate ${targetAuthority} link`);
          links[targetAuthority] = buildShareUrl(publicUrl, token);
        } else {
          // Generate all links the caller can create
          const tiers: AuthorityLevel[] = ["admin", "member", "guest"];
          for (const tier of tiers) {
            const token = tokens.generateShareToken(session.authority, tier);
            if (token) links[tier] = buildShareUrl(publicUrl, token);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ links }));
        return;
      }

      // ── POST /disconnect ────────────────────────────────────────────────
      if (url.pathname === "/disconnect") {
        // Accept either session token or legacy participantId/agentId
        const token = String(body.token ?? "");
        const legacyId = String(body.participantId ?? body.agentId ?? "");

        let targetToken = token;
        if (!targetToken && legacyId) {
          targetToken = idToSession.get(legacyId) ?? "";
        }

        if (targetToken) {
          const p = participants.get(targetToken);
          if (p) {
            await p.channel.disconnect();
            participants.delete(targetToken);
            idToSession.delete(p.id);
            tokens.revokeSessionToken(targetToken);
            const sse = sseConnections.get(p.id);
            if (sse) { sse.end(); sseConnections.delete(p.id); }
            log(`${p.name} disconnected`);
          }

          const g = guests.get(targetToken);
          if (g) {
            await g.channel.disconnect();
            guests.delete(targetToken);
            idToSession.delete(g.id);
            tokens.revokeSessionToken(targetToken);
            const sse = sseConnections.get(g.id);
            if (sse) { sse.end(); sseConnections.delete(g.id); }
          }
        }

        jsonOk(res);
        return;
      }
    }

    res.writeHead(404).end("Not found");
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Another stoops instance may be running.`);
      console.error(`  Kill it:   lsof -ti :${port} | xargs kill`);
      console.error(`  Or use:    stoops --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, "0.0.0.0", () => resolve());
  });

  // Start tunnel if --share
  if (options.share) {
    tunnelProcess = await startTunnel(port);
    if (tunnelProcess) {
      const tunnelUrl = await waitForTunnelUrl(tunnelProcess);
      if (tunnelUrl) publicUrl = tunnelUrl;
    }
  }

  // Generate share tokens on boot
  const adminToken = tokens.generateShareToken("admin", "admin")!;
  const memberToken = tokens.generateShareToken("admin", "member")!;

  if (options.headless) {
    process.stdout.write(JSON.stringify({ serverUrl, publicUrl, roomName, adminToken, memberToken }) + "\n");
  } else if (!options.quiet) {
    let version = process.env.npm_package_version ?? "";
    if (!version) {
      try {
        const require = createRequire(import.meta.url);
        const pkg = require("../../package.json");
        version = pkg.version ?? "unknown";
      } catch {
        version = "unknown";
      }
    }
    const adminUrl = buildShareUrl(publicUrl, adminToken);
    const joinUrl = buildShareUrl(publicUrl, memberToken);

    console.log(`
  stoops v${version}

  Room:    ${roomName}
  Server:  ${serverUrl}${publicUrl !== serverUrl ? `\n  Tunnel:  ${publicUrl}` : ""}

  Join:      stoops join ${joinUrl}
  Admin:     stoops join ${adminUrl}
  Claude:    stoops run claude  →  then tell agent to join: ${joinUrl}
`);
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async () => {
    log("shutting down...");
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    for (const [id, sse] of sseConnections) { sse.end(); sseConnections.delete(id); }
    for (const p of participants.values()) { await p.channel.disconnect().catch(() => {}); }
    for (const g of guests.values()) { await g.channel.disconnect().catch(() => {}); }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { serverUrl, publicUrl, roomName, adminToken, memberToken };
}

// ── Server log ────────────────────────────────────────────────────────────────

function logServer(message: string): void {
  console.log(`  [${formatTimestamp(new Date())}] ${message}`);
}

// ── Cloudflared tunnel ───────────────────────────────────────────────────────

function cloudflaredAvailable(): boolean {
  try {
    execFileSync("which", ["cloudflared"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function startTunnel(port: number): Promise<ChildProcess | null> {
  if (!cloudflaredAvailable()) {
    console.error("  --share requires cloudflared. Install: brew install cloudflared");
    return null;
  }

  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.on("error", () => {
    // cloudflared failed to start
  });

  return child;
}

function waitForTunnelUrl(child: ChildProcess, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    });

    child.on("exit", () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
    });
  });
}
