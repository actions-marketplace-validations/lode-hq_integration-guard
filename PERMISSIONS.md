# Lode Integration Guard: permissions, and why

Lode Integration Guard asks for the least access it can work with. This page lists every permission it requests, why, and what Lode keeps. There are two ways to run it, and they differ in where the work happens.

## GitHub App: runs on Lode's server

| Permission | Access | Why it's needed | What Lode keeps |
|---|---|---|---|
| Single file: `package.json`, `requirements.txt`, `pyproject.toml`, `Gemfile`, `go.mod`, `.env.example`, `vercel.json`, `netlify.toml`, `supabase/config.toml` | Read | To see which integrations the repository uses: at a pull request's base and head commits, or, for a branch pushed before its pull request is opened, at the branch's latest commit and the default branch | Nothing |
| Checks | Write | To post Lode's result as a check on the commit, which shows on its pull request. The check is always neutral, so it never blocks a merge | Nothing |
| Metadata | Read (GitHub's default for every app) | To know which repository an event came from | Nothing |

The app does not request access to your code (Contents), issues or pull requests.

**What reaches Lode's server.** GitHub sends Lode's server an event for each check suite. That event includes your repository's name, its owner and details of the latest commit, such as the commit message and the author. The server then reads the nine files above at two points: the commit being checked and the one it is compared with.

- **What it uses:** only the commit ids and those nine files.
- **`.env.example`:** the server receives the whole file but parses only the variable names, the part before `=`.
- **What it keeps:** nothing. Nothing is stored or logged, and no other request goes to Lode: the app looks up Lode's data on the same server.

## GitHub Action: runs in your own CI

The Action runs on your workflow's runner with your workflow's token.

- **What it reads:** the same nine files in each folder you list, at the base commit and at the checked-out commit.
- **What it writes:** the result, to the job summary.
- **Comments:** if you allow it (`pull-requests: write`), it also posts or updates one pull request comment. Set `comment: false` to keep the result in the job summary only.

**What reaches Lode.** Nothing from your repository is sent. The Action reads Lode's public files over HTTPS (`https://trylode.io/api/...`), using GET requests only. Lode's site logs those reads the way it logs any program reading its public data: the file requested, the time and the type of client (this one says `lode-guard`), with no IP address.

The record files read in one run are the ones for the integrations found. So the list of files read in a single run reflects which integrations a repository uses, even though nothing names the repository.

## Never read or kept

- Any file other than the nine above.
- Your code.

## Sharing

If Lode ever offers anonymous sharing (for example, counting which integrations repositories add), it will be off unless you turn it on. It will be described here and on Lode's privacy page before it starts.

## Removing it

Uninstall the app from your organisation's or account's GitHub settings, or delete the workflow step. Lode keeps nothing about your repository, so there is nothing to delete. Questions: data@trylode.io. Privacy policy: https://trylode.io/privacy/

## Check it yourself

The code is open.

- **File reads:** in `app/app.mjs` (`readFiles`) and `action/run.mjs` (`filesAtCommit`).
- **Lode data:** the Action reads it in `lib/guard.mjs` (`lodeReader`, GET only). The app is passed the data directly (the `read` option of `handleEvent`).
