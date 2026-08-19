---
title: "Letting Claude loose on an AWS account with Prowler"
date: 2026-08-11T00:08:30Z
description: "Running Prowler across an AWS account with an agent, a read-only role, and a bastion — then triaging 1,684 findings."
tags: ["aws", "security", "prowler", "ai", "automation"]
slug: ""
---

I had been meaning to run a proper security audit of one of our AWS accounts for months. The task kept losing to more urgent things, because it isn't a single job — it's install a scanner, work out its permissions, run it for an hour, then read several thousand findings and decide which twelve actually matter.

So I gave the whole thing to Claude Code and watched. The interesting part wasn't that it worked; it was where the effort actually went.

### The setup: a bastion and a read-only role

Two decisions up front, and both are the reason I was comfortable doing this at all.

**Run it from inside the account.** A Prowler scan makes thousands of API calls. Running that from a laptop over a VPN is slow and puts your personal credentials in the loop. Instead I pointed Claude Code at a bastion instance over SSH and let it work there — the scan runs next to the API endpoints it's hammering, and nothing sensitive lands on my machine.

**Give it a dedicated role that can only look.** This is the part I'd insist on for anyone repeating the exercise. I created a role — call it `ClaudeSecurityScan` — with read-only access and nothing else:

```hcl
resource "aws_iam_role" "claude_security_scan" {
  name = "ClaudeSecurityScan"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/BastionInstanceRole" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "read_only" {
  for_each = toset([
    "AmazonEC2ReadOnlyAccess",
    "AmazonEKSMCPReadOnlyAccess",
    "AmazonS3ReadOnlyAccess",
    "AmazonVPCReadOnlyAccess",
    "AWSLambda_ReadOnlyAccess",
    "CloudFrontReadOnlyAccess",
  ])

  role       = aws_iam_role.claude_security_scan.name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}
```

Six AWS-managed read-only policies, one per service I cared about. No write permissions anywhere, so the worst possible outcome of anything going sideways is a large CloudTrail bill and some throttling. The blast radius of an autonomous agent is exactly the blast radius of the credentials you hand it, and this is a case where the answer should be "none".

Note what this deliberately isn't. The usual advice for Prowler is to attach the managed `SecurityAudit` and `ReadOnlyAccess` policies, which between them cover every service Prowler knows how to check. I didn't want to hand out account-wide read on a first run, so I enumerated services instead and accepted the consequence: **the scan can only report on what it can see.** Services outside that list are invisible, and a check that can't call its API doesn't fail loudly — it just isn't in the report.

That's a real trade and you should make it consciously. Narrow permissions give you a scan you can justify to whoever owns the account; broad ones give you complete coverage. My own report ended up recommending I widen the role for the next run, which is a slightly funny outcome and also the correct one — the first scan tells you what the second scan should be allowed to look at.

Worth saying plainly: the agent ran unattended for a long stretch, and the reason that was fine is the role, not my confidence in the agent.

### Autonomy, including the boring parts

What I expected to do myself and didn't: install Prowler, resolve its Python dependency mess, work out the right invocation, deal with the run dying partway through.

```sh
pipx install prowler
prowler aws --region eu-south-2 \
  --output-formats json-ocsf html \
  --output-directory ~/prowler-report
```

That's the clean version. The actual sequence involved a missing `pipx`, a Python version mismatch, and a couple of restarts. Claude worked through all of it without asking me, which is the behaviour you want from something running on a machine where the downside is bounded.

The retries mattered more than I expected. A full-account scan is ~5,000 checks across every service, and at that volume you *will* hit API throttling. Some services return partial results and need re-running. Left to itself, the agent noticed the gaps, re-ran the affected service scans, and merged the results rather than reporting a partial run as complete. That's the difference between a tool and something that finishes the job — a plain `prowler` invocation in a shell script would have handed me an incomplete report and no indication it was incomplete.

Final numbers from the run:

```text
Total checks evaluated   5,116
PASS                     3,429 (67%)
FAIL                     1,684 (33%)
```

Those 5,116 are the checks the role could actually execute, across EC2, S3, IAM, Lambda, VPC, CloudFront, EKS and the services adjacent to them. Read that as a floor, not a total.

### Severity ranking is the actual product

1,684 failures is not a result, it's a homework assignment. Prowler assigns its own severity per check, but those are generic — a severity is attached to the *check*, not to your account. "Security group open to the internet" is critical in the abstract; whether it's critical for you depends on what's behind it.

