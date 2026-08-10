---
name: nlm-skill
description: "Expert guide for the NotebookLM CLI (`nlm`). Use when users want to interact with NotebookLM: manage notebooks, add sources, generate content (podcasts, reports, quizzes, flashcards, mind maps, slides, infographics, videos, data tables), conduct research, or automate workflows. Triggers on \"nlm\", \"notebooklm\", \"podcast generation\", \"audio overview\"."
metadata:
  version: "0.7.0"
---

# NotebookLM CLI (`nlm`)

## Quick Start

```bash
nlm --help              # List all commands
nlm <command> --help    # Help for specific command
nlm --ai                # Full AI-optimized documentation
nlm --version           # Check version
```

## Critical Rules

1. **Always `nlm login` first** — sessions expire ~20 min
2. **⚠️ ASK before delete** — deletions are irreversible
3. **`--confirm` / `-y` required** for all generation and delete commands
4. **`--notebook-id` is required flag** for research (not positional)
5. **Never use `nlm chat start`** — use `nlm notebook query` for one-shot Q&A
6. **Use aliases** — `nlm alias set <name> <uuid>` to simplify IDs

## Output Flags

| Flag | Use case |
|------|----------|
| (none) | Rich table (human) |
| `--json` | Parse programmatically |
| `--quiet` | IDs only (piping) |
| `--full` | All details |

## Core Commands

### Auth & Config

```bash
nlm login                           # Browser login
nlm login --check                   # Validate session
nlm login switch <profile>          # Switch profile
nlm login profile list              # List profiles
nlm config show                     # Show config
```

### Notebook

```bash
nlm notebook list [--json|--quiet]
nlm notebook create "Title"
nlm notebook get <id>               # Details
nlm notebook describe <id>          # AI summary + topics
nlm notebook query <id> "question"  # One-shot Q&A with sources
nlm notebook query <id> "question" --source-ids <id1,id2>  # Limit to specific sources
nlm notebook query <id> "follow-up" --conversation-id <conv-id>  # Follow-up
nlm notebook rename <id> "New Title"
nlm notebook delete <id> --confirm
```

### Source

```bash
# Add sources
nlm source add <nb> --url "https://..."             # Web page
nlm source add <nb> --url "https://youtube.com/..."  # YouTube
nlm source add <nb> --text "content" --title "X"    # Pasted text
nlm source add <nb> --file /path/to/file.pdf --wait  # Local file (PDF/TXT/MD/DOCX/CSV/EPUB/MP3/MP4/JPG/PNG)
nlm source add <nb> --drive <doc-id> --type doc      # Google Drive (doc/slides/sheets/pdf)

# Manage
nlm source list <nb> [--drive]
nlm source get|describe|content <source-id>
nlm source content <source-id> -o file.txt           # Export to file
nlm source rename <source-id> "New Title" --notebook <nb>
nlm source delete <source-id> --confirm

# Drive sync
nlm source stale <nb>                    # List outdated
nlm source sync <nb> --confirm           # Sync all stale
nlm source sync <nb> --source-ids <ids> --confirm  # Sync specific
```

### Research

```bash
nlm research start "query" --notebook-id <id>              # Fast (~30s, ~10 sources)
nlm research start "query" --notebook-id <id> --mode deep  # Deep (~5min, ~40+ sources)
nlm research start "query" --notebook-id <id> --source drive  # Drive search
nlm research start "query" --notebook-id <id> --auto-import   # Wait + auto-import
nlm research status <nb> [--max-wait 0|--task-id <tid>]
nlm research import <nb> <task-id> [--indices 0,2|--cited-only]
```

### Studio Generation (all need `--confirm`)

