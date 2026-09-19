# Guide

Welcome to the Offtangent user guide. Start with the basics, then go as deep as you want.

## Getting Started

- [**Quickstart**](./quickstart) — Get running in 5 minutes with Docker.
- [**Deployment**](./deployment) — Where to run it: Linux, macOS with or without Docker, proxy, backups.
- [**Configuration**](./configuration) — The three config layers (env, JSON, secrets) and what goes where.
- [**LLM Providers**](../web-ui/providers) — Connect OpenAI, Anthropic, Ollama, or any OpenAI-compatible API.

## Core Concepts

- [**Memory System**](../concepts/memory) — How the agent remembers things across conversations.
- [**Skills**](../concepts/skills) — Extend the agent with reusable capabilities.
- [**Tasks & Cronjobs**](../concepts/tasks-and-cronjobs) — Background jobs, scheduled work, one-shot reminders.
- [**Built-in Tools**](../concepts/tools) — `web_search`, `web_fetch`, `transcribe_audio`, and the rest.

## Web Interface

- [**Overview**](../web-ui/) — The Nuxt 3 frontend: layout, navigation, sidebar pages.
- [**Dashboard**](../web-ui/dashboard) — Provider health, activity, and system overview.
- [**Chat**](../web-ui/chat) — The main conversation view.
- [**Tasks**](../web-ui/tasks) — List, inspect, and restart background tasks.

## Other interfaces

- [**Telegram Bot**](./telegram) — Talk to the agent from your phone.

## Reference

- [Environment Variables](../reference/env-vars)
- [`settings.json` schema](../reference/settings)
- [File Paths](../reference/file-paths)
