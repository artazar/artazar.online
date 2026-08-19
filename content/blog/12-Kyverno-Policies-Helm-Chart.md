---
title: "Wrapping Kyverno policies into a chart you can actually tune"
date: 2026-07-07T00:08:30Z
description: "Turning a pile of static ClusterPolicy manifests into a Helm chart with three tiers of configurability."
tags: ["kyverno", "helm", "kubernetes", "security", "gitops"]
slug: ""
---

Kyverno's policy library is excellent and you should read it. It is also a directory of static YAML files, which means adopting it looks like copying twenty ClusterPolicy manifests into your GitOps repo and then editing them by hand, per cluster, forever.

That works until the second cluster. Dev wants `audit` where prod wants `enforce`. The infra cluster needs the CRI socket policy relaxed because your monitoring agent legitimately mounts it. A new namespace needs to be excluded from the Flux label requirement. Each of these is a one-line change to a file that's now duplicated across three repositories, and none of them are visible from a single place.

So I wrapped the lot in a Helm chart. Every policy is a template, every knob is a value, and a cluster's entire security baseline becomes a values file you can read in one sitting.

### The shape of it

```text
default-kyverno-cluster-policies/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── _helpers.tpl
    ├── add-node-metadata-labels-to-pod.yaml
    ├── add-vault-annotations.yaml
    ├── disable-automountserviceaccounttoken.yaml
    ├── disallow-container-sock-mounts.yaml
    ├── disallow-latest-tag.yaml
    ├── generate-default-deny-network-policies.yaml
    ├── require-flux-labels.yaml
    ├── require-ro-rootfs.yaml
    ├── restart-deployment-on-secret-change.yaml
    ├── verify-flux-sources.yaml
    └── verify-images.yaml
```

One file per policy, named after the policy. That's not an aesthetic choice — when a pod gets rejected at admission, the error message contains the policy name, and being able to go straight from a rejection message to the file that caused it is worth more than any clever grouping.

The values file is the entire security posture of a cluster:

```yaml
# -- 'enforce' to apply restrictions and 'audit' to store failures in policy reports only
validationFailureAction: 'enforce'

# -- Do not mount service account token into pods by default
disable_automountserviceaccounttoken: true

# -- Do not allow container engine socket mounts into pods
disallow_container_sock_mounts: true

# -- Do not allow to use :latest tag on container images
disallow_latest_tag: true

# -- Only allow read-only root FS inside pods
require_ro_rootfs: true

# -- Generate default-deny network policies for namespace
generate_default_deny_network_policies: true

# -- Require flux labels for deployed workloads
require_flux_labels: true
```

Somebody who has never opened the chart can read that and know what the cluster enforces. That's the whole point.

### Three tiers of configurability

Not every policy needs the same amount of flexibility, and pretending otherwise is how you end up with a values file nobody can navigate. Mine settled into three tiers.

**Tier one: a boolean.** The policy is either present or it isn't.

```yaml
{{- if .Values.disallow_latest_tag }}
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
spec:
  validationFailureAction: {{ .Values.validationFailureAction }}
  background: true
  rules:
  # ...
{{- end }}
```

Note `validationFailureAction` pulling from the shared value rather than being hardcoded. This is the single most useful line in the chart: flipping one value moves an entire cluster from `enforce` to `audit`. When you're onboarding a cluster that has years of non-compliant workloads on it, you install with `audit`, read the policy reports for a fortnight, fix what shows up, and then flip to `enforce`. Without that shared knob you'd be editing every template.

**Tier two: an object with a toggle and scope.**

```yaml
add_vault_annotations:
  enabled: false
  namespaces:
    - default
  names:
    - "*"
  annotations:
    vault.security.banzaicloud.io/run-as-non-root: "true"
    vault.security.banzaicloud.io/readonly-root-fs: "true"
```

```yaml
{{- if .Values.add_vault_annotations.enabled }}
{{- with .Values.add_vault_annotations }}
# ...
    mutate:
      patchStrategicMerge:
        metadata:
          annotations:
            {{- toYaml .annotations | nindent 12 }}
{{- end }}
{{- end }}
```

