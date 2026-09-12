import "dotenv/config";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { z } from "zod";
import { RoomManager } from "./room-manager.js";
import type { Role } from "./types.js";

const port = Number(process.env.PORT ?? 4000);
const mongoUri =
  process.env.MONGO_ATLAS ?? "mongodb://127.0.0.1:27017/visualarena";
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const app = express();
app.use(cors({ origin: clientOrigin }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: clientOrigin, methods: ["GET", "POST"] },
});
const rooms = new RoomManager(io);

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? "connected" : "connecting",
  }),
);
app.post("/api/rooms", async (req, res, next) => {
  try {
    const { title } = z
      .object({
        title: z.string().max(80).optional().default("Untitled watch party"),
      })
      .parse(req.body);
    res.status(201).json(await rooms.createRoom(title));
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  const withAck =
    <T>(handler: (value: T) => Promise<unknown> | unknown) =>
    async (
      value: T,
      ack?: (reply: { ok: boolean; data?: unknown; error?: string }) => void,
    ) => {
      try {
        ack?.({ ok: true, data: await handler(value) });
      } catch (error) {
        ack?.({
          ok: false,
          error:
            error instanceof Error ? error.message : "Unexpected server error",
        });
      }
    };
  socket.on(
    "join_room",
    withAck((value) =>
      rooms.joinRoom(
        socket,
        z
          .object({
            roomId: z.string(),
            username: z.string(),
            userId: z.string(),
            creatorToken: z.string().optional(),
          })
          .parse(value),
      ),
    ),
  );
  socket.on(
    "play",
    withAck(() => rooms.updatePlayback(socket, "play")),
  );
  socket.on(
    "pause",
    withAck(() => rooms.updatePlayback(socket, "pause")),
  );
  socket.on(
    "seek",
    withAck((value) =>
      rooms.updatePlayback(
        socket,
        "seek",
        z.object({ time: z.number() }).parse(value).time,
      ),
    ),
  );
  socket.on(
    "change_video",
    withAck((value) =>
      rooms.updatePlayback(
        socket,
        "change_video",
        z.object({ videoId: z.string() }).parse(value).videoId,
      ),
    ),
  );
  socket.on(
    "assign_role",
    withAck((value) => {
      const parsed = z
        .object({
          socketId: z.string(),
          role: z.enum(["moderator", "participant"]),
        })
        .parse(value);
      return rooms.assignRole(socket, parsed.socketId, parsed.role as Role);
    }),
  );
  socket.on(
    "remove_participant",
    withAck((value) =>
      rooms.removeParticipant(
        socket,
        z.object({ socketId: z.string() }).parse(value).socketId,
      ),
    ),
  );
  socket.on(
    "transfer_host",
    withAck((value) =>
      rooms.transferHost(
        socket,
        z.object({ socketId: z.string() }).parse(value).socketId,
      ),
    ),
  );
  socket.on(
    "send_message",
    withAck((value) =>
      rooms.sendMessage(
        socket,
        z.object({ message: z.string() }).parse(value).message,
      ),
    ),
  );
  socket.on("leave_room", withAck(() => rooms.leaveRoom(socket, true)));
  socket.on("disconnect", () => rooms.leaveRoom(socket));
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res
      .status(400)
      .json({
        error: error instanceof Error ? error.message : "Invalid request",
      });
  },
);

mongoose
  .connect(mongoUri)
  .then(() =>
    httpServer.listen(port, () =>
      console.log(`VisualArena API listening on http://localhost:${port}`),
    ),
  )
  .catch((error: unknown) => {
    console.error("MongoDB connection failed", error);
    process.exit(1);
  });
