---
title: "Fargate profiles and the art of waiting your turn"
date: 2026-04-07T00:08:30Z
slug: ""
---

There is a special kind of Terraform error that only shows up when you destroy things. Your `apply` has been green for months, everyone is happy, and then one day you run a `terragrunt destroy` on a test cluster and get this:

```
Error: deleting EKS Fargate Profile (test-spain-001:test-spain-001-karpenter-2a):
operation error EKS: DeleteFargateProfile, https response error StatusCode: 409,
ResourceInUseException: Cannot delete Fargate profile
test-spain-001-karpenter-2a because cluster test-spain-001 currently has
Fargate profile test-spain-001-karpenter-2b in status DELETING
```

Run it again — it works. Run it on the next cluster — it fails again. Welcome to the club.

### Why this happens

EKS allows exactly **one** Fargate profile mutation at a time per cluster. Creating, deleting, updating — doesn't matter, the cluster takes a global lock and everything else gets a 409. This is not documented anywhere near where you'd expect it, and it's not a rate limit you can retry your way out of on the AWS SDK level: the profile that holds the lock can stay in `DELETING` for a couple of minutes.

Terraform, meanwhile, is doing exactly what you asked it to do. If you run Karpenter on Fargate — which is the standard bootstrap pattern, since somebody has to schedule the Karpenter controller itself before Karpenter can provision nodes — you likely have one profile per availability zone:

```hcl
resource "aws_eks_fargate_profile" "karpenter" {
  for_each = toset(var.karpenter_subnet_zones)

  cluster_name           = aws_eks_cluster.this.name
  fargate_profile_name   = "${var.cluster_name}-karpenter-${each.key}"
  pod_execution_role_arn = aws_iam_role.fargate.arn
  subnet_ids             = [var.private_subnets_by_zone[each.key]]

  selector {
    namespace = "karpenter"
  }
}
```

Three zones, three profiles, one `for_each`. Terraform sees three independent resources with no dependencies between them, so it happily deletes all three in parallel. AWS accepts the first one and rejects the other two.

The same applies on create, by the way — you just hit it less often, because creation is usually the moment you're watching the log anyway and re-running feels normal.

### The fix nobody likes but everybody uses

The clean answer would be a `parallelism` setting scoped to a resource. Terraform has no such thing — `-parallelism=1` is a global flag, and slowing down the entire cluster apply to fix three resources is a poor trade.

What actually works is making the profiles depend on each other, so Terraform is forced into a chain. Since `for_each` can't self-reference, you drop it and write them out:

```hcl
resource "aws_eks_fargate_profile" "karpenter_a" {
  cluster_name         = aws_eks_cluster.this.name
  fargate_profile_name = "${var.cluster_name}-karpenter-2a"
  # ...
}

resource "aws_eks_fargate_profile" "karpenter_b" {
  cluster_name         = aws_eks_cluster.this.name
  fargate_profile_name = "${var.cluster_name}-karpenter-2b"
  # ...

  depends_on = [aws_eks_fargate_profile.karpenter_a]
}

resource "aws_eks_fargate_profile" "karpenter_c" {
  cluster_name         = aws_eks_cluster.this.name
  fargate_profile_name = "${var.cluster_name}-karpenter-2c"
  # ...

  depends_on = [aws_eks_fargate_profile.karpenter_b]
}
```

Ugly? Yes. Three near-identical blocks where a `for_each` used to live is not something you show off in a code review. But `depends_on` works in both directions: on `apply` Terraform creates `a → b → c`, and on `destroy` it reverses to `c → b → a`. One at a time, no 409s, and the whole thing is deterministic.

> **Note:** `depends_on` on a resource that already exists in state does not force a replacement — it only changes graph ordering. So you can retrofit this into a live module without touching a single running cluster. Run a plan first and confirm you see `No changes` before believing me.

### Keeping the loop, sort of

If three copy-pasted blocks make your skin crawl, there's a middle ground: keep the map, but chain through it explicitly. A single profile with a multi-subnet selector is the truly lazy option and works if your pods don't care about zone pinning:

```hcl
resource "aws_eks_fargate_profile" "karpenter" {
  cluster_name           = aws_eks_cluster.this.name
  fargate_profile_name   = "${var.cluster_name}-karpenter"
  pod_execution_role_arn = aws_iam_role.fargate.arn
  subnet_ids             = values(var.private_subnets_by_zone)

  selector {
    namespace = "karpenter"
  }
}
```

One profile, all subnets, no ordering problem at all — Fargate will spread the pods across the zones it was given. This is what I'd reach for first now. The per-zone split only earns its keep when you genuinely need different selectors or execution roles per zone, and in that case you're back to `depends_on`.

### While we're at it: the other 409

The same destroy run will sometimes hand you a sibling error on the way back up:

```
Error: creating IAM Policy (KarpenterIRSA-test-spain-001-...):
StatusCode: 409, EntityAlreadyExists
```

Different cause, same lesson. That one is a leftover from a partially failed destroy: the policy survived, the state entry didn't. It's not a race, it's drift. `terraform import` it back or delete it by hand, but don't go adding `depends_on` chains looking for a race that isn't there.

Which is the actual point of this post. When AWS returns a 409, the first question is always *is this a lock or is this a leftover?* A lock means you fix the ordering. A leftover means you fix the state. Applying the wrong remedy to the wrong error is how you end up with a module full of `depends_on` lines that nobody remembers the reason for.

Cheers!
