---
layout: home
title: Home
permalink: /
---

## Give every AI agent its own VM — a 4-part series

AI agents run untrusted code and are steerable by attackers through the prompt. Model guardrails aren't a security boundary, and a container shares the host kernel. This series builds the boring, important thing that makes agents safe to run: **infrastructure that assumes the agent is hostile** — from an empty AWS account to an AI agent running in its own hardware-isolated microVM, on bare metal that costs **$0 when idle**.

Every part is written to be followed by **a human or an agent**: engaging to read, exact to execute (defined variables, verify gates, and a "🐛 What bit me" box in each).

1. **[Part 1 — AWS account → EKS Auto Mode](/part-1/)** — from nothing to a cluster that scales to zero.
2. **[Part 2 — OpenChoreo on EKS](/part-2/)** — the platform layer, and the four EKS-specific gotchas.
3. **[Part 3 — Bare-metal Kata Containers that scale to zero](/part-3/)** — hardware isolation, on demand, at $0 idle.
4. **[Part 4 — agent-sandbox + a live security demo](/part-4/)** — the agent tries to escape its VM and writes its own failed pentest report.

**Companion repo (copy-paste manifests):** [github.com/Ketharan/agent-sandbox-eks](https://github.com/Ketharan/agent-sandbox-eks)

---
