# Security

## Reporting a vulnerability

Mail **court@subaud.io** with `galley security` in the subject. Please do not open a public issue for anything in the list below.

Say what you found, how to reproduce it, and what you think it lets someone do. A proof of concept helps but is not required. You will get a reply within a few days; if you do not, assume the mail went astray and send it again.

There is no bounty programme. There is one maintainer, and disclosures are handled by hand.

## What is in scope, and what a report is worth

galley is a local tool. It runs on your machine, serves a review page on `127.0.0.1`, and the binary never contacts a server — so the interesting surface is not a hosted one.

**Most valuable, in order:**

1. **Document corruption or data loss** — galley writes to files you asked it to review. A path that loses an author's words, writes outside the document's directory, or corrupts a document on a save is a serious bug even when nobody is attacking.
2. **The local server** — one `galley serve` per machine holds every open review on one loopback port. Every route and the editor's websocket need the server's token: the address galley opens carries it once, and the browser then holds it in a cookie. Anything that exposes the server beyond the machine, reaches a review without the token, lets another local process drive somebody else's review, or executes content from a document is in scope. Note that `--on-revise` and `--on-settle` run a shell command **by design**, configured by whoever opened the document; that is a feature, not a finding.

An HTML page under review runs its own scripts, on the server's origin, so that its preview renders as the real page does. Those scripts can therefore reach every review open on the server, not only their own. Review only HTML pages you trust. That a page under review can read and change other open reviews is known and out of scope. Running commands, opening other files, stopping the server or taking an agent's wakes from a page under review stay in scope.

galley has no license key, no gate, and no signing key: it is free under 25 people and licensed by one-time purchase above that, enforced by the license terms rather than by any technical control. There is therefore no "licence forgery" or "gate bypass" surface — the binary never verifies a key and never withholds a feature.

**Out of scope:** running the software outside the license terms (that is a licensing matter, not a technical control); and anything requiring an attacker who already has write access to your filesystem or your `~/.config`.

## Supported versions

Fixes land on the current release.
