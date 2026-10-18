// Runs the bridge socket under Node, as DeepSeek Harness does, with a fake session controller.
import {
  Bridge,
  serve,
} from "../../integrations/deepseek/agentplus-bridge.mjs";

const controller = {
  list: async () => ({
    items: [
      {
        sessionId: "session-a",
        cwd: "/repo/a",
        updatedAt: "t1",
        running: false,
      },
    ],
  }),
  create: async (req) => ({ sessionId: `session-new-${req.cwd ?? "default"}` }),
  prompt: async () => ({ accepted: true }),
};
const close = serve(new Bridge(controller), process.argv[2], {
  warn: () => {},
});
process.stdout.write("ready\n");
process.stdin.on("end", () => {
  close();
  process.exit(0);
});
process.stdin.resume();
