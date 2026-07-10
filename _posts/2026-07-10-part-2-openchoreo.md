---
layout: post
title: "Part 2 — Standing up OpenChoreo on EKS (an internal developer platform)"
date: 2026-07-10
permalink: /part-2/
tags: [kubernetes, aws, ai-agents, security, devops]
---

*Part 2 of 4. In [Part 1](/part-1/) we built an EKS Auto Mode cluster that scales to zero. Now we install [OpenChoreo](https://openchoreo.dev) — an open-source internal developer platform — on top of it. This is what turns a bare cluster into something a team (or an agent) can deploy onto without hand-writing Kubernetes YAML, and it's the substrate the "AI Agent" component type in Part 4 plugs into.*

Raw `kubectl` doesn't scale to a team shipping services *and* agents. OpenChoreo gives you projects, environments, component types, secrets, and a Backstage portal on top of Kubernetes. The official install guide targets a local k3d cluster; on EKS you hit **four specific things** that the guide doesn't warn you about. I'll flag each one loudly — they cost me hours so they won't cost you any.

> **Conventions recap** (from Part 1): `<PLACEHOLDERS>`, `export`ed `$VARS` reused throughout, **✅ Verify** gates, **🐛 gotcha** notes. Keep the same shell you used in Part 1 (or re-export `AWS_REGION` / `CLUSTER_NAME` and re-run `aws sso login`).

## What you'll have at the end of Part 2
- OpenChoreo **control plane + data plane** installed and healthy.
- The **Backstage console** reachable over HTTPS from your browser.
- A sample app serving public traffic — proof the data plane works.

## Versions used (pin these for reproducibility)
| Component | Version |
|-----------|---------|
| OpenChoreo charts | `1.1.1` |
| Gateway API CRDs | `v1.4.1` (experimental) |
| cert-manager | `v1.19.4` |
| External Secrets | `2.0.1` |
| kgateway | `v2.2.1` |
| OpenBao | `0.25.6` |
| ThunderID (IdP) | `0.28.0` |

```bash
# reuse from Part 1 (re-run if new shell)
export AWS_REGION=us-east-1
export CLUSTER_NAME=ai-agent-cluster
helm version --short && kubectl version --client   # helm v3.16+ needed
```

---

## Step 1 — Prerequisites (CRDs + operators)

```bash
# Gateway API (experimental channel — kgateway needs it)
kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.1/experimental-install.yaml

# cert-manager
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --namespace cert-manager --create-namespace --version v1.19.4 \
  --set crds.enabled=true --wait --timeout 180s

# External Secrets Operator
helm upgrade --install external-secrets oci://ghcr.io/external-secrets/charts/external-secrets \
  --namespace external-secrets --create-namespace --version 2.0.1 \
  --set installCRDs=true --wait --timeout 180s

# kgateway (CRDs + controller) — lives in the control-plane namespace
helm upgrade --install kgateway-crds oci://cr.kgateway.dev/kgateway-dev/charts/kgateway-crds \
  --create-namespace --namespace openchoreo-control-plane --version v2.2.1
helm upgrade --install kgateway oci://cr.kgateway.dev/kgateway-dev/charts/kgateway \
  --namespace openchoreo-control-plane --create-namespace --version v2.2.1 \
  --set controller.extraEnv.KGW_ENABLE_GATEWAY_API_EXPERIMENTAL_FEATURES=true

# OpenBao (secret backend) — this is the first thing that needs your Part 1 StorageClass
helm upgrade --install openbao oci://ghcr.io/openbao/charts/openbao \
  --namespace openbao --create-namespace --version 0.25.6 \
  --values https://raw.githubusercontent.com/openchoreo/openchoreo/release-v1.1/install/k3d/common/values-openbao.yaml \
  --wait --timeout 300s
```

Create the `ClusterSecretStore` that points External Secrets at OpenBao:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata: { name: external-secrets-openbao, namespace: openbao }
---
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata: { name: default }
spec:
  provider:
    vault:
      server: "http://openbao.openbao.svc:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "openchoreo-secret-writer-role"
          serviceAccountRef: { name: "external-secrets-openbao", namespace: "openbao" }
EOF
```

```bash
# ✅ Verify: OpenBao Running (proves the StorageClass works) and the store is Valid
kubectl get pod openbao-0 -n openbao
kubectl get clustersecretstore default   # READY should be True
```

## Step 2 — TLS certificate authority

OpenChoreo uses cert-manager to mint certs from a self-signed CA:

```bash
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: selfsigned-bootstrap }
spec: { selfSigned: {} }
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: openchoreo-ca, namespace: cert-manager }
spec:
  isCA: true
  commonName: openchoreo-ca
  secretName: openchoreo-ca-secret
  privateKey: { algorithm: ECDSA, size: 256 }
  issuerRef: { name: selfsigned-bootstrap, kind: ClusterIssuer }
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: openchoreo-ca }
spec: { ca: { secretName: openchoreo-ca-secret } }
EOF
kubectl wait --for=condition=Ready certificate/openchoreo-ca -n cert-manager --timeout=90s
```

## Step 3 — Control plane, first pass (and the webhook race 🐛)

Install with placeholder domains and TLS off — we'll rewrite these once we know the real domain:

```bash
helm upgrade --install openchoreo-control-plane oci://ghcr.io/openchoreo/helm-charts/openchoreo-control-plane \
  --version 1.1.1 --namespace openchoreo-control-plane --create-namespace \
  --values - <<'EOF'
