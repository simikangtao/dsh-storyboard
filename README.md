# dsh-storyboard

End-of-chat **Doubao-style visual storyboard** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web.

When a substantive conversation ends (real work done, a plan produced, or a concept explained), the model calls the `storyboard` tool once and a compact visual card summarizing **what was done and how it works** appears in the sidebar. A `/storyboard [focus]` command forces one on demand.

## Why it is light

- **Server-only plugin** — no client bundle, no extra JS shipped to the browser.
- **Zero runtime dependencies** — node built-ins only (`crypto`, `fs`, `os`, `path`).
- **One self-contained HTML file** per storyboard (~5–20 KB): system fonts, inline SVG, no network requests, no CDN, works offline.
- **Tiny prompt footprint** — the injected guidance section is ~500 characters.
- Storyboards are written under `$DSH_HOME/storyboard/<session>/` (default `~/.dsh/storyboard/<session>/`).

## Install

```bash
# from a workspace containing this folder:
dsh plugin --profile web add file:C:\path\to\dsh-storyboard

# or by package name once published:
dsh plugin --profile web add dsh-storyboard
```

The bundle patch inserts one row (`id: storyboard`) into the web profile.
Disable it by removing that row from the profile (the prompt section, tool, and command are all registered by the row's presence).

## Usage

1. **Automatic** — at the end of a substantive exchange the model generates the card and opens it in the sidebar by itself.
2. **On demand** — type `/storyboard` (optionally `/storyboard the install steps`) in the chat input.

## Card sections

| Section | Field | Notes |
| --- | --- | --- |
| Title / subtitle | `title`, `subtitle` | title required, max 40 / 80 chars |
| How it connects | `diagram` | ≤8 nodes, ≤12 edges, rendered as inline SVG with layered DAG layout + arrowheads |
| What was done | `flow` | ≤8 numbered steps with optional notes, connected by a vertical rail |
| Key facts | `facts` | ≤8 label/value pairs in a two-column grid |
| Timeline | `timeline` | ≤8 dotted-rail events with optional time labels |
| How it works | `howItWorks` | ≤8 mechanism bullet points |

Every string is length-capped and HTML-escaped on the host side; omit a section when you have no content for it.

## Development

```bash
node test/smoke.mjs   # standalone renderer + registration smoke test (no DSH host needed)
```

## Limitations

- v1 has no settings toggle: presence of the profile row enables the feature.
- Diagram layout is a simple longest-path layering (cycles are capped, not drawn as true cycles).
- The automatic trigger is instruction-based (the model decides a conversation is ending); it is deliberately not a hard hook.
