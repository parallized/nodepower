import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync("dist/agent", { recursive: true });
copyFileSync(join("agent", "nodepower-agent.sh"), join("dist", "agent", "nodepower-agent.sh"));
