---
title: "Terragrunt: deleting the boilerplate you were told to write"
date: 2026-05-19T00:08:30Z
description: "Hoisting version pins, generating providers, and deriving config from paths to shrink leaf units."
tags: ["terragrunt", "terraform", "iac", "aws"]
slug: ""
---

Terragrunt exists to keep you DRY, and then you open a mature Terragrunt repository and find ninety `terragrunt.hcl` files that are eighty percent identical. There's a joke in there somewhere.

It isn't Terragrunt's fault. The default onboarding path — copy the folder next door, change the inputs — is the fastest way to a working stack and the slowest way to a maintainable one. Here's what I strip out when I inherit one of these.

### Start by counting the lines that aren't inputs

A leaf `terragrunt.hcl` should be inputs and nothing else. If it contains `remote_state`, `generate`, provider blocks, or a `source` string with a version pin repeated from three directories over, those lines are boilerplate wearing a costume.

Typical starting point:

```hcl
include "root" {
  path = find_in_parent_folders()
}

terraform {
  source = "git::ssh://git@github.com/acme/modules.git//aws/eks?ref=v2.14.0"
}

dependency "vpc" {
  config_path = "../vpc"
}

inputs = {
  cluster_name    = "prod-spain-001"
  cluster_version = "1.32"
  vpc_id          = dependency.vpc.outputs.vpc_id
  private_subnets = dependency.vpc.outputs.private_subnets
}
```

The `source` line is the problem. It appears in every EKS unit across every environment, and bumping the module version means a find-and-replace across the repo — precisely the thing you adopted Terragrunt to avoid.

### Hoist the version pin

Put the module registry and the version map in the root config, and let the leaf ask for a module by name:

```hcl
# root.hcl
locals {
  module_repo = "git::ssh://git@github.com/acme/modules.git"

  module_versions = {
    eks = "v2.14.0"
    vpc = "v1.9.2"
    rds = "v3.1.0"
  }
}
```

```hcl
# prod/spain/eks/terragrunt.hcl
include "root" {
  path   = find_in_parent_folders()
  expose = true
}

terraform {
  source = "${include.root.locals.module_repo}//aws/eks?ref=${include.root.locals.module_versions.eks}"
}
```

`expose = true` is the piece people miss. Without it the included config's `locals` are invisible to the child, and you end up re-reading the same HCL file with `read_terragrunt_config()` — which works, but reads like an apology.

Now a module bump is one line in one file. If you need a single environment held back on an old version, override the map entry in that environment's intermediate `terragrunt.hcl` rather than in the leaf, so the exception lives at the level it actually applies to.

### Generate the provider once

Provider blocks are the other great duplicator, especially once you have `default_tags` and assume-role configuration. One `generate` block in the root covers every unit:

```hcl
# root.hcl
locals {
  parsed  = regex(".*/(?P<env>[^/]+)/(?P<region>[^/]+)/[^/]+$", get_terragrunt_dir())
  env     = local.parsed.env
  region  = local.parsed.region
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    provider "aws" {
      region = "${local.region}"

      assume_role {
        role_arn = "arn:aws:iam::${local.account_ids[local.env]}:role/TerraformExecution"
      }

      default_tags {
        tags = {
          Environment = "${local.env}"
          ManagedBy   = "terragrunt"
          Repository  = "infrastructure"
        }
      }
    }
  EOF
}
```

Deriving `env` and `region` from the directory path is the part that makes it work without inputs. Your folder structure already encodes that information — `prod/eu-south-2/eks` — so reading it back is free, and it means a leaf unit can't be wrong about which account it targets. Moving the directory moves the account, which is exactly the behaviour you want.

> **A caveat worth stating plainly:** path-derived configuration is implicit, and implicit configuration is harder to debug at 3am. Keep the regex in exactly one place, name the capture groups, and make sure `terragrunt render-json` is in your team's muscle memory so anyone can see what a unit resolved to without reverse-engineering the regex.

The same treatment applies to `remote_state`, which should already be in the root but is worth checking for hand-rolled per-unit versions left behind by an earlier migration:

```hcl
remote_state {
  backend = "s3"

  config = {
    bucket         = "acme-tfstate-${local.env}"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = local.region
    encrypt        = true
    dynamodb_table = "acme-tflocks-${local.env}"
  }

  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
}
```

`path_relative_to_include()` gives every unit a distinct state key derived from its position in the tree, so adding a unit requires no backend thought at all.

### Dependency mocks, or how to make `plan` work on an empty account

The one genuinely annoying part of a dependency graph is that `terragrunt run-all plan` on a fresh environment fails: the VPC doesn't exist yet, so its outputs can't be read, so the EKS unit can't plan.

```hcl
dependency "vpc" {
  config_path = "../vpc"

  mock_outputs = {
    vpc_id          = "vpc-00000000000000000"
    private_subnets = ["subnet-000000000000000a", "subnet-000000000000000b"]
  }

  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}
```

That last line is not optional decoration. Without it, mocks apply to `apply` and `destroy` too, and a dependency that silently returns a fake VPC ID during an apply is a genuinely bad afternoon. Restrict them to read-only commands and let real applies fail loudly when their dependency is missing.

### The measure of success

After this pass, a leaf unit in my current repo is the `include`, the `source` line, its dependencies, and its inputs — usually under twenty-five lines, and every one of them says something specific about that unit. Adding a new environment is copying a directory of small files rather than a directory of small files plus six hundred lines of ceremony that must be kept in sync forever.

Terragrunt gives you the tools to do this on day one. The trap is that it also lets you not to, and everything works fine until the day you need to change one thing in ninety places.

Cheers!
