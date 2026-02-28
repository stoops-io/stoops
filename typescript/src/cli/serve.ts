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

import { Room } from "../core/room.js";
import { InMemoryStorage } from "../core/storage.js";
import { randomRoomName, randomName } from "../core/names.js";
import { createEvent, type ActivityEvent, type RoomEvent } from "../core/events.js";
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

interface ConnectedObserver {
  id: string;
  authority: "observer";
  channel: Channel;
  sessionToken: string;
}

export interface ServeOptions {
  room?: string;
  port?: number;
  share?: boolean;
  quiet?: boolean;
}

export interface ServeResult {
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  participantToken: string;
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

  let publicUrl = serverUrl;
  let tunnelProcess: ChildProcess | null = null;

  // Create room
  const storage = new InMemoryStorage();
  const room = new Room(roomName, storage);

  // Auth
  const tokens = new TokenManager();

  // Connected participants and observers (by session token for lookup)
  const participants = new Map<string, ConnectedParticipant>();
  const observers = new Map<string, ConnectedObserver>();
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
    const o = observers.get(token);
    if (o) return { ...o, kind: "observer" as const };
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
      const sessionToken = url.searchParams.get("token");
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
          authority: p.authority ?? "participant",
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
          authority = "observer";
        } else if (legacyType === "human") {
          authority = "participant";
        } else {
          // Default: agent joins as participant
          authority = "participant";
        }

        const participantType = String(body.type ?? "human") as "human" | "agent";
        const name = String(body.name ?? randomName());

        if (authority === "observer") {
          const id = `obs_${randomUUID().slice(0, 8)}`;
          const channel = room.observe();
          const sessionToken = tokens.createSessionToken(id, "observer");

          observers.set(sessionToken, { id, authority: "observer", channel, sessionToken });
          idToSession.set(id, sessionToken);

          const participantList = room.listParticipants().map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            authority: p.authority ?? "participant",
          }));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sessionToken,
            participantId: id,
            roomName,
            roomId: room.roomId,
            participants: participantList,
            authority: "observer",
          }));
          return;
        }

        // admin or participant — connect as a real participant
        const id = `${participantType}_${randomUUID().slice(0, 8)}`;
        const channel = await room.connect(id, name, participantType, undefined, undefined, false, authority);
        const sessionToken = tokens.createSessionToken(id, authority);

        participants.set(sessionToken, { id, name, authority, channel, sessionToken });
        idToSession.set(id, sessionToken);

        const participantList = room.listParticipants().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          authority: p.authority ?? "participant",
        }));

        logServer(`${name} joined (${authority})`);

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
        if (session.authority === "observer") return jsonError(res, 403, "Observers cannot send messages");
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
        if (session.authority === "observer") return jsonError(res, 403, "Observers cannot emit events");
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

      // ── POST /kick ──────────────────────────────────────────────────────
      if (url.pathname === "/kick") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority !== "admin") return jsonError(res, 403, "Only admins can kick");
        const targetId = String(body.participantId ?? "");
        if (!targetId) return jsonError(res, 400, "Missing participantId");

        // Find and disconnect the target
        const targetSession = idToSession.get(targetId);
        if (targetSession) {
          const target = participants.get(targetSession) ?? observers.get(targetSession);
          if (target) {
            await target.channel.disconnect();
            participants.delete(targetSession);
            observers.delete(targetSession);
            idToSession.delete(targetId);
            tokens.revokeSessionToken(targetSession);
            // Close SSE connection
            const sse = sseConnections.get(targetId);
            if (sse) {
              sse.end();
              sseConnections.delete(targetId);
            }
            logServer(`kicked ${targetId}`);
          }
        }

        jsonOk(res);
        return;
      }

      // ── POST /share ─────────────────────────────────────────────────────
      if (url.pathname === "/share") {
        if (!session) return jsonError(res, 401, "Invalid session token");
        if (session.authority === "observer") return jsonError(res, 403, "Observers cannot create share links");

        const targetAuthority = (body.authority as AuthorityLevel) ?? undefined;

        const links: Record<string, string> = {};

        if (targetAuthority) {
          // Generate a specific link
          const token = tokens.generateShareToken(session.authority, targetAuthority);
          if (!token) return jsonError(res, 403, `Cannot generate ${targetAuthority} link`);
          links[targetAuthority] = buildShareUrl(publicUrl, token);
        } else {
          // Generate all links the caller can create
          const tiers: AuthorityLevel[] = ["admin", "participant", "observer"];
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
            logServer(`${p.name} disconnected`);
          }

          const o = observers.get(targetToken);
          if (o) {
            await o.channel.disconnect();
            observers.delete(targetToken);
            idToSession.delete(o.id);
            tokens.revokeSessionToken(targetToken);
            const sse = sseConnections.get(o.id);
            if (sse) { sse.end(); sseConnections.delete(o.id); }
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
  const participantToken = tokens.generateShareToken("admin", "participant")!;

  if (!options.quiet) {
    const version = process.env.npm_package_version ?? "0.3.0";
    const adminUrl = buildShareUrl(publicUrl, adminToken);
    const joinUrl = buildShareUrl(publicUrl, participantToken);

    console.log(`
  stoops v${version}

  Room:    ${roomName}
  Server:  ${serverUrl}${publicUrl !== serverUrl ? `\n  Tunnel:  ${publicUrl}` : ""}

  Admin:   stoops join ${adminUrl}
  Join:    stoops join ${joinUrl}
  Agent:   stoops run claude --join ${joinUrl}
  Agent:   stoops run opencode --join ${joinUrl}
`);
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async () => {
    logServer("shutting down...");
    if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
    for (const [id, sse] of sseConnections) { sse.end(); sseConnections.delete(id); }
    for (const p of participants.values()) { await p.channel.disconnect().catch(() => {}); }
    for (const o of observers.values()) { await o.channel.disconnect().catch(() => {}); }
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { serverUrl, publicUrl, roomName, adminToken, participantToken };
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
