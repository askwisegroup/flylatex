# FlyLaTeX Community Edition

**English** | [简体中文](./README.zh-CN.md)

A LaTeX collaboration platform built on top of **Overleaf Community Edition**.

This repository contains the code we are able to publish. It is enough to run the
editor, compile documents, manage projects and collaborate — but it does **not**
contain the commercial systems we operate around it (see
[What is not included](#what-is-not-included) below).

---

## Upstream and license

This project is a fork of Overleaf's open-source code base:

| Item | Value |
| --- | --- |
| Upstream project | https://github.com/overleaf/overleaf |
| Upstream commit this fork is based on | `811172f1fa` — *Merge pull request #16528 from overleaf/jdt-wf-settings-copy*, 2024-01-16 |
| Upstream package versions at that commit | `@overleaf/settings` 3.0.0, `@overleaf/logger` 3.1.1, `@overleaf/metrics` 4.1.0, `@overleaf/fetch-utils` 0.1.0, `@overleaf/object-persistor` 1.0.2 |
| Compatible container base image | `sharelatex/sharelatex:5.1.x` (Community Edition images are x86-64 only) |
| License | **AGPL-3.0** — see [LICENSE](./LICENSE) |

Overleaf Community Edition is distributed under the GNU Affero General Public
License v3. We keep that license, keep the upstream copyright notices, and
publish our modifications under the same terms, as the AGPL requires.

`libraries/` (the internal `@overleaf/*` packages that `npm ci` resolves from
disk) is vendored here at the same upstream commit, so this tree builds on its
own.

**Trademarks.** "Overleaf" is a trademark of Overleaf Ltd. and "LaTeX" belongs to
the LaTeX Project. The AGPL grants you a license to the *code*, not to those
names or logos. Strings that are still user-visible carry the upstream notices
they came with; anything we brand ourselves uses the name "FlyLaTeX".

---

## What is not included

A number of features you may see referenced in configuration or in the UI are
provided by **separate commercial systems** that we operate. They are not part of
this repository and cannot be published, because they contain partner
credentials, commercial pricing and customer data:

| Area | How it works in our deployment | In this repository |
| --- | --- | --- |
| Account system / login | An external user center, reached over OAuth2 + a password-transport API (`overleaf-ne-login/`) | Integration code and wiring are present but point at placeholders; no credentials, no endpoints |
| Campus federation (CARSI / Shibboleth-style) | Same external user center, plus an institution manager service | Not configured; adapters only |
| AI assistant backend | An LLM gateway we run, plus per-user credentials | `LLM_*` settings and the OpenAI-compatible protocol adapters are included; the gateway itself and its keys are not |
| Billing and payments | A hosted third-party checkout, plus an internal append-only ledger | The ledger/billing *code* is present and driven entirely by configuration; no merchant credentials, no real price list |
| Memberships / VIP | Our own plans service | Plan data is not included; pricing is configuration |
| SSO for companion apps | A registered-client table we maintain | The provider implementation is present; the client registry defaults to empty, which disables the endpoints |
| Whiteboard, template library, TikZ library, ops/portal console | Independent services on their own hosts | Only links/placeholders |
| Personal knowledge base, literature search | External services behind our gateway | Adapters present, endpoints not configured |
| Ops tooling (nav menu management, deployment runbooks, build pipeline) | Internal repositories | Not included |

In short: **the absence of these systems does not stop you from using the
product.** You can register a normal account, create projects, write and compile
LaTeX, invite collaborators and export PDFs. What you do not get are the
commercial add-ons that we sell, because they are separate products talking to
this one over HTTP, not code inside it.

The default configuration is intentionally "no commercial dependency":
`services/web/config/internal-values.example.js` is the file that a real
deployment replaces with its own private values (see
[Configuration](#configuration)).

---

## Requirements

* Node.js 18 (the upstream code base is from the Node 18 era)
* MongoDB 5+ (a replica set is required by the app, even single-node) and Redis
* A TeX Live installation, if you compile documents on the same host
* Optional: Docker, if you prefer to build the published image layout

## Quick start

```bash
# dependencies (all @overleaf/* packages resolve from ./libraries)
npm ci --workspace services/web --include-workspace-root

# configuration: copy the example and fill in your own values
cp services/web/config/internal-values.example.js services/web/config/internal-values.js
$EDITOR services/web/config/internal-values.js

# start (development mode)
cd services/web
npm run start:dev
```

The app expects MongoDB at `mongodb://mongo/sharelatex` and Redis at `redis`
by default; both are overridable with `MONGO_CONNECTION_STRING` / `REDIS_HOST`
and the other variables documented in `services/web/config/settings.defaults.js`.

### Rebuilding the editor front end

```bash
cd services/web
npm run webpack:production     # or: npm run webpack:dev
```

---

## Configuration

Everything private lives in one file:

```
services/web/config/internal-values.js          # your values, never commit this
services/web/config/internal-values.example.js  # the template that ships
```

Every value in it can also be overridden with an environment variable, which is
the recommended way for container deployments (see the comments in
`settings.defaults.js`). Notable ones:

| Variable | Meaning |
| --- | --- |
| `APP_NAME`, `SITE_URL`, `PUBLIC_URL` | Branding and absolute URLs |
| `MONGO_CONNECTION_STRING`, `REDIS_HOST` | Data stores |
| `LOGIN_PASSWORD` / `LOGIN_SMS` / `LOGIN_CARSI` / `LOGIN_GOOGLE` | Which login methods are offered |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in (needs an authorized JavaScript origin) |
| `LLM_PROTOCOL`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_DEFAULT_MODEL` | AI assistant upstream (any OpenAI-compatible endpoint) |
| `BILLING_ENABLED`, `BILLING_PROVIDER`, `BILLING_*` | Optional billing; leave disabled for a plain installation |
| `SSO_CLIENTS` | Registered OAuth clients for the SSO provider; empty disables it |

If no login method is usable, the app deliberately falls back to password login
and logs an error, so a misconfiguration cannot lock everybody out.

Useful checks:

```bash
cd services/web
npm run check:no-hardcoded-secrets   # no credentials outside internal-values
npm run check:sso-config             # SSO registry sanity
node scripts/i18n-llm/verify.js      # translation catalogue consistency
```

---

## Repository layout

```
libraries/                  vendored @overleaf/* workspace packages (upstream commit above)
patches/                    patch-package fixes required by the upstream dependency tree
services/web/               main web application (Express + React)
  app/                      server code
  frontend/                 client code
  config/                   settings.defaults.js + internal-values(.example).js
  locales/                  translation catalogues
services/clsi/              compile service
services/document-updater/  document history / OT service
services/*                  other upstream services (chat, contacts, filestore, real-time, ...)
```

## Contributing

Issues and pull requests are welcome. Please keep credentials, private endpoints
and customer data out of commits; the `check:no-hardcoded-secrets` script is
part of the review gate.

## Acknowledgements

FlyLaTeX exists because Overleaf published their Community Edition under the
AGPL. We keep the same license, the same spirit, and — where we could — the same
code.