The genuinely useful output was the re-ranking, which folded in things Prowler doesn't know: is the resource internet-facing, does it hold data, does a credential path lead out of it. A representative slice, anonymized:

**🔴 Critical — act now**

| Finding | Why it ranked here |
|---|---|
| Secrets in Lambda environment variables (4 functions) | Plaintext credentials readable by anyone with `lambda:GetFunction`; also land in CloudTrail |
| Security group with all ports `0-65535` open to `0.0.0.0/0` | Functionally equivalent to no firewall |
| MongoDB (27017) exposed to the internet on a public instance | Top-tier ransomware target; combined with the below, a single host owns the data |
| SSH (22) open to `0.0.0.0/0` on that same instance | Compounds the above — same host, two doors |

Four categories, ten findings, out of 1,684. That's the number a human can act on before lunch.

**🟠 High — this week**

| Finding | Count |
|---|---|
| EBS volumes with no snapshots | 152 |
| EBS volumes unencrypted | 142 |
| IAM service roles missing confused-deputy conditions | 53 |
| Security groups with broad internet ingress | 12 |
| IMDSv2 not enforced | 8 instances |
| Internet-facing instances carrying instance profiles | 4 |

**🟡 Medium — this month.** S3 bucket hygiene at scale (no SSE-KMS on 92 buckets, access logging off on 92, versioning off on 84), missing ALB and CloudFront access logs, log groups under a year's retention.

**🔵 Low — next quarter.** Multi-region DR posture, S3 lifecycle and cross-region replication, Network Firewall.

The ordering logic is worth stating because it's the thing you'd otherwise do by hand for a day: **exposure first, then blast radius, then data loss, then observability, then compliance.** An unencrypted EBS volume ranks below an open MongoDB port not because encryption doesn't matter, but because one requires an attacker to already have physical or API access and the other is reachable from a coffee shop.

Two things I'd have got wrong ranking these myself. The 53 confused-deputy IAM roles look like boilerplate noise and are easy to skim past — they're a real cross-service lateral movement path. And an *empty* WAF ACL sitting in front of a distribution is worse than no WAF, because everyone assumes it's doing something.

### Interrogating the report afterwards

The bit that made this better than a PDF from a scanning vendor: the report stayed queryable.

> *"Is this load balancer internet-facing?"*

It checked the actual scheme and came back: internal, private subnets only, fronting a Kubernetes gateway. Not a finding. Dismissed in thirty seconds instead of sitting on a spreadsheet for a week.

> *"Give me the exact list of the 8 instances without IMDSv2."*

It produced the list and then the loop to fix them:

```sh
for id in i-xxxxxxxxxxxxxxxxx i-yyyyyyyyyyyyyyyyy ...; do
  aws ec2 modify-instance-metadata-options \
    --region eu-south-2 \
    --instance-id $id \
    --http-tokens required \
    --http-endpoint enabled
done
```

Noting, correctly, that the three with public IPs were the urgent ones and that no reboot is required.

> *"Can Prowler re-check just one issue?"*

Yes — `--check <check_id>`, which I hadn't used before. Re-running the CloudFront default-root-object check showed 6 failures had become 5: one distribution had been fixed since the original scan. Being able to verify a single fix in seconds, rather than re-running a full hour-long scan, changes remediation from a big-bang exercise into something you can chip away at.

That's also where I learned CloudFront is scanned from `us-east-1` regardless of the `--region` flag, because it's a global service. Obvious in hindsight, and exactly the kind of thing that makes you distrust a report when the numbers don't line up.

### Would I do it again

Yes, with the same two guardrails: a dedicated read-only role, and execution on a host inside the account rather than my laptop. The one thing I'd change is starting with `SecurityAudit` and `ReadOnlyAccess` rather than six service-scoped policies — still read-only, still bounded, but without the silent blind spots.

The value wasn't the scan — Prowler is free and you can run it yourself this afternoon. It was collapsing 1,684 findings into ten things that need doing today, and then staying available to answer "is this one actually a problem?" for each of them. That triage is normally the reason security reports sit unread.

One caveat I'd apply to any repeat: everything above is a *read*. The moment you hand an agent write permissions to remediate findings automatically, the calculus changes completely and I'd want a much longer conversation about it. Reading your infrastructure and reporting on it is a genuinely safe autonomous task. Changing it is not the same thing.

Cheers!
