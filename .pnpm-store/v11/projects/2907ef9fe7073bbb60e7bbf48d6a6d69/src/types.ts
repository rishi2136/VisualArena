export type Role = "host" | "moderator" | "participant";
export type PlayState = "playing" | "paused";

export interface PlaybackState {
  videoId: string;
  currentTime: number;
  playState: PlayState;
  updatedAt: number;
}

export interface Participant {
  socketId: string;
  userId: string;
  username: string;
  role: Role;
}

export interface RoomState {
  roomId: string;
  title: string;
  playback: PlaybackState;
  participants: Participant[];
}

export interface ChatMessage {
  id: string;
  username: string;
  userId: string;
  message: string;
  sentAt: number;
}
