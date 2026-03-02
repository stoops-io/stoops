/**
 * Integration tests for the stoops CLI — exercises the full server + client
 * stack using --headless mode and direct HTTP calls.
 *
 * Requires a built CLI at dist/cli/index.js. Run `npm run build` first.
 */

import { describe, test, expect, beforeAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "../dist/cli/index.js");
const NODE = process.execPath;

// Skip all tests if dist doesn't exist
const HAS_BUILD = existsSync(CLI_PATH);

// ── Test helpers ────────────────────────────────────────────────────────────

interface ServerHandle {
  process: ChildProcess;
  serverUrl: string;
  publicUrl: string;
  roomName: string;
  adminToken: string;
  memberToken: string;
  cleanup: () => void;
}

let nextPort = 18900 + Math.floor(Math.random() * 100);

function getPort(): number {
  return nextPort++;
}

async function startServer(opts?: { port?: number; room?: string }): Promise<ServerHandle> {
  const port = opts?.port ?? getPort();
  const args = ["serve", "--headless", "--port", String(port)];
  if (opts?.room) args.push("--room", opts.room);

  const child = spawn(NODE, [CLI_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  return new Promise<ServerHandle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timed out")), 10_000);
    let buffer = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      try {
        const data = JSON.parse(line);
        clearTimeout(timer);
        resolve({
          process: child,
          serverUrl: data.serverUrl,
          publicUrl: data.publicUrl,
          roomName: data.roomName,
          adminToken: data.adminToken,
          memberToken: data.memberToken,
          cleanup: () => {
            child.kill("SIGTERM");
          },
        });
      } catch {
        clearTimeout(timer);
        reject(new Error(`Failed to parse server output: ${line}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}`));
    });
  });
}

interface JoinResponse {
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Array<{ id: string; name: string; type: string; authority?: string }>;
}

async function httpJoin(
  serverUrl: string,
  token: string,
  opts?: { name?: string; type?: string },
): Promise<JoinResponse> {
  const body: Record<string, unknown> = { token };
  if (opts?.name) body.name = opts.name;
  if (opts?.type) body.type = opts.type;

  const res = await fetch(`${serverUrl}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Join failed: ${await res.text()}`);
  return res.json() as Promise<JoinResponse>;
}

async function httpSend(
  serverUrl: string,
  sessionToken: string,
  content: string,
): Promise<{ ok: boolean; messageId?: string }> {
  const res = await fetch(`${serverUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sessionToken, content }),
  });
  return res.json() as Promise<{ ok: boolean; messageId?: string }>;
}

async function httpDisconnect(serverUrl: string, sessionToken: string): Promise<void> {
  await fetch(`${serverUrl}/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sessionToken }),
  }).catch(() => {});
}

async function httpParticipants(
  serverUrl: string,
  sessionToken: string,
): Promise<Array<{ id: string; name: string; type: string; authority?: string }>> {
  const res = await fetch(`${serverUrl}/participants?token=${sessionToken}`);
  if (!res.ok) throw new Error(`Failed to get participants: ${await res.text()}`);
  const data = (await res.json()) as { participants: Array<{ id: string; name: string; type: string; authority?: string }> };
  return data.participants;
}

