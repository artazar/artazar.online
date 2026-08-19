---
title: "A FluxCD repo layout that survives forty applications"
date: 2026-05-05T00:08:30Z
slug: ""
---

Every GitOps repository starts beautiful. One cluster, five apps, a flat `apps/` directory, and a Kustomization that reconciles the lot. Then the second cluster appears. Then staging needs a different replica count. Then somebody needs their own namespace with their own RBAC and no access to anyone else's. Six months later you are grepping through forty `kustomization.yaml` files trying to work out why a change to a shared ConfigMap took down two environments.

This post is the layout I settled on after doing it wrong twice.

### The rule that drives everything

**A directory should answer one question.** Either "what is this application?" or "how does this cluster differ?" — never both. The moment a single file answers both, you get the copy-paste explosion, because the only way to vary one axis is to duplicate the other.

That gives three top-level trees:

```
├── apps/
│   ├── base/
│   │   ├── grafana/
│   │   ├── harbor/
│   │   └── my-api/
│   └── overlays/
│       ├── prod-spain/
│       ├── dev-spain/
│       └── infra/
├── infrastructure/
│   ├── controllers/
│   └── configs/
└── clusters/
    ├── prod-spain/
    ├── dev-spain/
    └── infra/
```

`apps/base` is the application, described once. `apps/overlays/<cluster>` is the delta. `clusters/<cluster>` contains only Flux entry points — the `Kustomization` and `GitRepository` objects that tell Flux what to reconcile and in what order. It holds no application YAML at all, and that constraint is what keeps the whole thing navigable.

### Entry point, dependencies, and the ordering problem

Each cluster directory holds a handful of Flux `Kustomization` resources, and the `dependsOn` between them is the part that actually matters:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infra-controllers
  namespace: flux-system
spec:
  interval: 10m
  path: ./infrastructure/controllers
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  wait: true
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infra-configs
  namespace: flux-system
spec:
  dependsOn:
    - name: infra-controllers
  interval: 10m
  path: ./infrastructure/configs
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  dependsOn:
    - name: infra-configs
  interval: 10m
  path: ./apps/overlays/prod-spain
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
```

`wait: true` on the controllers layer is the load-bearing line. Without it, Flux marks the Kustomization ready as soon as the objects are *applied*, not when they're *healthy* — so `infra-configs` starts creating `ClusterIssuer` resources while cert-manager's CRDs are still being registered, and you get a reconciliation error that clears itself on the next interval. It's self-healing, which is exactly why it's insidious: everything goes green eventually and nobody investigates the ten minutes of red.

Three layers is the right number. Controllers (things with CRDs), configs (things that use those CRDs), apps (everything else). More layers and you're encoding a dependency graph in directory names; fewer and you're back to race conditions.

### Overlays that stay small

An overlay should be readable in one screen. If `apps/overlays/prod-spain/kustomization.yaml` is two hundred lines, the base is wrong.

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: default

resources:
  - ../../base/my-api
  - ../../base/grafana

patches:
  - target:
      kind: HelmRelease
      name: my-api
    patch: |-
      - op: replace
        path: /spec/values/replicaCount
        value: 6
      - op: replace
        path: /spec/values/resources/requests/cpu
        value: "2"
```

Inline patches rather than separate patch files, as long as they stay this short. A patch file for a three-line change means opening two files to understand one override — the indirection costs more than it saves.

For the values that differ on *every* cluster — region, account ID, domain suffix — don't patch at all. Use Flux's post-build substitution and keep them in one ConfigMap per cluster:

```yaml
spec:
  postBuild:
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
```

Then `${cluster_domain}` in the base resolves per cluster and the overlay stays empty. This is the single biggest reduction in overlay size I've made — roughly half of what I used to patch was just strings containing the region.

### Tenancy without a second repository

The temptation with multiple teams is one repo per team. Resist it for as long as you can: cross-repo dependency ordering in Flux is genuinely painful, and you will spend more time on the plumbing than the isolation is worth.

A `ServiceAccount` per tenant plus `spec.serviceAccountName` on their Kustomization gets you real isolation inside one repo:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-payments
  namespace: flux-system
spec:
  serviceAccountName: team-payments
  path: ./apps/overlays/prod-spain/payments
  prune: true
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: flux-system
```

Flux impersonates that ServiceAccount when applying, so the tenant's RBAC is enforced by the API server rather than by convention. If their manifests reach outside their namespace, the apply fails — which is the correct outcome, and much better than discovering the overreach during an incident.

Split the repository when teams need different release cadences or genuinely separate audit trails. Not before, and not because the directory listing got long.

### What I'd tell myself two years ago

Keep `clusters/` free of application YAML. Put `wait: true` on anything that installs CRDs. Push everything that varies per cluster into substitution variables before you reach for a patch. Three of those are one-line changes and all three of them are the ones I got wrong the first time.

Cheers!
