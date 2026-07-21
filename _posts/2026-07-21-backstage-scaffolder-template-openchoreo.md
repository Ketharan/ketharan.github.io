---
layout: post
category: technical
title: "Hand-writing a Backstage scaffolder template for OpenChoreo"
description: "Author an OpenChoreo component-creation form by hand — the parameters, the create step, and how it hands off to the ClusterComponentType that renders the workload."
date: 2026-07-21
tags: [openchoreo, backstage, platform-engineering, kubernetes]
---

{% raw %}
OpenChoreo's developer portal is built on [Backstage](https://backstage.io/), and every "create a component" form you see is a [Backstage scaffolder template](https://backstage.io/docs/features/software-templates/). The portal can auto-generate one for a component type, but the moment your component needs a *tailored* form — a specific set of inputs, secrets, provider choices, a fixed image, no build steps — you'll want to write that template by hand.

This is a practical, section-by-section guide to authoring one from scratch. Every snippet is the real shape used to create components from a `ClusterComponentType` (CCT).

> 💡 **Standard Backstage vs OpenChoreo** — The *form-building machinery* in this post is stock Backstage: the `Template` kind, `parameters` as JSON-Schema pages, `dependencies`, the `${{ parameters / secrets / steps }}` templating, `output.links`. What's OpenChoreo-specific is the **payload**: the `openchoreo:component:create` step action, the `ProjectNamespaceField` and `Secret` field widgets, `inject-user-token`, and the whole `ClusterComponentType` model. On vanilla Backstage the *form* looks identical; only the step action and custom fields change.

## How component creation works: two phases

Before writing a line of the template, it helps to know what actually happens on submit — because the scaffolder is only half the story.

**01 · Create time — the scaffolder writes a declarative Component.** On submit, `openchoreo:component:create` renders *no* Kubernetes YAML. It writes an OpenChoreo `Component` that **references a CCT by name** and carries the workload shape you collected — image, env vars, file mounts, endpoints. Runs once. The CCT is only named here, never executed.

**02 · Render time — the CCT expands it into real resources.** On every deploy/reconcile, the controller looks up the named CCT and runs its `spec.resources` templates — blueprints full of `${…}` holes that pull the Component's values in — emitting the actual `Service`, `ConfigMap`, `ExternalSecret`, and more.

Those `${…}` holes are where the Component's data lands:

```yaml
# in the CCT — a blueprint with holes the Component fills
image: ${workload.container.image}                        # ← your containerImage
env: ${dependencies.toContainerEnvs()}                    # ← your envVars
volumeMounts: ${configurations.toContainerVolumeMounts()} # ← your fileMounts
```

So the two files meet at a thin contract — **a type name plus a workload shape** — and each `workloadDetails` feature only takes effect if the CCT has a template that consumes it:

| Scaffolder sends… | …only works if the CCT renders… |
|---|---|
| `containerImage` | `${workload.container.image}` (always present) |
| `envVars` (plain) | an env `ConfigMap` via `toConfigEnvsByContainer()` |
| `envVars` (secret) | an `ExternalSecret` via `toSecretEnvsByContainer()` |
| `fileMounts` | a file `ConfigMap` (`toConfigFileList()`) **+** volume mounts |
| `endpoints` | a `Service` + `HTTPRoute` block |

> ⚠️ **Fails silently** — Send a `fileMounts` to a CCT that has no file-config template and it is **silently ignored** — the scaffolder can only use capabilities the CCT is built to render.

### Do you need the CCT definition to write a scaffolder?

You don't *import* or embed it, and the **form** (`parameters`) is entirely yours — but you do need to **know** the CCT to write a working step:

- its `metadata.name` → your `componentType` (exact-match requirement);
- its kind and `workloadType` → your `component_type_kind` / `component_type_workload_type`;
- its **capability contract** → which of `envVars` / `fileMounts` / `endpoints` it actually renders, so you don't wire up inputs that go nowhere.

