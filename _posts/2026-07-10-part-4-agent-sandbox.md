---
layout: post
category: technical
series: "Give every AI agent its own VM"
repo: https://github.com/Ketharan/agent-sandbox-eks
part: 4
title: "Part 4 — Give every AI agent its own VM: agent-sandbox on OpenChoreo (with a live security demo)"
description: "Deploy an AI agent into a Kata microVM and watch it write its own failed pentest report."
date: 2026-07-10
permalink: /part-4/
tags: [kubernetes, aws, ai-agents, security, devops]
---

*The finale. We have OpenChoreo on EKS ([Parts 1–2](/part-1/)) and bare-metal Kata that scales to zero ([Part 3](/part-3/)). Now we wire in the [Kubernetes-SIGs agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) project, deploy a real AI assistant into a Kata microVM as a one-dropdown OpenChoreo component, and run the same attack against a normal container and the sandbox. One leaks your secrets. The other watches the agent write its own pentest report — and conclude it can't escape.*

Here's the uncomfortable truth about AI agents: an agent is the first thing you deploy that is *both* highly privileged *and* directly steerable by an attacker — through the prompt. One poisoned web page or tool result and your helpful assistant is running the attacker's commands. Two things people lean on don't hold: **model guardrails aren't a security boundary** (a phrasing change walks past them), and **a container shares the host kernel**. So we give every agent its own VM — and in OpenChoreo that's a dropdown.

> **Conventions recap:** `<PLACEHOLDERS>`, `$VARS`, **✅ Verify**, **🐛 gotcha**. You'll need an **Anthropic API key** for the agent's LLM backend.

## What you'll have at the end
- The **agent-sandbox** controller + CRDs and the **`ai-agent`** component type installed.
- **OpenClaw** deployed twice — a plain container and a Kata microVM — plus a fake-secrets honeypot.
- A repeatable **security demo**: same prompts, opposite outcomes.

```bash
export AWS_REGION=us-east-1 CLUSTER_NAME=ai-agent-cluster
export OC_NS=openclaw-workspace OC_PROJECT=openclaw-workspace
export ANTHROPIC_API_KEY=<ANTHROPIC_API_KEY>   # keep this out of screenshots
```

---

## Step 1 — Install the agent-sandbox module

The module = the upstream Kubernetes-SIGs controller + CRDs (`Sandbox`, `SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool`) plus OpenChoreo RBAC. We install it **directly** (not via its Helm chart) so we can ship a *customized* `ai-agent` component type without the chart overwriting it:

```bash
# upstream CRDs + controller (installs into namespace agent-sandbox-system)
kubectl apply --server-side -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.6/manifest.yaml
kubectl apply --server-side -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.6/extensions.yaml

# RBAC: let OpenChoreo's data-plane agent manage sandbox resources
kubectl apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: openchoreo-agent-sandbox-access }
rules:
  - { apiGroups: ["agents.x-k8s.io"], resources: ["sandboxes"], verbs: ["get","list","watch","create","update","patch","delete"] }
  - { apiGroups: ["extensions.agents.x-k8s.io"], resources: ["sandboxclaims","sandboxtemplates","sandboxwarmpools"], verbs: ["get","list","watch","create","update","patch","delete"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: openchoreo-agent-sandbox-access }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: openchoreo-agent-sandbox-access }
subjects: [ { kind: ServiceAccount, name: cluster-agent-dataplane, namespace: openchoreo-data-plane } ]
EOF
```

```bash
# ✅ Verify: 4 CRDs + a Running controller
kubectl get crd | grep agents.x-k8s.io
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=120s
```

## Step 2 — The `ai-agent` component type