```bash
# Common flags: --source-ids <ids> --language <BCP-47> --focus "..."

nlm audio create <id> [--format deep_dive|brief|critique|debate] [--length short|default|long] [--focus "..."]
nlm video create <id> [--format explainer|brief|cinematic] [--style whiteboard|anime|...] [--style-prompt "..."] [--focus "..."]
nlm report create <id> [--format "Briefing Doc"|"Study Guide"|"Blog Post"|"Create Your Own"] [--prompt "..."]
nlm quiz create <id> [--count N] [--difficulty 1-5] [--focus "..."]
nlm flashcards create <id> [--difficulty easy|medium|hard] [--focus "..."]
nlm mindmap create <id> [--title "..."]
nlm slides create <id> [--format detailed|presenter] [--length short|default] [--focus "..."]
nlm slides revise <artifact-id> --slide '1 instruction' --confirm
nlm infographic create <id> [--orientation landscape|portrait|square] [--detail concise|standard|detailed] [--style professional|...] [--focus "..."]
nlm data-table create <id> "description" --confirm
```

### Studio Management

```bash
nlm studio status <nb> [--full|--json]
nlm studio rename <artifact-id> "New Title"
nlm studio delete <nb> <artifact-id> --confirm
nlm download audio|video|report|slide-deck|quiz|flashcards|data-table <nb> --output <path> [--id <artifact-id>]
nlm export docs|sheets <nb> <artifact-id> [--title "..."]
```

### Notes & Chat

```bash
nlm note create <nb> --content "..." [--title "..."]
nlm note list <nb> [--json]
nlm note update <nb> <note-id> --content "..." [--title "..."]
nlm note delete <nb> <note-id> --confirm
nlm chat configure <id> --goal default|learning_guide|custom [--prompt "..."] [--response-length longer|shorter]
```

### Sharing

```bash
nlm share status <nb>
nlm share public <nb> [--off]
nlm share invite <nb> user@example.com [--role viewer|editor]
```

### Tags & Batch

```bash
nlm tag add <nb> --tags "ai,research" [--title "Display Name"]
nlm tag remove <nb> --tags "ai"
nlm tag list|select "query"
nlm batch query "..." --notebooks|--tags|--all
nlm batch add-source --url "..." --notebooks "id1,id2"
nlm batch studio --type audio --tags "research" --confirm
nlm cross query "..." --notebooks|--tags|--all
```

### Pipeline & Alias

```bash
nlm pipeline list
nlm pipeline run <nb> ingest-and-podcast|research-and-report|multi-format --url "..."
nlm alias set|get|list|delete
```

---

## Capability Guide

### Query — Conversational Q&A

**What it CAN do:**

- Answer questions based on uploaded sources with citations
- Multi-turn conversations (`--conversation-id`) maintaining context
- Limit answers to specific sources (`--source-ids`)
- Notes are also included in the answer scope

**What it CANNOT do:**