If you're adding a capability the CCT doesn't have yet (say a config-file mount), you edit *both*. Otherwise the scaffolder is written *against* an existing CCT you never touch. The dependency runs one way — **scaffolder → CCT** — and the CCT stands alone: a component can equally be created via the API or `kubectl`, with no scaffolder at all. The scaffolder is just a typed front door.

## The skeleton

A scaffolder template is a single YAML document of kind `Template`. Here's the top-level shape, with each block's job:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: create-ai-agent-gemini     # unique id (kebab-case)
  title: Gemini Agent              # shown on the portal card
  description: Run Gemini CLI interactively in a kernel-isolated sandbox.
  tags: [openchoreo, ai-agent, gemini]
spec:
  type: Component                  # what this template produces
  owner: openchoreo

  EXPERIMENTAL_formDecorators:     # optional
    - id: openchoreo:inject-user-token

  parameters: [ ... ]              # the form (what the user fills in)
  steps: [ ... ]                   # what happens on submit
  output: { ... }                  # links shown after success
```

Three parts do the real work, and the rest of this guide covers them in order:

- **`parameters`** — the form the user fills in.
- **`steps`** — the action that turns those inputs into a component.
- **`output`** — where you send the user afterward.

`EXPERIMENTAL_formDecorators: openchoreo:inject-user-token` is worth keeping: it injects the logged-in user's token so the create action runs *as them*, with their permissions.

## Building the form

`parameters` is an **array of pages**. Each page is a JSON-Schema object with a `title` (the step name in the wizard), a `properties` map (the fields), and an optional `required` list (which gates the Next button). A conventional layout: identity first, then the type-specific configuration.

### Page 1 — component metadata

```yaml
parameters:
  - title: Component Metadata
    required: [project_namespace, name]
    properties:
      project_namespace:
        title: Project & Namespace
        type: object
        ui:field: ProjectNamespaceField      # OpenChoreo custom widget
      name:
        title: Component Name
        type: string
        pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
        maxLength: 63
        ui:autofocus: true
      displayName: { title: Display Name, type: string }
      description: { title: Description, type: string }
```

- `ui:field: ProjectNamespaceField` is an OpenChoreo widget that renders a project/namespace picker and returns an object with `project_name` and `namespace_name` — you destructure those in the step.
- `pattern` + `maxLength` enforce a DNS-safe name client-side, before submit.
- `ui:autofocus` puts the cursor in the first meaningful field.

### Page 2 — typed configuration

Model the inputs unique to your component. Use `enum` + `enumNames` for dropdowns, `default` for a sensible starting value, and `ui:field: Secret` for anything sensitive.

```yaml
  - title: Agent Configuration
    required: [model, geminiApiKey]
    properties:
      model:
        title: Model
        type: string
        default: gemini-3.1-pro-preview
        enum: [gemini-3.1-pro-preview, gemini-3-flash-preview]
        enumNames: [Gemini 3.1 Pro, Gemini 3 Flash]  # pretty labels
      geminiApiKey:
        title: Gemini API Key
        type: string
        ui:field: Secret          # collected + stored as a secret
```

> ⚠️ **The empty-value trap** — `ui:field: Secret` changes how you reference the value later. A normal field is read as `${{ parameters.geminiApiKey }}`; a secret field is read as `${{ secrets.geminiApiKey }}`. Mixing these up is the most common reason a value arrives empty in the step. Rule of thumb: **secrets in, secrets out**.

### Conditional fields with `dependencies`

When one choice should reshape the rest of the form — e.g. picking a provider changes the available models *and* the env-var name its key gets injected under — use JSON-Schema `dependencies.<field>.oneOf`. Each branch matches on a `const` and can introduce new properties, including **hidden** ones the step will read.

```yaml
    dependencies:
      llmProvider:
        oneOf:
          - required: [model]
            properties:
              llmProvider: { const: anthropic }
              apiKeyEnvVar:                 # hidden — carries data, not shown
                type: string
                default: ANTHROPIC_API_KEY
                ui:widget: hidden
              model:
                type: string
                default: anthropic/claude-sonnet-4-6
                enum: [anthropic/claude-opus-4-8, anthropic/claude-sonnet-4-6]
          - required: [model]
            properties:
              llmProvider: { const: openai }
              apiKeyEnvVar: { type: string, default: OPENAI_API_KEY, ui:widget: hidden }
              model:
                type: string
                default: openai/gpt-5.2
                enum: [openai/gpt-5.2, openai/gpt-5.1]
