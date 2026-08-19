---
title: "Karpenter consolidation without the pager fatigue"
date: 2026-06-16T00:08:30Z
slug: ""
---

Karpenter's consolidation is the feature that pays for the migration. It watches your cluster, notices that the workload fits on cheaper capacity, and rearranges the nodes to match. On a fleet running mostly spot, the savings are real and continuous — when I went through [the cost optimisation exercise](/blog/04-cutting-the-eks-bill/), it was one of the few changes that measurably moved the bill.

It is also a machine that deliberately deletes your nodes, all day, forever. If your workloads aren't ready for that, consolidation turns into a steady drip of alerts that eventually teaches everyone to ignore the alerting channel — which is a worse outcome than paying for the oversized nodes.

Here's how I got mine quiet.

### Understand what consolidation actually does

Two distinct behaviours hide behind one word:

**Delete consolidation** — the workload on a node fits elsewhere, so the node goes away entirely. Uncontroversial, and the bulk of your savings.

**Replace consolidation** — the workload doesn't fit elsewhere, but it would fit on a *smaller* node, so Karpenter launches a cheaper one and moves everything over. Also valuable, but it's a churn source: a node that's 40% utilised is a candidate, and after the replacement the new node might itself become a candidate an hour later.

The `disruption` block is where you tune the appetite:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: prod
spec:
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
    budgets:
      - nodes: "10%"
      - nodes: "0"
        schedule: "0 8 * * mon-fri"
        duration: 10h
```

`consolidateAfter: 5m` means a node must look consolidatable continuously for five minutes before Karpenter acts. This single setting removed most of my churn. The default reacts to momentary dips — a batch job finishes, utilisation drops for ninety seconds, a node gets replaced, the next batch job starts and Karpenter provisions capacity again. A few minutes of hysteresis and that entire cycle disappears.

The budgets are the other half. `nodes: "10%"` caps concurrent voluntary disruption at a tenth of the pool, so even a large rebalance happens gradually. The second budget is a hard freeze during business hours on weekdays — no voluntary disruption between 08:00 and 18:00, Monday to Friday. Nothing about consolidation is urgent enough to happen while your team is shipping.

> Budgets only constrain *voluntary* disruption. Spot interruptions, node expiry from `terminationGracePeriod`, and anything AWS initiates ignore them entirely. A budget of `0` is not a maintenance window, it's a politeness setting.

### Your workloads need to actually tolerate this

Consolidation exposes every deployment that quietly assumed its pods would live forever. Three things fix ninety percent of it.

**A PodDisruptionBudget on everything that matters.** Without one, Karpenter drains a node and takes all your replicas with it if they happen to be co-located:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-api
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: my-api
```

Use `minAvailable` with an absolute number rather than `maxUnavailable` with a percentage. A percentage of a two-replica deployment rounds in ways that surprise you at exactly the wrong moment.

**Topology spread, so the PDB has somewhere to go.** A PDB that can never be satisfied blocks consolidation forever and shows up as a node stuck in `Deleting`:

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        app: my-api
```

`ScheduleAnyway` rather than `DoNotSchedule` — during a drain you want the pod placed somewhere imperfect rather than pending. A pod that can't schedule because of a strict spread constraint is a self-inflicted outage during an event that was supposed to be routine.

**`terminationGracePeriodSeconds` that reflects reality.** Karpenter respects it. If your app takes 45 seconds to finish in-flight requests and the grace period is the default 30, consolidation truncates them. Measure it, don't guess.

### Spot interruptions are a different problem

Consolidation is voluntary and can be scheduled. Spot interruption is neither — AWS gives you two minutes and that's the whole negotiation. The interruption queue turns those two minutes into a graceful drain instead of a hard kill:

```hcl
resource "aws_sqs_queue" "karpenter_interruption" {
  name                      = "${var.cluster_name}-karpenter"
  message_retention_seconds = 300
  sqs_managed_sse_enabled   = true
}
```

Point Karpenter at it, wire the EventBridge rules for spot interruption warnings, rebalance recommendations and instance state changes, and Karpenter cordons and drains on the warning rather than discovering the node is gone. Two minutes is enough for most workloads if the drain starts immediately.

What it is not enough for is anything holding long-lived state. Which brings me to the split that made the biggest practical difference:

```yaml
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m6i", "m6a", "m7i", "m7a", "c6i", "c6a", "c7i"]
```

Give the spot pool a wide instance family list. Karpenter picks from the deepest capacity pools, and interruption frequency drops noticeably compared to a narrow list — you're no longer competing for one instance type. Then run a small on-demand pool alongside it, and put anything stateful there with a nodeSelector. Stop trying to make databases survive spot; it's a lot of engineering to avoid a modest bill.

### Alert on the right thing

The mistake I made early was alerting on node terminations. That's the system working — Karpenter terminating nodes all day is precisely what you asked for, and the alert is pure noise.

What's worth waking up for:

```yaml
- alert: KarpenterNodeStuckDraining
  expr: karpenter_nodeclaims_disrupted_total unless on(nodepool) increase(karpenter_nodeclaims_terminated_total[15m]) > 0
  for: 15m
  labels:
    severity: warning
  annotations:
    description: "NodeClaim disruption started but no termination completed in 15m — likely a blocking PDB"

- alert: KarpenterPodsPendingTooLong
  expr: sum(kube_pod_status_phase{phase="Pending"}) by (namespace) > 0
  for: 10m
  labels:
    severity: warning
  annotations:
    description: "Pods pending for 10m — Karpenter may be unable to provision matching capacity"
```

Pods pending is the alert that actually correlates with user impact. A node stuck draining is the one that predicts a problem before anyone notices. Everything else about consolidation is background noise, and treating it as such is how the alerting channel stays worth reading.

### The settings that mattered

If you take three things: `consolidateAfter` in the minutes, disruption budgets that respect working hours, and a wide instance family list on the spot pool. Those three cut my consolidation-related noise to near zero without measurably changing the bill.

Cheers!
