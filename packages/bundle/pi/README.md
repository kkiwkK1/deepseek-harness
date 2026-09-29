---
description: "The pi agent-preset bundle: a lean four-tool operation space (read, write, edit, one platform shell) as an installable composition."
kind: "package-bundle"
---

# @deepseek-ai/dsh-pi

English | [中文](README.zh.md)

## Summary

`dsh-pi` adds the **pi** agent preset: the model's whole operation space is four tools — `read` (text pages and images), `write`, `edit`, and one platform shell (`bash` off Windows, `pwsh` on it). Search, directory listing, builds, and tests run through the shell; questions reach the user as ordinary replies. The shipped Web and Desktop profiles select this bundle by default, and any initialized profile can install it. It changes no default: sessions still start on the `standard` preset until pi is chosen.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Choose pi in a session

Start `dsh --profile web` (or Desktop), create a task, and pick **Pi mode** in the agent-preset chooser; or set it as the new-task default in General settings. Every session keeps its own preset, so a pi session runs beside standard ones in the same process.

### Install into another profile

The bundle ships inside the Web and Desktop profile templates. Any other initialized profile adds it explicitly:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-pi
```

The profile must already contain `@deepseek-ai/dsh-base` and a surface that mounts agent presets (the Web bundle or `dsh-headless` over it). Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-pi` removes the preset from the roster.

### What the model gets

| Tool | Responsibility |
|---|---|
| `read` | Paged UTF-8 text and image reads (images through `read` itself; no separate `read_image`) |
| `write` | Create or fully replace a file |
| `edit` | Exact literal replacement with uniqueness and version guards |
| `bash` / `pwsh` | Search, list directories, build, test, and run commands — one platform shell, foreground only |

Repository instructions, the working directory, platform context, approval flows, sandboxing, and session recording all stay on the existing services. Background jobs, skills, goals, plan mode, subagents, workflows, web tools, and plugin management never register.

## Understand the implementation

The package's runtime content is one patch document: [`pi.patch.yml`](pi.patch.yml) inserts a `preset-pi` row — a `@deepseek-ai/dsh-agent-preset` declaration over the base + web-app layers. The preset mounts `dsh-persona` (the standard identity plus one line routing questions to plain replies), `dsh-agent-instructions`, the foreground-only shell rows (`enableRunInBackground: false`, `promoteOnTimeout: false`), `dsh-tool-fs` with `imageReadMode: integrated`, `dsh-agent-tool-presentation` with `mode: native`, and the compaction group (`compaction-basic`, `command-compact`, `tool-result-pruner`) — session infrastructure that registers no model-facing tools.

Everything else is inherited: the agent loop, filesystem and shell providers, sandbox and approval, attachments, and session logging need no pi-specific code. The integrated image read lives in `dsh-tool-fs`; see its README for the `imageReadMode` contract.

## Further Exploration

- [`dsh-tool-fs`](../../fs/tool-fs/README.md) — the four-tool filesystem suite and integrated image routing
- [`dsh-agent-preset-registry`](../../preset/agent-preset-registry/README.md) — preset roster, per-session binding, and composition inventory
- [`dsh-web-app`](../web-app/README.md) — the surface that mounts agent presets for Web and Desktop

## Model Experience

### System prompt

#### What the model sees

The persona keeps the standard identity, working directory, and one sentence routing questions to plain replies; the shipped `agent-instructions` row still injects repository instructions, and the runtime context (platform and environment) still renders. Guidance for tools pi does not mount never registers, so the prompt carries only the read and shell sections beside the persona.

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files and images. Use offset and limit to continue reading large text files; image reads return the image itself and accept neither argument.
```

#### Token effect

The four-tool catalog makes the first request smaller than `standard` by the schemas and guidance of every unmounted tool; the persona's extra sentence is the only addition.

#### KV Cache effect

Prefix-stable while the preset's mounted tools and their guidance stay unchanged; a preset switch invalidates reuse from the first changed token.

### Tool schemas

#### What the model sees

Exactly the generated [`read`, `write`, `edit`, and one shell schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs) — `bash` off Windows, `pwsh` on it — with no `read_image` beside them: the pi row configures `dsh-tool-fs` with `imageReadMode: integrated`, so `read` advertises PNG/JPEG/WebP/GIF itself. The shell schema carries no `run_in_background` argument (`enableRunInBackground: false`).

#### Token effect

Fixed schema cost on every request in the tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged.

### Tool results

#### What the model sees

Text reads return the line-numbered window with its continuation footer; image reads return the image envelope beside the image itself; the shell returns exit codes and truncated-to-tail output with the full-output file path. A timeout or cancellation ends the command — no background job id is ever returned.

#### Token effect

Read caps and shell output truncation bound each result; retained calls and results are resent until compaction, which pi mounts unchanged from `standard`.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

## Known Limitations and Deferred Work

- **Skills are not published into pi** — the shipped skill catalog loads through `tool-skill`, which pi does not mount. A later version may add an explicit skill extension.
- **Extension-less image files stay on the text path** — integrated routing decides by extension, so an extension-less image is refused as binary by the filesystem provider instead of read as an image.
- **Desktop profiles initialized before this bundle keep their old layer list** — add the bundle from the Plugins page or `dsh plugin add`.

### Dev Note

[`tests/pi.spec.ts`](tests/pi.spec.ts) pins the declared composition: the four mounted tool rows, the foreground-only shell flags, integrated image routing, explicit native presentation, and the absence of every other model-facing tool row. The [`pi-preset` Web snapshot](../../../snapshots/web/pi-preset/) replays a keyless session asserting the four-tool request, both read shapes, and the browser cards.

**Runtime invariant:** No companion is published. This composition bundle mounts other packages' presets and services; every lifecycle and execution relation belongs to the packages it composes.
