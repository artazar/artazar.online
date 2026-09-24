---
title: "The SYN that went nowhere"
date: 2026-09-24T00:08:30Z
description: "Random connect timeouts across an EKS cluster, five wrong theories, and a TODO comment in a scale-to-zero operator."
tags: ["kubernetes", "eks", "cilium", "networking", "debugging"]
slug: ""
---

We had finished an EKS minor version upgrade a few days earlier. Then the errors started:

```text
ERROR 1 --- [o-8080-exec-172] c.e.a.controller.advice.ControllerAdvisor :
Connect to file-service:80 [file-service/172.20.31.1] failed: Connect timed out
executing GET http://file-service/file/CONFIG?objectName=config/AppConfig.json
feign.RetryableException: ...
```

Then the same thing from other services, to other destinations. Intermittent. Mostly the backends answered fine. Sometimes they didn't.

A recent cluster upgrade is exactly the kind of fact that hijacks an investigation. It sits there looking like the answer, and every piece of evidence gets bent to fit it. It had nothing to do with this. It took me a while to accept that, and a couple of the dead ends below exist only because I couldn't let go of it.

### Connect timed out is a specific accusation

`Connect timed out` is not `Connection refused`. Refused means a machine answered and said no. Timed out means nobody answered at all — the SYN left and nothing came back. DNS had already resolved (`file-service/172.20.31.1` is right there in the message), so this wasn't a name resolution problem either.

That narrows things usefully. Something between the client socket and the destination was eating packets silently.

### Five theories, all wrong

**Endpoints are empty.** First guess, and the cheapest to check. `kubectl get endpointslices` showed a healthy backing pod. Not it.

**kube-proxy is broken.** A minor version jump moves kube-proxy and the CNI together, and EKS addons don't upgrade with the control plane. But the addon version matched the control plane — no skew. The logs showed it happily reloading iptables rules:

```text
I0000 00:00:00 proxier.go:1387] "Reloading service iptables data" ipFamily="IPv4"
numServices=437 numEndpoints=831 numNATChains=4 numNATRules=405
```

I spent a while being suspicious of "405 NAT rules for 437 services", which felt too low. It wasn't — recent kube-proxy releases landed significant rule-construction optimisations that cut chain counts. But the theory died on better evidence anyway: missing NAT rules are binary per service. That service would be 100% dead from every pod on the node, not 1% dead. The failures were intermittent against destinations that mostly worked.

**conntrack exhaustion.** This one fits the symptom beautifully. When the conntrack table fills, established connections keep working while *new* ones get dropped silently — random failures, healthy backends, nothing logged at the destination. There was even a plausible upgrade-related change to point at: a recent release capped `nf_conntrack_max` to stop high-core machines allocating absurd tables.

Dead end. The cap only bites on large nodes; ours are 4 and 8 core, where the auto-calculated value lands nowhere near it. And the clincher: I could reproduce the failure with a single API test. Exhaustion needs volume. I had none.

**The destination is refusing connections.** Worth ruling out properly, because `/proc/net/netstat` gives you a definitive answer:

```text
ListenOverflows 0    ListenDrops 0    TCPReqQFullDrop 0    SyncookiesSent 0
```

Zero. That pod had never overflowed its accept queue. It wasn't dropping anything — 1 retransmit timeout against 140,400 data segments sent. Whatever was happening, the destination wasn't doing it.

**A connection leak in the client.** This one I believed for two full rounds, and it's instructive how good the evidence looked. A test run showed exactly 200 successful requests before the 201st hung — and 200 is the default `maxConnections` for Feign's Apache HttpClient pool. Restarting the microservice made the problem vanish, which is precisely what a leaked pool does. Leaked connections are invisible to every recovery mechanism: idle eviction only touches connections that are *in* the pool, and `connectionRequestTimeout` defaults to wait-forever.

Then the detail that killed it. Watching the socket during reproduction:

```text
tcp 0 1 ::ffff:10.2.164.13:47434 ::ffff:172.20.31.1:80 SYN_SENT
```

A leaked connection never reaches `SYN_SENT`. It's already established and checked out. This was a fresh socket whose SYN was going unanswered. The 200 was coincidence, and the restart had worked for a different reason entirely.

### Asking conntrack instead of guessing

At this point I stopped theorising and watched flows directly. The `conntrack` utility has an event mode that's far more useful than any counter:

```sh
conntrack -E -p tcp --dst 172.20.31.1
```

Run during a reproduction, the output sorted itself into two populations. Healthy flows:

```text
[NEW]    tcp 6 120 SYN_SENT    src=10.2.164.13 dst=10.2.157.172 sport=43614 dport=8080 [UNREPLIED]
[UPDATE] tcp 6 60  SYN_RECV    src=10.2.164.13 dst=10.2.157.172 sport=43614 dport=8080
[UPDATE] tcp 6 86400 ESTABLISHED ...
```

And one that wasn't:

```text
[NEW]    tcp 6 120 SYN_SENT    src=10.2.164.13 dst=10.2.154.66 sport=56214 dport=8012 [UNREPLIED]
```

