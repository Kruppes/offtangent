# Memory View API

Reference for the read-only structured view over what the instance knows:
`GET /api/memory/tree`, `GET /api/memory/facts?node=...`,
`GET /api/memory/graph` and `GET /api/memory/fact/:id` (Offtangent SPEC 6.4).

These four endpoints replace the flat counters and the chronological fact
list in clients. They are JWT protected (`Authorization: Bearer <access
token>`) and readable by every logged-in user; the other `/api/memory/*`
endpoints stay admin only. Errors are
`{ "error": "<message>", "code": "<machine code>" }`.

Nothing here writes. Editing facts and wiki pages stays on the admin
endpoints.

## Scope

| Caller | Facts included |
|---|---|
| role `admin` | every fact in the instance |
| role `user` | facts with `user_id = <caller>` or `user_id IS NULL` |

`agent_id=<persona>` narrows a request to `agent_id IN (<persona>,
'shared')`. Without it, every persona is included.

## Node ids

| Prefix | Meaning |
|---|---|
| `wiki:<path>` | a wiki page, path relative to `memory/wiki` without `.md` |
| `folder:<path>` | a directory below `memory/wiki` |
| `bucket:unassigned` | facts that no rule could place |
| `strand:<id>` | a strand, graph only |

## How the tree is derived

Nothing is hardcoded. The tree comes out of the files:

1. **Pages** are the `.md` files under `memory/wiki` (recursive, at most 4
   levels and 500 files). Title is the first `# ` heading, aliases come from
   the frontmatter `aliases:` list.
2. **Folders** become nodes, and a page inside a folder is a child of it.
3. **Hub pages**: a top-level page with at least 3 links to other wiki pages
   may adopt children. A page linked by a hub becomes its child. With several
   candidates, the hub with the fewest outgoing links wins (ties by id).
4. Everything else stays at the root.
5. **Facts** attach to a page when the normalized fact text contains one of
   the page terms (file name, title or an alias) as a whole phrase. The
   longest matching term wins (ties by node id). That is `matchedBy: "term"`.
6. A fact that names no page inherits the node of its strand when at least 2
   term matched facts of that strand point at one node and that node has at
   least twice the matches of the runner up (`matchedBy:
   "strand_majority"`). Facts are usually extracted from a strand about one
   subject without naming it.
7. A fact that is still unplaced is matched by embedding similarity
   (`matchedBy: "embedding"`, see below).
8. Everything else stays in `bucket:unassigned` (`matchedBy: "none"`).

The rules are ordered: a term match always wins over a strand majority, and
both win over the semantic rule. `notes` reports the share that stays
unassigned.

## Semantic assignment

Text rules only place a fact that names its page, which extracted facts
usually do not do. The semantic rule closes part of that gap with the
embeddings the fact store already has.

- Every wiki page is embedded with the same endpoint and model as the facts
  (`memoryEmbeddings` in `settings.json`). A page is embedded in overlapping
  windows of 1200 characters (200 overlap, at most 12 per page), each window
  prefixed with title and aliases; a page scores as the best of its windows.
- Vectors are cached per page with a fingerprint of modification time and
  size, so a page is embedded again only when it changes or the model
  changes. The nearest page per fact and per strand centroid is cached with a
  signature over the whole page set.
- A fact is filed only when its own nearest page and the nearest page of its
  whole strand centroid are the same page, the strand cosine is at least
  `limits.embeddingMinScore` (default 0.65) and the fact cosine is at most
  0.20 below that floor. A weak or lonely neighbour stays unassigned.
- `embeddingScore` (fact) and `embeddingStrandScore` (strand centroid) are
  returned so a client can show confidence.

The floor can be tuned per instance with `memoryEmbeddings.assignMinScore`.
Calibration on a 4089 fact store with 116 wiki pages
(`qwen3-embedding:4b`), share of all facts assigned:

| Floor | Facts added by the rule | Total coverage |
|---|---|---|
| 0.55 | 1298 | 59.2 % |
| 0.60 | 1195 | 56.7 % |
| 0.65 | 917 | 49.9 % |
| 0.70 | 590 | 41.9 % |

