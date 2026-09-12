import { Schema, model } from "mongoose";
import type { PlayState } from "../types.js";

export interface RoomDocument {
  roomId: string;
  title: string;
  creatorTokenHash: string;
  videoId: string;
  currentTime: number;
  playState: PlayState;
  stateUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const roomSchema = new Schema<RoomDocument>(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    creatorTokenHash: { type: String, required: true, select: false },
    videoId: { type: String, required: true },
    currentTime: { type: Number, default: 0, min: 0 },
    playState: { type: String, enum: ["playing", "paused"], default: "paused" },
    stateUpdatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const Room = model<RoomDocument>("Room", roomSchema);
