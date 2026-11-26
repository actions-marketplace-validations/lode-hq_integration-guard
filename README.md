# Lode Integration Guard

A free check that runs on pull requests. When a change adds or removes an integration (Stripe, Resend, Clerk, Supabase and more), it shows Lode's published facts for it on the platforms the repository uses:

- the price as Lode recorded it;
- the platform plan needed;
- how many limitations are documented;
- objects that more than one app writes into the same platform.

Each line links to its Lode record, with the date the record was last verified.

It is quiet on every other pull request, and it never blocks a merge.

It reads 9 config files and stores nothing about your repository. See [PERMISSIONS.md](PERMISSIONS.md) for what reaches Lode with each way of running it.

## Two ways to run it

- **GitHub Action** (available now): runs in your own CI, works for monorepos and for organisations that don't install apps. Needs Node 18 or later on the runner, which GitHub-hosted runners have.
- **GitHub App** (coming soon): one click, no workflow to edit. It requests read access to the 9 named files only, plus checks. Its code is in `app/`; it isn't available to install yet.

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write   # only needed for the comment
jobs:
  lode:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lode-hq/integration-guard@v0
        with:
          dirs: "."            # comma-separated folders for monorepos, e.g. "apps/web,apps/api"
          comment: "true"      # "false" keeps the result in the job summary only
```

## How it decides what is an integration

Package names, `.env.example` variable prefixes and config files are matched with Lode's public list of official SDK names (`https://trylode.io/api/stack-signals.json`). Ordinary libraries (react, lodash) are never on it.

## Known limits

- **App, opening a pull request:** a branch pushed before its pull request was opened (the usual order) is compared with the default branch, so a pull request into another branch is compared with the default branch too. Branches without a pull request are checked the same way; the result stays quiet unless an integration changes.
- **App, forks:** pull requests from forks aren't checked.
- **App, moved base branch:** the app compares with the base branch as it is now. If that branch has gained an integration since the pull request's branch was cut, the integration can show as removed.
- **Unreadable `package.json`:** if `package.json` can't be read as JSON (for example during a merge conflict), it isn't compared, and the report says so.

## What it looks like

When a pull request adds Resend to a project that already uses Stripe on Vercel, the comment (or job summary) lists Resend's Lode records: the price as recorded, the platform plan needed, the number of documented limitations, and a link to each record with its last-verified date (DD-MM-YYYY). Where Lode has no record for an app on a platform, it says so: that means not documented by Lode, not unsupported.

## Source

This repository is published from Lode's main repository, where the code and its tests live. `lib/vendor/lode.mjs` is a copy of the script from Lode's Integration Check skill ([lode-hq/lode-mcp](https://github.com/lode-hq/lode-mcp)), so the guard, the skill and Lode's MCP server give the same answers. Issues and pull requests are welcome here.

## Licence

MIT. See [LICENSE](LICENSE).