The `with` block after the `if` is worth adopting as a habit — it drops the `.Values.add_vault_annotations` prefix from every subsequent line, and in a template with a dozen references that's the difference between readable and not. `toYaml | nindent` passes the annotation map through untouched, so adding a new Vault annotation is a values change and never a template change.

**Tier three: a list that generates rules.** Some policies need to exist N times with different parameters. Kyverno lets one ClusterPolicy hold many rules, so a `range` over a list gives you exactly that:

```yaml
verify_images:
  enabled: true
  apps:
    - namespaces:
        - default
      images:
        - "ghcr.io/foobar/*"
      keys:
        - "k8s://default/cosign-key"
```

```yaml
spec:
  rules:
    {{- range $ind, $pol := .Values.verify_images.apps }}
    - name: verify-image
      match:
        any:
        - resources:
            kinds: [Pod, Deployment, StatefulSet, DaemonSet, CronJob]
            namespaces:
              {{- range $k, $v := $pol.namespaces }}
              - {{ $v }}
              {{- end }}
      verifyImages:
      - imageReferences: {{ $pol.images }}
        attestors:
        - count: 1
          entries:
          {{- range $k, $v := $pol.keys }}
          - keys:
              publicKeys: {{ $v }}
          {{- end }}
    {{- end }}
```

Each team gets a block in the values file naming their namespaces, their image patterns and their cosign key. Adding a team is six lines of YAML in one place, with no template work at all.

The same pattern drives the secret-rotation policy, which is the one I'd have written a controller for if Kyverno couldn't do it:

```yaml
{{- if gt (len .Values.restart_deployment_on_secret_change) 0 -}}
```

Guarding on list length rather than a separate `enabled` flag means an empty list simply produces no policy. One less thing to keep in sync — you can't have `enabled: true` with nothing configured, because the list *is* the configuration.

### The escaping problem

Here's the wart, and there's no elegant fix. Kyverno's variable substitution uses `{{ }}`. So does Helm. A policy that references `{{ request.object.metadata.name }}` will be eaten by the Helm renderer before Kyverno ever sees it.

The workaround is `printf` with a quoted string:

```yaml
      namespace: {{ printf "\"{{request.object.metadata.name}}\"" }}
```

Helm evaluates `printf`, which emits the literal text including the braces, and Kyverno receives what it expects. It's ugly and it appears throughout the chart wherever a Kyverno variable is needed:

```yaml
    preconditions:
      all:
      - key: {{ printf "\"{{request.operation || 'BACKGROUND' }}\"" }}
        operator: Equals
        value: UPDATE
```

The other way is a backtick-quoted literal, which is terser and reads better once you've seen it a few times:

