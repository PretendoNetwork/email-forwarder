# Pretendo Network Email Forwarder

This is an SMTP server that forwards emails sent to a recipient of the form `<pid>@domain` to the associated PNID's real email address via SES.

## Why?

This exists for several reasons involving PNID SSO:

- The [Pretendo Network forum](https://forum.pretendo.network) runs on [Discourse](https://www.discourse.org), which requires every user to have a unique email address. However, Pretendo allows multiple PNIDs to share an email address, which means that multiple PNIDs would end up pointing to the same forum account ([discussed here](https://meta.discourse.org/t/integration-into-custom-auth-system-where-emails-are-not-unique/306489?u=matthewl246)). To ensure that every forum account gets a unique email address, Discourse account emails are set to `<pid>@domain` during SSO, which means that forwarding is required for email notifications.
- The Pretendo Network ticketing system SSO will use these fake emails to keep users' real email addresses private from agents.

This server forwards emails sent to the fake email addresses provided via SSO to the associated PNID's real email address.

## Setup

### Running in Docker

1. Install [Docker](https://www.docker.com).
2. Copy the contents of `example.env` to a `.env` file and set up the environment variables (see [Configuration](#configuration)).
3. Run `docker run --env-file .env -p PORT:PORT ghcr.io/pretendonetwork/email-forwarder` to start the server, replacing `PORT` with the SMTP port that you specified in the environment variables.

### Running locally

1. Install [Node.js](https://nodejs.org).
2. Clone this repository.
3. Copy `example.env` to `.env` and set up the environment variables (see [Configuration](#configuration)).
4. Run `npm install` to install dependencies.
5. Run `npm run build` to compile the TypeScript.
6. Run `npm start` to start the server.

## Configuration

This server is configured via environment variables:

| Name | Description | Default |
| --- | --- | --- |
| `PN_EMAIL_FORWARDER_SMTP_HOSTNAME` | Hostname of the SMTP server, sent to the client for identification and logged in the added `Received` header | `undefined` (uses system hostname) |
| `PN_EMAIL_FORWARDER_SMTP_PORT` | Port that the SMTP server listens on | `25` |
| `PN_EMAIL_FORWARDER_SMTP_USERNAME` | Username for SMTP client authentication | N/A (required) |
| `PN_EMAIL_FORWARDER_SMTP_PASSWORD` | Password for SMTP client authentication | N/A (required) |
| `PN_EMAIL_FORWARDER_SES_REGION` | SES region | `us-east-1` |
| `PN_EMAIL_FORWARDER_SES_ACCESS_KEY` | SES access key | N/A (required) |
| `PN_EMAIL_FORWARDER_SES_SECRET_KEY` | SES secret key | N/A (required) |
| `PN_EMAIL_FORWARDER_GRPC_ACCOUNT_ADDRESS` | Address of the [Pretendo Network account server](https://github.com/PretendoNetwork/account) | N/A (required) |
| `PN_EMAIL_FORWARDER_GRPC_ACCOUNT_PORT` | Port of the account server's gRPC service | N/A (required) |
| `PN_EMAIL_FORWARDER_GRPC_ACCOUNT_API_KEY` | API key for the account server's gRPC service | N/A (required) |
| `PN_EMAIL_FORWARDER_DOMAINS_DEFAULT_ACTION` | Default action for email sent to addresses with domains not specified in any of the below options, can be `forward`, `passthrough`, or `drop` | `drop` |
| `PN_EMAIL_FORWARDER_DOMAINS_FORWARD` | Emails sent to any address with a domain listed here will be treated as though the recipient is a PNID's fake email address and forwarded from `<pid>@domain` to the associated PNID's real email address | None |
| `PN_EMAIL_FORWARDER_DOMAINS_PASSTHROUGH` | Emails sent to any address with a domain listed here will be forwarded without modification to the recipient | None |
| `PN_EMAIL_FORWARDER_DOMAINS_DROP` | Emails sent to any address with a domain listed here will be silently dropped | None |

See [`example.env`](./example.env) for a full example configuration.