```

The `apiKeyEnvVar` field is the trick: `ui:widget: hidden` keeps it off the form, but it still flows into `parameters` — so the step injects the same secret under `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` depending on the branch, with no conditional logic in the step itself.

## Turning inputs into a component

`steps` is a list of actions run on submit. For creating an OpenChoreo component there is exactly one that matters — `openchoreo:component:create`:

```yaml
steps:
  - id: create-component
    name: Create Component
    action: openchoreo:component:create
    input:
      # --- where it goes (from the ProjectNamespaceField object) ---
      projectName: ${{ parameters.project_namespace.project_name }}
      namespaceName: ${{ parameters.project_namespace.namespace_name }}
      componentName: ${{ parameters.name }}
      displayName: ${{ parameters.displayName }}
      description: ${{ parameters.description }}

      # --- which component type it is ---
      componentType: ai-agent-gemini
      component_type_kind: ClusterComponentType
      component_type_workload_type: proxy

      # --- how it deploys ---
      deploymentSource: deploy-from-image     # REQUIRED for a fixed image
      containerImage: docker/sandbox-templates:gemini
      autoDeploy: true

      # --- what runs inside ---
      workloadDetails:
        envVars:
          - key: GEMINI_API_KEY
            value: ${{ secrets.geminiApiKey }}   # secret → secrets.*
          - key: GEMINI_MODEL
            value: ${{ parameters.model }}        # normal → parameters.*
```

- `componentType` must match the `metadata.name` of the target CCT, and `component_type_kind: ClusterComponentType` tells the action it's a cluster-scoped type.
- `deploymentSource: deploy-from-image` is mandatory for a pre-built image. Omit it and the action silently drops your `containerImage` and env vars — the component comes up empty. This is the single easiest mistake to make.
- `autoDeploy: true` deploys immediately instead of leaving the component undeployed.
- `workloadDetails` is the payload that becomes the running workload.

### `workloadDetails` variations

`envVars` is the common case, but the same block supports two other patterns.

**Mount a config file.** Inject file content into the container and point the app at it via an env var:

```yaml
      workloadDetails:
        envVars:
          - key: ${{ parameters.apiKeyEnvVar }}
            value: ${{ secrets.llmApiKey }}
          - key: OPENCODE_CONFIG                    # tell the app where the file is
            value: /etc/opencode/opencode.json
        fileMounts:
          - key: opencode.json                      # filename
            mountPath: /etc/opencode                # directory it mounts into
            value: |                                # the file's contents
              {
                "$schema": "https://opencode.ai/config.json",
                "model": "${{ parameters.model }}"
              }
```

This is how you set a default a CLI reads from disk rather than an env var — write the file with `fileMounts`, then reference it with an env var.

**Expose an HTTP endpoint.** For a component with a web UI rather than a terminal-only workload:

```yaml
      workloadDetails:
        endpoints:
          control-ui:
            type: HTTP
            port: 18789
            visibility:
              - external          # routed out through the gateway
        envVars:
          - key: GATEWAY_TOKEN
            value: ${{ secrets.gatewayToken }}
