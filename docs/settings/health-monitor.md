# Health Monitor

Offtangent can ping the active LLM provider on a schedule, mark it `healthy` / `degraded` / `down`, and **automatically fall back** to another provider when the active one misbehaves. This panel controls that loop.

**URL:** `/settings?tab=healthMonitor`

## Enabled

Master toggle. When off, no health checks run and the topbar health badge turns neutral.

```json
{
  "healthMonitor": {
    "enabled": true
  }
}
```

## Health check interval

How often each provider gets pinged, in minutes. Default: `5`.

```json
{
  "healthMonitor": {
    "intervalMinutes": 5
  }
}
```

## Fallback trigger

When to consider a provider bad enough to switch away from it.

| Value      | Meaning                                                           |
|------------|-------------------------------------------------------------------|
| `down`     | Only fall back when the provider is fully unreachable / erroring. |
| `degraded` | Fall back on slow responses or partial failures too.              |

Choose `degraded` if your users notice latency, `down` if you'd rather tolerate some slowness than bounce between providers. Default: `down`.

```json
{
  "healthMonitor": {
    "fallbackTrigger": "down"
  }
}
```

## Failures before fallback

How many consecutive failing checks are required before the monitor flips a provider to `down` and triggers the fallback. Minimum: `1`. Default: `1`.

Higher = slower reaction, fewer false positives.

```json
{
  "healthMonitor": {
    "failuresBeforeFallback": 1
  }
}
```

## Recovery check interval

Once a provider has fallen out, it gets re-checked on this shorter interval (in minutes) to see if it's back. Default: `1`.

```json
{
  "healthMonitor": {
    "recoveryCheckIntervalMinutes": 1
  }
}
```

## Successes before recovery

How many consecutive successful checks are required before marking the provider `healthy` again and allowing it back into the rotation. Default: `3`.

```json
{
  "healthMonitor": {
    "successesBeforeRecovery": 3
  }
}
```

## Notifications

Admin notifications the monitor can emit on state transitions, delivered through the agent's normal notification channels (e.g. Telegram if configured).

Each transition is a separate toggle:

| Key                 | Transition             | Default | Meaning                                                                 |
|---------------------|------------------------|---------|-------------------------------------------------------------------------|
| `healthyToDegraded` | Healthy → Degraded     | `false` | Provider started responding slowly or with partial failures.            |
| `degradedToHealthy` | Degraded → Healthy     | `false` | Provider recovered from a degraded state.                               |
| `degradedToDown`    | Degraded → Down        | `true`  | Provider went fully offline after being degraded.                       |
| `healthyToDown`     | Healthy → Down         | `true`  | Provider went fully offline without a degraded phase.                   |
| `downToFallback`    | Down → Fallback        | `true`  | Offtangent automatically switched to another provider.                       |
| `fallbackToHealthy` | Fallback → Healthy     | `true`  | Original provider recovered and was switched back in.                   |

Turn everything off if you prefer a silent, self-healing monitor.

```json
{
  "healthMonitor": {
    "notifications": {
      "healthyToDegraded": false,
      "degradedToHealthy": false,
      "degradedToDown": true,
      "healthyToDown": true,
      "downToFallback": true,
      "fallbackToHealthy": true
    }
  }
}
```
