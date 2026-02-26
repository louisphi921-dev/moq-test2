import type * as Watch from "@moq/watch";

export interface DiagEvent {
  t: number;
  tag: string;
  msg: string;
}

export interface RemoteParticipant {
  id: string;
  broadcast: Watch.Broadcast;
  sync: Watch.Sync;
  videoSource: Watch.Video.Source;
  videoDecoder: Watch.Video.Decoder;
  audioSource: Watch.Audio.Source;
  audioDecoder: Watch.Audio.Decoder;
}