A hand audit of 40 random facts filed at 0.65 found 3 clear mistakes, plus 4
debatable ones where a different page would also have been defensible. The
error rate rises quickly below 0.65, which is why that is the default.

Refreshing page vectors and matches is a background job: it runs at startup
and when a request finds the caches stale, never inside the request itself.
A request that arrives before the first refresh has finished sees the old
term and strand rules only and gets the semantic assignments on the next
request.

If the wiki has no hubs and no folders, the tree is flat and `notes` says so.
The tree is never deeper than what the data supports.

## `GET /api/memory/tree`

Query: `agent_id=<persona>` · `q=<filter>` · `only_with_facts=1`.

`q` matches title, path and aliases, keeps the ancestors of a match and the
whole subtree below it.

**200**

```json
{
  "generatedAt": "2026-09-13T16:40:00.000Z",
  "totals": {
    "nodes": 128, "pages": 90, "folders": 4,
    "facts": 4089, "assignedFacts": 2039, "unassignedFacts": 2050, "conflicts": 11,
    "byTerm": 555, "byStrandMajority": 567, "byEmbedding": 917
  },
  "limits": {
    "hubMinOutgoingLinks": 3, "conflictScanPerNode": 150, "wikiMaxPages": 500,
    "embeddingMinScore": 0.65, "embeddedPages": 799
  },
  "notes": ["Conflict detection compares at most 150 facts per node, newest first."],
  "nodes": [
    {
      "id": "wiki:index",
      "type": "page",
      "title": "Wiki Index",
      "path": "wiki/index.md",
      "aliases": [],
      "factCount": 3,
      "subtreeFactCount": 412,
      "conflictCount": 0,
      "linksOut": 61,
      "linksIn": 0,
      "updatedAt": "2026-09-13T09:12:44.000Z",
      "children": []
    }
  ]
}
```

`factCount` counts active facts on the node itself, `subtreeFactCount`
includes the children. `type` is `page`, `folder` or `bucket`.

`byTerm`, `byStrandMajority` and `byEmbedding` split `assignedFacts` by rule.
`limits.embeddedPages` is the number of stored page chunk vectors, 0 when
embeddings are disabled or the first refresh has not run yet.

**400** `unknown_agent`.

## `GET /api/memory/facts?node=<id>`

Query: `node=<id>` (required) · `limit=1..200` (default 50) ·
`cursor=<opaque>` · `q=<substring>` · `include_superseded=1` ·
`agent_id=<persona>`.

Facts come back newest first, grouped by node, never as a global stream.

**200**

```json
{
  "node": { "id": "wiki:looplab", "type": "page", "title": "Looplab", "path": "wiki/looplab.md" },
  "facts": [
    {
      "id": 4091,
      "content": "Looplab runs on port 3800",
      "userId": 1,
      "agentId": "main",
      "source": "extracted_fact",
      "provenance": "owner",
      "status": "active",
      "sessionKind": null,
      "observedAt": null,
      "supersessionKey": "looplab.port",
      "supersededBy": null,
      "createdAt": "2026-09-13 15:02:11",
      "strandId": "df5a3749-e644-4da4-9783-c0929104adb8",
      "strandTitle": "Bike routing",
      "nodeId": "wiki:looplab",
      "matchedBy": "term",
      "matchedTerm": "looplab",
      "embeddingScore": null,
      "embeddingStrandScore": null,
      "conflict": true,
      "conflictWith": [{ "id": 4090, "reason": "same_subject_key" }]
    }
  ],
  "total": 12,
  "limit": 50,
  "nextCursor": "MjAyNi0wOS0xMyAxNTowMjoxMXw0MDkx",
  "conflictScanLimit": 150
}
```

`matchedBy` is `term`, `strand_majority`, `embedding` or `none`.
`embeddingScore` and `embeddingStrandScore` are `null` unless `matchedBy` is
`embedding`.