```yaml
      context:
        - name: nodeLabels
          apiCall:
            urlPath: "/api/v1/nodes/{{`{{node}}`}}"
            jmesPath: "metadata.labels"
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              env: "{{`{{ nodeLabels.env }}`}}"
              karpenter.sh/nodepool: "{{`{{ nodeLabels.\"karpenter.sh/nodepool\" }}`}}"
```

Anything between backticks inside `{{ }}` is passed through as a raw string, braces included. Both forms produce identical output. Mine has both, which is a small inconsistency born of writing the templates months apart — if I were being disciplined I'd pick the backtick form everywhere, since it's shorter and doesn't need the escaped quotes that make the `printf` version hard to read.

You can also change Helm's delimiters, but not per-file, and not without surprising everyone who later opens the chart. I took the ugly-but-local option. If you write one of these charts, expect this to be the thing that costs you an afternoon the first time a policy silently renders with an empty namespace field.

### Using the cluster's own state

The chart also does something that a static manifest can't: it looks up real values from the cluster at render time. The default-deny network policy needs to allow traffic to the API server and to DNS, and those addresses differ per cluster:

```yaml
{{- define "default-kyverno-cluster-policies.KubeDNSAddress" -}}
{{- if (lookup "v1" "Service" "kube-system" "kube-dns") }}
{{- print (lookup "v1" "Service" "kube-system" "kube-dns").spec.clusterIP "/32" }}
{{- end }}
{{- if (lookup "v1" "Service" "kube-system" "coredns") }}
{{- print (lookup "v1" "Service" "kube-system" "coredns").spec.clusterIP "/32" }}
{{- end }}
{{- end }}
```

Checking for both `kube-dns` and `coredns` because the service name varies by distribution and I got tired of remembering which cluster was which.

Be aware of what you're signing up for: `lookup` returns an empty map during `helm template` and `--dry-run`, because there's no cluster to query. So this helper renders to nothing in CI, and any test that lints the rendered output needs to tolerate that. It's a real trade — you get per-cluster correctness at install time and lose the ability to fully validate the chart offline. For network policy addresses I think it's worth it, but I wouldn't reach for `lookup` casually.

### Deploying it

The chart lives in the same repository as the rest of the platform code, so Flux installs it straight from the Git source without a chart repository in between:

```yaml
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: default-kyverno-cluster-policies
spec:
  chart:
    spec:
      chart: ./helm/charts/security/default-kyverno-cluster-policies
      sourceRef:
        kind: GitRepository
        name: flux-system
        namespace: flux-system
  interval: 1h0m0s
  releaseName: default-kyverno-cluster-policies
  dependsOn:
    - name: kyverno
  timeout: 10m
  install:
    crds: Create
    strategy:
      name: RetryOnFailure
  upgrade:
    crds: CreateReplace
    strategy:
      name: RetryOnFailure
  values:
    require_ro_rootfs: true
    require_flux_labels: true
    flux_git_repo_org: MyORG
    add_node_metadata_labels_to_pods:
      enabled: true
      namespaces:
        - status-app
        - jenkins
        - observability
    verify_images:
      enabled: true
```

Three things in there earn their place.

`dependsOn: [kyverno]` is mandatory, not defensive. ClusterPolicy is a CRD owned by Kyverno itself, so without the dependency Flux will try to apply policies against an API that doesn't know the kind yet. It eventually succeeds on a later reconciliation, which is the worst kind of failure — transient, self-healing, and completely invisible unless you happen to be reading logs at the time.

`strategy: RetryOnFailure` covers the same ground from the other direction. Kyverno's admission webhook needs to be up and serving before policies apply cleanly, and there's a window during a cluster rebuild where it isn't. A retry turns that window into a non-event.

And the `values` block is the entire security posture of this cluster, sitting in the cluster's own directory. Reading it tells you that read-only root filesystems are required, Flux ownership labels are enforced, cosign verification is on, and node metadata labels get stamped onto pods in exactly three namespaces. Nothing else needs to be opened to know what this cluster enforces.

### Exclusions are not optional

Every restrictive policy needs an escape hatch, and the honest ones put it in the template rather than pretending it won't be needed. The Flux label policy is a good example — it demands that every workload carry a Flux ownership label, which is exactly right for application namespaces and completely wrong for the components that bootstrap the cluster:

```yaml
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - flux-system
          - metrics-server
          - karpenter
          - amazon-cloudwatch
```

Same story with the CRI socket policy, which excludes `falco*` and `weave-scope-*` by name, because those genuinely need the socket and blocking them means blocking your security tooling with your security policy.

If I were starting the chart again, I'd make these exclusion lists values from day one rather than baking them into the templates. They're the thing that most often differs per cluster, and right now changing one means a chart version bump rather than a values change. That's the main piece of technical debt in here and I'm writing it down partly so I finally do something about it.

### Was it worth it?

A new cluster gets its full security baseline from a values file and a HelmRelease. Policy changes go through a chart version bump, so there's a changelog and a rollback path. And `validationFailureAction: audit` as a first-class value turned policy adoption from a scary flag day into a gradual, observable process.

Cheers!
