---
title: "My First Post: Warp the Terminal"
date: 2023-05-26T04:08:30Z
slug: ""
---

About a month ago I installed [Warp](https://www.warp.dev/) on my workstation to try it out. Now I cannot go back to iTerm2 anymore. It's a trap.

![image](/01 - warp-image.jpg)

Now you claim everywhere you're a DevOps engineer, because "Linux Administrator" has become something old-school. But call it what you like, there's one common thing - you're the Terminal Guy. That means you use the Terminal and CLI set for all your tasks every day. Being a control freak like me, CLI has never been superseded by any fanciest UI tools.

Warp has produced that WOW-effect on me by bringing the feature I could not even imagine I could get from it.

Let me name a few:

1 - A small one but my favorite, because it covers a many-years-old pain: once you copy some wrong text into the Terminal window, you hit ctrl+z to undo, so simple yet fantastic!

{{< youtube id="Nh9uq0x3N8c" autoplay="true" >}}

2 - PasteBin like experience with sharing the outputs, because Warp treats a CLI command output as an object that you can manipulate and generate a link to it, example: [click](https://app.warp.dev/block/Vsy0PXZpdrWfglobYv64HI)

Also you can use text search within such output block only. Haven't used it so far, but also sounds nice.

3 - AI helper is great in certain scenarios, for example, to generate some unusual kubectl outputs: a prompt like "use kubectl to list pods and their attached volumes, use headers" immediately generated this:

```kubectl get pods -o=jsonpath='{range .items[*]}{"\n"}{"Pod Name: "}{.metadata.name}{"\n"}{"Volumes: "}{range .spec.volumes[*]}{.name}{", "}{end}{"\n"}{end}'```

It has so much more features you can study to boost productivity, I only start to learn them.
Besides that, it's very fast, very very fast, blazingly-fast as they say in their marketing shoutouts. I don't get any waiting moments with it. It just works.

There are some downsides though that I found:

* No immediate support for context visibility like K8S contexts or AWS profiles (investigating the workarounds...)
* Excessive RAM usage -> [tracked as a github issue](https://github.com/warpdotdev/Warp/issues/2611#issuecomment-1557370822)
* Sometimes the Terminal starts blinking a lot and becomes annoying, most likely it's a side effect of the point with RAM, as relaunching Warp will fix it. This doesn't happen often, once in few days.

Also, it's high likely they will make it a commercial product soon. So far I enjoy it, not sure if I am going to throw my dollars at it. But the temptation is there.