`nextCursor` is opaque; pass it back unchanged. It is `null` on the last
page. A cursor from another node is rejected.

Without `node` the request falls through to the admin fact list
(`{ facts, total }`, admin only), which keeps its old behaviour.

**400** `invalid_cursor` · **400** `unknown_agent` · **404**
`node_not_found`.

## `GET /api/memory/graph`

Query: `root=<node id>` · `depth=1..2` (default 1) · `limit=1..300`
(default 120) · `agent_id=<persona>`.

Breadth-first from the root, or from all root nodes when `root` is omitted.
The node set is always capped: `truncated: true` means the cap cut the
traversal short.

**200**

```json
{
  "root": "wiki:index",
  "depth": 2,
  "nodeLimit": 120,
  "truncated": false,
  "nodes": [
    { "id": "wiki:index", "type": "page", "title": "Wiki Index", "factCount": 3, "conflictCount": 0, "depth": 0 },
    { "id": "strand:df5a3749", "type": "strand", "title": "Bike routing", "factCount": 7, "conflictCount": 0, "depth": 2 }
  ],
  "edges": [
    { "from": "wiki:index", "to": "wiki:looplab", "type": "wiki_link", "weight": 1 },
    { "from": "strand:df5a3749", "to": "wiki:looplab", "type": "fact_origin", "weight": 7 }
  ]
}
```

Edge types: `contains` (folder to page), `wiki_link` (page to page),
`fact_origin` (strand to node, `weight` is the number of facts).

**404** `node_not_found` for an unknown root.

## `GET /api/memory/fact/:id`

**200**

```json
{
  "fact": { "...": "same shape as in the fact list" },
  "node": { "id": "wiki:looplab", "type": "page", "title": "Looplab", "path": "wiki/looplab.md" },
  "origin": {
    "strandId": "df5a3749-e644-4da4-9783-c0929104adb8",
    "strandTitle": "Bike routing",
    "strandType": "interactive",
    "strandAgentId": "main",
    "startedAt": "2026-09-10 08:00:00",
    "lastActivity": "2026-09-13 15:04:00",
    "archived": false
  },
  "supersedes": [{ "id": 4090, "content": "Looplab runs on port 3700", "status": "superseded", "createdAt": "2026-08-01 10:00:00", "supersededBy": 4091 }],
  "supersededBy": null,
  "history": [{ "id": 4090, "...": "oldest first" }],
  "conflicts": [{ "id": 4093, "reason": "same_subject_key", "content": "Looplab runs on port 3900" }]
}
```

`history` is the chain for the `supersessionKey` (oldest first, at most 20
entries). Facts without a key fall back to the direct
superseded/superseding neighbours.

**400** `invalid_fact_id` · **404** `fact_not_found` (also when the fact
exists but belongs to another user).

## Conflict detection

Facts on the same node are compared pairwise, newest first, at most 150 per
node (`conflictScanLimit`). The result is deterministic, there is no model
call. The first matching rule wins:

| `reason` | Rule |
|---|---|
| `same_subject_key` | both facts are active and share a `supersession_key`. The write path retires the previous fact per key, so two active rows are a real contradiction |
| `negation` | the significant tokens agree (Jaccard >= 0.6, at least 2 shared) but exactly one side is negated |
| `value_mismatch` | the non-numeric tokens agree but the numbers differ |

Both partners of a pair carry `conflict: true` and list the other side in
`conflictWith`. Facts outside the scan window are reported without conflict
data.

## Caching

The backend caches the derived index per scope and rebuilds it when the fact
count, the highest fact id, the newest timestamp, the superseded count, the
number of wiki files, their newest mtime, the page signature, the similarity
floor or the number of cached fact matches changes. A rebuild over a wiki
with 116 pages and roughly 4000 facts takes about 150 ms, a cached read is a
signature comparison.

The page vector cache is separate and survives restarts. A refresh with
nothing to do costs about 40 ms and makes no network call. A full rebuild of
all page vectors depends on the embedding endpoint (about 6 minutes for 116
pages against a local qwen3-embedding:4b) and runs in the background.
