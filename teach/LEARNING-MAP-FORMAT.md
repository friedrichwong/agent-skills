# LEARNING_MAP.md Format

`LEARNING_MAP.md` is the living coverage and routing map for a teaching workspace. It answers three questions: what is in scope, what evidence exists, and why a particular unit should come next. It is not a fixed calendar and does not replace `learning-records/`.

## Template

```md
# Learning Map: {Topic}

Last updated: {YYYY-MM-DD}
Map status: {provisional | complete for current scope}

## Mission boundary

- In scope: {short description}
- Reference only: {content retained for lookup but not taught for mastery}
- Out of scope: {content intentionally excluded and why}
- Resource gaps: {missing, conflicting, or stale sources; use `none` when empty}

## Progress

- In-scope units: {N}
- 未处理: {N}
- 已讲解: {N}
- 已尝试: {N}
- 已独立验证: {N}

## Next

- Unit: {LU-NNN — title}
- Why now: {one sentence connecting prerequisites, mission value, and current evidence}
- Verification target: {the observable performance required to advance state}

## Units

### LU-001 — {Observable capability}

- Sources: [{resource and section}](...)
- Mission link: {why this unit matters}
- Prerequisites: {none | LU-NNN, ...}
- Status: {未处理 | 已讲解 | 已尝试 | 已独立验证}
- Lesson: {none | lessons/NNNN-slug.html}
- Evidence: {none | learning-records/NNNN-slug.md}
- Notes: {conflicts, gaps, misconceptions, or scheduling constraints; omit when empty}
```

Repeat the unit block for each learning unit.

## Status Rules

- `未处理`: The unit has not been taught or tested.
- `已讲解`: Instruction was delivered, but the user has not attempted the skill.
- `已尝试`: The user attempted it with guidance, immediate repetition, or answer-revealing support. A single supported success is not mastery.
- `已独立验证`: The user succeeded without answer-revealing support in a transfer, delayed-retrieval, or real-world task. Link a learning record as evidence.
- `reference-only`: Keep the source available without counting it toward mastery progress.
- `out-of-scope`: Exclude the unit deliberately and record the reason.

## Mapping Rules

- Use stable IDs even when order changes. Add new units without renumbering existing ones.
- Write units as observable capabilities, not chapter titles or vague topics.
- Map every in-scope resource section to a unit or an explicit non-learning classification. List unmapped sections as resource gaps.
- Keep one fact in one place: the map tracks coverage and routing; lessons teach; learning records hold evidence; `RESOURCES.md` evaluates sources.
- Recalculate counts and `## Next` whenever unit state, mission, scope, resources, or prerequisites change.
- Do not report a single mastery percentage without also showing counts by state and explicit skips.
