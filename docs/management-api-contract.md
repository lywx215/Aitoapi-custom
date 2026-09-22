# Management API implementation contract

This is the shared contract for tasks T1-T6. Preserve production model routing and existing UI behavior. Single-instance filesystem persistence. Never deploy or use real credentials in tests.

## Ownership and integration

- T0 integrates StatusRoutes.js, ProxyServerSystem.js, BrowserManager.js, CreateAuth.js, RequestHandler.js, package.json and shared startup/shutdown.
- T1 owns src/storage/CredentialStore.js, src/auth/AuthSource.js, credential store tests.
- T2 owns src/storage/RuntimeSettingsStore.js and its tests.
- T3 owns docs/management-api-openapi.json, docs/management-api.md, scripts/tests/managementAcceptance.test.js and isolated fixtures.
- Wave 2 T4 owns key service, key routes, auth session provenance and key UI component; T5 owns management routes, operation service and account service; T6 owns isolated verifier and its tests.
- Do not edit another task's files. Return integration instructions and commit SHA. Use explicit file lists for commits; no deployment or production account operations.

## Credential store (T1)

CommonJS class constructed with `{rootDir = process.cwd(), logger}`. State under data/management, credentials under configs/auth. Methods async unless stated.

- `create(content, {disabled = false, reason = 'pending_verification'} = {})` -> `{index, accountId, credentialVersion, stateVersion, changed:true}`. Accept legacy JSON string/object; validate Playwright cookies/origins; allocate using all filenames and durable non-reused high water.
- `getMetadata(index)` synchronous -> metadata or null. Initialize stable identities for legacy accounts without rewriting their auth JSON.
- `read(index)` synchronous -> auth object or null (do not expose in public snapshots).
- `listMetadata()` synchronous -> metadata rows, includes archived flag.
- `replace(index, content, {expectedCredentialVersion, expectedStateVersion} = {})` -> metadata result. Preserve latest management flags; replace credentials only.
- `updateState(index, patch, {expectedCredentialVersion, expectedStateVersion} = {})` -> `{...metadata,changed}`. Patch allowlisted disabled/expired/disabledReason/disabledStatus/disabledAt; null removes field. Errors throw with code/status.
- `mergeStorageState(index, state, {expectedCredentialVersion})` -> metadata result or explicit conflict; changes cookies/origins only.
- `remove(index)` -> result; `archive(index)` -> metadata; `restore(accountId)` -> metadata with disabled manual state; `refresh()` coordinates external file scan/metadata reconciliation.
- Internal same-account queue, allocation queue, durable metadata, atomic writes with unique temp files; never hold locks while running browser actions. Credential replacement/deletion invalidates stale refresh snapshots. Preserve identity tombstones on deletion.
- AuthSource constructor creates `.store`, wrappers createAuth(content,options), replaceAuth(index,content,options), archiveAuth(index), restoreAuth(id) delegate and reload on success. Existing enableAuth/disableAuth/expired wrappers keep boolean semantics for consumers, throw persistence errors instead of ambiguous false; removeAuth becomes async. Ensure synchronous scanning still works and schema-invalid legacy entries are not silently deleted.

## Runtime settings store (T2)

CommonJS class `{config, logger, filePath, onApplied}`. `update(patch)` -> `{values,persisted,applied:true|false,applicationError?}`; `toggle(key)` legacy serialized toggle; `snapshot()` -> allowlisted settings with persistentKeys; `save()` compatibility helper. Shared single writer, validate before mutate, persist candidate before live config changes; persisted subset remains maxContexts/maxRetries/retryDelay/autoDisableStatusCodes/accountCooldownMs/accountCooldownMaxMs/autoHealProbeIntervalMs/autoHealProbeTimeoutMs. In-memory flags retain existing restart semantics. Single-file bind mount compatible fallback must restore file on failed write where possible. No environment precedence changes.

## Management HTTP contract

