# Changelog

## 0.6.0

- New project type for .NET servers (C#, .NET Framework), with its setup steps, for the `Vedhaai.MCPWatch` NuGet package.
- Alerts per project by email (SMTP server entered in the dashboard; no server, no email), Slack incoming webhook or signed webhook, with severity, block/throttle and cooldown settings and a test button.
- Outlook alert channel, separate from email: an Outlook or Microsoft 365 mailbox, its password (stored encrypted) and recipients, sent through smtp.office365.com over STARTTLS.
- Alert emails are HTML with the MCPWatch logo and name, readable rule titles and a plain-text version; test alerts say they are a test. Email requires TLS whenever a username is set.

## 0.5.0

- Show AI reviewer usage in the dashboard. Requires `@vedhaai/mcpwatch` 0.4.0 or later.
- Harden stored secrets and the dashboard link to the engine.
- Package: `bugs` URL and `author` fields.

## 0.4.1

- Ship the MIT license in the package.