openchoreoApi: { http: { hostnames: ["api.placeholder.tld"] } }
backstage:
  baseUrl: "https://console.placeholder.tld"
  secretName: backstage-secrets
  http: { hostnames: ["console.placeholder.tld"] }
security: { oidc: { issuer: "https://thunder.placeholder.tld" } }
gateway: { tls: { enabled: false } }
EOF
```

> 🐛 **This first install almost always fails** with `server-side apply failed … ClusterAuthzRoleBinding … no endpoints available for service "controller-manager-webhook-service"`. The chart applies its own custom resources before its controller's webhook is ready. It's a race, not a real error. Wait for the controller, then **re-run the exact same command** (it's idempotent):

```bash
kubectl rollout status deploy/controller-manager -n openchoreo-control-plane --timeout=180s
# now re-run the `helm upgrade --install openchoreo-control-plane ...` command above verbatim
```

## Step 4 — Make the gateway internet-facing, then derive the real domain 🐛

> 🐛 **EKS Auto Mode creates *internal* load balancers by default.** If you skip this, your console gets a private `192.168.x.x` address and you can't reach it from your laptop. Since the domain gets baked into TLS certs and OIDC URLs, decide this **now**.

```bash
helm upgrade openchoreo-control-plane oci://ghcr.io/openchoreo/helm-charts/openchoreo-control-plane \
  --version 1.1.1 --namespace openchoreo-control-plane --reuse-values \
  --values - <<'EOF'
gateway:
  infrastructure:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "external"
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
      service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
EOF
```

Wait for the public NLB, then compute the `nip.io` domain from its IP:

```bash
# poll until the NLB resolves to a PUBLIC ip (not 10./172.16-31/192.168)
HN=""; CP_LB_IP=""
until [ -n "$CP_LB_IP" ]; do
  HN=$(kubectl get svc gateway-default -n openchoreo-control-plane -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
  [ -n "$HN" ] && CP_LB_IP=$(dig +short "$HN" | grep -E '^[0-9]' | grep -vE '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1)
  sleep 10
done
export CP_BASE_DOMAIN="openchoreo.${CP_LB_IP//./-}.nip.io"
echo "CP_BASE_DOMAIN=$CP_BASE_DOMAIN"
```

## Step 5 — Control-plane TLS certificate 🐛

```bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: cp-gateway-tls, namespace: openchoreo-control-plane }
spec:
  secretName: cp-gateway-tls
  issuerRef: { name: openchoreo-ca, kind: ClusterIssuer }
  dnsNames: ["*.${CP_BASE_DOMAIN}", "${CP_BASE_DOMAIN}"]
  privateKey: { rotationPolicy: Always }   # 🐛 the doc says "AlwaysRotate" — invalid on cert-manager >= 1.18
EOF
kubectl wait --for=condition=Ready certificate/cp-gateway-tls -n openchoreo-control-plane --timeout=90s
```

## Step 6 — Identity provider (ThunderID)

Thunder's config is templated for k3d URLs; rewrite them to your domain on the way in:

```bash
curl -fsSL https://raw.githubusercontent.com/openchoreo/openchoreo/release-v1.1/install/k3d/common/values-thunder.yaml \
| sed "s#http://thunder.openchoreo.localhost:8080#https://thunder.${CP_BASE_DOMAIN}#g" \
| sed "s#thunder.openchoreo.localhost#thunder.${CP_BASE_DOMAIN}#g" \
| sed "s#http://openchoreo.localhost:8080#https://console.${CP_BASE_DOMAIN}#g" \
| sed "s#port: 8080#port: 443#g" \
| sed 's#scheme: "http"#scheme: "https"#g' \
| helm upgrade --install thunder oci://ghcr.io/asgardeo/helm-charts/thunder \
    --namespace thunder --create-namespace --version 0.28.0 --values -
kubectl wait -n thunder --for=condition=available --timeout=300s deployment -l app.kubernetes.io/name=thunder
```

## Step 7 — Backstage secrets

```bash
kubectl apply -f - <<'EOF'
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: backstage-secrets, namespace: openchoreo-control-plane }
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: default }
  target: { name: backstage-secrets }
  data:
    - { secretKey: backend-secret,  remoteRef: { key: backstage-backend-secret,  property: value } }
    - { secretKey: client-secret,   remoteRef: { key: backstage-client-secret,   property: value } }
    - { secretKey: jenkins-api-key, remoteRef: { key: backstage-jenkins-api-key, property: value } }
