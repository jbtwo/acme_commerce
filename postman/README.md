# Postman assets

This directory is intentionally almost empty.

## Why there is no collection here

The Postman collection for Acme Commerce is **yours to build, by hand, at the learning
checkpoints**. It is not generated, and it will not be written for you.

That is a deliberate split in how this project is built:

| Responsibility                                                      | Owner                               |
| ------------------------------------------------------------------- | ----------------------------------- |
| Building the API                                                    | The lead engineer (Claude)          |
| Verifying the API works, without Postman                            | The lead engineer                   |
| Building the Postman collection, environments, variables, and tests | **You**                             |
| Reviewing what you built and suggesting improvements                | The lead engineer                   |
| Wiring your finished collection into CI                             | The lead engineer, from your export |

The reason is simple: a generated collection teaches you what a generator produces. Building
one by hand teaches you what a variable scope is, why a base URL belongs in an environment
rather than in a request, what `pm.response.json()` actually returns, and — most usefully —
what it feels like when a request fails and you have to work out whether the fault is in your
collection or in the API.

The API is verified before each checkpoint precisely so that when something fails, "the API is
broken" is a real hypothesis you have to rule out rather than the assumed answer. Verification
evidence for the current milestone is in [`../docs/BUILD_VERIFICATION.md`](../docs/BUILD_VERIFICATION.md).

## Expected layout once you have exported your work

```text
postman/
├── README.md                                        (this file)
├── Acme-Commerce.postman_collection.json            your collection
└── environments/
    ├── Acme-Commerce-Local.postman_environment.json     laptop / dev container
    └── Acme-Commerce-Unraid.postman_environment.json    your Unraid deployment
```

Export from Postman with the ⋯ menu on the collection or environment → **Export** → Collection
v2.1 (the current format) → save into this directory with the filename above.

## Naming

**Collection:** `Acme Commerce`. One collection for the whole API, with folders per domain.
Splitting into `Acme Commerce Catalog`, `Acme Commerce Orders`, and so on looks tidy at first
and then makes a cross-domain workflow — check inventory, price it, place an order — impossible
to express without duplicating requests.

**Folders:** name them after the API's own tags, so the collection and the OpenAPI document
navigate the same way. In Milestone 1 that is `Platform` and `Catalog`.

**Requests:** name them after what they do, not after the URL. `List products (filtered)` is
findable; `GET {{base_url}}/api/v1/products?status=active&vendor=Acme` is not, and it becomes
a lie the moment you change a parameter.

**Environments:** `Acme Commerce — Local` and `Acme Commerce — Unraid`. The point of two
environments with identical variable _names_ and different _values_ is that the same request
runs against both. If a request only works in one environment, something that should be a
variable is hard-coded.

## Secrets — read this before your first commit

Postman environment exports contain **variable values in plain text**. Exporting an
environment that holds a real password or bearer token and committing it publishes that
credential, and a later `git rm` does not unpublish it: it stays in the repository history and
in every clone and fork.

Before committing any environment file:

1. **Keep the variable names.** They are the useful part — they document what the API needs.
2. **Replace every secret value with a placeholder.** `REPLACE_ME`, or an obviously fake value
   like `dev-token-goes-here`.
3. **Use Postman's `secret` variable type** for anything sensitive, and set it as a **current
   value** rather than an initial value. Postman exports _initial_ values and leaves current
   values on your machine — that distinction is the single most useful thing to know about
   Postman and secrets.
4. **Consider whether the hostname itself is sensitive.** An internal Unraid hostname or a LAN
   IP is not a credential, but it is information about your network. `http://REPLACE_WITH_UNRAID_HOST:3000`
   is a reasonable committed value.
5. **Look at the diff before you commit.** `git diff --staged postman/` takes five seconds and
   catches this.

Nothing in Milestone 1 requires a credential — the Catalog API is unauthenticated. Bearer
tokens arrive in Milestone 2 and partner API keys in Milestone 4, which is exactly when this
section starts to matter. It is here now so that the habit is in place before the secret is.

## Variable placement

A rule of thumb that will save you rework:

| Put it in                  | When                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Environment**            | The value differs between local and Unraid. `base_url`, credentials, ports.                                   |
| **Collection variable**    | The value is the same everywhere but used in many requests. A default page size for your tests, say.          |
| **Collection-level auth**  | From Milestone 2. Set the token once; individual requests inherit it, and the few that must not can override. |
| **Nowhere — hard-code it** | Almost never. A hard-coded `localhost:3000` is the reason an exported collection fails for everyone else.     |

Identifiers captured from a response (`product_id`, `variant_id`) belong in **collection
variables** set from a test script, not in the environment. They are run state, not
configuration, and putting run state in an environment means your committed environment file
carries a stale id from last Tuesday.

## What happens to your export

Once you have exported a working collection, the lead engineer will:

1. Review it — naming, folder structure, variable scopes, auth inheritance, request chaining,
   test quality, duplication, and any accidentally-committed secrets.
2. Explain every recommended change **before** touching anything.
3. Make only the changes needed for reliable command-line execution, preserving the intent of
   your requests and tests.
4. Add a Newman or Postman CLI runner script.
5. Wire it into GitHub Actions and walk you through reading the results.

Your collection will not be replaced with a generated one.
