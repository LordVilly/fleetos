# OpenAI migration ledger — FleetOS diagnostics

## Objective and approved scope
Implement the requested vehicle-bound GPT diagnostic workflow in the existing PHP/HTML/JS application, preserving current behavior and OpenAI provider. User explicitly selected reuse of the existing OpenAI key; no key is available in the local execution environment. Do not create/rotate/recover a key or write secrets. No production edits, migrations, GitHub push, or deployment are authorized by the task.

## Repository snapshot
- Root: FleetOS-publish; branch at start `main`, commit `72a2a99` (`Use authorized server context for GPT diagnostics`); clean.
- PHP backend: `api/index.php`, bootstrap/config in `api/bootstrap.php`; frontend `index.html`; schema `database/schema.sql`.
- Data: MySQL/MariaDB `fleetos_state` JSON snapshot and `fleetos_documents` blobs. `history` entries, maintenance items, orders, safety records, and vehicle metadata are scoped via `vehicleId` in the central snapshot.
- Key: checked presence without reading value. No local `.env`, process, user, or machine `OPENAI_API_KEY`; `.env.example` contains blank placeholder. Runtime loader checks dotenv then process environment. Actual cPanel filesystem path is not available for verification.

## Current integration and gaps
- Existing `POST /api/vehicle/investigate` uses `https://api.openai.com/v1/responses`, `OPENAI_MODEL` default `gpt-6-astra`, `store:false`, required `web_search`, strict JSON schema, authorized server context and selected vehicle-owned documents.
- Frontend opens a single-turn form, immediately saves only a compact GPT summary and closes; there is no continuing chat, report review screen, or explicit final report-save action.
- OpenAI error body is currently returned directly to the frontend; status classes, transport details, and malformed/incomplete output handling need safer mapping.
- Auth and CSRF use existing session guard; the vehicle is looked up by ID in the authenticated central state; document ownership is verified against vehicle metadata and SQL `vehicle_id`.
- The history UI shows summary, accuracy and citations; state autosync is through existing `save()` / cloud sync.

## Responses API capability review
Reviewed each section of the installed Responses API guidance:
- Model selection: preserve configured `gpt-6-astra`; official catalog confirms Responses, web search and structured output support. Do not change the configured model automatically.
- Instruction file naming: no instruction-file rename/addition needed.
- Chat Completions migration: not applicable; app already uses Responses.
- Streaming/WebSocket: defer; existing buffered API/UI flow and JSON schema make buffered turns the lower-risk compatible choice.
- Privacy/residency: preserve stateless `store:false`; FleetOS retains only the final compact report/history in its own DB. OpenAI project residency/ZDR settings remain unverified.
- Processing tiers: keep standard/default; no background/batch work is requested.
- Prompt caching: no behavior change in this stage; model-specific cache diagnostics are optional and not needed for correctness.
- State management: replay a bounded transcript from the browser; no OpenAI server-side stored response IDs or conversation objects.
- Reasoning and verbosity: preserve current model defaults; do not add unsupported/unspecified settings.
- Maximum output tokens: preserve current 3200-token investigation budget unless report generation needs a narrowly justified budget.
- Assistant phases: no streamed or multi-phase assistant items are used.
- Context compaction: bound transcript length and use compact prior reports; no Responses API compaction required for this workflow.
- Structured outputs: retain JSON Schema, validate server-side fields before returning.
- Tools: retain required web search and citation capture; no extra tool or parallel calls.

## Ordered delivery stages
1. **Current stage — usable diagnostic and report flow:** safe API errors; bounded stateless multi-turn transcript; explicitly generated report preview; user-confirmed save into vehicle service history; previous saved diagnostic reports remain context for future runs. Add focused local/mock checks where repository tooling permits.
2. **Credential activation and live API verification — blocked on server-side secret entry:** user enters their existing key in the confirmed cPanel/server secret mechanism. Then verify config-loaded boolean and one billable request only after explicit spend authorization. No secret transmission in chat, shell output, logs, or Git.
3. **Production rollout — not authorized:** backup, migration review, deploy, post-deploy checks and rollback only after separate explicit production authorization.

