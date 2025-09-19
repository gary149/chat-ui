**Spec Overview**

- This spec covers all SPA blockers identified under “Gaps & Work Needed”.
- Follow path references exactly; line numbers are 1-based (e.g. `src/lib/server/api/routes/groups/conversations.ts:139`).
- Every deliverable must meet the acceptance tests listed per section before cutting over.

**1. Conversation Creation & Message Streaming**

Goal

- Move conversation creation and message streaming from SvelteKit handlers into the `/api/v2/conversations` Elysia group so clients can run in pure SPA mode.

Scope

- Extend the existing POST placeholder at `src/lib/server/api/routes/groups/conversations.ts:139` to mirror the logic currently in `src/routes/conversation/+server.ts:13`.
- Implement a nested POST handler under `/:id` that streams message updates, replicating `src/routes/conversation/[id]/+server.ts:27`.

Detailed Requirements

- Request validation: reuse `validateModel(models)` and zod schemas from the Svelte endpoints. Preserve `fromShare`, `model`, `preprompt`, and file-handling semantics.
- Rate limits & guest checks: port all usage-limit and `config.MESSAGES_BEFORE_LOGIN` branches. Ensure helper calls (`authCondition`, `usageLimits`, `collections.messageEvents`) are identical.
- Legacy conversion: keep `convertLegacyConversation` handling before returning/streaming.
- Streaming protocol: return a `ReadableStream` that yields JSON lines matching today’s client expectations (`MessageUpdateType.Stream`, `MessageUpdateType.FinalAnswer`, etc.). Reuse `textGeneration` and `mergeAsyncGenerators` as in the Svelte handler, and wrap the stream in a `Response` so `src/routes/api/v2/[...slugs]/+server.ts` can forward it unchanged.
- Side effects: maintain AbortedGenerations inserts, file upload semantics (`uploadFile`), title sanitisation, and message tree mutations.
- Response shape: `POST /conversations` must return `{ conversationId: string }`. The streaming endpoint must emit identical events consumed by `fetchMessageUpdates` today.

Acceptance Tests

- Unit/integration tests covering: new conversation creation, cloning via `fromShare`, rate-limit rejection, and happy-path streaming.
- Manual verification using the SPA client with the legacy endpoint disabled (`src/routes/conversation/+server.ts` temporarily returning 410) to prove completeness.

Out of Scope

- No UI adjustments here (handled in section 3).
- No change to share/export endpoints (handled later).

**2. Complete Conversation Subroutes**

Goal

- Replace TODOs in the Elysia conversation group with working handlers, then retire duplicate SvelteKit routes.

Scope

- Implement the following in `src/lib/server/api/routes/groups/conversations.ts`:
  1. `POST ""` (covered in section 1)
  2. `POST "/share"`: port logic from `src/routes/conversation/[id]/share/+server.ts:9`.
  3. `POST "/stop-generating"`: port logic from `src/routes/conversation/[id]/stop-generating/+server.ts:9`.
  4. `GET "/output/:sha256"`: mirror `src/routes/conversation/[id]/output/[sha256]/+server.ts:10`.
  5. `DELETE "/message/:messageId"` already implemented—leave intact.
  6. Add `GET "/prompt/:messageId"` mirroring `src/routes/conversation/[id]/message/[messageId]/prompt/+server.ts:1` (this route does not currently exist in the Elysia group).

Detailed Requirements

