---
title: "Cutting the EKS bill: what actually moved the needle"
date: 2025-07-15T00:08:30Z
slug: ""
---

Every cost optimisation article opens with a list of twenty things you should do. Most of them save single-digit percentages and cost you a week each. This is the shorter, more honest version: the things that actually changed my EKS bill, roughly in order of return per hour of effort, and the ones that didn't.

Context so the numbers mean something: three clusters, a few hundred pods, mixed prod and dev, one region, Karpenter-managed nodes.

### 1. Spot, with a wide instance list

The single biggest line item, and it isn't close. Moving stateless workloads to spot cut compute by roughly 60% on those nodes.

The part people get wrong is the instance family list. A narrow list means competing for one shallow capacity pool, frequent interruptions, and a bad experience that makes everyone conclude spot isn't viable:

```yaml
requirements:
  - key: karpenter.sh/capacity-type
    operator: In
    values: ["spot"]
  - key: karpenter.k8s.aws/instance-family
    operator: In
    values: ["m6i", "m6a", "m7i", "m7a", "c6i", "c6a", "c7i", "r6i", "r6a"]
  - key: karpenter.k8s.aws/instance-size
    operator: NotIn
    values: ["nano", "micro", "small"]
```

Nine families instead of two, and interruption rates dropped to the point where they stopped being a topic of conversation. Exclude the tiny sizes so Karpenter doesn't solve a scheduling problem with a fleet of `t3.small` nodes that each carry a full kubelet's overhead.

**Effort: an afternoon. Return: the largest of anything here.**

### 2. Resource requests that resemble usage

The second biggest, and the one nobody wants to do because it means talking to application teams.

Requests are what the scheduler bin-packs against. A deployment requesting 2 CPU and using 200m occupies ten times the cluster it needs, and Karpenter dutifully provisions nodes for the fiction. Across a few hundred pods this compounds into a lot of empty, billed capacity.

The data is already there:

```promql
quantile_over_time(0.95,
  sum by (namespace, pod) (
    rate(container_cpu_usage_seconds_total{container!=""}[5m])
  )[7d:5m]
)
```

Compare against `kube_pod_container_resource_requests` and sort by the gap in absolute CPU-hours, not by ratio. A 10× over-request on a tiny sidecar is noise; a 3× over-request on your largest deployment is the entire finding.

I did this by hand the first time. Don't — run VPA in recommendation mode and let it produce the numbers:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-api
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-api
  updatePolicy:
    updateMode: "Off"
```

`updateMode: "Off"` means it only recommends. Read `kubectl describe vpa` after a week and you have a data-backed proposal per workload instead of an argument.

One thing I'd defend: leave CPU limits off, keep memory limits on. CPU throttling from limits causes latency problems that look like application bugs and burn far more engineering time than the capacity is worth. Memory has no such graceful degradation, so cap it.

**Effort: ongoing, a few weeks of nagging. Return: second largest.**

### 3. Consolidation actually enabled

Worth stating because it's easy to have Karpenter installed and consolidation effectively off:

```yaml
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 5m
```

`WhenEmpty` alone only removes nodes with nothing on them, which is the small half of the benefit. `WhenEmptyOrUnderutilized` is what repacks a half-empty cluster onto fewer nodes. Pair it with disruption budgets so it doesn't churn during business hours — there's a whole separate post's worth of tuning in that, which I'll get to eventually.

**Effort: one line, plus the workload readiness work. Return: solid double digits.**

### 4. The things that weren't compute

After the compute work, the bill's composition changed and things I'd never looked at became the largest remaining items.

**NAT Gateway data processing.** Every byte from a private subnet to S3, ECR or anything else outside the VPC goes through NAT at a per-GB charge. VPC endpoints for S3 and ECR removed most of mine:

```hcl
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.private_route_table_ids
}
```

The S3 gateway endpoint is free and removes image-layer and artifact traffic from NAT entirely. The ECR interface endpoints have an hourly cost, so check your actual pull volume first — on a cluster that pulls constantly they pay for themselves quickly, on a quiet one they don't.

**Cross-AZ traffic.** Charged in both directions, and invisible until you look. Topology-aware routing keeps service traffic in-zone where possible:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-api
  annotations:
    service.kubernetes.io/topology-mode: Auto
```

Free to enable, and it only engages when there's enough endpoint capacity per zone to do so safely.

**Orphaned EBS volumes.** Unembarrassing to admit only because everyone has them. PVCs from deleted namespaces, volumes from clusters destroyed six months ago, snapshots nobody scheduled a lifecycle policy for:

```sh
aws ec2 describe-volumes \
  --filters Name=status,Values=available \
  --query 'Volumes[].{ID:VolumeId,Size:Size,Created:CreateTime}' \
  --output table
```

Anything in `available` state is attached to nothing and billed monthly. Mine was a genuinely irritating number.

**Effort: a day total. Return: surprisingly large once compute stopped dominating.**

### What didn't move the needle

**Graviton.** The per-hour saving is real, but the migration cost was not trivial — multi-arch images for everything, a handful of dependencies without arm64 builds, and a period of running both. Worth doing eventually, poor return per hour compared to everything above. Start with new workloads, don't migrate old ones as a cost project.

**Chasing the control plane cost.** It's a fixed hourly charge per cluster. Consolidating three clusters into one with namespace isolation would save it, and would cost far more in blast radius than the saving is worth. I looked at it, priced it, dropped it.

**Reserved Instances / Savings Plans, initially.** Committing before doing the right-sizing work means committing to your inflated baseline. Do the optimisation first, run at the new baseline for a month, *then* commit to the floor you've established. Committing early is how you buy a discount on waste.

### The actual lesson

Two things — spot with a wide instance list, and requests that match reality — accounted for the overwhelming majority of the reduction. Everything else was a rounding error by comparison, and I spent a disproportionate amount of time on the rounding errors because they were more interesting.

Measure first, fix the largest line item, then measure again. The second measurement is the one that stops you optimising something that stopped mattering.

Cheers!