No `[UPDATE]`. Ever. It sat `[UNREPLIED]` until the 120-second timeout reaped it.

Two things jumped out. First, conntrack *created* the entry — so the packet reached netfilter and was forwarded. Nothing on this node was dropping it. Second, the destination was a pod IP, not a ClusterIP. Direct pod-to-pod traffic was failing the same way, which quietly excluded every service-layer theory I'd been entertaining.

And what was port 8012?

### The scale-to-zero operator

Port 8012 belongs to [KubeElasti](https://github.com/KubeElasti/KubeElasti), a scale-to-zero controller we run. When a service scales to zero, Elasti *hijacks* its EndpointSlices — rewriting them to point at its own resolver proxy, which holds incoming requests while the real workload spins back up. When the workload is up, it hands the endpoints back.

The live resolver was at `10.2.131.127`. My pod was dialling `10.2.154.66`. That address belonged to a resolver pod that no longer existed — the resolver had been restarted over the weekend, and something had not caught up.

Cilium's view of the service map made it plain:

```sh
cilium-dbg service list | grep 172.20.31.1
```
```text
435   172.20.31.1:80/TCP   ClusterIP   1 => 10.2.154.66:8012/TCP (active)
```

`file-service` — the service from the original stack trace — pointing at a dead pod, marked active. Every Feign call to it on that node went to an address where nothing was listening, and sat in `SYN_SENT` until it gave up.

Sweeping every node showed the damage wasn't uniform:

```text
cilium-4j7rd   1 => 10.2.154.66:8012  (dead resolver)
cilium-4pmc7   1 => 10.2.157.172:8080 (real backend)
cilium-5skkd   1 => 10.2.157.172:8080 (real backend)
cilium-6lgwr   1 => 10.2.154.66:8012  (dead resolver)
```

Three nodes in ten were broken. A pod scheduled onto one of those failed every call; anywhere else it worked. Restarting a workload "fixed" it whenever the pod happened to land on a healthy node, and reintroduced it whenever it landed back on a bad one — which is what had made the whole thing look random.

On an affected node, around forty services were routed through the resolver, several with *both* a live and a dead backend:

```text
4    172.20.62.185:80/TCP   ClusterIP   1 => 10.2.131.127:8012/TCP (active)
                                        2 => 10.2.154.66:8012/TCP (active)
```

Half the requests to those hit a black hole. That's the intermittency, and it's why it looked statistical when it was entirely deterministic.

### The actual bug

I was briefly convinced this was a Cilium datapath bug — the live EndpointSlice said `8080` while the BPF map said `8012`, which looks like an agent failing to reconcile. I was wrong, and the mistake is worth naming: Elasti *rewrites* EndpointSlices, so the slice I was looking at wasn't the one Cilium had programmed from. Cilium was faithfully implementing what it had been told.

The real cause is [KubeElasti PR #297](https://github.com/KubeElasti/KubeElasti/pull/297). The resolver Deployment's informer had `DeleteFunc` as a TODO — it logged a warning and did nothing else. Delete or replace the resolver Deployment while any ElastiService is in proxy mode, and the hijacked EndpointSlices keep pointing at dead resolver pods indefinitely. In the author's own words: *all traffic to affected services silently timed out with no error surfaced anywhere the operator could see.*

That last clause is the whole story. An unhandled delete event — which is to say a dozen lines of missing code — presented itself as a cluster-wide network fault, with a recent infrastructure upgrade standing nearby looking guilty.

### What I'd do differently

**Watch flows before reading counters.** `conntrack -E` during a reproduction told me more in thirty seconds than a day of `/proc/net/netstat` arithmetic. Counters tell you a population is unhealthy; events tell you which flow died and where it stopped.

**Treat coincident timing as a hypothesis, not a premise.** The upgrade had nothing to do with the symptoms. I burned real time reading changelogs because the timing felt like evidence. It wasn't — it was a prior, and I should have held it more loosely once the first two checks came back clean.

**When a restart fixes it, ask what the restart actually changed.** I read "restarting the pod fixed it" as proof of in-process state, which pointed at the connection pool. It was equally consistent with the pod being rescheduled onto a healthy node. Both explanations fit; I only checked one.

**Silence from a drop monitor is data.** `cilium-dbg monitor --type drop` was clean throughout, and I kept treating that as a failed check. It wasn't — it meant nothing was being *dropped*. The packets were being delivered, correctly and efficiently, to somewhere nothing was listening. Which, once you say it out loud, is a much more specific clue than a drop would have been.

**Pre-1.0 operators own your control plane.** Elasti was on a release candidate, rewriting EndpointSlices for forty services in our dev cluster — which is exactly where you want to find this out. The failure mode is close to the worst case for debuggability: silent, partial, and node-dependent. Worth knowing before it gets anywhere near production. If you run something that mutates endpoints, monitor the datapath against the API server's view. A CronJob diffing `cilium-dbg service list` against live EndpointSlices would have caught this in minutes.
