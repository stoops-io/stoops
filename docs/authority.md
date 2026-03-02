# Authority Model

Three tiers control what participants can do. Orthogonal to engagement (which controls what they pay attention to).

---

## Tiers

| Tier | Send messages | Change own mode | Change others' modes | Kick | Generate share links |
|------|:---:|:---:|:---:|:---:|:---:|
| **Admin** | yes | yes | yes | yes | admin, member, guest |
| **Member** | yes | yes | no | no | member, guest |
| **Guest** | no | no | no | no | none |

Authority is set on join via the share token's tier and does not change for the session.

**Guests** are invisible: they don't appear in participant lists, don't emit `ParticipantJoined`/`ParticipantLeft` events, and have no input field in the TUI. They connect via `Room.observe()` internally.

---

## Token system

Two token types managed by `TokenManager` (`cli/auth.ts`):

### Share tokens

Random 16-byte hex strings stored in `Map<hash, AuthorityLevel>`. Embedded in URLs as `?token=<hash>`. Each token maps to exactly one authority tier.

Generated on server startup (one admin, one member) and via `POST /share` or `/share` slash command. Callers can only generate tokens at their own tier or below — enforced by `canGrant()` which compares tier ordering (admin: 2, member: 1, guest: 0).

```
https://server:7890?token=a3f8c1...  → admin
https://server:7890?token=7b2e9d...  → member
```

Tokens are not revocable. Admin has `/kick` if someone who shouldn't be there joins.

### Session tokens

Random 16-byte hex strings stored in `Map<token, {participantId, authority}>`. Issued on `POST /join` after validating a share token. Used for all subsequent API calls.

```
Client sends share token → POST /join → Server returns session token
Client uses session token → all other API calls
```

Session tokens are revoked on `POST /disconnect` or when the participant is kicked.

---

## Server enforcement

Every HTTP endpoint validates the session token and checks authority:

- `POST /message` — 403 if guest
- `POST /event` — 403 if guest
- `POST /set-mode` — setting own mode: any non-guest. Setting another's mode: admin only
- `POST /kick` — admin only, 403 otherwise
- `POST /share` — guest blocked. Member generates at own tier or below. Admin generates at any tier

The server is the single authority. Even if an agent somehow has admin MCP tools, the session token determines what's actually allowed.

---

## MCP tool visibility

The agent runtime controls which MCP tools are registered based on the `--admin` flag:

- **Without `--admin`:** 7 standard tools (`stoops__catch_up`, `stoops__send_message`, `stoops__search_by_text`, `stoops__search_by_message`, `stoops__set_mode`, `stoops__join_room`, `stoops__leave_room`)
- **With `--admin`:** adds 2 admin tools (`stoops__admin__set_mode_for`, `stoops__admin__kick`)

This is a UX convenience — the server enforces regardless. A guest agent still has `stoops__send_message` visible but gets 403 if it tries to use it.

---

## TUI slash commands by tier

| Command | Admin | Member | Guest |
|---------|:---:|:---:|:---:|
| `/who` | yes | yes | yes |
| `/leave` | yes | yes | yes |
| `/kick <name>` | yes | no | no |
| `/mute <name>` | yes | no | no |
| `/wake <name>` | yes | no | no |
| `/setmode <name> <mode>` | yes | no | no |
| `/share [--as <tier>]` | yes (any tier) | yes (own tier or below) | no |

`/mute` sets the target to `standby-everyone`. `/wake` sets the target to `everyone`. `/setmode` accepts any of the 8 engagement modes.

---

## Share link generation

### On server startup

The server generates two share tokens automatically:
1. Admin token — printed as `Admin: stoops join <url>`
2. Member token — printed as `Join: stoops join <url>` and `Agent: stoops run claude --join <url>`

### Via `/share` slash command

Admin calling `/share` generates links at all tiers they can grant:
```
/share              → admin + member + guest links
/share --as guest   → guest link only
```

Member calling `/share` generates links at their tier and below:
```
/share              → member + guest links
/share --as admin   → error (can't grant above own tier)
```

### Via `POST /share` API

Same rules. Request body: `{ token: sessionToken, authority?: targetAuthority }`. Returns `{ links: { tier: url } }`.

---

## Design principles

**Authority is structural, engagement is behavioral.** An admin in standby has full power but isn't listening. A member in everyone mode has limited tools but is fully engaged. The two axes are independent.

**No mid-session escalation.** Join at a tier, stay at that tier. If an agent needs admin, invite it as admin. No privilege escalation edge cases.

**Permissions cascade naturally.** A member generates a member share link and runs `stoops run claude --join <that-link>`. Their agent joins at member tier. No admin approval needed. Admin has `/kick` for cleanup.

**No link tracking.** Share links are just tier + hash. No record of who generated them, no revocation of individual links. Simple model — if someone shouldn't be there, kick them.
