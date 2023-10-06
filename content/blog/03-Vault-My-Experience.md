---
title: "Yet another Vault story"
date: 2023-10-06T00:08:30Z
slug: ""
---

One can find a million blog posts about various aspects of using Hashicorp Vault, this solution has truly received massive adoption. So now you don't even question what you're going to use as secrets storage, but the matter is more of "how".

Being a complete and inveterate gitops'er, one of my primary objectives is to store as much as I can in Git and to deploy that into Kubernetes. This brought me to the BanzaiCloud Bank Vaults solution bundle that allows you to achieve exactly this. It provides the ability to configure Vault as a Custom Resource and store all its primary settings on a repository. This is not very far from the official Helm chart deployment with their values, but BanzaiCloud give you a bit more:

* Vault init and unseal in automated mode (some cloud KMS is needed)
* On-the-fly reconfiguration without pod restarts
* A handy webhook to inject secrets into pods

### To inject

The last point is of a very special interest, since it's the only webhook out there that can inject secrets directly into application's memory without storing it inside files, etcd, visible environment variables, whatsoever. Whoa, how does that even work?

The authors have come up with an idea of intercepting the entrypoint of the containers defined in pod spec, and injecting their binary into it, which fetches the secrets directly from Vault and launches the original entrypoint with these secrets put into *its* environment only. So what does it give us:

1. Secrets stored inside Kubernetes are out of the question, we don't have anything in plain base64 anymore, and we cannot see secret values in pod specifications as well
2. We don't see the secret values inside container's shell running `env`, we'll only see the magic "vault:/path/to/secret" URI. Of course secrets do not magically appear out of nowhere, and the content of `/proc/1/environ` will reveal them to you, but only if you know where to look. 
3. The application we launch in pod is still unaware of Vault existence, it directly consumes what's given by the Vault client

I find such approach very nice and robust, and I won't dive more into it, because it's been well explained by the [original authors](https://banzaicloud.com/blog/inject-secrets-into-pods-vault-revisited/).

But there were also some difficulties that this caused for me.

### Or not to inject

One of the walls I hit is that I cannot use secrets inside liveness/readiness probes. Why would I need it? Well, with Spring Boot framework such probes are provided by [Actuator libraries](https://www.baeldung.com/spring-liveness-readiness-probes). And to secure Actuator endpoints, you add authentication too. Once you add authentication, you can not use it inside a liveness probe directly. As a result, I have this block in place:

```yaml
path: /spec/template/spec/containers/0/readinessProbe
value:
initialDelaySeconds: 10
periodSeconds: 5
timeoutSeconds: 10
exec:
    command:
    - /bin/sh
    - -c
    - |-
        wget --quiet \
            --auth-no-challenge \
            --spider \
            --user ${MANAGEMENT_USERNAME} \
            --password ${MANAGEMENT_PASSWORD} \
            http://localhost:8080/actuator/health/liveness \
            -O /dev/null
```

where MANAGEMENT_USERNAME and MANAGEMENT_PASSWORD are supposed to come from a secret:

```yaml
envFrom:
- secretRef:
    name: actuator-credentials
```

Once you start injecting Vault secrets, this stops working, since the application is able to obtain the credentials, but `kubelet` that sends the probes via its own shell process - does not inherit them. 

So this obstacle makes such kinds of credentials "special", required to be stored in k8s directly.

### R-r-raft snapshot (Bless you!)

Since Vault moved to supporting Raft storage backend, the whole backup/restore chain has become much less of a burden. In my case it consists of 2 actions:

1) Create the snapshot:

```sh
vault operator raft snapshot save /storage/vault.snap
```

One more piece of kudos to Banzai team is the ability to pass a Vault token for a service account into pod by using a special notation:

```yaml
env:
- name: VAULT_TOKEN
    value: vault:login
```

2) Transfer the snapshot to external storage:

```sh
mc --config-dir /storage/mc cp /storage/vault.snap s3/${MINIO_BUCKET}/vault.snap.${DATE}
```

The restoration part was slighly more complex to achieve, as it took me some time to understand the order of init / unseal / restore operations, especially when the first two are automated by operators. This may probably be more elegant, but I ended up with spinning up a new instance with a different name (this is to avoid naming collisions) and a "forced" restore that disregards the new instance unseal keys:

```sh
vault operator raft snapshot restore -force /tmp/vault.snap.20231005
```

But right after this restore, you should go to the AWS bucket where the keys are stored and replace them with the old ones.

### Seal it

Wrapping this up, using a Vault is essential, and having operational rapidity and reliability is crucial for day-to-day routines. My journey of setting up Vault and surrounding operations in automated form is over. Good luck!
