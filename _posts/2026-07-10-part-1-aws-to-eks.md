---
layout: post
part: 1
title: "Part 1 — From zero to an AI-ready Kubernetes cluster: AWS account → EKS Auto Mode"
description: "Start from an empty AWS account and end with an EKS Auto Mode cluster that scales to zero."
date: 2026-07-10
permalink: /part-1/
tags: [kubernetes, aws, ai-agents, security, devops]
---

*This is Part 1 of a 4-part series that goes from an empty AWS account to an AI agent running inside its own hardware-isolated virtual machine — and failing to escape it. By the end of the series you'll have a real, cost-optimized platform: [OpenChoreo](https://openchoreo.dev) on EKS, bare-metal [Kata Containers](https://katacontainers.io) that scale to zero, and a one-dropdown "AI Agent" component type that boxes each agent inside a microVM.*

Everyone is shipping AI agents. They write code, run shell commands, call internal APIs — we gave them hands. That makes them the first thing you deploy that is *both* highly privileged *and* steerable by an attacker through the prompt. So we're going to build the boring, unglamorous thing that makes agents safe to run: **infrastructure that assumes the agent is hostile.**

We start at the very bottom: a Kubernetes cluster that's ready for this. No prior AWS or Kubernetes experience assumed.

---

## 📖 How to read this series

This series is written to be followed by **a human or an agent**.

- **Placeholders** look like `<THIS>` — replace them before running.
- **Variables** you `export` once are reused throughout; keep the same shell (or re-export them).
- **✅ Verify** blocks are gates: the output should match before you move on.
- **🐛 gotcha** notes are real problems we hit — don't skip them.
- **🧑 Human step** = needs a person (a browser, a credit card). **🤖 Scriptable** = an agent can run it headless.
- Every part ends with a **copy-paste run script** that concatenates the commands.

> ⚠️ **This costs real money while it runs.** By the end of the series: EKS control plane ~$0.10/hr, a NAT gateway ~$0.045/hr, and — only while an agent is actually running — a bare-metal node ~$2.18/hr. Part 4 tears everything down to $0. Set the budget alarm in Step 1.

---

## What you'll have at the end of Part 1

- An **EKS Auto Mode** cluster that provisions nodes on demand and **scales to zero** when idle.
- `kubectl` wired up and verified against it.
- A default **StorageClass** (needed by everything in Part 2).

## Prerequisites (tools)

