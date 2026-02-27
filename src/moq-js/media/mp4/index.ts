// Rename some stuff so it's on brand.
// We need a separate file so this file can use the rename too.
import * as MP4 from "./rename"
export * from "./rename"

export * from "./parser"

export function isAudioTrack(track: MP4.Track): track is MP4.AudioTrack {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	return (track as MP4.AudioTrack).audio !== undefined
}

export function isVideoTrack(track: MP4.Track): track is MP4.VideoTrack {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	return (track as MP4.VideoTrack).video !== undefined
}

// TODO contribute to mp4box
// TODO contribute to mp4box
if (MP4.BoxParser && MP4.BoxParser.dOpsBox) {
	MP4.BoxParser.dOpsBox.prototype.write = function (stream: MP4.Stream) {
		this.size = 11 // Base size for dOps box
		if (this.ChannelMappingFamily !== 0) {
			this.size += 2 + this.ChannelMapping!.length
		}

		this.writeHeader(stream)

		stream.writeUint8(this.Version)
		stream.writeUint8(this.OutputChannelCount)
		stream.writeUint16(this.PreSkip)
		stream.writeUint32(this.InputSampleRate)
		stream.writeInt16(this.OutputGain)
		stream.writeUint8(this.ChannelMappingFamily)

		if (this.ChannelMappingFamily !== 0) {
			if (!this.StreamCount || !this.CoupledCount) throw new Error("failed to write dOps box with channel mapping")
			stream.writeUint8(this.StreamCount)
			stream.writeUint8(this.CoupledCount)
			for (const mapping of this.ChannelMapping!) {
				stream.writeUint8(mapping)
			}
		}
	}
}

if (MP4.BoxParser && !(MP4.BoxParser as any).dOpsBox) {
	const BoxParserAny = MP4.BoxParser as any;
	BoxParserAny.dOpsBox = function (this: any) {
		BoxParserAny.Box.call(this, "dOps", 11);
	};
	// Inherit from Box so we get writeHeader, etc.
	if (BoxParserAny.Box) {
		BoxParserAny.dOpsBox.prototype = Object.create(BoxParserAny.Box.prototype);
		BoxParserAny.dOpsBox.prototype.constructor = BoxParserAny.dOpsBox;
	}

	BoxParserAny.dOpsBox.prototype.parse = function (stream: any) {
		this.Version = stream.readUint8();
		this.OutputChannelCount = stream.readUint8();
		this.PreSkip = stream.readUint16();
		this.InputSampleRate = stream.readUint32();
		this.OutputGain = stream.readInt16();
		this.ChannelMappingFamily = stream.readUint8();
	};
	BoxParserAny.dOpsBox.prototype.write = function (stream: any) {
		this.size = 11; // Base size for dOps box
		if (this.ChannelMappingFamily !== 0 && this.ChannelMapping) {
			this.size += 2 + this.ChannelMapping.length;
		}

		if (typeof this.writeHeader === "function") {
			this.writeHeader(stream);
		} else {
			// Minimal fallback for writeHeader if Box inheritance didn't work
			stream.writeUint32(this.size);
			stream.writeString(this.type, null, 4);
		}

		stream.writeUint8(this.Version || 0);
		stream.writeUint8(this.OutputChannelCount || 1);
		stream.writeUint16(this.PreSkip || 0);
		stream.writeUint32(this.InputSampleRate || 48000);
		stream.writeInt16(this.OutputGain || 0);
		stream.writeUint8(this.ChannelMappingFamily || 0);

		if (this.ChannelMappingFamily !== 0 && this.ChannelMapping) {
			if (!this.StreamCount || !this.CoupledCount) throw new Error("failed to write dOps box with channel mapping");
			stream.writeUint8(this.StreamCount);
			stream.writeUint8(this.CoupledCount);
			for (const mapping of this.ChannelMapping) {
				stream.writeUint8(mapping);
			}
		}
	};
}