Prefix `/api/manage/v1`. Bearer management token only, no session or model key fallback. Error `{error:{code,message},requestId}`. Success `{data:...,requestId}`. Async `{data:{taskId,status:'queued'},requestId}` HTTP 202. Request IDs generated server-side. Mutating task submissions require Idempotency-Key, scoped by key ID and canonical content; same key/content -> original task; different -> 409. Credential state is never returned except export permission.

Routes: GET /system/status, /system/readiness, /accounts, /accounts/:id, /settings, /usage, /audit, /tasks, /tasks/:id; POST /accounts/import, /accounts/batch, /accounts/:id/test, /accounts/export, /accounts/:id/archive, /accounts/:id/restore, /accounts/:id/reload, /system/reload-auth, /tasks/:id/cancel; PUT /accounts/:id/credentials; PATCH /accounts/:id, /settings.

IDs are stable accountId; responses include index. Lists `{items,total,offset,limit}` default50 max200. Import `{items:[{clientRef,credentials}],model?:'gemini-3.8-flash'}` default test then autoenable. Reject duplicate email rather than replacing. Settings explicit patch. Account PATCH `{enabled:boolean,force?:boolean}`. Batch `{action:'enable'|'disable'|'archive',accountIds:[...],force?:boolean}`. Test `{mode:'connection'|'model',model?}` default model. Export `{accountIds:[...]}`. Body10MiB max100 batch items/1MiB credential. Credentials allow only accountName,cookies,origins on external import; strip/reject control flags.

Scopes: system:read, accounts:read, accounts:write, accounts:test, accounts:export, accounts:archive, settings:read, settings:write, usage:read, audit:read, tasks:read, tasks:write. Templates readonly/operator/admin; operator excludes export/archive/settings:write/audit:read. Keys API under `/api/management-keys` is console-password session only: list GET, create POST `{name,scopes,expiresAt?}`, revoke DELETE /:id. Token prefix mgmt_, 32 random bytes, SHA256 only persisted, plaintext once. Login marks session.authMethod='console_password' or 'model_key'; existing old sessions require re-login for key admin. No new mandatory env. UI add standalone ManagementKeys component for settings panel. New namespace mounted before raw-body collector/model fallback; API JSON no redirects, local404/405; model requests unchanged.

## Tasks and verification (T5/T6)

Persist tasks/audit/idempotency in data/management, 30-day retention. States queued/running/succeeded/partial/failed/cancelled/interrupted. Per-item state/progress/stage/error and clientRef; task createdByKeyId, timestamps, counts, result. Restart queued resumes, running interrupted and not replayed automatically. Cancellation cooperative, already committed state not rolled back. Key revocation cancels queued writes, running work remains attributed.

Verifier interface `new ManagementVerifier(serverSystem)`; `verify({index,credentials,mode='model',model='gemini-3.8-flash',signal,onProgress})` -> `{success,authIndex,model,requestId,upstreamStatus,stage,credentialState?}` or typed error. Credentials permit isolated candidate verification before replacement. `.close()` shuts down owned resources. Default concurrency1, overall10min, bounded fixed OK prompt. Never use production ConnectionRegistry or mutate currentAuthIndex/production context; no failover. Isolated local WebSocket server plus init-script endpoint redirection for its page only is acceptable. Authentic model result is required, not only page console success. Do not persist production state as side effect of verification. Caller commits/enables after expected credential+state version checks; manual actions win. Account drain waits up to60s then returns explicit pending/failure state, no forced interruption unless force true. Production pool rebalance after commit, not inside store lock.

## Acceptance and evidence

Tests run with temp dirs/mocks, no production endpoints. Distinguish simulated E2E from live model verification. Require two different fixture accounts to pass full orchestration with attribution, plus failed target never succeeds by another account. Real two-account acceptance is a separate live gate and may not be claimed without evidence. Report all tests, changed files, commit SHA and unresolved blockers.
