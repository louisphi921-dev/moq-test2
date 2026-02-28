import { Client } from "../transport/client"
import { Broadcast, BroadcastConfig } from "../contribute"
import { Connection } from "../transport/connection"

function tsNow(): string {
	return `${performance.now().toFixed(1)}ms`
}

export interface PublisherOptions {
	url: string
	namespace: string[]
	media: MediaStream
	video?: VideoEncoderConfig
	audio?: AudioEncoderConfig
	fingerprintUrl?: string
	connection?: Connection
}

export class PublisherApi {
	private client?: Client
	private connection?: Connection
	private broadcast?: Broadcast
	private opts: PublisherOptions

	constructor(opts: PublisherOptions) {
		this.opts = opts
		this.connection = opts.connection
		if (!this.connection) {
			this.client = new Client({
				url: opts.url,
				fingerprint: opts.fingerprintUrl,
			})
		}
	}

	async publish(): Promise<void> {
		if (!this.connection && this.client) {
			this.connection = await this.client.connect()
		}

		if (!this.connection) throw new Error("No connection provided or created")

		const bcConfig: BroadcastConfig = {
			connection: this.connection,
			namespace: this.opts.namespace,
			media: this.opts.media,
			video: this.opts.video,
			audio: this.opts.audio,
		}

		this.broadcast = new Broadcast(bcConfig)
		console.log(`[PUBLISH] PublisherApi.publish() resolved ts=${tsNow()} waits_for_namespace_ok=false`)
	}

	async stop(): Promise<void> {
		if (this.broadcast) {
			this.broadcast.close()
			await this.broadcast.closed()
		}
		if (this.connection) {
			this.connection.close()
			await this.connection.closed()
		}
	}
}
