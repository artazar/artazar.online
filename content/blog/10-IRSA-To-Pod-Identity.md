---
title: "IRSA to Pod Identity: notes from the migration"
date: 2026-06-02T00:08:30Z
description: "Migration notes, the annotation that becomes a lie, and the host port 80 conflict that took down ingress."
tags: ["aws", "eks", "iam", "kubernetes", "security"]
slug: ""
---

IRSA has been the way to give a Kubernetes pod an AWS identity since 2019, and it works. It also requires an OIDC provider per cluster, a trust policy per role that names a specific cluster's OIDC issuer, and a mental model involving projected service account tokens that you re-derive from scratch every time something breaks.

EKS Pod Identity does the same job with less machinery. I've now moved a few clusters over and it's mostly good news, with a couple of edges worth knowing before you start.

### What actually changes

With IRSA, the trust relationship lives in the IAM role and points at the cluster:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.eu-south-2.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.eu-south-2.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:payments:api",
        "oidc.eks.eu-south-2.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
      }
    }
  }]
}
```

That OIDC issuer ID is generated when the cluster is created. Which means the role cannot be written until the cluster exists, the role is bound to exactly one cluster, and rebuilding a cluster invalidates every role that trusted it. If you run ephemeral test clusters, you know this pain intimately.

With Pod Identity, the trust policy is generic and identical for every role you'll ever write:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "pods.eks.amazonaws.com" },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}
```

The binding between service account and role moves out of IAM and into an EKS API object:

```hcl
resource "aws_eks_pod_identity_association" "payments_api" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "payments"
  service_account = "api"
  role_arn        = aws_iam_role.payments_api.arn
}
```

This is the whole point. The role becomes cluster-agnostic and reusable, and the cluster-specific part becomes a three-line resource that Terraform can create, destroy and recreate without touching IAM. For a repo that spins clusters up and down, this deletes an entire category of ordering problem.

You also need the agent, which is a standard EKS add-on:

```hcl
resource "aws_eks_addon" "pod_identity" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "eks-pod-identity-agent"
}
```

Install it before you create any associations. It runs as a DaemonSet and serves credentials to pods over a link-local address, so nodes provisioned before the agent is healthy will need their pods restarted.

And now the part that cost me an outage.

### The agent wants port 80. On your host.

The Pod Identity agent runs with `hostNetwork: true` and, by default, binds to **port 80**:

```yaml
containers:
  - name: eks-pod-identity-agent
    command:
      - /go-runner
      - /eks-pod-identity-agent
      - server
    args:
      - '--port'
      - '80'
      - '--cluster-name'
      - prod-spain-001
      - '--probe-port'
      - '2703'
    ports:
      - name: proxy
        containerPort: 80
        protocol: TCP
```

`hostNetwork: true` plus port 80 means the agent claims the node's HTTP port. If you run an ingress controller with `hostNetwork` or a `hostPort: 80` — which is a completely ordinary way to run nginx-ingress, HAProxy or Traefik on EKS — you now have two DaemonSets competing for the same port on every node.

There is no negotiation. The instant I applied the add-on, ingress pods started failing to schedule and getting evicted, and the cluster stopped serving external traffic. Not a subtle degradation, not something drift detection catches later — the front door closed while the add-on install reported success.