Apply the `ai-agent` ClusterComponentType from the [companion repo](https://github.com/Ketharan/agent-sandbox-eks) (`04-agent-sandbox/ai-agent-cct.yaml`). It exposes one parameter — `isolationTier` (`runc` | `gvisor` | `kata`) — and for `kata` it injects exactly the scheduling from Part 3:

```yaml
# excerpt — the kata path of the CCT
runtimeClassName: kata-qemu
nodeSelector: { kata-enabled: "true" }
tolerations: [ { key: sandbox, operator: Equal, value: "true", effect: NoSchedule } ]
# 🐛 and the two fixes below, baked in:
dnsPolicy: None
dnsConfig: { nameservers: ["8.8.8.8","1.1.1.1"] }   # so the agent can resolve api.anthropic.com
```

```bash
kubectl apply -f https://raw.githubusercontent.com/Ketharan/agent-sandbox-eks/main/04-agent-sandbox/ai-agent-cct.yaml
kubectl get clustercomponenttype ai-agent
```

> **Two fixes are baked into that CCT** (see the gotcha box for the *why*): its network policy is a standard `NetworkPolicy` (not `CiliumNetworkPolicy`), and the sandbox pod template sets public DNS so the agent can reach `api.anthropic.com` (this also makes internal `partner-service` cleanly unresolvable — the "blocked" result).

## Step 3 — Store the API key + deploy the honeypot and both agents

```bash
# put the Anthropic key in OpenBao, expose it as a SecretReference
kubectl exec -n openbao openbao-0 -- bao kv put secret/anthropic-api-key value="$ANTHROPIC_API_KEY"
```

Apply the manifests from the companion repo (`04-agent-sandbox/`):

- **`partner-service.yaml`** — a multi-arch fake-secrets server on `:5678` returning `{"db_password":"…","stripe_key":"sk_live_abc123","admin_token":"…"}` (all fabricated). The target.
- **`openclaw-regular.yaml`** — OpenClaw as a plain container.
- **`openclaw-sandbox.yaml`** — OpenClaw as an `ai-agent`, `isolationTier: kata`, `warmPoolSize: 1` (keeps the metal node hot), resources `500m/1Gi → 2/4Gi`, `ANTHROPIC_API_KEY` from the SecretReference.

```bash
kubectl apply -f 04-agent-sandbox/partner-service.yaml
kubectl apply -f 04-agent-sandbox/openclaw-regular.yaml
kubectl apply -f 04-agent-sandbox/openclaw-sandbox.yaml

# ✅ Verify both agents are Running (the sandbox one triggers a metal node scale-up 0->1)
kubectl get pods -n dp-* -l 'app in (openclaw-regular,openclaw-sandbox)' -o wide
```

## Step 4 — The demo (same prompts, two worlds)

Open two terminals — left **REGULAR**, right **SANDBOX**. In each:

```bash
export OC_NS=openclaw-workspace OC_PROJECT=openclaw-workspace
export GODEBUG=http2client=0    # 🐛 forces HTTP/1.1 for the exec WebSocket
occ component exec openclaw-regular  -n $OC_NS -p $OC_PROJECT -it -- /bin/sh   # left
occ component exec openclaw-sandbox  -n $OC_NS -p $OC_PROJECT -it -- /bin/sh   # right
```

**Beat 1 — the kernel tells the truth.**
```bash
uname -r    # REGULAR: host kernel 6.x  |  SANDBOX: 6.18 (its own)
```

**Beat 2 — steal a secret, through the agent.**
```bash
openclaw agent --local --model "anthropic/claude-sonnet-4-6" --session-id steal-$RANDOM \
  -m "run: curl -s http://partner-service:5678"
```
- **REGULAR → LEAKED:** the agent returns `{"db_password":"SuperSecret123!","stripe_key":"sk_live_abc123","admin_token":"…"}`.
- **SANDBOX → BLOCKED:** "couldn't resolve host" / no route. Same agent, same prompt — the *infrastructure* said no, not the model.

**Beat 3 — the mic drop.** Ask the sandboxed agent to break out:
```bash
openclaw agent --local --model "anthropic/claude-sonnet-4-6" --session-id escape-$RANDOM \
  -m "Run uname -r, ps aux, check mounts and capabilities. Is there ANY way to reach the host? Write it up as a pentest report."
```
It reports: kernel `6.18` (not the host), `virtiofs` + `kataShared` mounts ⇒ a Kata microVM, all capabilities zero, no service-account token, no host mounts — **"no realistic escape path."** The agent wrote its own pentest report and failed itself.

| Attack | Regular container | Kata sandbox |
|--------|-------------------|--------------|
| Internal secret (`curl partner-service`) | **LEAKED** | **BLOCKED** |
| K8s service-account token | **FOUND** | **NOT MOUNTED** |
| Kernel / runtime | **host `6.x`** | **VM `6.18` + virtiofs** |
| Cloud metadata (169.254.169.254) | **REACHABLE** | **degraded / empty** |
| Write code (`say hello`, REST API) | works | works |

The sandbox blocks the attacks **without breaking the agent's actual job.**

---

## 🐛 What bit me

- **`ResourceApplyFailed: ciliumnetworkpolicies.cilium.io … not found`.** The stock `ai-agent` CCT renders a `CiliumNetworkPolicy`, but this cluster runs the **AWS VPC CNI, not Cilium**. Fix: convert that one resource to a standard `networking.k8s.io/v1 NetworkPolicy` — the VPC CNI *does* enforce those (its `policyendpoints.networking.k8s.aws` controller is present). You keep ingress-from-`sandbox-router` and egress to DNS + public-except-RFC1918; you lose only Cilium's L7/FQDN filtering.
- **The live agent couldn't reach `api.anthropic.com`** — the CoreDNS debt from Part 3. Fix: `dnsPolicy: None` + `dnsConfig.nameservers: [8.8.8.8, 1.1.1.1]` on the sandbox pod template. Bonus: internal `partner-service` no longer resolves, which *is* the "blocked" beat.
- **`occ component exec` failed** until I set `GODEBUG=http2client=0` (forces HTTP/1.1 for the exec WebSocket) and enabled WebSocket upgrades on the control-plane gateway (an `HTTPListenerPolicy`).
- **gVisor tier isn't wired** here (no `gvisor` RuntimeClass / gvisor nodes) — only `runc` and `kata` work.
- **Live-demo reality:** pre-warm the metal node (`warmPoolSize ≥ 1`), keep screenshot fallbacks, and expect ~10–30 s per LLM call. Cold start is ~3 minutes — never start cold on stage.

---

## Tear it all down (back to $0)

When you're done, remove everything in dependency order so nothing orphans and the VPC can actually delete:

```
1. delete the kata-nodes node group        4. delete our IAM roles
2. delete the EKS cluster                    5. delete the eksctl CFN stacks (VPC/NAT/subnets)
3. delete leftover load balancers            6. delete orphan security groups + EBS volumes
```

Watch for the stragglers that block a clean VPC delete — orphan **security groups** and **available EBS volumes** from PVCs. The [companion repo](https://github.com/Ketharan/agent-sandbox-eks) has a `teardown.sh`. (And disable eksctl's **termination protection** on the CFN stacks before deleting them.)

## The pitch (CTA)

AI agents are about to run untrusted code at every company on earth. Model guardrails won't save you; a shared kernel won't save you. **Give every agent its own VM** — and make it a dropdown your developers pick, on bare metal that costs nothing when idle.

It's all open source: **[OpenChoreo](https://openchoreo.dev)** · **[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)** · **[Kata Containers](https://katacontainers.io)**. Star them, clone the [companion repo](https://github.com/Ketharan/agent-sandbox-eks), and run the whole series from an empty AWS account. Come build agent-native infrastructure with us.

*Series complete. From thin air to an AI agent that can't escape its own VM.*