## Decisions
- Preserve current OpenAI Responses API provider/model selection and stateless request behavior.
- Vehicle context/document access is backend-only and validated per authenticated session and vehicle ID.
- User reviews and confirms before a diagnostic report is written to service history. GPT never writes confirmed repair operations or maintenance parts automatically as a diagnostic fact.
- Never expose API error body or key; return safe Romanian categories.

## Validation map
- Syntax checks: inline JavaScript via Node; PHP lint if a PHP CLI is available.
- Focused mocked API tests: payload validation, bounded transcript, vehicle ownership, safe status mapping, response parsing and final-report structure.
- Frontend checks: conversation keeps vehicle ID, handles send/retry errors, final report can be reviewed, explicit save creates one history row with sources and context, cancellation does not create a report.
- Full existing suite: `node --test tests/cloud-sync.test.cjs`; record existing failures as-is and do not modify unrelated sync behavior.
- Live API: not run until server key is configured and billable use has explicit authorization.
- Production: not touched.

## Open blockers / follow-up
- Existing API key is not available to this local workspace; never fetch/recreate it. Runtime PHP on production has not been inspected in this turn.
- Exact production `.env`/environment-secret location, PHP cURL/OpenSSL status, key validity, project model access, quota/billing and live responses remain unverified.
- User needs one secure action: set the already-created key in the hosting's PHP environment or protected env file, without sharing it in chat. Then authorize one billed smoke request before live validation.

## Current stage implementation status
- Implemented locally on development branch `codex/gpt-diagnostics-report`; production and `main` are unchanged.
- `api/index.php`: bounded, alternating user/assistant transcript (max 10 completed exchanges and 30 KB); current selected vehicle is reloaded and authorized on every request; attached vehicle documents are still checked against both state ownership and `vehicle_id`; stateless Responses API replay preserves sources; report mode reuses the same strict response schema; incomplete/failed outputs and common API/transport failures now map to safe Romanian errors, with only status/code/type logged.
- `index.html`: multi-turn GPT chat; selected vehicle stays fixed; attachments are included on turns and the report request; confirmation before dismissing unsaved chat; generated report preview with vehicle identification/date/signature and citations; explicit save action adds a compact report to vehicle history; historical reports can be reopened and downloaded as TXT. GPT does not mark repairs as complete.
- `tests/gpt-diagnostics-contract.test.cjs`: 4 static/source-contract tests added.

## Latest validation
- Passed: `node --test tests/gpt-diagnostics-contract.test.cjs` — 4/4.
- Passed: inline JavaScript parse via Node and `git diff --check`.
- Existing suite: `node --test tests/cloud-sync.test.cjs` — 12/20 passed, 8 failed in pre-existing cloud sync expectations; `cloud-sync.js` was not modified. Failures assert local-wins merge behavior while current code returned central versions; no changes were made to hide or alter these unrelated failures.
- PHP lint not run: no PHP CLI found in this Windows workspace.
- No live OpenAI call: key absent from local process/user/machine environment; no cPanel secret write performed; billable test condition not satisfied.
- No real authenticated browser/API flow, MySQL write, migration, production check, push, or deployment executed.

## Remaining required action
Set the already-created key securely in the PHP runtime on the target host (application-root `.env`, protected by the app `.htaccess`, or hosting-native environment setting). Do not send it in chat. The local code reads `.env` from the application root via `api/bootstrap.php` and falls back to PHP process environment. After this is done, verify key presence as a boolean only and obtain explicit authorization for one billable smoke call; confirm model/project access and PHP outbound cURL behavior. PHP lint and flow-level runtime tests also remain pending in an environment with PHP.