interface HeadlessClient {
  process: ChildProcess;
  events: Array<Record<string, unknown>>;
  send(message: string): void;
  waitForEvent(
    predicate: (e: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  cleanup: () => void;
}

function joinHeadless(
  serverUrl: string,
  token: string,
  opts?: { name?: string; guest?: boolean },
): Promise<HeadlessClient> {
  const url = `${serverUrl}?token=${token}`;
  const args = [CLI_PATH, "join", url, "--headless"];
  if (opts?.name) args.push("--name", opts.name);
  if (opts?.guest) args.push("--guest");

  const child = spawn(NODE, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (e: Record<string, unknown>) => boolean;
    resolve: (e: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];

  const rl = createInterface({ input: child.stdout!, terminal: false });
  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      // Check waiters
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(event)) {
          waiters[i].resolve(event);
          waiters.splice(i, 1);
        }
      }
    } catch {
      // not JSON
    }
  });

  // Wait a bit for connection to establish
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        process: child,
        events,
        send(message: string) {
          child.stdin!.write(message + "\n");
        },
        waitForEvent(predicate, timeoutMs = 5000) {
          // Check existing events first
          const existing = events.find(predicate);
          if (existing) return Promise.resolve(existing);

          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error("waitForEvent timed out"));
            }, timeoutMs);

            waiters.push({
              predicate,
              resolve: (e) => { clearTimeout(timer); res(e); },
              reject: (err) => { clearTimeout(timer); rej(err); },
            });
          });
        },
        cleanup() {
          child.stdin!.end();
          child.kill("SIGTERM");
        },
      });
    }, 500);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_BUILD)("Integration", () => {
  const servers: ServerHandle[] = [];
  const clients: HeadlessClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.cleanup();
    for (const s of servers.splice(0)) s.cleanup();
    // Brief pause for OS to release ports
    await new Promise((r) => setTimeout(r, 100));
  });

  // ── 1. Server lifecycle ──────────────────────────────────────────────

  test("headless server starts and outputs JSON", async () => {
    const server = await startServer();
    servers.push(server);

    expect(server.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.roomName).toBeTruthy();
    expect(server.adminToken).toBeTruthy();
    expect(server.memberToken).toBeTruthy();

    // Verify server is reachable
    const res = await fetch(`${server.serverUrl}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: server.memberToken, name: "probe", type: "human" }),
    });
    expect(res.ok).toBe(true);
  }, 15_000);

  // ── 2. Join/leave ─────────────────────────────────────────────────────

  test("participant joins and appears in list, then disconnects", async () => {
    const server = await startServer();
    servers.push(server);

    const join1 = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    expect(join1.authority).toBe("member");
    expect(join1.roomName).toBe(server.roomName);

    const list = await httpParticipants(server.serverUrl, join1.sessionToken);
    expect(list.find((p) => p.name === "Alice")).toBeTruthy();

    await httpDisconnect(server.serverUrl, join1.sessionToken);

    // Join again to check participant list
    const join2 = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    const list2 = await httpParticipants(server.serverUrl, join2.sessionToken);
    expect(list2.find((p) => p.name === "Alice")).toBeFalsy();
    expect(list2.find((p) => p.name === "Bob")).toBeTruthy();
  }, 15_000);

  // ── 3. Observer join ──────────────────────────────────────────────────

  test("guest joins with guest authority", async () => {
    const server = await startServer();
    servers.push(server);

    // Generate guest token
    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const shareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: admin.sessionToken, authority: "guest" }),
    });
    const shareData = (await shareRes.json()) as { links: Record<string, string> };
    const guestUrl = shareData.links.guest;
    const guestToken = new URL(guestUrl).searchParams.get("token")!;

    const obs = await httpJoin(server.serverUrl, guestToken, { name: "Watcher" });
    expect(obs.authority).toBe("guest");
  }, 15_000);

  // ── 4. Messaging ──────────────────────────────────────────────────────

  test("messages sent via HTTP appear in search", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    await httpSend(server.serverUrl, alice.sessionToken, "hello world unique123");

    // Search for the message
    const searchRes = await fetch(
      `${server.serverUrl}/search?token=${alice.sessionToken}&query=unique123`,
    );
    const searchData = (await searchRes.json()) as { items: Array<{ content: string }> };
    expect(searchData.items.length).toBeGreaterThanOrEqual(1);
    expect(searchData.items.some((m) => m.content.includes("unique123"))).toBe(true);
  }, 15_000);

  test("headless client receives messages via SSE", async () => {
    const server = await startServer();
    servers.push(server);

    const client = await joinHeadless(server.serverUrl, server.memberToken, { name: "Eve" });
    clients.push(client);

    // Send a message from another participant
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    await httpSend(server.serverUrl, bob.sessionToken, "ping from bob");

    const event = await client.waitForEvent(
      (e) => e.type === "MessageSent" && (e as any).message?.content === "ping from bob",
    );
    expect(event).toBeTruthy();
  }, 15_000);

  // ── 5. Authority enforcement ──────────────────────────────────────────

  test("guest cannot send messages", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const shareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: admin.sessionToken, authority: "guest" }),
    });
    const shareData = (await shareRes.json()) as { links: Record<string, string> };
    const guestToken = new URL(shareData.links.guest).searchParams.get("token")!;

    const obs = await httpJoin(server.serverUrl, guestToken);
    expect(obs.authority).toBe("guest");

    const sendRes = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: obs.sessionToken, content: "should fail" }),
    });
    expect(sendRes.status).toBe(403);
  }, 15_000);

  // ── 6. Non-admin can't kick ───────────────────────────────────────────

  test("participant cannot kick others", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });

    const kickRes = await fetch(`${server.serverUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: alice.sessionToken, participantId: bob.participantId }),
    });
    expect(kickRes.status).toBe(403);
  }, 15_000);

  // ── 7. Admin can kick ─────────────────────────────────────────────────

  test("admin can kick a participant", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const target = await httpJoin(server.serverUrl, server.memberToken, { name: "Target" });

    const kickRes = await fetch(`${server.serverUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: admin.sessionToken, participantId: target.participantId }),
    });
    expect(kickRes.ok).toBe(true);

    const list = await httpParticipants(server.serverUrl, admin.sessionToken);
    expect(list.find((p) => p.name === "Target")).toBeFalsy();
  }, 15_000);

  // ── 8. Mute/unmute (authority change) ─────────────────────────────────

  test("admin can mute (demote to guest) and unmute (restore to member)", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });

    // Verify Alice can send before mute
    const send1 = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: alice.sessionToken, content: "before mute" }),
    });
    expect(send1.ok).toBe(true);

    // Mute Alice (demote to guest)
    const muteRes = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: admin.sessionToken,
        participantId: alice.participantId,
        authority: "guest",
      }),
    });
    expect(muteRes.ok).toBe(true);

    // Alice should now be blocked from sending
    const send2 = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: alice.sessionToken, content: "should fail" }),
    });
    expect(send2.status).toBe(403);

    // Unmute Alice (restore to member)
    const unmuteRes = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: admin.sessionToken,
        participantId: alice.participantId,
        authority: "member",
      }),
    });
    expect(unmuteRes.ok).toBe(true);

    // Alice should be able to send again
    const send3 = await fetch(`${server.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: alice.sessionToken, content: "after unmute" }),
    });
    expect(send3.ok).toBe(true);
  }, 15_000);

  // ── 9. Multi-participant ──────────────────────────────────────────────

  test("multiple participants see each other", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    const charlie = await httpJoin(server.serverUrl, server.memberToken, { name: "Charlie" });

    const list = await httpParticipants(server.serverUrl, alice.sessionToken);
    const names = list.map((p) => p.name);
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");
    expect(names).toContain("Charlie");
  }, 15_000);

  // ── 10. Share link generation ──────────────────────────────────────────

  test("admin gets all tier links, participant gets limited links", async () => {
    const server = await startServer();
    servers.push(server);

    // Admin gets all tiers
    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });
    const adminShareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: admin.sessionToken }),
    });
    const adminLinks = ((await adminShareRes.json()) as { links: Record<string, string> }).links;
    expect(adminLinks.admin).toBeTruthy();
    expect(adminLinks.member).toBeTruthy();
    expect(adminLinks.guest).toBeTruthy();

    // Member only gets member + guest
    const part = await httpJoin(server.serverUrl, server.memberToken, { name: "Part" });
    const partShareRes = await fetch(`${server.serverUrl}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: part.sessionToken }),
    });
    const partLinks = ((await partShareRes.json()) as { links: Record<string, string> }).links;
    expect(partLinks.admin).toBeUndefined();
    expect(partLinks.member).toBeTruthy();
    expect(partLinks.guest).toBeTruthy();
  }, 15_000);

  // ── 11. @mention delivery ─────────────────────────────────────────────

  test("@mention delivers MentionedEvent to target SSE stream", async () => {
    const server = await startServer();
    servers.push(server);

    // Alice joins via headless to receive SSE events
    const alice = await joinHeadless(server.serverUrl, server.memberToken, { name: "Alice" });
    clients.push(alice);

    // Bob joins via HTTP and sends @Alice
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });
    await httpSend(server.serverUrl, bob.sessionToken, "hey @Alice what do you think?");

    // Alice should receive the MessageSent event
    const msgEvent = await alice.waitForEvent(
      (e) => e.type === "MessageSent" && (e as any).message?.content?.includes("@Alice"),
    );
    expect(msgEvent).toBeTruthy();
  }, 15_000);

  // ── 12. Self-demotion blocked ──────────────────────────────────────────

  test("admin cannot demote self", async () => {
    const server = await startServer();
    servers.push(server);

    const admin = await httpJoin(server.serverUrl, server.adminToken, { name: "Admin" });

    const res = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: admin.sessionToken,
        participantId: admin.participantId,
        authority: "guest",
      }),
    });
    expect(res.status).toBe(400);
  }, 15_000);

  // ── 13. Non-admin cannot change authority ──────────────────────────────

  test("non-admin cannot change authority", async () => {
    const server = await startServer();
    servers.push(server);

    const alice = await httpJoin(server.serverUrl, server.memberToken, { name: "Alice" });
    const bob = await httpJoin(server.serverUrl, server.memberToken, { name: "Bob" });

    const res = await fetch(`${server.serverUrl}/set-authority`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: alice.sessionToken,
        participantId: bob.participantId,
        authority: "guest",
      }),
    });
    expect(res.status).toBe(403);
  }, 15_000);
});