| Tool | Min version | Install |
|------|-------------|---------|
| AWS CLI | v2 | `brew install awscli` / [installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| eksctl | 0.210+ | `brew install eksctl` / [install](https://eksctl.io/installation/) |
| kubectl | 1.32+ | `brew install kubectl` |

```bash
# ✅ Verify tools are present
aws --version && eksctl version && kubectl version --client
```

---

## Step 1 — Create and secure the AWS account 🧑 Human step

An agent can't sign up for AWS (it needs an email, a credit card, and a phone). A human does this once:

1. Sign up at [aws.amazon.com](https://aws.amazon.com/) → create the account.
2. **Turn on MFA for the root user, then stop using root.**
3. Open **IAM Identity Center**, create a user with the **AdministratorAccess** permission set, and note your **AWS access portal URL**.
4. **Set a budget alarm:** Billing → Budgets → create a $50/month cost budget with an email alert. Cheap insurance against a forgotten bare-metal node.

Everything after this is 🤖 scriptable.

## Step 2 — Authenticate the CLI

```bash
aws configure sso          # one-time: enter your access-portal URL + region (us-east-1)
aws sso login              # opens a browser to authorize this session
```

```bash
# ✅ Verify you're authenticated as an admin identity
aws sts get-caller-identity --query 'Arn' --output text
# Expected: an ARN ending in /<your-sso-user>, e.g. .../AWSReservedSSO_AdministratorAccess.../you@example.com
```

Set the variables the rest of Part 1 uses:

```bash
export AWS_REGION=us-east-1
export CLUSTER_NAME=ai-agent-cluster   # pick any name
```

## Step 3 — Create the EKS Auto Mode cluster 🤖

We use **EKS Auto Mode**: AWS manages the compute (Karpenter under the hood), CNI, kube-proxy, CoreDNS, load balancing, and storage. You get nodes that appear when a pod needs one and **disappear when idle** — no node groups to babysit. `eksctl` sets up the VPC and all the IAM roles correctly, which (as you'll see in the gotcha box) is the safe way to do it.

Write the cluster config:

```bash
cat > auto-mode-cluster.yaml <<EOF
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: ${CLUSTER_NAME}
  region: ${AWS_REGION}
  version: "1.32"
autoModeConfig:
  enabled: true            # creates the node role + general-purpose & system node pools
EOF

eksctl create cluster -f auto-mode-cluster.yaml
```

This takes **~15–20 minutes** (control plane + VPC + IAM). eksctl also points your `kubectl` at the new cluster when it finishes.

```bash
# ✅ Verify kubectl reaches the cluster and Auto Mode node pools exist
kubectl config current-context          # -> ...:cluster/<CLUSTER_NAME>
kubectl get nodepools                    # -> general-purpose, system
```

> **`kubectl get nodes` may be empty — that's correct.** Auto Mode is scale-to-zero: no pending pods, no nodes. It's not broken; it's frugal.

## Step 4 — Watch a node appear (and disappear)

Prove the scale-from-zero behavior with a throwaway workload:

```bash
kubectl create deployment hello --image=public.ecr.aws/nginx/nginx:latest
kubectl wait --for=condition=available deployment/hello --timeout=180s
kubectl get nodes -o wide                # a Bottlerocket node is now present
kubectl delete deployment hello          # node will be reclaimed a few minutes later
```

```bash
# ✅ Verify the node that appeared is a real, Ready EKS Auto node
kubectl get nodes -L eks.amazonaws.com/compute-type
# Expected: STATUS Ready, COMPUTE-TYPE "auto"
```

## Step 5 — Create a default StorageClass 🤖

Auto Mode does **not** ship a default StorageClass, and Kubernetes 1.32+ no longer has the old in-tree EBS provisioner. Anything with a PersistentVolumeClaim — like OpenBao in Part 2 — will hang in `Pending` forever without this. Fix it now:

```bash
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: auto-ebs-sc
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.eks.amazonaws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
EOF
```

```bash
# ✅ Verify a default StorageClass exists
kubectl get storageclass
# Expected: auto-ebs-sc (default)   ebs.csi.eks.amazonaws.com ...
```

---

## 🐛 What bit me

- **Auto Mode nodes silently refused to launch.** On a cluster I *didn't* create with eksctl, nodes never appeared and the `NodeClass` was stuck on `InstanceProfileCreationFailed`. Root cause: the Auto Mode **cluster IAM role had zero policies attached.** Auto Mode needs five: `AmazonEKSClusterPolicy`, `AmazonEKSComputePolicy`, `AmazonEKSBlockStoragePolicy`, `AmazonEKSLoadBalancingPolicy`, `AmazonEKSNetworkingPolicy`. **eksctl attaches these for you** — but if you create the cluster via the console (or nodes never appear), check it:
  ```bash
  # troubleshooting only
  ROLE=$(aws eks describe-cluster --name $CLUSTER_NAME --region $AWS_REGION \
    --query 'cluster.roleArn' --output text | awk -F/ '{print $NF}')
  aws iam list-attached-role-policies --role-name "$ROLE" \
    --query 'AttachedPolicies[].PolicyName'
  # If empty, attach the five policies above with: aws iam attach-role-policy ...
  ```
- **Don't bolt plain managed node groups onto an Auto Mode cluster casually.** A mismatched pair (standard nodes using the Auto node role) fails to join with *"Instances failed to join the kubernetes cluster."* We'll add a standard node group the *right* way in Part 3 — for Kata — and it takes real care.

---

## Recap & next

You have an EKS Auto Mode cluster that scales to zero, `kubectl` verified against it, and a working default StorageClass. Total moving parts: one `eksctl` command and one StorageClass.

**Next → [Part 2: Standing up OpenChoreo on EKS](/part-2/)** — the internal developer platform that turns this cluster into something a team (and an agent) can deploy onto without hand-writing Kubernetes YAML.

---

## Appendix — full run script (Steps 2–5)

For an agent or the impatient. Assumes tools installed and `aws sso login` done.

```bash
set -euo pipefail
export AWS_REGION=us-east-1
export CLUSTER_NAME=ai-agent-cluster

aws sts get-caller-identity --query 'Arn' --output text

cat > auto-mode-cluster.yaml <<EOF
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: ${CLUSTER_NAME}
  region: ${AWS_REGION}
  version: "1.32"
autoModeConfig:
  enabled: true
EOF
eksctl create cluster -f auto-mode-cluster.yaml

kubectl get nodepools

kubectl apply -f - <<'YAML'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: auto-ebs-sc
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.eks.amazonaws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
YAML

kubectl get storageclass
echo "Part 1 complete: Auto Mode cluster '${CLUSTER_NAME}' ready with a default StorageClass."
```
