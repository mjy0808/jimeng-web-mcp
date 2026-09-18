## Why

Film Studio needs human-reviewed editing of an existing Take without replacing the source or falling back to ordinary generation.

## What Changes

- Add production_edit for one local source video, one interval, exact prompt and optional image references.
- Reuse task_query and Film Studio operation/download/import flow.
- Preserve source versions and require prompt approval and result selection.
- Scope approved by the user on 2026-09-18. Paid live generation still requires separate confirmation.

## Impact

- Affected specs: film-production-integration.
- Affected code: production-tools, upload/edit protocol, Film Studio shot editing and prompt Skill.