- Cannot generate non-multiple-choice quizzes (use chat or Create Your Own report instead)
- Cannot guarantee inline citations (audio/video don't show source annotations)
- Cannot access content that wasn't uploaded

**Best practices:**

```bash
# One-shot question
nlm notebook query <nb> "What are the main themes across these sources?"

# Multi-turn conversation
nlm notebook query <nb> "Elaborate on theme 1" --conversation-id <conv-id>

# Limit to specific sources
nlm notebook query <nb> "Summarize chapter 3" --source-ids <source-id>
```

### Studio — Content Generation

**General principles:**

- **Fast track (default):** Silently infer format → 1-3 sentence prompt + grounding anchor → generate
- **Guided (exception):** Vague requests, cinematic video, high-stakes deliverables → show settings + full prompt
- **Grounding anchor:** Add to every prompt: `Use only uploaded sources. Do not invent statistics, quotes, or examples not in the sources.`

**Format capability boundaries:**

| Format | Capabilities | Limitations |
|--------|-------------|-------------|
| **Audio** | deep_dive(~10min)/brief(~3min)/critique/debate, supports short/default/long | Cannot exceed 30min |
| **Video** | explainer(teaching)/brief(exec summary)/cinematic(narrative) | Cinematic has daily quota (~2/day), always requires guided |
| **Slides** | detailed(sharing)/presenter(presentation), supports `studio_revise` per-slide | Cannot add new source data via revise |
| **Infographic** | 11 style presets, supports landscape/portrait/square | `detailed` level not recommended as default |
| **Report** | Briefing Doc/Study Guide/Blog Post/Create Your Own | Create Your Own requires `--prompt` |
| **Quiz** | Multiple choice only, difficulty 1-5 | Does not support non-MC question types |
| **Flashcards** | Definition/scenario cards | Defaults to "What is X?" type, adjust via focus |
| **Data Table** | Structured data extraction | Must specify column names in description |

**Prompt framework (5 elements):**

- **Audience:** Who consumes this content
- **Goal:** One outcome
- **Scope:** What to include/exclude
- **Structure:** Sections, beats, layout
- **Constraints:** Tone, length, language

**Fast track minimal prompt:**

```
[Audience]. Focus on [2-3 themes]. [Structure hint]. Use only uploaded sources.
```

### Research — Source Discovery

**What it CAN do:**

- Discover new sources from the web or Google Drive
- Fast mode (~30s, ~10 sources) / Deep mode (~5min, ~40+ sources)
- `--auto-import` waits for completion and auto-imports
- `--cited-only` imports only sources cited by the research report

**What it CANNOT do:**

- Cannot guarantee all discovered sources are high quality
- Deep mode occasionally hits Google API error 3, requires retry

### Batch & Cross-Notebook — Batch Operations

**What it CAN do:**

- Query across multiple notebooks (`cross query`)
- Batch generate content (`batch studio`)
- Organize and select notebooks by tags

**Best practices:**

```bash
# Query by tags
nlm cross query "What are the main conclusions?" --tags "ai"

# Batch generate podcasts
nlm batch studio --type audio --tags "research" --confirm
```

### Pipeline — Workflow Automation

**Built-in pipelines:**

- `ingest-and-podcast`: URL → add source → generate podcast
- `research-and-report`: research → import → generate report
- `multi-format`: audio + report + flashcards

**Custom pipelines:** Add YAML files to `~/.notebooklm-mcp-cli/pipelines/`

---

## Studio Prompting Quick Reference

**Fast track (default):** Silently infer → minimal prompt → generate. No questions asked.

**Guided (exception):** Vague request, cinematic, high-stakes, empty notebook, user asks → show settings + prompt → one refinement chance → generate.

**Format quick pick:**

| Intent | Command |
|--------|---------|
| Podcast / learn | `audio: deep_dive, default` |
| Quick recap | `audio: brief, short` |
| Teach / explain | `video: explainer` |
| Exec summary | `video: brief` |
| Narrative / launch | `video: cinematic` + full brief in `--focus` |
| Shareable slides | `slide_deck: detailed_deck` |
| Live presentation | `slide_deck: presenter_slides` |
| LinkedIn visual | `infographic: square, concise, bento_grid` |
| Custom report | `report: "Create Your Own" --prompt` |
| Data extraction | `data-table: explicit column schema in description` |

**Iteration principle:** Only iterate on failure or dissatisfaction. Slides use `studio_revise`. Do not proactively suggest regeneration.

**Detailed guides:** [Studio Prompting Guide](references/studio-prompting-guide.md) | [Examples](references/studio-prompt-examples.md)

---

## Error Recovery

| Error | Fix |
|-------|-----|
| Cookies expired | `nlm login` |
| Notebook/Source not found | List to verify ID |
| Rate limit | Wait 30s |
| Research in progress | Import first or `--force` |
| Import timeout | `--timeout 600` |
| Google API error 3 | Retry or use `--mode fast` |

## Rate Limits

Source: 2s · Generation: 5s · Research: 2s · Query: 2s

## Detailed References

- [Command Reference](references/command_reference.md) — all flags and options
- [Studio Prompting Guide](references/studio-prompting-guide.md) — fast vs guided modes, per-artifact decision trees
- [Studio Prompt Examples](references/studio-prompt-examples.md) — copy-paste templates
- [Troubleshooting](references/troubleshooting.md) — error handling
- [Workflows](references/workflows.md) — end-to-end sequences
