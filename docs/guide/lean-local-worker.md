# Lean local worker (`lean_local`)

`lean_local` is a worker profile for small, bounded jobs on a **local** model: pull a total out of a file, classify a mail, list the ids that match a rule. The goal is to save cloud tokens and keep the local prompt short, so a local model should start faster (expected, not measured, see [Limits](#limits)). It is an **efficiency profile, not an isolation boundary** (see [Limits](#limits)).

## How to use it

Pass `worker_profile: "lean_local"` to `create_task`, or to `create_cronjob` with `action_type: "task"`. Two things are required:

- **`output_schema`**: a JSON Schema of `type: "object"`, as a JSON string, inside the supported dialect below. It is the result contract.
- **A local provider and model**, pinned explicitly (e.g. provider `Ollama`). A provider counts as local only when its configured URL, its preset URL and the URL the model is actually built with all point at a loopback or private address. OAuth/subscription providers are never local.

```
create_task(
  name: "Invoice total",
  prompt: "Read /workspace/inbox/invoice-0815.txt and return the gross total.",
  worker_profile: "lean_local",
  provider: "Ollama", model: "qwen3.8:27b-mlx",
  output_schema: '{"type":"object","required":["total"],"properties":{"total":{"type":"string"}}}'
)
```

### Supported schema dialect

A lean task only accepts a schema that is valid **and** inside this JSON Schema subset; everything else is refused before the model runs (at creation, run start, recovery and before a result is accepted):

- `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, or a list of them)
- objects: `properties`, `required` (list of names), `additionalProperties` (boolean or schema), `minProperties`, `maxProperties`
- arrays: `items` (one schema, no tuple form), `minItems`, `maxItems`, `uniqueItems`
- strings: `minLength`, `maxLength`, `pattern` (must compile as a JavaScript regex with the `u` flag), `format` (`date`, `date-time`, `time`, `email`, `uri`, `uuid`, `ipv4`, `ipv6`, `hostname`)
- numbers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (numbers), `multipleOf` (> 0)
- any: `enum`, `const`, `anyOf`, `oneOf`, `allOf`
- annotations: `title`, `description`, `$comment`, `$schema`, `default`, `examples`

Not supported: `$ref`/`$defs`, `not`, `if`/`then`/`else`, `patternProperties`, `prefixItems`, `dependent*`, `unevaluated*`, unknown keywords and unknown formats. Normal tasks keep their previous, permissive schema handling.

Put everything the worker needs (paths, ids, the exact question) into `prompt`: it sees no chat history, no memory and no skills.

## What changes compared to a normal task

- **Short, fixed system prompt**, the same bytes for every lean task, so the local server can reuse its prompt cache. No task guidelines, memory reference, skill index or persona files.
- **Five tools only**: `read_file`, `list_files`, `shell`, `email_list`, `email_read`. No `create_task`, no web tools, no mail sending.
- **No reviewer round.**
- **No cloud fallback.** A missing or unusable schema, or a provider that is not local, refuses the task at creation, at run start (cronjob runs) and at server-restart recovery. The task fails instead of moving to the default provider.

## What comes back

- **Success**: the SUMMARY must satisfy the schema. If it does not, the worker gets exactly one correction round. The returned result is only the validated JSON object, compact (`{"total":"12.50"}`); prose around it is dropped.
- **Anything else** (failed, question, schema still not met, error, abort, handoff) is capped at 2000 characters. The beginning is kept and the cut is stated, so a question stays a question and can be answered with `resume_task`.
- If the stored schema becomes unusable (e.g. a damaged row), the task fails; it never accepts an unvalidated result.

## Limits

- **Not a privacy boundary.** The validated result goes to the coordinating agent, which may run in the cloud. `shell` can do whatever a shell can, including network access. The read tools (`get_task`, `recall_message`, `read_chat_history`) hide lean transcripts from callers that do not run locally, but not every path is covered: automatic summaries, local tasks acting as a proxy and oversized tool output saved to files can still expose raw content. Do not use `lean_local` to keep data away from cloud models.
- **Speed-up is not measured.** The system prompt is much shorter than the normal task prompt (about 2.8k instead of 20k+ characters), which makes faster prefill plausible, but no benchmark on real hardware exists yet.
- **No size limit on a successful result.** Only non-success texts are capped at 2000 characters. A validated success is returned in full, so a large schema result (long strings, big arrays) still costs orchestrator context. Bound the result in the schema itself (`maxLength`, `maxItems`, few fields).
- **Small jobs only.** One clear question, a schema for the answer. Research, coding or anything that needs the web belongs in a normal task.