- Maintain authentication/authorization via `authCondition` for user-owned conversations and support shared links where applicable (`id` length === 7`).
- Ensure file streaming sets correct headers (`Content-Disposition`, CSP) and returns binary bodies.
- Preserve nanoid share IDs, hash reuse behaviour, and GridFS copy semantics.
- Return JSON in the same shapes as legacy endpoints (e.g. `{ shareId }`, prompt payload containing `prompt`, `model`, `parameters`, `messages`).
- After ports succeed, mark the SvelteKit counterparts as deprecated and remove their exports in the same PR.

Acceptance Tests

- Regression tests for: creating share links twice, downloading shared/non-shared attachments, stopping generation (check Mongo update), prompt export success/failure cases.
- Manual test: call each new route via `curl` while legacy endpoints are disabled to confirm the SPA survives.

Out of Scope

- Streaming message POST (covered in section 1).
- Admin/export endpoints (unchanged).

**3. Client Migration to Treaty**

Goal

- Make the SPA use only `useAPIClient` and `/api/v2` routes for conversations and settings.

Scope

- Update these call sites to use Treaty-generated methods:
  - Conversation creation in `src/routes/+page.svelte:24` and `src/routes/models/[...model]/+page.svelte:22`.
  - Shared conversation clone in `src/routes/conversation/[id]/+page.svelte:96`.
  - Settings persistence in `src/lib/stores/settings.ts:34` and `.instantSet`.
  - Share link helper `src/lib/createShareLink.ts:9`.
  - Streaming helper `src/lib/utils/messageUpdates.ts:18`.
  - Verify nav menu delete/patch in `src/routes/+layout.svelte:63` and the model switch continue working once the new Treaty endpoints are in place.

Detailed Requirements

- Add Treaty definitions for new endpoints if missing (augment `src/lib/APIClient.ts` type generation or `App` definition as required).
- Ensure `fetchMessageUpdates` calls the new Treaty method for `POST /api/v2/conversations/:id` (expected shape: `client.conversations({ id }).post(...)`).
- Handle binary downloads via `fetch` if Treaty does not support streaming; document reason.
- When calling Treaty helpers inside `load` functions, continue to use SvelteKit’s provided `fetch` so internal requests stay in-process during SSR.
- Remove direct `fetch(`${base}/conversation`...)` usage; retain fallback only where API coverage is pending.
- Conversation deletion/title edits already rely on Treaty—verify they continue to work after server migrations rather than changing their call sites.

Acceptance Tests

- End-to-end UI smoke (start conversation, send message, share chat, load prompt export) using only `/api/v2` network traffic.
- Automated tests for settings updates verifying the API call (mock Treaty) and UI persistence.

Out of Scope

- Auth flows (handled in section 4).
- Non-conversation routes (models list already API-backed).

**4. Settings Endpoint Consolidation**

Goal

- Eliminate duplicate settings handlers and rely solely on the API.

Scope

- After client migration, remove `src/routes/settings/(nav)/+server.ts`.
- Ensure `userGroup.post("/settings")` (`src/lib/server/api/routes/groups/user.ts:77`) is the single write path.
- Update debounce logic to reuse Treaty responses; on success, continue calling `invalidate(UrlDependency.ConversationList)`.

Acceptance Tests

- Automated test verifying settings toggle triggers Treaty call once after debounce.
- Manual test toggling settings in UI, inspecting network panel for `/api/v2/user/settings` POST only.

Out of Scope

- Settings UI redesign.

**5. Auth Endpoints in API**

Goal

- Provide `/api/v2/login`, `/api/v2/login/callback`, and `/api/v2/logout` so the SPA can authenticate without SvelteKit routes.

Scope

- Fill stubs at `src/lib/server/api/routes/groups/user.ts:12`.
- Copy logic from `src/routes/login/+server.ts:5`, `src/routes/login/callback/+server.ts:27`, and `src/routes/logout/+server.ts:1`, adapting cookies and redirects to work via API responses.
- Expose any necessary helper (e.g. `refreshSessionCookie`) via shared module.
- Adjust SPA login links (`src/lib/components/NavMenu.svelte:149`, `src/lib/components/LoginModal.svelte:30`) to hit the new endpoints; ensure redirect semantics preserved (`callback` query).
- Remove or stub the legacy SvelteKit login/logout handlers once clients switch.

Detailed Requirements

- `GET /api/v2/login`: accept optional `callback`, validate against `config.ALTERNATIVE_REDIRECT_URLS`, and respond with 302 to OIDC provider.
- `GET /api/v2/login/callback`: process OIDC code, apply domain/email filters, call `updateUser`, set cookies, redirect to `/` (302).
- `POST /api/v2/logout`: delete session records, clear cookie, respond 204 or 302 to base path.
- Maintain session refresh logic as in `hooks.server.ts` (cookie options identical).

Acceptance Tests

- Automated SvelteKit request tests hitting new API routes to confirm cookie behaviour.
- Manual flow: log in through SPA, confirm `/api/v2/login` -> IdP -> callback works, and logout returns to home with session cleared.

Out of Scope

- Changes to `authenticateRequest` (already API-aware).
- Admin token validation (existing logic reused).

**6. Retire Legacy `/api/*` Routes**

Goal

- Avoid drift by removing duplicated REST endpoints once parity is achieved.

Scope

- Delete or convert to thin wrappers:
  - `src/routes/api/conversations/+server.ts`
  - `src/routes/api/conversation/[id]/+server.ts`
  - `src/routes/api/conversation/[id]/message/[messageId]/+server.ts`
  - `src/routes/api/models/+server.ts`
  - `src/routes/api/user/+server.ts`
  - `src/routes/api/user/validate-token/+server.ts`
- Ensure any external consumers are updated (coordinate with maintainers before removal).

Acceptance Tests

- Run SvelteKit build; no missing route errors.
- Regression run to confirm SPA functionality still intact.

Out of Scope

- Admin routes (`src/routes/admin/**`)—verify dependencies before removal.

**Cross-Cutting Requirements**

- Add integration coverage for conversation flows using the new API to guard against regressions.
- Update docs (`README.md` or developer guides) to describe API-first setup; note removal timeline for legacy endpoints.
- Ensure lint/tests (`npm run lint`, `npm run test`) pass before submission.
- Keep server-only logic inside `$lib/server/**` modules or `.server.ts` files to satisfy SvelteKit’s server-only import rules.
- Preserve the default SSR behaviour (do **not** set `ssr = false`) so the app continues to follow SvelteKit best practices for SEO and perceived performance.

**Rollout Plan**

1. Implement server-side API parity (sections 1 & 2); ship behind feature flag if needed.
2. Migrate client (sections 3 & 4); toggle to new API.
3. Deliver auth endpoints (section 5); verify login/logout.
4. Remove legacy routes (section 6).
5. Tag release, communicate migration path to integrators.
