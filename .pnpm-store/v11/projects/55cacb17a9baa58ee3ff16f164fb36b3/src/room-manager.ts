import { createHash, randomBytes } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { Room } from "./models/Room.js";
import type { Participant, PlaybackState, PublicRoom, Role } from "./types.js";

const DEFAULT_VIDEO_ID = "M7lc1UVf-VE";
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type LiveRoom = {
  roomId: string;
  title: string;
  playback: PlaybackState;
  participants: Map<string, Participant>;
};

const cleanName = (value: string) =>
  value.trim().replace(/\s+/g, " ").slice(0, 30);
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const isController = (role: Role) => role === "host" || role === "moderator";

export class RoomManager {
  private readonly rooms = new Map<string, LiveRoom>();

  constructor(private readonly io: Server) {}

  async createRoom(title: string) {
    const roomId = await this.createUniqueRoomId();
    const creatorToken = randomBytes(32).toString("hex");
    const room = await Room.create({
      roomId,
      title: title.trim().slice(0, 80) || "Untitled watch party",
      creatorTokenHash: hashToken(creatorToken),
      videoId: DEFAULT_VIDEO_ID,
      currentTime: 0,
      playState: "paused",
      stateUpdatedAt: new Date(),
    });
    return { roomId: room.roomId, title: room.title, creatorToken };
  }

  async joinRoom(
    socket: Socket,
    input: {
      roomId: string;
      username: string;
      userId: string;
      creatorToken?: string | undefined;
    },
  ) {
    const roomId = input.roomId.toUpperCase();
    const username = cleanName(input.username);
    if (!roomId || !username || !input.userId.trim())
      throw new Error("A room code, display name, and user ID are required.");
    const persisted = await Room.findOne({ roomId })
      .select("+creatorTokenHash")
      .lean();
    if (!persisted)
      throw new Error(
        "That room could not be found. Check the code and try again.",
      );

    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        title: persisted.title,
        playback: this.toPlayback(persisted),
        participants: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    const isHost = Boolean(
      input.creatorToken &&
      hashToken(input.creatorToken) === persisted.creatorTokenHash,
    );
    const existingForUser = [...room.participants.values()].find(
      (member) => member.userId === input.userId,
    );
    if (existingForUser && existingForUser.socketId !== socket.id) {
      this.io.sockets.sockets.get(existingForUser.socketId)?.disconnect(true);
      room.participants.delete(existingForUser.socketId);
    }
    const participant: Participant = {
      socketId: socket.id,
      userId: input.userId.trim(),
      username,
      role: isHost ? "host" : "participant",
    };
    room.participants.set(socket.id, participant);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = participant.userId;
    socket.emit("room_state", this.publicRoom(room));
    this.io.to(roomId).emit("participants_updated", this.participants(room));
    socket.to(roomId).emit("user_joined", participant);
    return this.publicRoom(room);
  }

  async leaveRoom(socket: Socket) {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    const participant = room.participants.get(socket.id);
    room.participants.delete(socket.id);
    socket.leave(roomId);
    delete socket.data.roomId;
    if (participant) {
      this.io.to(roomId).emit("user_left", participant);
      this.io.to(roomId).emit("participants_updated", this.participants(room));
    }
    if (room.participants.size === 0) this.rooms.delete(roomId);
  }

  async updatePlayback(
    socket: Socket,
    action: "play" | "pause" | "seek" | "change_video",
    value?: unknown,
  ) {
    const { room, actor } = this.getActor(socket);
    if (!isController(actor.role))
      throw new Error("Only the host or a moderator can control playback.");
    const current = this.effectiveTime(room.playback);
    if (action === "play")
      room.playback = {
        ...room.playback,
        currentTime: current,
        playState: "playing",
        updatedAt: Date.now(),
      };
    if (action === "pause")
      room.playback = {
        ...room.playback,
        currentTime: current,
        playState: "paused",
        updatedAt: Date.now(),
      };
    if (action === "seek") {
      const time = Number(value);
      if (!Number.isFinite(time) || time < 0)
        throw new Error("Seek time must be a positive number.");
      room.playback = {
        ...room.playback,
        currentTime: time,
        updatedAt: Date.now(),
      };
    }
    if (action === "change_video") {
      if (typeof value !== "string" || !/^[\w-]{11}$/.test(value))
        throw new Error("Please provide a valid YouTube video URL or ID.");
      room.playback = {
        videoId: value,
        currentTime: 0,
        playState: "paused",
        updatedAt: Date.now(),
      };
    }
    await this.persistPlayback(room);
    this.io.to(room.roomId).emit("sync_state", room.playback);
    return room.playback;
  }