EOF
kubectl get externalsecret backstage-secrets -n openchoreo-control-plane   # READY -> True
```

## Step 8 — Reconfigure the control plane with real domains + TLS

```bash
helm upgrade openchoreo-control-plane oci://ghcr.io/openchoreo/helm-charts/openchoreo-control-plane \
  --version 1.1.1 --namespace openchoreo-control-plane --reuse-values \
  --values - <<EOF
openchoreoApi:
  config:
    server: { publicUrl: "https://api.${CP_BASE_DOMAIN}" }
    security: { authentication: { jwt: { jwks: { skip_tls_verify: true } } } }
  http: { hostnames: ["api.${CP_BASE_DOMAIN}"] }
backstage:
  secretName: backstage-secrets
  baseUrl: "https://console.${CP_BASE_DOMAIN}"
  http: { hostnames: ["console.${CP_BASE_DOMAIN}"] }
  auth: { redirectUrls: ["https://console.${CP_BASE_DOMAIN}/api/auth/openchoreo-auth/handler/frame"] }
  extraEnv: [ { name: NODE_TLS_REJECT_UNAUTHORIZED, value: "0" } ]
security:
  oidc:
    issuer: "https://thunder.${CP_BASE_DOMAIN}"
    jwksUrl: "https://thunder.${CP_BASE_DOMAIN}/oauth2/jwks"
    authorizationUrl: "https://thunder.${CP_BASE_DOMAIN}/oauth2/authorize"
    tokenUrl: "https://thunder.${CP_BASE_DOMAIN}/oauth2/token"
gateway:
  infrastructure:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "external"
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
      service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
  tls:
    enabled: true
    hostname: "*.${CP_BASE_DOMAIN}"
    certificateRefs: [ { name: cp-gateway-tls } ]
EOF

# point Thunder's route at the real hostname, then wait for convergence
helm upgrade thunder oci://ghcr.io/asgardeo/helm-charts/thunder \
  --namespace thunder --version 0.28.0 --reuse-values \
  --set "httproute.hostnames[0]=thunder.${CP_BASE_DOMAIN}"
kubectl wait -n openchoreo-control-plane --for=condition=available --timeout=300s deployment --all
kubectl wait -n openchoreo-control-plane --for=condition=Ready certificate/cluster-gateway-ca --timeout=120s
```

## Step 9 — Default platform resources

```bash
kubectl label namespace default openchoreo.dev/control-plane=true --overwrite
kubectl apply -f https://raw.githubusercontent.com/openchoreo/openchoreo/release-v1.1/samples/getting-started/all.yaml
```

## Step 10 — Data plane (install + register)

```bash
# namespace + copy the control-plane CA in
kubectl create namespace openchoreo-data-plane --dry-run=client -o yaml | kubectl apply -f -
kubectl get secret cluster-gateway-ca -n openchoreo-control-plane -o jsonpath='{.data.ca\.crt}' | base64 -d \
 | kubectl create configmap cluster-gateway-ca --from-file=ca.crt=/dev/stdin -n openchoreo-data-plane --dry-run=client -o yaml | kubectl apply -f -

# install (internet-facing, TLS off first)
helm upgrade --install openchoreo-data-plane oci://ghcr.io/openchoreo/helm-charts/openchoreo-data-plane \
  --version 1.1.1 --namespace openchoreo-data-plane --create-namespace \
  --set gateway.tls.enabled=false \
  --set 'gateway.infrastructure.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-type=external' \
  --set 'gateway.infrastructure.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-nlb-target-type=ip' \
  --set 'gateway.infrastructure.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-scheme=internet-facing'

