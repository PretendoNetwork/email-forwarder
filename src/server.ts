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
		console.error(`Error: client ${session.remoteAddress} did not specify a MAIL FROM address`);
		return callback(new Error('Invalid email: no MAIL FROM address specified'));
	}

	const receivedDate = new Date();
	const toAddresses = session.envelope.rcptTo.map((address) => address.address);

	for (const address of toAddresses) {
		const toDomain = address.split('@')[1];

		let action = config.domains.defaultAction;

		if (config.domains.forward.includes(toDomain)) {
			action = 'forward';
		} else if (config.domains.passthrough.includes(toDomain)) {
			action = 'passthrough';
		} else if (config.domains.drop.includes(toDomain)) {
			action = 'drop';
		}

		if (action === 'drop') {
			continue;
		}

		let forwardToAddress = address;
		let emailToSend = email;
		if (action === 'forward') {
			try {
				const pid = Number(address.split('@')[0]);
				const userAccountData = await getUserAccountData(pid);

				forwardToAddress = userAccountData.emailAddress;
				emailToSend = emailToSend.replaceAll(address, userAccountData.emailAddress);
			} catch (error) {
				console.error(`Error when fetching user account data for ${address}: ${error}`);
				return callback(new Error(`Error when fetching user account data for ${address}: ${error}`));
			}
		}

		// * Source: https://wordtothewise.com/2024/03/anatomy-of-a-received-header/
		const receivedHeader =
			`Received: from ${session.hostNameAppearsAs} (${session.clientHostname} [${session.remoteAddress}])\r\n` +
			`        by ${config.smtp.hostname} (Pretendo email forwarder) with ${session.transmissionType} id ${session.id}\r\n` +
			`        for <${address}>; ${receivedDate.toUTCString()}`;
		emailToSend = `${receivedHeader}\r\n${emailToSend}`;

		try {
			await transporter.sendMail({
				envelope: {
					from: session.envelope.mailFrom.address,
					to: forwardToAddress
				},
				raw: emailToSend
			});
		} catch (error) {
			console.error(`Error when sending email for ${address}: ${error}`);
			return callback(new Error(`Error when sending email for ${address}: ${error}`));
		}
	}

	return callback();
}

const server = new SMTPServer({
	name: config.smtp.hostname,
	allowInsecureAuth: true, // TODO: Set up TLS
	onAuth: authHandler,
	onData: emailHandler
});

server.listen(config.smtp.port);
console.log(`SMTP server started on port ${config.smtp.port}`);