This is [aws/eks-pod-identity-agent#10](https://github.com/aws/eks-pod-identity-agent/issues/10), opened in June 2024, titled `[BAD-DECISION]` by the reporter, who hit it the same way with HAProxy ingress. It is still open at the time of writing. The AWS documentation mentions the port only in a passing note under [pod identity considerations](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html#pod-id-considerations) — nowhere near the install instructions you're actually following.

The reasonable question, which the issue asks better than I can: why is a credential agent that talks to pods over a link-local address binding to the single most contended port on the host at all? Nothing about the design requires it. The probe port is already 2703, so somebody clearly thought about port selection for the health endpoint and then left the main listener on 80.

**Check your nodes before you install:**

```sh
kubectl get pods -A -o json | jq -r '
  .items[]
  | select(.spec.hostNetwork == true or (.spec.containers[].ports // [])[]?.hostPort)
  | "\(.metadata.namespace)/\(.metadata.name)"' | sort -u
```

Anything in that list is a candidate for collision. If your ingress controller is there, deal with the port before the add-on goes anywhere near a production cluster.

The options, none of them lovely:

**Move your ingress controller off host port 80.** If it's behind an NLB, it doesn't need `hostNetwork` at all — a `LoadBalancer` service with `externalTrafficPolicy: Local` gets you the same source IP preservation without claiming a host port. This is what I ended up doing, and it's the change I'd have made eventually anyway.

**Patch the agent's port.** Doable via the add-on's configuration values, but you're overriding an AWS-managed add-on's container args, and every add-on version bump is a chance for your override to be reverted or to stop applying cleanly. Test it survives an upgrade before relying on it.

**Schedule them apart.** Anti-affinity between the ingress controller and the agent works on paper and is a bad idea in practice: the agent is a DaemonSet that needs to be on every node, because a node without it is a node where Pod Identity silently doesn't work.

If you take one thing from this post, make it this: run that `hostPort` check first. Everything else here is a config change you can iterate on. This one takes your ingress down at the moment you apply it, on a cluster where you were confident you'd made a small additive change.

### The `eks.amazonaws.com/role-arn` annotation is now a lie

This is the migration's sharpest edge. The IRSA annotation on the service account:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
  namespace: payments
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payments-api
```

Pod Identity ignores it completely. It is not an error, it does not warn you, and it stays in your manifests looking authoritative. If you migrate an association to a different role but leave the annotation pointing at the old one, every future reader of that manifest — including you, six months later — will believe the wrong thing.

Worse, if the annotation is still present *and* the IRSA webhook is still active, the pod gets both credential sources. Pod Identity wins the SDK credential chain, so the behaviour is correct while the manifest says otherwise. Strip the annotations as part of the migration, not afterwards.

### Migrate one workload at a time

Both mechanisms can coexist on a cluster, which makes this a genuinely incremental migration. My order:

1. Check for host port 80 conflicts, resolve them, *then* install the add-on and confirm the DaemonSet is healthy on every node.
2. Pick a low-stakes workload. Add the second trust statement to its existing role — keep the OIDC federation *and* add the `pods.eks.amazonaws.com` service principal — so both paths work.
3. Create the association. Restart the pod. Verify it's using the new path.
4. Remove the service account annotation and the OIDC statement from the trust policy.
5. Repeat.

Step 3's verification matters, because "it still works" proves nothing when both mechanisms are live. Check which one is actually in use:

```sh
kubectl exec -n payments deploy/api -- env | grep AWS_

AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.23/v1/credentials
AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE=/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token
```

Those two variables mean Pod Identity. If you instead see `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`, you're still on IRSA and something didn't take — usually the pod predates the association, since the injection happens at pod creation.

### Where IRSA still wins

Two cases, and both are real:

**Anything outside EKS.** Pod Identity is an EKS feature. Self-managed clusters, EKS Anywhere, or a pod on another platform assuming an AWS role — IRSA's OIDC federation is the general mechanism and Pod Identity is not.

**Cross-account access.** Pod Identity added support for this, but it works by having the association's role assume a role in the target account — a second hop. With IRSA the pod's role can be trusted directly by the target account, one hop, no intermediate. If you have a heavily cross-account setup, price that extra role in before you commit.

Also worth checking: your SDK versions. Pod Identity's credential provider needs a reasonably recent AWS SDK, and an old container image with a pinned SDK from 2021 will simply not find the credentials. This surfaces as an unhelpful `NoCredentialProviders` error rather than anything pointing at the actual cause, so verify SDK versions before you start rather than debugging it under pressure.

### Worth doing?

For a fleet of clusters managed by Terraform, unambiguously yes — decoupling IAM roles from cluster lifecycle is worth the migration on its own. For a single long-lived cluster where IRSA already works, the payoff is smaller and there's no urgency. IRSA isn't going anywhere.

Cheers!
