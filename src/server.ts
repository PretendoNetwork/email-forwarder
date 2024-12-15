import dotenv from 'dotenv';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { SMTPServer } from 'smtp-server';
import { createTransport } from 'nodemailer';
import { createChannel, createClient, Metadata } from 'nice-grpc';
import { AccountDefinition } from '@pretendonetwork/grpc/account/account_service';

import type {
	SMTPServerAuthentication,
	SMTPServerAuthenticationResponse,
	SMTPServerDataStream,
	SMTPServerSession
} from 'smtp-server';
import type { GetUserDataResponse } from '@pretendonetwork/grpc/account/get_user_data_rpc';

type EmailAction = 'forward' | 'passthrough' | 'drop';

dotenv.config();

const config = {
	smtp: {
		hostname: process.env.PN_EMAIL_FORWARDER_SMTP_HOSTNAME,
		port: Number(process.env.PN_EMAIL_FORWARDER_SMTP_PORT ?? 25),
		username: process.env.PN_EMAIL_FORWARDER_SMTP_USERNAME,
		password: process.env.PN_EMAIL_FORWARDER_SMTP_PASSWORD
	},
	ses: {
		region: process.env.PN_EMAIL_FORWARDER_SES_REGION ?? 'us-east-1',
		accessKey: process.env.PN_EMAIL_FORWARDER_SES_ACCESS_KEY ?? '',
		secretKey: process.env.PN_EMAIL_FORWARDER_SES_SECRET_KEY ?? ''
	},
	grpc: {
		account: {
			address: process.env.PN_EMAIL_FORWARDER_GRPC_ACCOUNT_ADDRESS ?? '',
			port: process.env.PN_EMAIL_FORWARDER_GRPC_ACCOUNT_PORT ?? '',
			api_key: process.env.PN_EMAIL_FORWARDER_GRPC_ACCOUNT_API_KEY ?? ''
		}
	},
	domains: {
		defaultAction: (process.env.PN_EMAIL_FORWARDER_DOMAINS_DEFAULT_ACTION as EmailAction) ?? 'drop',
		forward: process.env.PN_EMAIL_FORWARDER_DOMAINS_FORWARD?.split(',') ?? [],
		passthrough: process.env.PN_EMAIL_FORWARDER_DOMAINS_PASSTHROUGH?.split(',') ?? [],
		drop: process.env.PN_EMAIL_FORWARDER_DOMAINS_DROP?.split(',') ?? []
	}
};

const ses = new SESClient({
	apiVersion: '2010-12-01',
	region: config.ses.region,
	credentials: {
		accessKeyId: config.ses.accessKey,
		secretAccessKey: config.ses.secretKey
	}
});

const transporter = createTransport({
	SES: {
		ses,
		aws: { SendRawEmailCommand }
	}
});

const gRPCAccountChannel = createChannel(`${config.grpc.account.address}:${config.grpc.account.port}`);
const gRPCAccountClient = createClient(AccountDefinition, gRPCAccountChannel);

function getUserAccountData(pid: number): Promise<GetUserDataResponse> {
	return gRPCAccountClient.getUserData(
		{
			pid: pid
		},
		{
			metadata: Metadata({
				'X-API-Key': config.grpc.account.api_key
			})
		}
	);
}

function authHandler(
	auth: SMTPServerAuthentication,
	session: SMTPServerSession,
	callback: (err?: Error | null, response?: SMTPServerAuthenticationResponse) => void
): void {
	if (auth.username === config.smtp.username && auth.password === config.smtp.password) {
		return callback(null, { user: auth.username });
	}

	return callback(new Error('Invalid username or password'));
}

async function emailHandler(
	stream: SMTPServerDataStream,
	session: SMTPServerSession,
	callback: (err?: Error | null) => void
): Promise<void> {
	let email = '';
	stream.on('data', (chunk) => {
		email += chunk.toString();
	});
	await new Promise((resolve) => {
		stream.on('end', resolve);
	});

	if (session.envelope.mailFrom === false) {
		return callback(new Error('Invalid email: no from address specified'));
	}

	// * Source: https://wordtothewise.com/2024/03/anatomy-of-a-received-header/
	const receivedHeader =
		`Received: from ${session.hostNameAppearsAs} (${session.clientHostname} [${session.remoteAddress}])\r\n` +
		`        by ${config.smtp.hostname} (Pretendo email forwarder) with ${session.transmissionType} id ${session.id}\r\n` +
		`        for ${session.envelope.rcptTo.map((address) => `<${address.address}>`).join(',')}` +
		`; ${new Date().toUTCString()}`;

	const toAddresses = session.envelope.rcptTo.map((address) => address.address);
	const toDomains = toAddresses.map((address) => address.split('@')[1]);

	let action = config.domains.defaultAction;

	if (toDomains.some((domain) => config.domains.forward.includes(domain))) {
		action = 'forward';
	} else if (toDomains.some((domain) => config.domains.passthrough.includes(domain))) {
		action = 'passthrough';
	} else if (toDomains.some((domain) => config.domains.drop.includes(domain))) {
		action = 'drop';
	}

	if (action === 'drop') {
		return callback();
	}

	let forwardToAddresses = toAddresses;
	if (action === 'forward') {
		forwardToAddresses = [];

		for (const address of toAddresses) {
			try {
				const pid = Number(address.split('@')[0]);
				const userAccountData = await getUserAccountData(pid);

				forwardToAddresses.push(userAccountData.emailAddress);
				email = email.replaceAll(address, userAccountData.emailAddress);
			} catch (error) {
				if (error instanceof Error) {
					return callback(error);
				} else {
					return callback(new Error(`Unknown error when fetching user account data: ${error}`));
				}
			}
		}
	}

	email = `${receivedHeader}\r\n${email}`;

	try {
		await transporter.sendMail({
			envelope: {
				from: session.envelope.mailFrom.address,
				to: forwardToAddresses
			},
			raw: email
		});
		return callback();
	} catch (error) {
		if (error instanceof Error) {
			return callback(error);
		} else {
			return callback(new Error(`Unknown error when sending email: ${error}`));
		}
	}
}

const server = new SMTPServer({
	name: config.smtp.hostname,
	allowInsecureAuth: true, // TODO: Set up TLS
	onAuth: authHandler,
	onData: emailHandler
});

server.listen(config.smtp.port);
console.log(`SMTP server started on port ${config.smtp.port}`);