```

`endpoints` is a map of name → `{ type, port, visibility }`. `external` visibility gets the port routed through the gateway; omit it for internal-only.

### Where each value comes from

Three namespaces show up in `${{ … }}` expressions — keep them straight:

| Reference | Source |
|---|---|
| `${{ parameters.x }}` | a normal form field |
| `${{ secrets.x }}` | a `ui:field: Secret` form field |
| `${{ steps['id'].output.y }}` | an output of an earlier step |

## Sending the user somewhere

After the component is created, link the user straight to it. Build the entity reference **explicitly** from the step's outputs:

```yaml
output:
  links:
    - title: View Component
      icon: kind:component
      entityRef: component:${{ steps['create-component'].output.namespaceName }}/${{ steps['create-component'].output.componentName }}
```

`component:<namespace>/<name>` is the canonical Backstage entity-ref format, and both halves come reliably from `steps['create-component'].output`. Reaching for a single `output.entityRef` field tends to come back empty and leave you with a dead link — assemble it yourself.

## A complete template

Everything above, assembled into one working file:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: create-ai-agent-gemini
  title: Gemini Agent
  description: Run Gemini CLI interactively in a kernel-isolated sandbox.
  tags: [openchoreo, ai-agent, gemini]
spec:
  type: Component
  owner: openchoreo
  EXPERIMENTAL_formDecorators:
    - id: openchoreo:inject-user-token

  parameters:
    - title: Component Metadata
      required: [project_namespace, name]
      properties:
        project_namespace:
          title: Project & Namespace
          type: object
          ui:field: ProjectNamespaceField
        name:
          title: Component Name
          type: string
          pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
          maxLength: 63
          ui:autofocus: true
        displayName: { title: Display Name, type: string }
        description: { title: Description, type: string }

    - title: Agent Configuration
      required: [model, geminiApiKey]
      properties:
        model:
          title: Model
          type: string
          default: gemini-3.1-pro-preview
          enum: [gemini-3.1-pro-preview, gemini-3-flash-preview]
          enumNames: [Gemini 3.1 Pro, Gemini 3 Flash]
        geminiApiKey:
          title: Gemini API Key
          type: string
          ui:field: Secret

  steps:
    - id: create-component
      name: Create Component
      action: openchoreo:component:create
      input:
        projectName: ${{ parameters.project_namespace.project_name }}
        namespaceName: ${{ parameters.project_namespace.namespace_name }}
        componentName: ${{ parameters.name }}
        displayName: ${{ parameters.displayName }}
        description: ${{ parameters.description }}
        componentType: ai-agent-gemini
        component_type_kind: ClusterComponentType
        component_type_workload_type: proxy
        deploymentSource: deploy-from-image
        containerImage: docker/sandbox-templates:gemini
        autoDeploy: true
        workloadDetails:
          envVars:
            - key: GEMINI_API_KEY
              value: ${{ secrets.geminiApiKey }}
            - key: GEMINI_MODEL
              value: ${{ parameters.model }}

  output:
    links:
      - title: View Component
        icon: kind:component
        entityRef: component:${{ steps['create-component'].output.namespaceName }}/${{ steps['create-component'].output.componentName }}
```

## Author's checklist

The mistakes that cost the most time, distilled:

- **`deploymentSource: deploy-from-image`** — required for a fixed image; without it the image and env vars are silently dropped.
- **Secrets are `secrets.*`, not `parameters.*`** — a `ui:field: Secret` value is only readable through the `secrets` namespace.
- **`componentType` must equal the CCT's `metadata.name`**, and set `component_type_kind: ClusterComponentType`.
- **`ProjectNamespaceField` returns an object** — destructure `.project_name` and `.namespace_name` in the step.
- **Build `entityRef` by hand** as `component:<ns>/<name>`; don't rely on a single `output.entityRef`.
- **`dependencies.oneOf` + a `ui:widget: hidden` field** is the clean way to make one dropdown reshape both the visible inputs and the values the step consumes.
- **`fileMounts` for defaults a CLI reads from disk; `envVars` for everything else** — wire the two together with a `*_CONFIG` env var pointing at the mount path.

Get these right and you can hand-write a form that captures exactly the inputs your component needs — no build steps, no guesswork, just the fields that matter.
{% endraw %}
