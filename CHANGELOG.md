# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Terms of use and imprint can be switched off in _Einstellungen → Rechtliches_, for private wikis. The privacy notice always stays. Without an imprint, the postal address is no longer required.
- When the wiki is served through Cloudflare (tunnel or proxy, detected from the `CF-Ray` header), the privacy notice explains what Cloudflare processes, that TLS ends at Cloudflare, its cookies (`__cf_bm`, `cf_clearance`, `_cfuvid`) and the transfer basis (EU-US Data Privacy Framework plus standard contractual clauses). No setting needed.
- `tests/attack.mjs`: the adversarial test battery against any running instance.

### Fixed

- Uploads and imports left one `error` listener on the file stream per backpressure cycle (thousands on a large video or import). The listeners are now removed after each wait.

## [1.0.0] — 2026-11-03

First public release.

### Reading and writing

- Markdown pages in chapters with live preview, drafts, live updates for readers, conflict detection, history with diff and restore, recent changes, backlinks.
- Search while typing with a full results page; substring matching, `*` wildcards, phrases, case- and accent-insensitive.
- Links to other sites open in a new tab; picture-in-picture for every video.
- Images and videos by upload, paste or drag & drop; two-click YouTube/Vimeo embeds.
- Import and export of single pages and the whole wiki; new pages from a `.md` file.
- One typeface throughout (Inter), monospace only for code.

### Accounts and administration

- Roles (owner, administrator, editor, viewer), self-registration, public read-only or private mode.
- Two-factor authentication with several devices per account, required per role.
- Password policy, escalating lock-out, session overview with sign-out per device, self-service profile changes.
- SMTP in the settings with a test mail; HTML mails in the wiki's design.
- Security log with IDs, filters and export; GDPR export and erasure; generated legal pages.
- Confirmation dialogs for destructive actions.

### Upgrading from pre-release builds

The database migrates automatically: the existing authenticator becomes a device named "Authenticator", a former "2FA required for everyone" setting turns into "required" for all three roles, and an unedited Markdown guide is replaced by the current one.

[Unreleased]: ../../compare/v1.0.0...HEAD
[1.0.0]: ../../releases/tag/v1.0.0
