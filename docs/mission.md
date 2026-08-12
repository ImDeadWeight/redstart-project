# Mission & Origin

*[← back to the README](../README.md) · [docs index](README.md)*

What Redstart is, why it exists, who it is for, and where the name came from.

---

## What Redstart is

Redstart is a small ecosystem of applications built around a self-hosted AI server.

**Redstart Nest** is the server. It runs local models, hosts the tools, accounts and policy, and exposes controlled AI capabilities to the applications that connect to it. **Redstart Twig** is the chat client. [**Blueprints**](https://github.com/ImDeadWeight/redstart-blueprints) (a local-first SQL data workbench) and [**Yellowscript**](https://github.com/ImDeadWeight/redstart-yellowscript) (a VS Code coding agent) are in development against the same server, and **Greenhouse** (project management) is planned.

Rather than building a separate AI backend into every application, Nest provides one shared server that hosts local models and exposes controlled capabilities to the applications that use them. Twig and Yellowscript connect to the same Nest instance while using it for entirely different purposes.

The goal is to make a local AI server useful in the same way a small organization's internal application server is useful: one piece of infrastructure that provides capabilities to multiple users and multiple applications, administered in one place.

---

## Origin

Redstart started as a personal frustration fix. Running llama.cpp meant remembering and typing out long command-line arguments every time — model path, context size, GPU layers, port, host. I wanted a UI where I could save those settings and hit a button.

The primary use case was a **local coding agent**: a capable AI assistant that works without a subscription and never sends code off-device. That began as pointing an off-the-shelf extension at a local model — anything OpenAI-compatible works, and Kilo Code and Continue still do — and has since become Yellowscript, a coding agent built directly against Nest rather than adapted to it. Everything else — the Android app, the QR code, the Windows client — grew from wanting that same server accessible on my phone from the couch.

The privacy angle is not an afterthought. My background is in social work, where you routinely handle information that genuinely should not leave the room. The idea of pasting case notes or client details into a cloud AI product is uncomfortable, but workloads in the field are often challenging, making tools like LLM workflows for documentation helpful. Running a model locally means the data stays on the machine — no API calls phoning home, no training pipeline, no terms of service to read carefully or settings to change.

**On the name:** the project was originally called *Beaver* (llama.cpp is named for an animal, and a beaver builds a dam — a fitting metaphor for keeping your AI use contained). It was renamed to **Redstart** to avoid a naming conflict with an established project in the same space. A redstart is a small bird, which keeps the animal theme alongside the llama. The naming carries through the pieces: the server that hosts the model is **Redstart Nest** (where the bird lives), and the lightweight clients that connect to it are **Redstart Twig**. The applications built on top — Blueprints, Yellowscript, Greenhouse — continue the theme.

---

## Why self-hosted

Cloud AI is convenient, and for most workloads it is the sensible choice. But using a hosted service also means accepting someone else's infrastructure, policies, pricing, and controls. That is not necessarily a problem.

There are situations where individuals and organizations need more say in how AI is deployed and what it can reach. Redstart is built for those situations. The point is not to avoid the cloud on principle — it is to give the operator **control over their own AI infrastructure** when that control actually matters.

Redstart's answer to that is simple: **own the hardware, run free software, pay once.**

A gaming PC with a capable GPU is a capital expense. It depreciates, but you own it. The model weights are a file you download. The software is open source. That cost structure is predictable in a way a per-seat subscription is not, and it does not scale with headcount.

**Why open source matters here specifically.** Beyond cost, open source software can be audited. In regulated industries that matters — you can verify what the software does and doesn't send. It also removes the continuity risk that comes with depending on any single vendor's product roadmap.

---

## Who this is for

The primary target is **small businesses and organizations** that want an internal AI system running on hardware they own and administered by the organization, rather than purchased per-seat as a hosted service.

**The liability problem is concrete, not abstract.** For organizations in regulated fields, the question isn't just cost — it's what can be used without professional exposure:

- **Social work** — client confidentiality is a licensing requirement. Information leaving your network, even to a "secure" third-party service, is a legally uncomfortable position depending on jurisdiction.
- **Legal** — attorney-client privilege attaches to communications. Routing client details through a third-party API creates privilege questions most attorneys don't want to litigate.
- **Healthcare-adjacent** — HIPAA business associate agreements exist for this reason, and the major providers do offer them: Anthropic, OpenAI, Google Cloud and Azure OpenAI all support BAAs and zero-retention arrangements under their business and enterprise agreements. The barriers for a small organization are practical rather than absolute — the covered tiers cost more than the consumer ones, the agreements need legal review most small shops can't fund, and the consumer products staff actually reach for are explicitly *not* covered. A BAA is also a contractual allocation of liability, not a technical boundary: the data still leaves your network, and you are relying on a third party's controls and their subprocessors. Self-hosting removes the question instead of papering over it.
- **Education** — FERPA covers student records. Same shape of problem.

**Developers** are the other group this already serves well today: an AI coding assistant that can work against a local development environment without giving a third-party service unrestricted access to it.

**On consumer use.** The same properties that make Redstart useful to a small office should make it useful in a home — a household running an assistant on its own hardware, where a parent decides which models are available, who can sign in, and which tools and external resources are reachable. That direction matters because it is the clearest test of whether this is genuinely usable by non-specialists rather than only by people who enjoy configuring servers. Today Nest supports accounts and per-account file isolation, but tool and capability grants are still server-wide rather than per-account, so the fine-grained version of that story is intent and direction, not a shipped feature. See the [roadmap](roadmap.md#known-limitations).

---

## Control, not isolation

Redstart is designed around local inference and administrator-controlled access, not the assumption that nothing can ever communicate outside the machine.

Inference runs on your hardware, so the default path for a conversation is that nothing is transmitted anywhere — no third party, no terms-of-service clause to parse. What leaves the building is exactly what an administrator turns on: approved web sources, academic search, or an external tool server. Each is an explicit, auditable choice rather than a condition of using the software.

That means the operator decides which models are available, which applications and users can connect, which tools and MCP servers can be used, which resources those tools can reach, and whether external connections are permitted at all.

The result is not a promise that data can never leave the machine. It is a system where **you have a meaningful say in what is allowed to leave it** — and one that will tell you the live answer, since `GET /egress` reports which domains are approved, which tool servers are remote, and which local stores exist. See [Security & Trust Boundaries](security.md#what-actually-leaves-the-machine).

---

## Where this is going

The mission is to make self-hosted AI practical for the people and organizations that want greater control over the systems they use — without requiring them to build the infrastructure themselves.

**The hardware case for small organizations.** Grants fund capital expenditures. A purpose-built AI server is a line item in a capital grant application — something a foundation or government program can fund once. A recurring SaaS subscription competes with salaries and direct services every year and is harder to justify to funders.

The long-term goal of this project — a **Redstart Box**, a dedicated appliance that sits in the office and just works — is designed around this reality. A single hardware purchase, free software, zero ongoing cost. Staff on any device connect to it the way they'd connect to a printer. That's the shape a solution needs to take for a 6-person social work agency, a small legal aid clinic, or a community health provider that genuinely cannot afford enterprise AI and genuinely cannot send client data to the cloud.

The project isn't there yet. But that's the direction.