  assignRole(socket: Socket, targetSocketId: string, role: Role) {
    const { room, actor } = this.getActor(socket);
    if (actor.role !== "host")
      throw new Error("Only the host can change roles.");
    if (!targetSocketId || !["moderator", "participant"].includes(role))
      throw new Error("Hosts can assign moderator or participant roles.");
    const target = room.participants.get(targetSocketId);
    if (!target) throw new Error("That participant is no longer in this room.");
    if (target.role === "host")
      throw new Error("Use transfer host to choose a new host.");
    target.role = role;
    this.io
      .to(room.roomId)
      .emit("role_assigned", {
        participant: target,
        participants: this.participants(room),
      });
  }

  removeParticipant(socket: Socket, targetSocketId: string) {
    const { room, actor } = this.getActor(socket);
    if (actor.role !== "host")
      throw new Error("Only the host can remove participants.");
    const target = room.participants.get(targetSocketId);
    if (!target || target.role === "host")
      throw new Error("That participant cannot be removed.");
    this.io
      .to(target.socketId)
      .emit("removed_from_room", {
        message: "The host removed you from this watch party.",
      });
    this.io.sockets.sockets.get(target.socketId)?.disconnect(true);
  }

  async transferHost(socket: Socket, targetSocketId: string) {
    const { room, actor } = this.getActor(socket);
    if (actor.role !== "host")
      throw new Error("Only the host can transfer the room.");
    const target = room.participants.get(targetSocketId);
    if (!target || target.socketId === actor.socketId)
      throw new Error("Choose another participant to become host.");
    actor.role = "moderator";
    target.role = "host";
    const creatorToken = randomBytes(32).toString("hex");
    await Room.updateOne(
      { roomId: room.roomId },
      { creatorTokenHash: hashToken(creatorToken) },
    );
    this.io
      .to(target.socketId)
      .emit("host_credentials", { roomId: room.roomId, creatorToken });
    this.io
      .to(room.roomId)
      .emit("participants_updated", this.participants(room));
  }

  sendMessage(socket: Socket, message: string) {
    const { room, actor } = this.getActor(socket);
    const body = message.trim().slice(0, 500);
    if (!body) throw new Error("Message cannot be empty.");
    this.io
      .to(room.roomId)
      .emit("chat_message", {
        id: randomBytes(8).toString("hex"),
        username: actor.username,
        userId: actor.userId,
        message: body,
        sentAt: Date.now(),
      });
  }

  private getActor(socket: Socket) {
    const roomId = socket.data.roomId as string | undefined;
    const room = roomId ? this.rooms.get(roomId) : undefined;
    const actor = room?.participants.get(socket.id);
    if (!room || !actor)
      throw new Error("Join a room before using this action.");
    return { room, actor };
  }

  private publicRoom(room: LiveRoom): PublicRoom {
    return {
      roomId: room.roomId,
      title: room.title,
      playback: {
        ...room.playback,
        currentTime: this.effectiveTime(room.playback),
      },
      participants: this.participants(room),
    };
  }

  private participants(room: LiveRoom) {
    return [...room.participants.values()];
  }
  private effectiveTime(state: PlaybackState) {
    return state.playState === "playing"
      ? state.currentTime + (Date.now() - state.updatedAt) / 1000
      : state.currentTime;
  }
  private toPlayback(room: {
    videoId: string;
    currentTime: number;
    playState: "playing" | "paused";
    stateUpdatedAt: Date;
  }) {
    return {
      videoId: room.videoId,
      currentTime: room.currentTime,
      playState: room.playState,
      updatedAt: room.stateUpdatedAt.getTime(),
    };
  }
  private async persistPlayback(room: LiveRoom) {
    await Room.updateOne(
      { roomId: room.roomId },
      {
        videoId: room.playback.videoId,
        currentTime: room.playback.currentTime,
        playState: room.playback.playState,
        stateUpdatedAt: new Date(room.playback.updatedAt),
      },
    );
  }

  private async createUniqueRoomId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const roomId = Array.from(
        { length: 6 },
        () =>
          ROOM_CODE_ALPHABET[
            Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)
          ],
      ).join("");
      if (!(await Room.exists({ roomId }))) return roomId;
    }
    throw new Error("Could not allocate a room code. Please try again.");
  }
}