# derive the apps domain from the DP public NLB
HN=""; DP_LB_IP=""
until [ -n "$DP_LB_IP" ]; do
  HN=$(kubectl get svc gateway-default -n openchoreo-data-plane -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
  [ -n "$HN" ] && DP_LB_IP=$(dig +short "$HN" | grep -E '^[0-9]' | grep -vE '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1)
  sleep 10
done
export DP_DOMAIN="apps.openchoreo.${DP_LB_IP//./-}.nip.io"; echo "DP_DOMAIN=$DP_DOMAIN"

# DP TLS cert, then enable TLS
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: dp-gateway-tls, namespace: openchoreo-data-plane }
spec:
  secretName: dp-gateway-tls
  issuerRef: { name: openchoreo-ca, kind: ClusterIssuer }
  dnsNames: ["*.${DP_DOMAIN}", "${DP_DOMAIN}"]
  privateKey: { rotationPolicy: Always }
EOF
kubectl wait --for=condition=Ready certificate/dp-gateway-tls -n openchoreo-data-plane --timeout=90s
helm upgrade openchoreo-data-plane oci://ghcr.io/openchoreo/helm-charts/openchoreo-data-plane \
  --version 1.1.1 --namespace openchoreo-data-plane --reuse-values \
  --values - <<EOF
gateway: { tls: { enabled: true, hostname: "*.${DP_DOMAIN}", certificateRefs: [ { name: dp-gateway-tls } ] } }
EOF

# register the data plane with the control plane
kubectl wait -n openchoreo-data-plane --for=jsonpath='{.data.ca\.crt}' secret/cluster-agent-tls --timeout=120s
AGENT_CA=$(kubectl get secret cluster-agent-tls -n openchoreo-data-plane -o jsonpath='{.data.ca\.crt}' | base64 -d)
DP_HTTP_PORT=$(kubectl get gateway gateway-default -n openchoreo-data-plane -o jsonpath='{.spec.listeners[?(@.name=="http")].port}')
DP_HTTPS_PORT=$(kubectl get gateway gateway-default -n openchoreo-data-plane -o jsonpath='{.spec.listeners[?(@.protocol=="HTTPS")].port}')
kubectl apply -f - <<EOF
apiVersion: openchoreo.dev/v1alpha1
kind: ClusterDataPlane
metadata: { name: default }
spec:
  planeID: default
  clusterAgent:
    clientCA:
      value: |
$(echo "$AGENT_CA" | sed 's/^/        /')
  secretStoreRef: { name: default }
  gateway:
    ingress:
      external:
        http:  { host: ${DP_DOMAIN}, listenerName: http,  port: ${DP_HTTP_PORT} }
        https: { host: ${DP_DOMAIN}, listenerName: https, port: ${DP_HTTPS_PORT} }
        name: gateway-default
        namespace: openchoreo-data-plane
EOF
```

## Step 11 — Verify end-to-end

```bash
# console + IdP reachable
curl -k -s -o /dev/null -w 'console: %{http_code}\n' "https://console.${CP_BASE_DOMAIN}"
curl -k -s -o /dev/null -w 'thunder jwks: %{http_code}\n' "https://thunder.${CP_BASE_DOMAIN}/oauth2/jwks"

# deploy a sample app and hit it over public HTTPS
kubectl apply -f https://raw.githubusercontent.com/openchoreo/openchoreo/release-v1.1/samples/from-image/react-starter-web-app/react-starter.yaml
kubectl wait --for=condition=available deployment -l openchoreo.dev/component=react-starter -A --timeout=240s
HOST=$(kubectl get httproute -A -l openchoreo.dev/component=react-starter -o jsonpath='{.items[0].spec.hostnames[0]}')
curl -k -s -o /dev/null -w "react-starter: %{http_code}\n" "https://${HOST}"
```

**✅ Verify:** console → `200`, thunder jwks → `200`, react-starter → `200`.

Open **`https://console.${CP_BASE_DOMAIN}`** in a browser (accept the self-signed cert warning) and log in with **`admin@openchoreo.dev`** / **`Admin@123`**.

---

## 🐛 What bit me

1. **`rotationPolicy: AlwaysRotate` is invalid** on cert-manager ≥ 1.18 — the value is `Always`. The k3d guide's value fails validation on a modern cert-manager.
2. **Auto Mode LBs are internal by default** — set `gateway.infrastructure.annotations` for an internet-facing NLB, and do it *before* issuing the TLS cert (the domain is baked into the cert SANs and every OIDC URL).
3. **The control-plane chart races its own webhook** on first install — wait for `controller-manager`, then re-run `helm upgrade`. Idempotent.
4. **nip.io is pinned to the NLB IP.** If the NLB is ever recreated, the IP changes and the certs / OIDC URLs / `ClusterDataPlane` all need updating. For anything long-lived, use a real domain (Route 53 + a publicly-trusted cert) instead of nip.io.
5. **Change that default password** — but note Thunder 0.28.0's `PUT /users/{id}` is broken (schema-validation error on a unique-email self-collision). To rotate a password you **delete + recreate the user**, then delete + recreate its group with the new user id (group membership is only settable at creation). Save that for after the demo.

---

## Recap & next

OpenChoreo is live: control plane, data plane, a reachable console, and a sample app serving public HTTPS. Everything so far runs on shared-kernel Auto Mode nodes.

**Next → [Part 3: Bare-metal Kata Containers that scale to zero](/part-3/)** — we add the hardware isolation boundary that makes it safe to run untrusted AI agents, without paying for bare metal 24/7.

*(Full helm values files are in the [companion repo](https://github.com/Ketharan/agent-sandbox-eks) under `02-openchoreo/`.)*
