---
title: "EKS Access Entries: one ARN, one cluster, no sharing"
date: 2026-04-21T00:08:30Z
slug: ""
---

EKS Access Entries replaced the `aws-auth` ConfigMap and made cluster authorization a proper AWS API object instead of a YAML blob that you edited with trembling hands, hoping you wouldn't lock yourself out. It's a genuine improvement. But moving auth into the API surface also moves it into Terraform state, and that's where it gets interesting.

The error that sent me down this road:

```
Error: creating EKS Access Entry (test-spain-001:arn:aws:iam::123456789012:role/PlatformAdmin):
ResourceInUseException: The specified access entry resource is already in use
on this cluster.
```

My first reaction was the wrong one: *are access entries global? Did creating one for cluster A break cluster B?*

### No, they are not shared

Access entries are scoped per cluster. The composite key is `(cluster_name, principal_arn)`, and that's the whole story. The same IAM role ARN can — and normally does — have an access entry on every cluster in your account. Nothing is shared, nothing leaks across clusters.

So when EKS tells you the entry is "already in use on this cluster", it means precisely that: *on this cluster*, for *this ARN*, an entry already exists. The message is accurate and I was reading a global conflict into a local one.

There are exactly three ways to get there, and it's worth being able to tell them apart quickly:

**1. Two Terraform resources, one ARN.** The most common one. Somebody adds a role to a `for_each` map of cluster admins, and the same role is also granted explicitly somewhere else in the module:

```hcl
resource "aws_eks_access_entry" "admins" {
  for_each = toset(var.admin_role_arns)

  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_entry" "ci" {
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = var.ci_role_arn   # ...also present in var.admin_role_arns
  type          = "STANDARD"
}
```

Terraform sees two distinct resources, EKS sees one key. Whichever applies second gets the 409.

**2. `bootstrap_cluster_creator_admin_permissions`.** When it is left at its default of `true`, EKS silently creates an access entry for whichever principal created the cluster. If your Terraform role *is* that principal and you then declare an access entry for it explicitly, you collide with an entry you never wrote:

```hcl
resource "aws_eks_cluster" "this" {
  # ...
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }
}
```

Setting it to `false` and declaring every entry explicitly is the cleaner posture — no invisible admin, everything in code. Just make sure you actually declare an entry for yourself before you apply it, otherwise you get to practise your cluster recovery procedure.

**3. State drift.** The entry exists in AWS, but not in state — a failed apply, a manual `aws eks create-access-entry` during an incident, a partially destroyed cluster. Same fix as any drift:

```sh
aws eks list-access-entries --cluster-name test-spain-001

terraform import \
  'aws_eks_access_entry.admins["arn:aws:iam::123456789012:role/PlatformAdmin"]' \
  test-spain-001:arn:aws:iam::123456789012:role/PlatformAdmin
```

The import ID is `cluster_name:principal_arn`, colon-separated, which reads oddly given ARNs are full of colons themselves — but the provider splits on the first one, so it works out.

### Deduplicate before you apply

Since the collision is always "one ARN declared twice", the durable fix is to make it structurally impossible: build a single map of principals and let one resource own all of them.

```hcl
locals {
  access_entries = merge(
    { for arn in var.admin_role_arns : arn => {
        policy = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
        scope  = "cluster"
      }
    },
    { for arn in var.viewer_role_arns : arn => {
        policy = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"
        scope  = "cluster"
      }
    },
  )
}

resource "aws_eks_access_entry" "this" {
  for_each = local.access_entries

  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.key
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "this" {
  for_each = local.access_entries

  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_eks_access_entry.this[each.key].principal_arn
  policy_arn    = each.value.policy

  access_scope {
    type = each.value.scope
  }
}
```

`merge()` over maps keyed by ARN collapses duplicates for you: if the same role appears in both lists, the later one wins and you get one entry, not an error. That is a deliberate choice — silently taking the last policy is fine for admin-over-viewer, but if you ever merge two lists where neither should win, swap `merge` for an explicit check so the ambiguity fails loudly at plan time instead of quietly at apply time.

### One thing worth knowing

Access entries and the policy associations attached to them are separate resources with separate lifecycles. Deleting the entry cascades and removes the associations, but *updating* the entry does not touch them. So if you change a principal's access scope from `cluster` to a namespace list, you're modifying the association — and Terraform will happily do that in place without warning you that a human just lost or gained reach across the whole cluster.

Add a `plan` review step for anything touching `aws_eks_access_policy_association`. It's four lines of HCL that decide who can `kubectl delete` your production namespace.

Cheers!
